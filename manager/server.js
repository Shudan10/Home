import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONF_DIR, ensureDirs, STACK_HOST } from './lib/paths.js';
import { loadManagerConfig, readEnvFile, saveManagerConfig, updateEnvFile } from './lib/store.js';
import * as dockerctl from './lib/dockerctl.js';
import * as apps from './lib/apps.js';
import * as backup from './lib/backup.js';
import * as mountwatch from './lib/mountwatch.js';
import * as host from './lib/host.js';
import * as selfservice from './lib/selfservice.js';
import * as tunnel from './lib/tunnel.js';
import * as lifecycle from './lib/lifecycle.js';
import { jobs, requestContext } from './lib/jobs.js';
import {
    authConfigured,
    authRequired,
    clearCookie,
    hashPassword,
    passwordUnusable,
    isAuthenticated,
    issueSession,
    sessionCookie,
    verifyPassword,
} from './lib/auth.js';

// Identifies this manager process, and nothing more. The panel reads it on
// every status poll and reloads itself when it changes, so a tab left open
// overnight is never running the code of a build that has already been
// replaced -- after the panel updates itself, and after every restart while
// `dev.sh watch` is rebuilding it.
const BOOT_ID = crypto.randomUUID();

const PANEL_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version;
    } catch {
        return '1.0.0';
    }
})();

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ------------------------------------------------------------- http helpers --

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    // Served with the right type or the browser ignores the manifest entirely
    // and the panel is silently not installable.
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
    });
    res.end(payload);
}

const fail = (res, status, message, extra = {}) => sendJson(res, status, { error: message, ...extra });

async function readBody(req, limit = 512 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('Request body too large.');
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new Error('Request body is not valid JSON.');
    }
}

function serveStatic(req, res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    // Path traversal guard: the resolved file must stay inside PUBLIC_DIR.
    if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) && file !== path.join(PUBLIC_DIR, 'index.html')) {
        return fail(res, 403, 'Forbidden');
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            // Unknown paths fall back to the single page app entry point.
            return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
                if (err2) return fail(res, 404, 'Not found');
                res.writeHead(200, { 'Content-Type': MIME['.html'] });
                res.end(html);
            });
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
        });
        res.end(data);
    });
}

function sse(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const send = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const keepAlive = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 20_000);
    const close = () => clearInterval(keepAlive);
    req.on('close', close);
    res.on('close', close);
    return { send, onClose: (fn) => req.on('close', fn) };
}

// ------------------------------------------------------------------ helpers --

/** Where the panel's own port is published, which .env records. */
const managerBind = () => (readEnvFile().MANAGER_BIND || '0.0.0.0').trim();
const isLoopbackBind = () => ['127.0.0.1', '::1', 'localhost'].includes(managerBind());

/**
 * Notes when an app's image was built, and from what.
 *
 * For an app built from a git ref that is the commit, so "commits behind" can
 * be answered later. For one built from a published base image there is no
 * commit to record and pretending otherwise puts a meaningless sha on screen,
 * so only the date is kept.
 */
async function recordBuild(name, settings, onLine = () => {}) {
    const app = apps.APPS[name];
    if (!app.tracksRepo) {
        apps.writeBuildRecord(name, { sha: null, ref: null, builtAt: new Date().toISOString() });
        return;
    }
    try {
        const upstream = await apps.checkUpstream(name, apps.loadAppsConfig());
        apps.writeBuildRecord(name, { sha: upstream.latestSha, ref: settings.ref, builtAt: new Date().toISOString() });
        onLine(`Built from ${upstream.shortSha}.`);
    } catch (err) {
        onLine(`Could not record the upstream commit: ${err.message}`);
    }
}

/**
 * Applies the Nextcloud settings that only exist inside its own config.php.
 *
 * Trusted domains and the preview providers are both written by the image
 * during first-time install and never again, so changing either afterwards
 * means talking to the running container. That makes *when* this runs the
 * whole problem: it has to be every time Nextcloud starts, because installing
 * it and switching it on are separate actions here and neither one alone used
 * to reach this code. Enabling it applied them; installing it and then
 * flipping the sidebar switch -- which is the path the panel actually
 * recommends -- did not.
 *
 * Nothing here is worth failing a job over. Nextcloud is up either way, and a
 * setting that did not stick is fixed by the next start.
 */
/**
 * The address the outside reaches an app on, or null if it is not published.
 * Always https and never a port: Cloudflare serves the name, on 443.
 */
const publicOriginFor = (key) => tunnel.originFor(key);

async function reconcileNextcloud(onLine = () => {}) {
    const cfg = apps.loadAppsConfig();

    // A container that has just started is not a Nextcloud that can answer:
    // the first boot installs the database, which takes a while, and `occ`
    // refuses until it is done. So this waits for it rather than firing once
    // into a container that is not listening yet.
    const ready = await apps.waitForNextcloud(dockerctl.docker, {
        onWaiting: () => onLine('Waiting for Nextcloud to finish starting before applying its settings...'),
    });
    if (!ready) {
        onLine('Nextcloud did not become ready in time, so its settings were left for the next start.');
        return;
    }

    try {
        await apps.syncTrustedDomains(dockerctl.docker, cfg, onLine);
    } catch (err) {
        onLine(`Could not update the trusted domains: ${err.message}`);
    }
    try {
        await apps.syncPreviewSettings(dockerctl.docker, onLine);
    } catch (err) {
        onLine(`Could not switch the preview providers on: ${err.message}`);
    }
    // First install only -- it marks itself done in Nextcloud's own config, so
    // this is a cheap no-op on every start after the first. Sits here rather
    // than in the install route because this is the one place that has already
    // waited for `occ` to start answering.
    try {
        await apps.installBundledApps(dockerctl.docker, onLine);
    } catch (err) {
        onLine(`Could not install the bundled apps: ${err.message}`);
    }
    // The bind mounts are made by compose; this is the half that tells
    // Nextcloud they are there. Reapplied on every start because the mount list
    // lives in Nextcloud's database, which a reinstall starts empty.
    try {
        await apps.syncExternalStorage(dockerctl.docker, cfg, onLine);
    } catch (err) {
        onLine(`Could not update the shared folders: ${err.message}`);
    }
    // Reapplied on every start rather than only when the name is assigned: the
    // public port can change without the name changing, and a stale origin
    // sends every redirect somewhere wrong.
    try {
        await apps.syncNextcloudUrls(dockerctl.docker, publicOriginFor('nextcloud'), onLine);
    } catch (err) {
        onLine(`Could not set the public address: ${err.message}`);
    }
}

async function applyAppConfig(name, cfg, onLine = () => {}) {
    const app = apps.APPS[name];
    const settings = cfg[name];

    // Which group owns each shared folder, so the container can be put in it.
    // Done here rather than in validation because it reads the filesystem, and
    // it has to happen before the override is written.
    if (name === 'nextcloud') {
        const gids = await apps.ownerGids(dockerctl.docker, cfg.nextcloud.sharedPaths ?? []);
        if (gids.length) {
            cfg.nextcloud.sharedGids = gids;
            apps.saveAppsConfig(cfg);
            onLine(`Shared folders are owned by group ${gids.join(', ')}; Nextcloud will run as a member.`);
        }
    }

    apps.ensureSecrets();
    apps.writeAppsEnv(cfg);
    apps.renderAppsPortsOverride(cfg);

    if (!settings.enabled) {
        onLine(`${app.label} disabled - removing its containers.`);
        await dockerctl.compose(['rm', '-sf', ...app.services], { onLine, profile: app.profile, timeoutMs: 10 * 60_000 });
        return { enabled: false };
    }

    onLine('Building images if needed...');
    await dockerctl.compose(['build', ...app.services.filter((sv) => BUILDABLE_SERVICES.has(sv))], {
        onLine,
        profile: app.profile,
        timeoutMs: 120 * 60_000,
    });

    onLine('Starting containers...');
    await dockerctl.compose(['up', '-d', ...app.services], { onLine, profile: app.profile, timeoutMs: 20 * 60_000 });

    await recordBuild(name, settings, onLine);

    // Nextcloud reads its trusted domains only while installing, so a change
    // made later has to be applied to the running instance or it silently does
    // nothing. Failure here is worth reporting but not worth failing the job:
    // the container is up either way.
    if (name === 'nextcloud') await reconcileNextcloud(onLine);

    onLine(`${app.label} is up.`);
    return { enabled: true };
}

/**
 * Tells an app the public name it now answers on.
 *
 * Some apps need to be told, and each refuses differently when it has not been:
 * Nextcloud turns away a name that is not in its trusted list, with a blank
 * error page. Jellyfin serves fine but hands clients an address from its own
 * point of view, which is wrong the moment there is a proxy in front of it.
 *
 * Publishing is the moment either becomes true, so it happens there rather than
 * being left as a thing to discover.
 */
async function notifyPublished(key, domain, onLine = () => {}) {
    // The full address including the port, because that is what an app has to
    // put in front of every link it builds. A name on its own is only right
    // when the proxy happens to be on the default port.
    const origin = publicOriginFor(key);

    if (key === 'jellyfin') {
        const next = origin ?? '';
        if ((readEnvFile().JELLYFIN_PUBLISHED_URL ?? '') === next) return;
        updateEnvFile({ JELLYFIN_PUBLISHED_URL: next });
        onLine(next ? `Jellyfin will tell clients it lives at ${next}.` : 'Jellyfin no longer has a public address.');

        /*
         * And then replace the container, because otherwise none of that is
         * true yet.
         *
         * Jellyfin reads this at startup, and a container's environment is
         * fixed when it is created -- so `restart` would faithfully bring back
         * a container still holding the old value. It has to be recreated.
         *
         * Two cases are deliberately left alone. A stopped Jellyfin, because
         * recreating it would start it, and publishing a name is not a request
         * to run something -- it picks the value up whenever it is next
         * started, which goes through `up -d` as well. And unpublishing, where
         * the address merely becomes stale: interrupting whatever somebody is
         * watching, to stop advertising an address that no longer resolves, is
         * a poor trade. That one is written now and applied at the next start.
         */
        if (!next) return;
        const state = await dockerctl.containerState(apps.APPS.jellyfin.container);
        if (!state.running) return;

        onLine('Recreating Jellyfin so it picks the address up. Playback in progress will drop.');
        await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', ...apps.APPS.jellyfin.services], {
            onLine,
            profile: apps.APPS.jellyfin.profile,
            timeoutMs: 5 * 60_000,
        });
        return;
    }
    if (key !== 'nextcloud') return;

    const cfg = apps.loadAppsConfig();
    const names = new Set(String(cfg.nextcloud.trustedDomains || '').split(/[\s,]+/).filter(Boolean));
    // No domain means a name was taken away rather than given: there is
    // nothing to trust, only the public address below to refresh. Without the
    // check this added the word "null" to Nextcloud's trusted domains.
    if (domain && !names.has(domain)) {
        names.add(domain);
        cfg.nextcloud.trustedDomains = [...names].join(' ');
        apps.saveAppsConfig(cfg);
        apps.writeAppsEnv(cfg);
        onLine(`Adding ${domain} to Nextcloud's trusted domains.`);
    }

    // Only meaningful against a running container; a stopped one picks both of
    // these up the next time it starts, via reconcileNextcloud.
    if ((await dockerctl.containerState(apps.APPS.nextcloud.container)).running) {
        await apps.syncTrustedDomains(dockerctl.docker, cfg, onLine).catch((err) => {
            onLine(`Could not update the trusted domains: ${err.message}`);
        });
        await apps.syncNextcloudUrls(dockerctl.docker, origin, onLine).catch((err) => {
            onLine(`Could not set the public address: ${err.message}`);
        });
    }
}

// --------------------------------------------------------------- the routes --

const routes = [];
const route = (method, pattern, handler, { auth = true } = {}) =>
    routes.push({ method, pattern, handler, auth });

route('GET', /^\/healthz$/, async (req, res) => sendJson(res, 200, { ok: true }), { auth: false });

route(
    'GET',
    /^\/api\/session$/,
    async (req, res) =>
        sendJson(res, 200, {
            // `required` false means no password is set. The installer always
            // sets one, so this is the state of an install whose .env was edited
            // by hand -- the panel says so loudly rather than quietly allowing it.
            required: authRequired(),
            authenticated: !authRequired() || isAuthenticated(req),
            // A stored hash that cannot be verified would otherwise present as
            // "your password is wrong", forever.
            passwordUnusable: passwordUnusable(),
            panelVersion: PANEL_VERSION,
        }),
    { auth: false },
);

route(
    'POST',
    /^\/api\/login$/,
    async (req, res) => {
        const body = await readBody(req);
        if (!authRequired()) return sendJson(res, 200, { ok: true, required: false });
        if (!verifyPassword(String(body.password ?? ''))) {
            // Constant-ish delay so the endpoint is not a fast password oracle.
            await new Promise((r) => setTimeout(r, 500));
            return fail(res, 401, 'Incorrect password.');
        }
        const { token } = issueSession();
        const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure }) });
    },
    { auth: false },
);

route('POST', /^\/api\/logout$/, async (req, res) => sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() }), {
    auth: false,
});

// ----------------------------------------------------------------- overview --

/**
 * The landing page: the machine, not any one app.
 *
 * A home server panel has no single thing to be a dashboard of, so this is the
 * honest summary -- how much disk is left, what is running, how long it has
 * been up -- plus whatever job is in flight, which every screen needs anyway.
 */
route('GET', /^\/api\/status$/, async (req, res) => {
    const [snapshot, services, connector] = await Promise.all([
        host.snapshot(),
        lifecycle.statusAll(),
        dockerctl.containerState(tunnel.TUNNEL_CONTAINER).catch(() => ({ running: false })),
    ]);
    sendJson(res, 200, {
        host: snapshot,
        services,
        tunnel: { connected: tunnel.isConnected(), running: Boolean(connector.running) },
        bootId: BOOT_ID,
        panelVersion: PANEL_VERSION,
        job: jobs.snapshot(),
    });
});

route('GET', /^\/api\/host$/, async (req, res) => sendJson(res, 200, await host.snapshot()));

// --------------------------------------------------------------------- logs --

const containerFor = (url) => {
    const wanted = url.searchParams.get('container');
    return dockerctl.STACK_CONTAINERS.find((c) => c.key === wanted)?.name ?? dockerctl.MANAGER_CONTAINER;
};

route('GET', /^\/api\/logs$/, async (req, res, match, url) => {
    const tail = Math.min(Number(url.searchParams.get('tail')) || 300, 5000);
    sendJson(res, 200, { text: await dockerctl.logs(containerFor(url), tail) });
});

route('GET', /^\/api\/logs\/stream$/, async (req, res, match, url) => {
    const { send, onClose } = sse(req, res);
    const stop = dockerctl.streamLogs(containerFor(url), (line) => send('line', { line }));
    onClose(stop);
});

route('GET', /^\/api\/logs\/containers$/, async (req, res) => {
    const rows = await Promise.all(
        dockerctl.STACK_CONTAINERS.map(async (c) => ({ ...c, state: await dockerctl.containerState(c.name) })),
    );
    sendJson(res, 200, { containers: rows.filter((c) => c.state.exists) });
});

/**
 * Every container's log at once, and it keeps up with the stack.
 *
 * Deliberately multiplexed rather than one EventSource per tile: browsers allow
 * only about six concurrent HTTP/1.1 connections per origin, so a tile each
 * would consume the entire budget and stall the status polling that drives the
 * rest of the panel.
 *
 * What is on the machine changes while somebody is watching this page:
 * installing creates a container, a switch starts one, uninstalling takes one
 * away. The set used to be read once, when the page connected -- so a container
 * that appeared afterwards never got a tile, and one that restarted went quiet
 * for good, because `docker logs --follow` ends when its container does and
 * nothing reattached. Rescanned every few seconds instead.
 */
route('GET', /^\/api\/logs\/stream-all$/, async (req, res) => {
    const { send, onClose } = sse(req, res);

    const followers = new Map(); // name -> { stop, startedAt }
    let listed = null;
    let closed = false;

    const detach = (name) => {
        const follower = followers.get(name);
        if (!follower) return;
        followers.delete(name);
        try {
            follower.stop();
        } catch {
            /* already exited */
        }
    };

    const scan = async () => {
        if (closed) return;

        const present = [];
        for (const c of dockerctl.STACK_CONTAINERS) {
            const state = await dockerctl.containerState(c.name);
            if (state.exists) present.push({ ...c, state });
        }

        // The browser rebuilds every tile when this arrives, losing what is in
        // them, so it is sent when the set itself changed and not on every scan.
        const signature = present.map((c) => `${c.key}:${c.state.running ? 1 : 0}`).join(',');
        if (signature !== listed) {
            listed = signature;
            send('containers', {
                containers: present.map(({ key, label, name, state }) => ({
                    key,
                    label,
                    name,
                    running: state.running,
                })),
            });
        }

        const names = new Set(present.map((c) => c.name));
        for (const name of [...followers.keys()]) if (!names.has(name)) detach(name);

        for (const c of present) {
            const follower = followers.get(c.name);
            // startedAt is what tells one run of a container from the next, and
            // a new run means the old `docker logs` has already exited.
            if (follower && follower.startedAt === c.state.startedAt) continue;
            detach(c.name);
            followers.set(c.name, {
                startedAt: c.state.startedAt,
                stop: dockerctl.streamLogs(c.name, (line) => send('line', { key: c.key, line }), { tail: 60 }),
            });
        }
    };

    await scan();
    const timer = setInterval(() => scan().catch(() => {}), 5000);
    onClose(() => {
        closed = true;
        clearInterval(timer);
        for (const name of [...followers.keys()]) detach(name);
    });
});

// --------------------------------------------------------------------- jobs --

// -------------------------------------------------------------------- backup --

/**
 * What can be backed up to, and how the last attempt went.
 *
 * The drive list is discovered rather than typed: a path is easy to get subtly
 * wrong, and a wrong one here does not fail -- Docker creates a bind mount
 * source that is missing, so a typo backs up onto the internal disk and reports
 * success.
 */
route('GET', /^\/api\/backup$/, async (req, res) => {
    const drives = await backup.listDestinations();
    // The folders come from Nextcloud's shared folders, so the page shows what
    // will be copied rather than asking for it a second time.
    sendJson(res, 200, { config: backup.loadBackupConfig(), drives, sources: backup.backupSources() });
});

route('PUT', /^\/api\/backup$/, async (req, res) => {
    const body = await readBody(req);
    const { cfg, errors } = backup.validateBackupConfig(body ?? {});
    if (errors.length) return fail(res, 400, errors[0], { details: errors });

    // Preserved: these describe what happened, not what was asked for, and a
    // save should not erase the record of the last run.
    const prev = backup.loadBackupConfig();
    const saved = backup.saveBackupConfig({
        ...cfg,
        lastRunAt: prev.lastRunAt,
        lastResult: prev.lastResult,
        lastOk: prev.lastOk,
    });
    backup.scheduleFromConfig(log, enqueueBackup);
    sendJson(res, 200, { ok: true, config: saved });
});

/** Runs one copy now, through the job queue so it gets the usual live log. */
route('POST', /^\/api\/backup\/run$/, async (req, res) => {
    const job = enqueueBackup();
    sendJson(res, 202, { ok: true, jobId: job.id });
});

function enqueueBackup() {
    return jobs.start('Back up', async (onLine) => {
        try {
            await backup.run(onLine);
        } catch (err) {
            backup.saveBackupConfig({
                lastRunAt: new Date().toISOString(),
                lastOk: false,
                lastResult: err.message,
            });
            throw err;
        }
    });
}

route('GET', /^\/api\/jobs\/stream$/, async (req, res) => {
    const { send, onClose } = sse(req, res);
    const snapshot = jobs.snapshot();
    if (snapshot) send('snapshot', snapshot);
    const onLine = (e) => send('line', e);
    const onStart = (job) =>
        send('start', { id: job.id, name: job.name, queued: job.queued, startedAt: job.startedAt, pending: jobs.pending });
    const onEnd = (job) =>
        send('end', {
            id: job.id,
            name: job.name,
            queued: job.queued,
            status: job.status,
            error: job.error,
            pending: jobs.pending,
        });
    // Asked for but not started. Without this the browser has no way to show
    // that a second request was accepted rather than swallowed.
    const onQueued = (job) => send('queued', job);
    jobs.on('line', onLine);
    jobs.on('start', onStart);
    jobs.on('end', onEnd);
    jobs.on('queued', onQueued);
    onClose(() => {
        jobs.off('line', onLine);
        jobs.off('start', onStart);
        jobs.off('end', onEnd);
        jobs.off('queued', onQueued);
    });
});

route('GET', /^\/api\/jobs\/current$/, async (req, res) => sendJson(res, 200, { job: jobs.snapshot(), busy: jobs.busy }));

/** Running, waiting and the last ten finished -- everything the Update Queue page shows. */
route('GET', /^\/api\/jobs\/queue$/, async (req, res) => sendJson(res, 200, jobs.view()));

/*
 * How a job went, asked for rather than waited for. The overlay watches the job
 * stream, but a dropped connection loses the one event that says a job ended,
 * and there is no second delivery -- so the overlay also asks here on a timer.
 *
 * Registered after /stream and /current on purpose: this pattern matches both of
 * those names, and the first matching route wins.
 */
route('GET', /^\/api\/jobs\/([a-z0-9-]+)$/, async (req, res, match) => {
    const job = jobs.find(match[1]);
    // Old enough to have fallen out of the history. Not an error: it is not
    // running, which is the only thing the caller is really asking.
    if (!job) return sendJson(res, 200, { job: null, gone: true });
    sendJson(res, 200, { job });
});

/**
 * Stop a job. What it had already done stays done -- the overlay says so before
 * it asks -- and the next job in the queue starts as soon as this one lets go.
 */
route('POST', /^\/api\/jobs\/([a-z0-9-]+)\/cancel$/, async (req, res, match) => {
    const result = jobs.cancel(match[1]);
    if (!result.cancelled) return fail(res, 409, result.reason ?? 'That job cannot be cancelled.');
    sendJson(res, 202, { ok: true, ...result });
});

// --------------------------------------------------------------- panel port --

/**
 * Moves the panel itself to another port.
 *
 * Same shape as setting a password: .env holds it, the container reads it when
 * it is created, so a sidecar recreates this container a moment after the
 * answer goes out. The browser has to be told where to look next, because the
 * address it is on stops working.
 */
route('POST', /^\/api\/panel\/port$/, async (req, res) => {
    const body = await readBody(req);
    const wanted = Number(body.port);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) return fail(res, 400, 'That is not a port number.');

    const env = readEnvFile();
    if (wanted === (Number(env.HTTP_PORT) || 80) || wanted === (Number(env.HTTPS_PORT) || 443)) {
        return fail(res, 409, `Port ${wanted} belongs to the reverse proxy.`);
    }
    const appsCfg = apps.loadAppsConfig();
    if (appsCfg.nextcloud.publish.web && wanted === Number(appsCfg.nextcloud.hostPort)) {
        return fail(res, 409, `Port ${wanted} is where Nextcloud is published.`);
    }
    if (wanted === (Number(env.GUI_PORT) || 8420)) return sendJson(res, 200, { ok: true, unchanged: true });

    updateEnvFile({ GUI_PORT: String(wanted) });
    await selfservice.restartManager();
    sendJson(res, 202, { ok: true, port: wanted, restarting: true });
});

// --------------------------------------------------------------------- apps --

route('GET', /^\/api\/apps$/, async (req, res) => {
    const cfg = apps.loadAppsConfig();

    const state = {};
    for (const [name, app] of Object.entries(apps.APPS)) {
        const [container, published] = await Promise.all([
            dockerctl.containerState(app.container),
            dockerctl.publishedPorts(app.container),
        ]);
        state[name] = {
            label: app.label,
            repo: app.repo,
            tracksRepo: Boolean(app.tracksRepo),
            container,
            published,
            build: apps.readBuildRecord(name),
            // What is actually running, which only the app itself knows. Null
            // while it is stopped; the build date covers that case.
            version: name === 'nextcloud' && container.running ? await apps.nextcloudVersion(dockerctl.docker) : null,
            // Whether the GPU setting is even offerable on this machine.
            gpuAvailable: name === 'jellyfin' ? await apps.hasRenderDevice(dockerctl.docker) : null,
            // The address the outside reaches it on, when it has one. The
            // local address the panel works out for itself, from whichever
            // address the browser used to reach the panel -- which is the only
            // one that is certain to work from wherever it is being read.
            publicUrl: publicOriginFor(name),
            blockers: apps.appBlockers(name, cfg),
            lastRun: apps.readLastRun(name),
        };
    }
    sendJson(res, 200, { config: cfg, apps: state });
});

route('PUT', /^\/api\/apps\/(nextcloud|jellyfin|mealplan)$/, async (req, res, match) => {
    const name = match[1];
    const body = await readBody(req);

    // Validate the whole document so one app's edit cannot corrupt another's
    // stored settings, then apply only the app that was asked for.
    const current = apps.loadAppsConfig();
    const merged = { ...current, [name]: { ...current[name], ...(body.config ?? {}) } };
    const { cfg, errors } = apps.validateAppsConfig(merged);
    if (errors.length) return fail(res, 400, 'The configuration has problems.', { details: errors });

    const blockers = apps.appBlockers(name, cfg);
    if (blockers.length) return fail(res, 409, `${apps.APPS[name].label} cannot start yet.`, { details: blockers });

    // A media folder that is not there is refused rather than mounted. Docker
    // would not complain -- it creates the missing directory as root and mounts
    // that -- so the only sign of a typo would be an empty library and a
    // directory nobody meant to make. Checked here rather than in the validator
    // because it has to ask the host, which takes a container.
    if (name === 'jellyfin' && cfg.jellyfin.mediaPaths.length) {
        const checked = await apps.verifyHostPaths(dockerctl.docker, cfg.jellyfin.mediaPaths);
        const missing = checked.filter((c) => c.exists === false).map((c) => c.path);
        if (missing.length) {
            return fail(res, 400, 'Some of those media folders do not exist on this machine.', {
                details: [
                    ...missing.map((p) => `${p} was not found.`),
                    'Check the spelling, and give the path as this machine sees it rather than as another device sees it over the network.',
                ],
            });
        }
    }

    // Asking for a GPU that is not there is not a setting, it is a container
    // that refuses to start -- and the refusal names a device rather than a
    // choice somebody made on this page.
    if (name === 'jellyfin' && cfg.jellyfin.hardwareAcceleration && !(await apps.hasRenderDevice(dockerctl.docker))) {
        return fail(res, 400, 'This machine has no /dev/dri, so there is no GPU to give Jellyfin.', {
            details: [
                'That is normal on a server with no graphics chip, or where the driver is not loaded.',
                'Leave hardware transcoding off: Jellyfin will use the processor instead, which works and is only slower.',
            ],
        });
    }

    apps.saveAppsConfig(cfg);
    const job = jobs.start(`${cfg[name].enabled ? 'Start' : 'Stop'} ${apps.APPS[name].label}`, async (onLine) => {
        // Remember how this turned out. The job itself only lives in memory, so
        // without a record on disk a failed build is indistinguishable from one
        // that is still running as soon as the manager restarts.
        apps.writeLastRun(name, { ok: null, error: null, enabled: cfg[name].enabled });

        // Docker's own error says which build step died but not why; the reason
        // is a line printed further up, which only ever appears in the streamed
        // output. Keeping the tail of it means the panel can say something more
        // useful than "exit code 1".
        const output = [];
        const capture = (line) => {
            output.push(line);
            if (output.length > 400) output.shift();
            onLine(line);
        };

        try {
            const result = await applyAppConfig(name, cfg, capture);
            apps.writeLastRun(name, { ok: true, error: null, enabled: cfg[name].enabled });
            return result;
        } catch (err) {
            apps.writeLastRun(name, {
                ok: false,
                error: `${output.join('\n')}\n${err.message}`,
                enabled: cfg[name].enabled,
            });
            throw err;
        }
    });
    sendJson(res, 202, { ok: true, jobId: job.id, config: cfg });
});

route('GET', /^\/api\/apps\/(nextcloud|jellyfin|mealplan)\/refs$/, async (req, res, match, url) => {
    try {
        sendJson(res, 200, await apps.listRefs(match[1], { force: url.searchParams.get('force') === '1' }));
    } catch (err) {
        fail(res, 502, err.message);
    }
});

route('GET', /^\/api\/apps\/nextcloud\/admin$/, async (req, res) => {
    // The same value sitting in the stack's .env, behind the same password as
    // the rest of the panel. It is the only way to reach a fresh install.
    sendJson(res, 200, apps.nextcloudAdmin());
});

route('POST', /^\/api\/apps\/nextcloud\/admin\/password$/, async (req, res) => {
    const body = await readBody(req);
    const password = String(body.password ?? '');

    // Nextcloud's own minimum is 10 characters. Checking here means a bad one is
    // refused before the container is touched, rather than after a failed occ run.
    if (password.length < 10) return fail(res, 400, 'The password needs to be at least 10 characters.');
    if (password.length > 200) return fail(res, 400, 'That password is too long.');

    const state = await dockerctl.containerState(apps.APPS.nextcloud.container);
    if (!state.running) return fail(res, 409, 'Nextcloud is not running, so its password cannot be changed yet.');

    try {
        await apps.setNextcloudAdminPassword(dockerctl.docker, password);
        sendJson(res, 200, { ok: true });
    } catch (err) {
        fail(res, 500, `Nextcloud refused the change: ${err.message}`);
    }
});

/*
 * Meal Plan's family password, which is not the panel's.
 *
 * Deliberately separate: this is the one thing in the stack handed out to
 * everybody in the house, and sharing the panel's password to get at the dinner
 * list would hand them the Docker socket with it.
 */
route('GET', /^\/api\/apps\/mealplan\/password$/, async (req, res) =>
    sendJson(res, 200, { set: Boolean((readEnvFile().MEALPLAN_PASSWORD_HASH || '').trim()) }));

route('POST', /^\/api\/apps\/mealplan\/password$/, async (req, res) => {
    const body = await readBody(req);
    const password = String(body.password ?? '');
    if (password.length < 8) return fail(res, 400, 'Use at least 8 characters.');
    if (password.length > 200) return fail(res, 400, 'That is longer than 200 characters.');

    updateEnvFile({ MEALPLAN_PASSWORD_HASH: hashPassword(password) });

    // The hash reaches the app as an environment variable, and a running
    // container cannot be told about a new one -- it has to come back with it.
    // A stopped one picks it up whenever it is next started, so there is
    // nothing to do and saying "restarting" would be a lie.
    const state = await dockerctl.containerState(apps.APPS.mealplan.container);
    if (!state.running) return sendJson(res, 200, { ok: true, restarting: false });

    const job = jobs.start('Applying the Meal Plan password', async (onLine) => {
        await lifecycle.setRunning('mealplan', true, onLine);
    });
    sendJson(res, 202, { ok: true, jobId: job.id, restarting: true });
});

route('GET', /^\/api\/apps\/(nextcloud|jellyfin|mealplan)\/check$/, async (req, res, match) => {
    const name = match[1];
    try {
        // Nextcloud and Jellyfin come from a Docker Hub tag, not a repository:
        // for them "up to date" means built on what that tag points at now.
        if (!apps.APPS[name].tracksRepo) {
            return sendJson(res, 200, { kind: 'image', ...(await apps.checkBaseImage(name, dockerctl.docker)) });
        }
        const upstream = await apps.checkUpstream(name, apps.loadAppsConfig());
        const built = apps.readBuildRecord(name);
        sendJson(res, 200, {
            ...upstream,
            builtSha: built.sha,
            builtAt: built.builtAt,
            // No published releases upstream, so "up to date" means the running
            // image was built from the commit the branch currently points at.
            updateAvailable: Boolean(built.sha) && built.sha !== upstream.latestSha,
            neverBuilt: !built.sha,
        });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

route('POST', /^\/api\/apps\/(nextcloud|jellyfin|mealplan)\/update$/, async (req, res, match) => {
    const name = match[1];
    const cfg = apps.loadAppsConfig();
    if (!cfg[name].enabled) return fail(res, 409, `${apps.APPS[name].label} is switched off.`);

    const app = apps.APPS[name];
    const buildable = app.services.filter((sv) => BUILDABLE_SERVICES.has(sv));
    const job = jobs.start(`Update ${app.label}`, async (onLine) => {
        if (buildable.length) {
            onLine(`Rebuilding ${app.label}...`);
            // --pull so a rebuild actually picks up a newer base image;
            // --no-cache because the layers above it would otherwise be reused
            // unchanged.
            await dockerctl.compose(['build', '--pull', '--no-cache', ...buildable], {
                onLine,
                profile: app.profile,
                timeoutMs: 120 * 60_000,
            });
        } else {
            // Nothing is built here, so updating is fetching a newer image.
            onLine(`Downloading the newest ${app.label} image...`);
            await dockerctl.compose(['pull', ...app.services], {
                onLine,
                profile: app.profile,
                timeoutMs: 60 * 60_000,
            });
        }
        // The new image is in place either way; what was stopped stays stopped
        // and comes up on it whenever somebody starts it.
        if ((await lifecycle.status(name))?.running) {
            await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', ...app.services], {
                onLine,
                profile: app.profile,
                timeoutMs: 20 * 60_000,
            });
        } else {
            onLine(`${app.label} is stopped, so it stays stopped. It runs the new image when you start it.`);
        }
        await recordBuild(name, cfg[name], onLine);
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/apps\/(nextcloud|jellyfin|mealplan)\/(start|stop|restart)$/, async (req, res, match) => {
    const [, name, action] = match;
    const app = apps.APPS[name];
    const job = jobs.start(`${action} ${app.label}`, async (onLine) => {
        const verb = action === 'start' ? ['up', '-d'] : [action];
        await dockerctl.compose([...verb, ...app.services], { onLine, profile: app.profile, timeoutMs: 10 * 60_000 });
        if (name === 'nextcloud' && action !== 'stop') await reconcileNextcloud(onLine);
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// -------------------------------------------------------- admin password --

/**
 * Sets, changes or clears the panel's own password.
 *
 * The hash lives in .env and is read into the process once at startup, so this
 * writes the file and then has a sidecar replace this container. Nothing is
 * lost: the proxy and every app keep running, and the browser is told to expect
 * a few seconds of silence.
 */
route('POST', /^\/api\/auth\/password$/, async (req, res) => {
    const body = await readBody(req);

    if (authConfigured() && !verifyPassword(String(body.current || ''))) {
        return fail(res, 403, 'That is not the current password.');
    }

    if (body.clear) {
        if (!authConfigured()) return sendJson(res, 200, { ok: true, unchanged: true });
        // Removing the password is only sane while the panel is on loopback and
        // not on a domain; either would leave the Docker socket open.
        const published = Boolean(tunnel.originFor('panel'));
        if (published) {
            return fail(res, 409, 'This panel is published on a domain, so it cannot have its password removed.', {
                details: ['Unpublish it first, or keep the password.'],
            });
        }
        if (!isLoopbackBind()) {
            return fail(res, 409, `This panel is bound to ${managerBind()}, not to loopback, so it needs a password.`, {
                details: ['Anything on your network can reach it, and it holds the Docker socket.'],
            });
        }
        updateEnvFile({ ADMIN_PASSWORD_HASH: '' });
        await selfservice.restartManager();
        return sendJson(res, 202, { ok: true, cleared: true, restarting: true });
    }

    const password = String(body.password || '');
    if (password.length < 8) return fail(res, 400, 'Use at least 8 characters.');
    if (password.length > 200) return fail(res, 400, 'That is longer than 200 characters.');

    updateEnvFile({ ADMIN_PASSWORD_HASH: hashPassword(password) });
    await selfservice.restartManager();
    sendJson(res, 202, { ok: true, restarting: true });
});

// -------------------------------------------------------------- lifecycle --

/**
 * Install, start, stop, uninstall, for every service that is a container.
 *
 * One set of endpoints rather than a set per service, because the difference
 * between them is a table and the mistake worth avoiding -- a switch that
 * quietly deletes an hour of building -- is the same mistake everywhere.
 */
route('GET', /^\/api\/services$/, async (req, res) => {
    sendJson(res, 200, { services: await lifecycle.statusAll() });
});

route('POST', /^\/api\/services\/([a-z-]+)\/install$/, async (req, res, match) => {
    const key = match[1];
    const unit = lifecycle.unitFor(key);
    if (!unit) return fail(res, 404, 'No such service.');

    const job = jobs.start(`Install ${unit.label}`, async (onLine) => {
        // Whatever the service needs written before it starts. Enabling it in
        // the apps config keeps the rest of the panel agreeing with reality.
        const appsCfg = apps.loadAppsConfig();
        if (appsCfg[key]) {
            appsCfg[key].enabled = true;
            apps.saveAppsConfig(appsCfg);
            apps.ensureSecrets();
            apps.writeAppsEnv(appsCfg);
            apps.renderAppsPortsOverride(appsCfg);
        }

        await lifecycle.install(key, onLine);
        // Installing is what builds the image, so it is what has something to
        // record. Without this the Updates tab says "not built yet" about an
        // app that was just built.
        if (apps.APPS[key]) await recordBuild(key, appsCfg[key], onLine);
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/services\/([a-z-]+)\/(start|stop)$/, async (req, res, match) => {
    const unit = lifecycle.unitFor(match[1]);
    if (!unit) return fail(res, 404, 'No such service.');

    const running = match[2] === 'start';
    const state = await lifecycle.status(match[1]);
    if (!state.installed) return fail(res, 409, `${unit.label} is not installed yet.`);

    const job = jobs.start(`${running ? 'Start' : 'Stop'} ${unit.label}`, async (onLine) => {
        await lifecycle.setRunning(match[1], running, onLine);
        // Settings that live inside the app rather than in compose have to be
        // reapplied to the container that has just come up.
        if (running && match[1] === 'nextcloud') await reconcileNextcloud(onLine);
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/services\/([a-z-]+)\/uninstall$/, async (req, res, match) => {
    const key = match[1];
    const unit = lifecycle.unitFor(key);
    if (!unit) return fail(res, 404, 'No such service.');
    const body = await readBody(req);

    // Deleting somebody's Nextcloud is not a thing to do on a mis-click, so the
    // request has to name the service it means.
    if (String(body.confirm ?? '') !== key) {
        return fail(res, 400, 'The uninstall request did not confirm which service it meant.');
    }

    const keepData = body.keepData === true;
    const job = jobs.start(`Uninstall ${unit.label}`, async (onLine) => {
        const removed = await lifecycle.uninstall(key, { keepData, onLine });

        // Back to how it looked before it was ever installed.
        const appsCfg = apps.loadAppsConfig();
        if (appsCfg[key]) {
            appsCfg[key] = structuredClone(apps.DEFAULT_APPS_CONFIG[key]);
            apps.saveAppsConfig(appsCfg);
            apps.writeAppsEnv(appsCfg);
            apps.renderAppsPortsOverride(appsCfg);
            onLine('Its settings are back to their defaults.');
        }
        return removed;
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// ------------------------------------------------------------ global system --

route('GET', /^\/api\/system$/, async (req, res) => {
    sendJson(res, 200, {
        panelVersion: PANEL_VERSION,
        stackDir: STACK_HOST,
        stackRepo: selfservice.STACK_REPO,
        lastUpdate: selfservice.lastUpdate(),
        panelPort: Number(readEnvFile().GUI_PORT) || 8420,
        panelBind: managerBind(),
    });
});

route('GET', /^\/api\/system\/panel-latest$/, async (req, res, match, url) => {
    const repo = (url.searchParams.get('repo') || selfservice.STACK_REPO).trim();
    const ref = (url.searchParams.get('ref') || 'main').trim();
    try {
        const latest = await selfservice.latestCommit({ repo, ref });
        const installed = selfservice.lastUpdate();
        // Only meaningful once something has recorded which commit is installed,
        // which is the first time this panel updates itself.
        const known = installed?.repo === repo ? installed.sha : null;
        sendJson(res, 200, {
            latest,
            installedSha: known || null,
            upToDate: known ? known === latest.sha : null,
            compare: known ? await selfservice.compareToInstalled({ repo, base: known, head: latest.sha }) : null,
        });
    } catch (err) {
        fail(res, 400, err.message);
    }
});

/*
 * How the running update is getting on. Polled by the overlay, because the
 * updater replaces this process and so cannot report through the job queue.
 * Deliberately cheap and unauthenticated-shaped: it reads one small file.
 */
route('GET', /^\/api\/system\/panel-update\/status$/, async (req, res) =>
    sendJson(res, 200, selfservice.updateProgress()));

route('POST', /^\/api\/system\/panel-update$/, async (req, res) => {
    const body = await readBody(req);
    try {
        const started = await selfservice.updatePanel({
            repo: String(body.repo || selfservice.STACK_REPO).trim(),
            ref: String(body.ref || 'main').trim(),
        });
        log(`panel update started in ${started.container}`);
        sendJson(res, 200, started);
    } catch (err) {
        fail(res, 400, err.message);
    }
});

route('POST', /^\/api\/system\/teardown$/, async (req, res) => {
    const body = await readBody(req);
    // Typed rather than clicked. This removes every app, its data and this
    // panel, and there is no undo anywhere in the flow.
    if (String(body.confirm || '') !== 'DELETE EVERYTHING') {
        return fail(res, 400, 'Type DELETE EVERYTHING to confirm.');
    }
    try {
        const started = await selfservice.teardown();
        log(`teardown started in ${started.container}; this panel is about to go away`);

        // The removal runs in a container of its own, because it has to delete
        // the image this panel is running from and docker will not remove an
        // image a running container is using. Its output is the only account of
        // what happened, so it is followed and republished as a job -- which is
        // what puts it on the overlay, right up until the step that removes
        // this panel and takes the log with it.
        const job = jobs.start('Remove everything', async (onLine) => {
            onLine('Removing everything this stack put on the machine. Docker itself is left installed.');
            onLine('This panel goes last, and its disappearing is what finishing looks like.');

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if ((await dockerctl.containerState(started.container)).exists) break;
                await new Promise((r) => setTimeout(r, 500));
            }

            await new Promise((resolve) => {
                const stop = dockerctl.streamLogs(started.container, onLine, { tail: 0 });
                // Nothing here resolves in the ordinary case: this container is
                // removed part-way through and the process ends with it. The
                // timeout is only so a teardown that somehow fails to reach us
                // does not leave a job running for the rest of the day.
                setTimeout(() => {
                    try {
                        stop();
                    } catch {
                        /* already gone */
                    }
                    resolve();
                }, 30 * 60_000).unref?.();
            });
        });

        sendJson(res, 202, { ...started, jobId: job.id });
    } catch (err) {
        fail(res, 400, err.message);
    }
});

// ------------------------------------------------------------------- tunnel --

/*
 * Public addresses go through a Cloudflare Tunnel; lib/tunnel.js has the why.
 * Connecting, publishing and the rest are jobs, so they get the queue and the
 * log like any other change: each one waits on Cloudflare and on a container.
 */
route('GET', /^\/api\/tunnel$/, async (req, res) => sendJson(res, 200, await tunnel.status()));

route('POST', /^\/api\/tunnel\/connect$/, async (req, res) => {
    const body = await readBody(req);
    const token = String(body.token ?? '').trim();
    if (!token) return fail(res, 400, 'Paste the API token from Cloudflare first.');
    const job = jobs.start('Connecting to Cloudflare', async (onLine) => {
        await tunnel.connect(token, onLine);
        // Anything already published gets told its address again: a reconnect
        // can be the first time a fresh install learns it.
        for (const key of ['nextcloud', 'jellyfin']) {
            if (tunnel.originFor(key)) await notifyPublished(key, new URL(tunnel.originFor(key)).hostname, onLine);
        }
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/tunnel\/routes$/, async (req, res) => {
    const body = await readBody(req);
    if (body.service === 'panel' && !authConfigured()) {
        return fail(res, 409, 'This panel has no admin password. Set one under Global settings before putting it on the internet: it holds the Docker socket, so an address without a password is the whole machine.');
    }
    // Checked before queueing, so a typo is an answer on the spot rather than a
    // job that fails a moment later.
    const zone = (loadManagerConfig().tunnel?.zones ?? []).find((z) => z.id === body.zoneId);
    if (!zone) return fail(res, 400, 'Pick one of your domains.');
    try {
        tunnel.hostnameFor(body.subdomain, zone);
        if (body.service === 'custom') tunnel.customOrigin(body.origin);
    } catch (err) {
        return fail(res, err.status ?? 400, err.message);
    }
    const service = tunnel.serviceFor(body.service);
    const job = jobs.start(`Publishing ${service?.label ?? body.service}`, async (onLine) => {
        const result = await tunnel.publish(body, onLine);
        await notifyPublished(result.service, result.hostname, onLine);
        return result;
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('DELETE', /^\/api\/tunnel\/routes\/([a-z0-9.-]+)$/, async (req, res, match) => {
    const hostname = match[1];
    const job = jobs.start(`Taking ${hostname} offline`, async (onLine) => {
        const route = await tunnel.unpublish(hostname, onLine);
        // The app's address moves to its next name, or goes; either way it is
        // told, so Nextcloud stops putting a dead name in its e-mails.
        if (['nextcloud', 'jellyfin'].includes(route.service)) await notifyPublished(route.service, null, onLine);
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/tunnel\/disconnect$/, async (req, res) => {
    const job = jobs.start('Disconnecting from Cloudflare', async (onLine) => {
        await tunnel.disconnect(onLine);
        for (const key of ['nextcloud', 'jellyfin']) await notifyPublished(key, null, onLine).catch(() => {});
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

/**
 * Retires the nginx container an older version of this panel ran.
 *
 * The compose file no longer has a proxy service, so nothing would ever stop
 * the old container: it would keep holding ports 80 and 443 (or whatever was
 * forwarded to them) with nobody managing it. Removed once, on the first start
 * of this version. Its configuration and certificates stay in the stack
 * directory -- nothing here deletes files that someone might want to look at.
 *
 * The old DuckDNS settings go from manager.json too: they can hold a token,
 * and a credential for a feature that no longer exists is just a credential.
 */
async function retireOldProxy() {
    const old = await dockerctl.containerState('quickstart-home-proxy').catch(() => ({ exists: false }));
    if (old.exists) {
        log('migration      : removing the old nginx proxy container; publishing now goes through a Cloudflare Tunnel');
        await dockerctl.docker(['rm', '-f', 'quickstart-home-proxy'], { timeoutMs: 60_000 }).catch((err) => {
            log(`migration      : could not remove it: ${err.message}`);
        });
    }
    const mgr = loadManagerConfig();
    if ('duckdns' in mgr || 'proxy' in mgr) {
        delete mgr.duckdns;
        delete mgr.proxy;
        saveManagerConfig(mgr);
        log('migration      : dropped the old DuckDNS and proxy settings');
    }
}

// ------------------------------------------------------------------- server --

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';

    if (!isApi) return serveStatic(req, res, url.pathname);

    const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!match) return fail(res, 404, 'Not found');

    if (match.auth && authRequired() && !isAuthenticated(req)) {
        return fail(res, 401, 'Not signed in.');
    }

    // Same-origin guard for state changes. The session cookie is SameSite=Strict
    // already; this closes the gap for clients that ignore that.
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) {
            let sameHost = false;
            try {
                sameHost = new URL(origin).host === req.headers.host;
            } catch {
                sameHost = false;
            }
            if (!sameHost) return fail(res, 403, 'Cross-origin request refused.');
        }
    }

    try {
        // What the button asked for, read once here rather than threaded through
        // every route: whether this job belongs on the Update Queue page instead
        // of the blocking overlay, what to call it there, and whether it is one
        // of the few that must run to the end once started.
        //
        // The title is percent-encoded by the client because a header is latin-1
        // and these are sentences; a malformed one is dropped rather than
        // failing the request, since the job matters more than its label.
        let title = null;
        try {
            title = decodeURIComponent(String(req.headers['x-qsh-queue-title'] || '')).slice(0, 120) || null;
        } catch {
            title = null;
        }
        const asked = {
            queued: req.headers['x-qsh-queue'] === '1',
            title,
            noCancel: req.headers['x-qsh-no-cancel'] === '1',
        };
        await requestContext.run(asked, () => match.handler(req, res, match.pattern.exec(url.pathname), url));
    } catch (err) {
        log('request failed', url.pathname, err);
        if (!res.headersSent) fail(res, 500, err.message || 'Internal error');
    }
});

// -------------------------------------------------------------------- boot ---

async function bootstrap() {
    ensureDirs();

    const appsCfg = apps.loadAppsConfig();
    apps.ensureSecrets();
    apps.writeAppsEnv(appsCfg);
    apps.renderAppsPortsOverride(appsCfg);

    log(`stack dir      : ${CONF_DIR}`);
    log(`panel version  : ${PANEL_VERSION}`);
    if (passwordUnusable()) {
        log('auth           : the stored password hash is unusable and no password will be accepted.');
        log('                 It was truncated by docker compose reading a $ in .env, which is fixed now.');
        log(`                 Clear ADMIN_PASSWORD_HASH in ${STACK_HOST}/.env, recreate this container, and set a new one.`);
    }
    if (authRequired()) {
        log('auth           : password required');
    } else {
        log(`auth           : NONE, and this panel is bound to ${managerBind()}.`);
        if (!isLoopbackBind()) {
            log('                 Anything on your network can drive the Docker daemon through it.');
            log('                 Set a password under Global settings now.');
        }
    }

    await retireOldProxy();

    // Queued rather than run directly, so a scheduled copy shares the one-at-a-
    // time queue with everything else and cannot start while an image is
    // building or a container is being recreated underneath it.
    // Resolved before the schedule is armed: without it a Nextcloud that keeps
    // its own files has no backup source and every tick does nothing.
    await backup.resolveDataVolume();
    backup.scheduleFromConfig(log, enqueueBackup);

    // A bind mount is resolved once, when the container starts. Unplug the
    // drive Jellyfin reads from and plug it back in and the host is looking at
    // the drive while Jellyfin is still holding the mount that went away --
    // reporting an empty library rather than an error. This notices and
    // restarts it.
    mountwatch.watch(log, () => jobs.busy);
}

bootstrap()
    .then(() => {
        server.listen(PORT, '0.0.0.0', () => log(`Quick Start Home listening on :${PORT}`));
    })
    .catch((err) => {
        console.error('failed to start', err);
        process.exit(1);
    });

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        log(`received ${signal}, shutting down`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
