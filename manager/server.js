import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONF_DIR, DOMAINS_FILE, ensureDirs, PROXIES_FILE, STACK_HOST } from './lib/paths.js';
import {
    loadDomains,
    loadManagerConfig,
    loadProxies,
    readEnvFile,
    updateEnvFile,
    saveDomains,
    saveManagerConfig,
    saveProxies,
} from './lib/store.js';
import * as dockerctl from './lib/dockerctl.js';
import * as nginx from './lib/nginx.js';
import * as certbot from './lib/certbot.js';
import * as duckdns from './lib/duckdns.js';
import * as apps from './lib/apps.js';
import * as host from './lib/host.js';
import * as selfservice from './lib/selfservice.js';
import * as publish from './lib/publish.js';
import * as portcheck from './lib/portcheck.js';
import * as lifecycle from './lib/lifecycle.js';
import { jobs } from './lib/jobs.js';
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

/**
 * What the renderer needs to know about the world outside this machine.
 *
 * Only the ports so far, and only because a redirect has to name one: nginx
 * knows what it binds, but not what a router put in front of it.
 */
const renderOptions = () => ({ publicHttpsPort: loadManagerConfig().proxy.publicHttpsPort ?? 443 });

const proxyEnabled = () => loadManagerConfig().proxy.enabled === true;

/**
 * The DuckDNS credentials for a name, when it is one and the panel holds the
 * token.
 *
 * A DuckDNS name is exactly the case where DNS-01 is both possible and worth
 * preferring: it proves the name with a TXT record instead of an inbound
 * request, so it works on a network where port 80 already belongs to something
 * else, and it keeps working if that ever changes.
 */
function duckdnsFor(domain) {
    // The registered account, not the hostname: cloud.restohome.duckdns.org is
    // served by the account `restohome`, and that is the only name the update
    // API will accept.
    const account = duckdns.duckdnsAccount(domain);
    if (!account) return null;
    const token = loadManagerConfig().duckdns.token;
    return token ? { subdomain: account, token } : null;
}

/**
 * Renewal runs over every certificate at once, so it needs the credentials if
 * any of them was issued against a DuckDNS name. One token covers them all.
 */
const anyDuckdnsCredentials = () => {
    const dd = loadManagerConfig().duckdns;
    // Only the token is passed. The hook takes the name from certbot, so one
    // token covers every DuckDNS certificate on the account.
    return dd.token ? { subdomain: duckdns.normalizeDomains(dd.domains)[0] ?? '', token: dd.token } : null;
};

/** Where the panel's own port is published, which .env records. */
const managerBind = () => (readEnvFile().MANAGER_BIND || '0.0.0.0').trim();
const isLoopbackBind = () => ['127.0.0.1', '::1', 'localhost'].includes(managerBind());

async function applyProxyState(enabled, onLine = () => {}) {
    const mgr = loadManagerConfig();
    mgr.proxy.enabled = enabled;
    saveManagerConfig(mgr);

    if (!enabled) {
        onLine('Stopping the reverse proxy and releasing ports 80 and 443.');
        await dockerctl.compose(['rm', '-sf', 'proxy'], { onLine, profile: 'proxy', timeoutMs: 5 * 60_000 });
        return;
    }
    nginx.writeAll(loadProxies(), renderOptions());
    onLine('Starting the reverse proxy on ports 80 and 443.');
    await dockerctl.compose(['up', '-d', 'proxy'], { onLine, profile: 'proxy', timeoutMs: 5 * 60_000 });
}

/**
 * Brings an app in line with its saved config: writes what compose reads, then
 * builds and starts, or removes the containers when it is switched off.
 */
// The services built from a Dockerfile. The rest are stock images (databases,
// cache, previews) with nothing to build, and asking compose to build them is
// an error rather than a no-op.
const BUILDABLE_SERVICES = new Set(['nextcloud']);

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
}

async function applyAppConfig(name, cfg, onLine = () => {}) {
    const app = apps.APPS[name];
    const settings = cfg[name];

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
    if (key === 'jellyfin') {
        // Read at startup, so this takes effect when the container is next
        // recreated -- which switching it off and on does.
        updateEnvFile({ JELLYFIN_PUBLISHED_URL: `https://${domain}` });
        onLine(`Jellyfin will tell clients it lives at https://${domain}.`);
        return;
    }
    if (key !== 'nextcloud') return;
    const cfg = apps.loadAppsConfig();
    const names = new Set(String(cfg.nextcloud.trustedDomains || '').split(/[\s,]+/).filter(Boolean));
    if (names.has(domain)) return;

    names.add(domain);
    cfg.nextcloud.trustedDomains = [...names].join(' ');
    apps.saveAppsConfig(cfg);
    apps.writeAppsEnv(cfg);
    onLine(`Adding ${domain} to Nextcloud's trusted domains.`);

    // Only meaningful against a running container; a stopped one picks the
    // setting up the next time applyAppConfig runs.
    if ((await dockerctl.containerState(apps.APPS.nextcloud.container)).running) {
        await apps.syncTrustedDomains(dockerctl.docker, cfg, onLine).catch((err) => {
            onLine(`Could not update the trusted domains: ${err.message}`);
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
    const [snapshot, services] = await Promise.all([host.snapshot(), lifecycle.statusAll()]);
    sendJson(res, 200, {
        host: snapshot,
        services,
        proxy: { enabled: proxyEnabled() },
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

route('GET', /^\/api\/jobs\/stream$/, async (req, res) => {
    const { send, onClose } = sse(req, res);
    const snapshot = jobs.snapshot();
    if (snapshot) send('snapshot', snapshot);
    const onLine = (e) => send('line', e);
    const onStart = (job) => send('start', { id: job.id, name: job.name, pending: jobs.pending });
    const onEnd = (job) => send('end', { id: job.id, name: job.name, status: job.status, error: job.error, pending: jobs.pending });
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

/**
 * Stop a job. What it had already done stays done -- the overlay says so before
 * it asks -- and the next job in the queue starts as soon as this one lets go.
 */
route('POST', /^\/api\/jobs\/([a-z0-9-]+)\/cancel$/, async (req, res, match) => {
    const result = jobs.cancel(match[1]);
    if (!result.cancelled) return fail(res, 409, result.reason ?? 'That job cannot be cancelled.');
    sendJson(res, 202, { ok: true, ...result });
});

// ------------------------------------------------------------------ proxies --

route('GET', /^\/api\/proxies$/, async (req, res) => {
    const list = loadProxies().map((p) => ({
        ...p,
        auth: p.auth ? { ...p.auth, htpasswd: undefined, hasPassword: Boolean(p.auth.htpasswd) } : undefined,
        certificate: nginx.hasCertificate(p.domain),
    }));
    sendJson(res, 200, {
        proxies: list,
        targets: nginx.TARGET_KINDS,
        enabled: proxyEnabled(),
        container: await dockerctl.containerState(dockerctl.PROXY_CONTAINER),
    });
});

async function saveProxyList(list, onLine) {
    saveProxies(list);
    nginx.writeAll(list, renderOptions());
    // With the proxy off the files are still written, so switching it on later
    // brings up everything that was configured meanwhile.
    if (!proxyEnabled()) return;
    await nginx.reload();
    onLine?.('Reverse proxy reloaded.');
}

route('POST', /^\/api\/proxies$/, async (req, res) => {
    const body = await readBody(req);
    const list = loadProxies();
    const proxy = {
        enabled: true,
        websocket: true,
        allowlist: [],
        rateLimit: null,
        customSnippet: '',
        ...body.proxy,
        // Assigned after the spread so a client cannot choose its own id.
        id: nginx.newId(),
        domain: String(body.proxy?.domain || '').trim().toLowerCase(),
    };

    const errors = nginx.validateProxy(proxy, { existing: list, panelHasPassword: authConfigured() });
    if (errors.length) return fail(res, 400, 'The proxy host has problems.', { details: errors });

    nginx.storeBasicAuth(proxy);
    list.push(proxy);

    try {
        await saveProxyList(list);
    } catch (err) {
        // Roll back so a config nginx rejects never stays on disk.
        saveProxies(list.filter((p) => p.id !== proxy.id));
        nginx.writeAll(loadProxies(), renderOptions());
        return fail(res, 400, `nginx rejected the configuration: ${err.message}`);
    }
    sendJson(res, 201, { ok: true, proxy: { ...proxy, auth: undefined } });
});

route('PUT', /^\/api\/proxies\/([a-f0-9]{12})$/, async (req, res, match) => {
    const body = await readBody(req);
    const list = loadProxies();
    const index = list.findIndex((p) => p.id === match[1]);
    if (index < 0) return fail(res, 404, 'No such proxy host.');

    const previous = list[index];
    const proxy = {
        ...previous,
        ...body.proxy,
        id: previous.id,
        domain: String(body.proxy?.domain ?? previous.domain).trim().toLowerCase(),
        auth: { ...previous.auth, ...body.proxy?.auth },
    };

    const errors = nginx.validateProxy(proxy, { existing: list, panelHasPassword: authConfigured() });
    if (errors.length) return fail(res, 400, 'The proxy host has problems.', { details: errors });

    nginx.storeBasicAuth(proxy);
    list[index] = proxy;

    try {
        await saveProxyList(list);
    } catch (err) {
        list[index] = previous;
        saveProxies(list);
        nginx.writeAll(list, renderOptions());
        return fail(res, 400, `nginx rejected the configuration: ${err.message}`);
    }
    sendJson(res, 200, { ok: true, proxy: { ...proxy, auth: undefined } });
});

route('DELETE', /^\/api\/proxies\/([a-f0-9]{12})$/, async (req, res, match) => {
    const list = loadProxies();
    const next = list.filter((p) => p.id !== match[1]);
    if (next.length === list.length) return fail(res, 404, 'No such proxy host.');
    await saveProxyList(next);
    sendJson(res, 200, { ok: true });
});

route('POST', /^\/api\/proxies\/([a-f0-9]{12})\/certificate$/, async (req, res, match) => {
    const body = await readBody(req);
    const list = loadProxies();
    const proxy = list.find((p) => p.id === match[1]);
    if (!proxy) return fail(res, 404, 'No such proxy host.');

    const email = String(body.email || proxy.ssl?.email || '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, `"${email}" is not an e-mail address.`);
    // Let's Encrypt proves the domain by fetching a file over port 80, which
    // nginx serves. Without it running the request can only fail.
    if (!proxyEnabled()) {
        return fail(res, 409, 'Turn the reverse proxy on first.', {
            details: ['Certificates are issued by answering a request on port 80, which needs the proxy running.'],
        });
    }

    const job = jobs.start(`Issue certificate for ${proxy.domain}`, async (onLine) => {
        onLine(`Requesting a certificate for ${proxy.domain} from Let's Encrypt.`);
        onLine('This needs port 80 reachable from the internet for that domain.');
        await certbot.issue(proxy.domain, email, {
            staging: Boolean(body.staging),
            onLine,
            duckdns: duckdnsFor(proxy.domain),
        });

        const current = loadProxies();
        const target = current.find((p) => p.id === proxy.id);
        if (target) {
            target.ssl = { ...target.ssl, mode: 'letsencrypt', email, forceHttps: target.ssl?.forceHttps !== false };
            saveProxies(current);
            nginx.writeAll(current, renderOptions());
            await nginx.reload();
            onLine('HTTPS is now enabled for this host.');
        }
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/proxy\/enabled$/, async (req, res) => {
    const body = await readBody(req);
    const enabled = Boolean(body.enabled);
    if (enabled === proxyEnabled()) return sendJson(res, 200, { ok: true, unchanged: true });

    const job = jobs.start(enabled ? 'Start reverse proxy' : 'Stop reverse proxy', (onLine) =>
        applyProxyState(enabled, onLine),
    );
    sendJson(res, 202, { ok: true, jobId: job.id });
});

/**
 * The ports the outside world reaches this machine on, which a router decides
 * and nginx cannot know. Saved rather than detected: the check can tell you
 * whether a port arrives, but not which one a visitor should type.
 */
route('POST', /^\/api\/proxy\/ports$/, async (req, res) => {
    const body = await readBody(req);
    const port = (value, fallback) => {
        const n = Number(value);
        return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
    };

    const env = readEnvFile();
    const bindHttp = port(body.bindHttp, Number(env.HTTP_PORT) || 80);
    const bindHttps = port(body.bindHttps, Number(env.HTTPS_PORT) || 443);
    const guiPort = Number(env.GUI_PORT) || 8420;

    // Docker accepts the mapping and then fails to start the container, so the
    // clash is caught here where it can be explained.
    if (bindHttp === guiPort || bindHttps === guiPort) {
        return fail(res, 409, `Port ${guiPort} is this panel's own port, so the proxy cannot take it.`, {
            details: ['Move the panel first, under Global settings, or give the proxy a different port.'],
        });
    }
    if (bindHttp === bindHttps) return fail(res, 400, 'http and https cannot share one port on this machine.');

    const cfg = loadManagerConfig();
    cfg.proxy.publicHttpPort = port(body.http, 80);
    cfg.proxy.publicHttpsPort = port(body.https, 443);
    saveManagerConfig(cfg);

    const rebind = bindHttp !== (Number(env.HTTP_PORT) || 80) || bindHttps !== (Number(env.HTTPS_PORT) || 443);
    if (rebind) updateEnvFile({ HTTP_PORT: String(bindHttp), HTTPS_PORT: String(bindHttps) });

    // Redirects embed the https port, so every vhost is rewritten.
    nginx.writeAll(loadProxies(), renderOptions());

    if (rebind && proxyEnabled()) {
        // A published port is fixed when a container is created, so this is a
        // recreate rather than a reload. Only the proxy changes; every app keeps
        // running.
        const job = jobs.start(`Move the proxy to ports ${bindHttp} and ${bindHttps}`, async (onLine) => {
            onLine(`Recreating the reverse proxy on ports ${bindHttp} and ${bindHttps}.`);
            await dockerctl.compose(['up', '-d', '--force-recreate', 'proxy'], {
                onLine,
                profile: 'proxy',
                timeoutMs: 5 * 60_000,
            });
        });
        return sendJson(res, 202, {
            ok: true,
            jobId: job.id,
            http: cfg.proxy.publicHttpPort,
            https: cfg.proxy.publicHttpsPort,
            bindHttp,
            bindHttps,
        });
    }

    if (proxyEnabled()) await nginx.reload().catch(() => {});
    sendJson(res, 200, { ok: true, http: cfg.proxy.publicHttpPort, https: cfg.proxy.publicHttpsPort, bindHttp, bindHttps });
});

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

route('GET', /^\/api\/proxy\/portcheck$/, async (req, res) => {
    const domain = loadDomains()[0]?.domain ?? null;
    const mgr = loadManagerConfig().proxy;
    const env = readEnvFile();
    sendJson(
        res,
        200,
        await portcheck.check(domain, {
            httpPort: mgr.publicHttpPort ?? 80,
            httpsPort: mgr.publicHttpsPort ?? 443,
            bindHttp: Number(env.HTTP_PORT) || 80,
            bindHttps: Number(env.HTTPS_PORT) || 443,
            // A DuckDNS name proves itself with a TXT record, so nothing here
            // is required for a certificate -- only for serving.
            dnsChallenge: Boolean(domain && duckdnsFor(domain)),
        }),
    );
});

route('POST', /^\/api\/proxy\/reload$/, async (req, res) => {
    if (!proxyEnabled()) return fail(res, 409, 'The reverse proxy is switched off.');
    try {
        nginx.writeAll(loadProxies(), renderOptions());
        await nginx.reload();
        sendJson(res, 200, { ok: true, test: await nginx.testConfig() });
    } catch (err) {
        fail(res, 400, err.message);
    }
});

route('POST', /^\/api\/proxy\/renew$/, async (req, res) => {
    const job = jobs.start('Renew certificates', async (onLine) => {
        await certbot.renew({ onLine, duckdns: anyDuckdnsCredentials() });
        await nginx.reload();
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// ------------------------------------------------------- domains & publishing --

/**
 * The service-first view of the reverse proxy: what can be published, what it
 * is published on, and every domain available to publish it on.
 *
 * The proxy-host endpoints above still exist and still own the detail -- basic
 * auth, allowlists, custom snippets, certificates. This is the same data asked
 * a friendlier question.
 */
route('GET', /^\/api\/publish$/, async (req, res) => {
    const proxies = loadProxies();
    const env = readEnvFile();
    sendJson(res, 200, {
        services: publish.overview({ proxies, panelHasPassword: authConfigured() }),
        domains: loadDomains().map((d) => ({
            ...d,
            certificate: nginx.hasCertificate(d.domain),
            expiry: nginx.certificateExpiry(d.domain),
            // Which services are on this name, and where. A name carries
            // several, so the wizard shows what it would be joining.
            usedBy: proxies.find((p) => p.domain === d.domain && (p.path ?? '/') === '/')?.target?.kind ?? null,
            hosts: proxies
                .filter((p) => p.domain === d.domain)
                .map((p) => ({ kind: p.target?.kind ?? null, path: p.path ?? '/' })),
            rootFree: !proxies.some((p) => p.domain === d.domain && (p.path ?? '/') === '/'),
        })),
        enabled: proxyEnabled(),
        publicPorts: {
            http: loadManagerConfig().proxy.publicHttpPort ?? 80,
            https: loadManagerConfig().proxy.publicHttpsPort ?? 443,
            // What nginx binds here, which is what a router rule points at.
            bindHttp: Number(env.HTTP_PORT) || 80,
            bindHttps: Number(env.HTTPS_PORT) || 443,
            panel: Number(env.GUI_PORT) || 8420,
        },
        container: await dockerctl.containerState(dockerctl.PROXY_CONTAINER),
    });
});

route('POST', /^\/api\/domains$/, async (req, res) => {
    const body = await readBody(req);
    const { domain, error } = nginx.validateDomainName(body.domain);
    if (error) return fail(res, 400, error);

    const list = loadDomains();
    if (list.some((d) => d.domain === domain)) return fail(res, 400, `${domain} is already on the list.`);

    const mode = body.ssl?.mode === 'letsencrypt' ? 'letsencrypt' : 'none';
    const email = String(body.ssl?.email || '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, `"${email}" is not an e-mail address.`);

    const record = { id: nginx.newId(), domain, ssl: { mode, email }, addedAt: new Date().toISOString() };
    list.push(record);
    saveDomains(list);
    sendJson(res, 201, { ok: true, domain: record });
});

route('DELETE', /^\/api\/domains\/([a-f0-9]{12})$/, async (req, res, match) => {
    const list = loadDomains();
    const record = list.find((d) => d.id === match[1]);
    if (!record) return fail(res, 404, 'No such domain.');

    // Removing a name that something answers on would leave a vhost pointing at
    // a domain the panel no longer knows about, so the assignment goes first.
    const inUse = loadProxies().find((p) => p.domain === record.domain);
    if (inUse) {
        const service = publish.SERVICES.find((sv) => sv.kind === inUse.target?.kind);
        return fail(res, 409, `${record.domain} is still publishing ${service?.label ?? 'a proxy host'}.`, {
            details: ['Set that service back to "not published" first, then remove the domain.'],
        });
    }

    saveDomains(list.filter((d) => d.id !== record.id));
    sendJson(res, 200, { ok: true });
});

/**
 * Points a service at one of the stored domains, or at none of them.
 *
 * Everything here funnels into the same proxy-host list the advanced screen
 * edits, so a service published from this screen can be opened there and given
 * an allowlist or a password without any of it being a special case.
 */
route('POST', /^\/api\/publish\/([a-z]+)$/, async (req, res, match) => {
    const service = publish.serviceFor(match[1]);
    if (!service) return fail(res, 404, 'No such service.');

    const body = await readBody(req);
    const wanted = body.domain ? String(body.domain).trim().toLowerCase() : null;

    const list = loadProxies();
    const index = list.findIndex((p) => p.target?.kind === service.kind);

    if (!wanted) {
        if (index < 0) return sendJson(res, 200, { ok: true, unchanged: true });
        const [removed] = list.splice(index, 1);
        await saveProxyList(list);
        return sendJson(res, 200, { ok: true, domain: null, was: removed.domain });
    }

    const record = loadDomains().find((d) => d.domain === wanted);
    if (!record) return fail(res, 400, `${wanted} is not one of your domains.`, { details: ['Set it up from a service first.'] });

    // The domain owns the certificate settings: a certificate is issued for a
    // name, not for whatever happens to sit behind it this week.
    const ssl = { mode: record.ssl?.mode ?? 'none', email: record.ssl?.email ?? '' };
    try {
        const proxy = await attachDomain(service, wanted, ssl);
        await notifyPublished(service.key, wanted);
        sendJson(res, 200, { ok: true, domain: wanted, proxyId: proxy.id });
    } catch (err) {
        fail(res, 400, err.message, err.details ? { details: err.details } : undefined);
    }
});

/**
 * Attaches a domain to a service, creating the proxy host if there is not one.
 * Shared by the dropdown on the services page and by the setup wizard, so both
 * produce exactly the same proxy host.
 */
async function attachDomain(service, domain, ssl, extras = null) {
    const list = loadProxies();
    const index = list.findIndex((p) => p.target?.kind === service.kind);
    // Where it sits on that name depends on what is already there. Throws with
    // an explanation when the service can only live at a root that is taken.
    const { path } = publish.pathFor(service, domain, index >= 0 ? list.filter((_, i) => i !== index) : list);
    const proxy =
        index >= 0
            ? { ...list[index], domain, ssl, path }
            : {
                  path,
                  id: nginx.newId(),
                  enabled: true,
                  websocket: true,
                  allowlist: [],
                  rateLimit: null,
                  customSnippet: '',
                  auth: { enabled: false },
                  domain,
                  target: { kind: service.kind },
                  ssl,
              };

    // Basic auth and an allowlist used to be reachable only from the advanced
    // screen. They are the two protections worth offering at the moment someone
    // puts a service on the internet, so the wizard asks for them there and
    // passes them through here.
    if (extras) {
        if (extras.auth?.enabled) {
            proxy.auth = { enabled: true, user: extras.auth.user, password: extras.auth.password, htpasswd: proxy.auth?.htpasswd };
        } else if (extras.auth) {
            proxy.auth = { enabled: false };
        }
        if (Array.isArray(extras.allowlist)) proxy.allowlist = extras.allowlist.filter(Boolean);
    }

    const errors = nginx.validateProxy(proxy, { existing: list, panelHasPassword: authConfigured() });
    if (errors.length) {
        const err = new Error(`${service.label} cannot be published on ${domain}.`);
        err.details = errors;
        throw err;
    }

    nginx.storeBasicAuth(proxy);

    const previous = index >= 0 ? { ...list[index] } : null;
    if (index >= 0) list[index] = proxy;
    else list.push(proxy);

    try {
        await saveProxyList(list);
    } catch (cause) {
        // Roll back so a configuration nginx rejects never stays on disk.
        const rolled = loadProxies().filter((p) => p.id !== proxy.id);
        if (previous) rolled.push(previous);
        saveProxies(rolled);
        nginx.writeAll(rolled, renderOptions());
        throw new Error(`nginx rejected the configuration: ${cause.message}`);
    }
    return proxy;
}

// ----------------------------------------------------------- setup wizard --

route('GET', /^\/api\/setup\/([a-z]+)$/, async (req, res, match) => {
    const plan = publish.setupPlan(match[1], { panelHasPassword: authConfigured(), proxyOn: proxyEnabled() });
    if (!plan) return fail(res, 404, 'No such service.');

    const dd = loadManagerConfig().duckdns;
    sendJson(res, 200, {
        ...plan,
        duckdns: { subdomain: duckdns.normalizeDomains(dd.domains)[0] ?? '', hasToken: Boolean(dd.token) },
        publicIp: await duckdns.publicIp(),
    });
});

/**
 * The whole setup, done once: name, DNS, whatever the service needs switched
 * on, the vhost, and the certificate. Every step narrates itself into the job
 * console, because "it did not work" is unanswerable when the failure could
 * have been any one of six things.
 */
route('POST', /^\/api\/setup\/([a-z]+)$/, async (req, res, match) => {
    const key = match[1];
    const plan = publish.setupPlan(key, { panelHasPassword: authConfigured(), proxyOn: proxyEnabled() });
    if (!plan) return fail(res, 404, 'No such service.');
    if (plan.blocked) return fail(res, 409, plan.blocked);

    const body = await readBody(req);

    // Two ways in: a name that already exists on this panel, or a new DuckDNS
    // one to create. Only the second needs a token, and only the second touches
    // the DNS record.
    const existing = body.domain ? loadDomains().find((d) => d.domain === String(body.domain).trim().toLowerCase()) : null;
    if (body.domain && !existing) return fail(res, 400, `${body.domain} is not one of your domains.`);

    /*
     * The name as typed, which may carry subdomains in front of the registered
     * one: `restohome`, or `cloud.restohome`. DuckDNS answers for every label
     * beneath a name it holds, at no cost and with nothing to configure, so
     * giving each app its own hostname is better than sharing one on paths --
     * a subpath has to be understood by the app behind it, and a hostname does
     * not.
     *
     * Not run through normalizeDomains: that reduces a name to its account,
     * which is right for the refresh list and would silently drop the `cloud.`
     * from the hostname being published here.
     */
    const typed = existing
        ? null
        : String(body.subdomain || '')
              .trim()
              .toLowerCase()
              .replace(/\.duckdns\.org\.?$/, '')
              .replace(/^\.+|\.+$/g, '');
    // Up to three labels: the registered name plus a little room in front of
    // it. Each label is what DNS allows, and the whole thing has to end
    // somewhere sane rather than accept an arbitrary depth.
    const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    if (!existing && (!typed || !new RegExp(`^${LABEL}(?:\\.${LABEL}){0,2}$`).test(typed))) {
        return fail(res, 400, 'Enter the DuckDNS name you created, without the .duckdns.org. You can put a subdomain in front of it, as cloud.yourname.');
    }
    // What the API has to be told, which is only ever the registered name.
    const account = existing ? null : duckdns.duckdnsAccount(`${typed}.duckdns.org`);

    const storedToken = loadManagerConfig().duckdns.token;
    const token = String(body.token || '').trim();
    if (!existing && !token && !storedToken) return fail(res, 400, 'Enter your DuckDNS token.');

    // No contact address is asked for or required: the ACME account registers
    // without one, and the panel shows the expiry date itself.
    const email = String(body.email || existing?.ssl?.email || '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, `"${email}" is not an e-mail address.`);

    const extras = {
        auth: body.auth?.enabled
            ? { enabled: true, user: String(body.auth.user || '').trim(), password: String(body.auth.password || '') }
            : { enabled: false },
        allowlist: String(body.allowlist || '')
            .split(/[\s,]+/)
            .map((entry) => entry.trim())
            .filter(Boolean),
    };

    const domain = existing ? existing.domain : `${typed}.duckdns.org`;

    const job = jobs.start(`Publish ${plan.service.label} on ${domain}`, async (onLine) => {
        // --- the name -------------------------------------------------------
        if (existing) {
            onLine(`Using ${domain}, which is already on this panel.`);
        } else {
            onLine(`Saving ${domain} and telling DuckDNS where this machine is.`);
            const mgr = loadManagerConfig();
            // DuckDNS refreshes every name on the account in one call, so a
            // second service on a second name adds to the list rather than
            // replacing it.
            // The account, not the hostname. Refreshing `restohome` moves every
            // name beneath it, so publishing cloud. and media. of one account
            // adds nothing to this list the second time.
            const names = new Set(duckdns.normalizeDomains(mgr.duckdns.domains));
            names.add(account);
            mgr.duckdns.domains = [...names].join(',');
            if (account !== typed) onLine(`${domain} is a subdomain of ${account}.duckdns.org, which is the name DuckDNS refreshes.`);
            if (token) mgr.duckdns.token = token;
            mgr.duckdns.enabled = true;
            saveManagerConfig(mgr);
            duckdns.scheduleFromConfig(log);

            const update = await duckdns.update({ domains: mgr.duckdns.domains, token: token || storedToken });
            onLine(`DuckDNS: ${update.body.split('\n').join(' ').trim()}`);
        }

        // --- does the name actually arrive here -----------------------------
        const [resolved, publicIp] = await Promise.all([
            dns.resolve4(domain).catch(() => []),
            duckdns.publicIp(),
        ]);
        if (!resolved.length) {
            onLine(`${domain} does not resolve yet. DNS can take a minute; the certificate step will say if it is still not there.`);
        } else if (publicIp && !resolved.includes(publicIp)) {
            onLine(`Careful: ${domain} resolves to ${resolved.join(', ')} but this connection looks like ${publicIp}.`);
        } else {
            onLine(`${domain} resolves to ${resolved.join(', ')}.`);
        }

        // --- whatever this service needs before it can answer ---------------
        if (!proxyEnabled()) {
            onLine('Starting the reverse proxy, which serves every domain.');
            await applyProxyState(true, onLine);
        }

        if (apps.APPS[key]) {
            const appsCfg = apps.loadAppsConfig();
            if (!appsCfg[key]?.enabled) {
                onLine(`Switching ${apps.APPS[key].label} on. The first build can take a while.`);
                appsCfg[key].enabled = true;
                apps.saveAppsConfig(appsCfg);
                await applyAppConfig(key, appsCfg, onLine);
            }
        }

        // --- the name becomes one of ours, and the service answers on it ----
        const domains = loadDomains();
        const ssl = { mode: 'letsencrypt', email };
        // Not `existing`: that name belongs to the domain record this job was
        // started for, declared outside this closure. Shadowing it here put the
        // outer one in the temporal dead zone for the whole job, so the very
        // first line that read it threw before anything ran.
        const record = domains.find((d) => d.domain === domain);
        if (record) {
            record.ssl = ssl;
        } else {
            domains.push({ id: nginx.newId(), domain, ssl, addedAt: new Date().toISOString() });
        }
        saveDomains(domains);

        onLine(`Publishing ${plan.service.label} on ${domain}.`);
        if (extras.auth.enabled) onLine(`It will ask for a username and password (${extras.auth.user}).`);
        if (extras.allowlist.length) onLine(`Only these addresses will be let through: ${extras.allowlist.join(', ')}.`);
        await attachDomain(plan.service, domain, ssl, extras);
        // Nextcloud answers a name it was not told about with a blank refusal,
        // so being published and being trusted have to happen together.
        await notifyPublished(key, domain, onLine);

        // --- https ----------------------------------------------------------
        if (nginx.hasCertificate(domain)) {
            onLine(`${domain} already has a certificate, so it is left alone.`);
        } else {
            const viaDns = duckdnsFor(domain);
            onLine(
                viaDns
                    ? "Asking Let's Encrypt for a certificate, proving the name with a DuckDNS TXT record. This needs no open ports."
                    : "Asking Let's Encrypt for a certificate. This needs port 80 open from the internet.",
            );
            try {
                await certbot.issue(domain, email, { onLine, duckdns: viaDns, staging: Boolean(body.staging) });
            } catch (err) {
                // Everything else is done and the address works over http, so
                // this is the one outstanding step rather than a failed job.
                // certbot cannot say why a challenge failed, so say it here:
                // the answer is almost always the route in, and the checks
                // below are what distinguish that from a broken vhost.
                onLine('');
                onLine("Let's Encrypt could not verify the name, so there is no certificate yet.");

                const [reachable, resolvedNow, ip] = await Promise.all([
                    certbot.selfTest(domain),
                    dns.resolve4(domain).catch(() => []),
                    duckdns.publicIp(),
                ]);

                onLine(
                    reachable.ok
                        ? `  - This machine serves the challenge correctly: nginx answered for ${domain} over the internal network.`
                        : `  - This machine did not serve the challenge: ${reachable.error ?? 'nginx did not return it'}. That is the thing to fix first.`,
                );
                onLine(
                    resolvedNow.length
                        ? `  - ${domain} resolves to ${resolvedNow.join(', ')}${ip ? `, and this connection looks like ${ip} from outside` : ''}.`
                        : `  - ${domain} does not resolve yet. DNS can take a few minutes to spread.`,
                );
                if (reachable.ok && ip && resolvedNow.includes(ip)) {
                    onLine('  - So the name points here and this machine answers. What is missing is the route from the');
                    onLine('    internet to it: forward TCP port 80 (and 443) on your router to this machine, then press');
                    onLine('    "Retry HTTPS" on the service. Some ISPs block port 80 on home connections, which looks the same.');
                }

                onLine('');
                onLine(`${plan.service.label} is live on http://${domain} in the meantime.`);
                return { domain, url: `http://${domain}`, certificate: false };
            }
        }
        // The vhost is rendered without a 443 block until the certificate is on
        // disk, so it has to be written again now that it is.
        nginx.writeAll(loadProxies(), renderOptions());
        await nginx.reload();

        onLine(`Done. https://${domain} is live.`);
        return { domain, url: `https://${domain}`, certificate: true };
    });

    sendJson(res, 202, { ok: true, jobId: job.id, domain });
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
            blockers: apps.appBlockers(name, cfg),
            lastRun: apps.readLastRun(name),
        };
    }
    sendJson(res, 200, { config: cfg, apps: state });
});

route('PUT', /^\/api\/apps\/(nextcloud|jellyfin)$/, async (req, res, match) => {
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

route('GET', /^\/api\/apps\/(nextcloud|jellyfin)\/refs$/, async (req, res, match, url) => {
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

route('GET', /^\/api\/apps\/(nextcloud|jellyfin)\/check$/, async (req, res, match) => {
    const name = match[1];
    try {
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

route('POST', /^\/api\/apps\/(nextcloud|jellyfin)\/update$/, async (req, res, match) => {
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

route('POST', /^\/api\/apps\/(nextcloud|jellyfin)\/(start|stop|restart)$/, async (req, res, match) => {
    const [, name, action] = match;
    const app = apps.APPS[name];
    const job = jobs.start(`${action} ${app.label}`, async (onLine) => {
        const verb = action === 'start' ? ['up', '-d'] : [action];
        await dockerctl.compose([...verb, ...app.services], { onLine, profile: app.profile, timeoutMs: 10 * 60_000 });
        if (name === 'nextcloud' && action !== 'stop') await reconcileNextcloud(onLine);
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// ------------------------------------------------------------------ duckdns --

route('GET', /^\/api\/duckdns$/, async (req, res) => {
    const cfg = loadManagerConfig();
    sendJson(res, 200, {
        duckdns: {
            ...cfg.duckdns,
            token: cfg.duckdns.token ? '********' : '',
            // Derived, not read back: a config saved before refreshing became
            // automatic can hold enabled:false while both fields are filled in,
            // and the scheduler goes by the fields.
            enabled: duckdns.isConfigured(cfg.duckdns),
        },
        publicIp: await duckdns.publicIp(),
    });
});

route('PUT', /^\/api\/duckdns$/, async (req, res) => {
    const body = await readBody(req);
    const cfg = loadManagerConfig();
    const domains = duckdns.normalizeDomains(body.domains ?? cfg.duckdns.domains);

    for (const d of domains) {
        if (!/^[a-z0-9-]{1,63}$/.test(d)) return fail(res, 400, `"${d}" is not a valid DuckDNS subdomain.`);
    }

    cfg.duckdns.domains = domains.join(',');
    // An unchanged masked token must not overwrite the stored one.
    if (typeof body.token === 'string' && body.token && !/^\*+$/.test(body.token)) cfg.duckdns.token = body.token.trim();
    cfg.duckdns.intervalMinutes = Math.max(5, Number(body.intervalMinutes) || 5);

    // Refreshing is not opt-in -- filling both fields in is the decision. Half
    // a pair is a mistake worth naming, rather than a silent no-op to save.
    if (domains.length && !cfg.duckdns.token) return fail(res, 400, 'A DuckDNS token is required.');
    if (!domains.length && cfg.duckdns.token) return fail(res, 400, 'Enter at least one DuckDNS subdomain.');
    cfg.duckdns.enabled = duckdns.isConfigured(cfg.duckdns);

    saveManagerConfig(cfg);
    duckdns.scheduleFromConfig(log);
    sendJson(res, 200, { ok: true, domains: domains.map((d) => `${d}.duckdns.org`) });
});

route('POST', /^\/api\/duckdns\/update$/, async (req, res) => {
    try {
        sendJson(res, 200, await duckdns.update());
    } catch (err) {
        fail(res, 400, err.message);
    }
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
        const published = loadProxies().some((p) => p.target?.kind === 'manager');
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

        // The proxy keeps its own idea of being on, in its own file, and the
        // rest of the panel reads that rather than asking docker. Starting the
        // container without setting it leaves a proxy that is running and that
        // every screen still describes as off.
        if (key === 'proxy') {
            const mgr = loadManagerConfig();
            mgr.proxy.enabled = true;
            saveManagerConfig(mgr);
            nginx.writeAll(loadProxies(), renderOptions());
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
        if (key === 'proxy') {
            const mgr = loadManagerConfig();
            mgr.proxy.enabled = false;
            saveManagerConfig(mgr);
            onLine('The proxy is switched off. Your domains and certificates are untouched.');
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

// --------------------------------------------------------------- port check --

route('GET', /^\/api\/portcheck$/, async (req, res, match, url) => {
    const port = Number(url.searchParams.get('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(res, 400, 'Invalid port.');

    const ip = url.searchParams.get('ip') || (await duckdns.publicIp());
    if (!ip) return fail(res, 502, "Could not determine this machine's public IP address.");

    const open = await new Promise((resolve) => {
        const socket = net.connect({ host: ip, port, timeout: 5000 });
        const done = (result) => {
            socket.destroy();
            resolve(result);
        };
        socket.on('connect', () => done(true));
        socket.on('timeout', () => done(false));
        socket.on('error', () => done(false));
    });

    sendJson(res, 200, {
        ip,
        port,
        open,
        // Home routers often refuse to route a LAN host back to their own WAN
        // address, so a negative result here is not proof the port is shut.
        note: open
            ? 'Reachable from this machine using its public address.'
            : 'No answer. That usually means the port is closed, but if this machine is behind a home router it can also just mean the router will not loop a connection back to itself. Worth checking from another network before you change anything.',
    });
});

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
        await match.handler(req, res, match.pattern.exec(url.pathname), url);
    } catch (err) {
        log('request failed', url.pathname, err);
        if (!res.headersSent) fail(res, 500, err.message || 'Internal error');
    }
});

// -------------------------------------------------------------------- boot ---

async function bootstrap() {
    ensureDirs();

    if (!fs.existsSync(PROXIES_FILE)) saveProxies([]);
    // A domain used to exist only as a field on a proxy host. The services
    // screen needs domains as things in their own right, so an install that
    // predates the split gets its list built from the hosts it already has.
    if (!fs.existsSync(DOMAINS_FILE)) {
        const seeded = [];
        for (const proxy of loadProxies()) {
            if (seeded.some((d) => d.domain === proxy.domain)) continue;
            seeded.push({
                id: nginx.newId(),
                domain: proxy.domain,
                ssl: { mode: proxy.ssl?.mode ?? 'none', email: proxy.ssl?.email ?? '' },
                addedAt: new Date().toISOString(),
            });
        }
        saveDomains(seeded);
        if (seeded.length) log(`domains: adopted ${seeded.length} from existing proxy hosts`);
    }

    nginx.writeAll(loadProxies(), renderOptions());

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

    // Decide the proxy's state once, for installs that predate it being
    // optional: if it is already running or there are hosts configured, it was
    // wanted. Otherwise it stays off and leaves ports 80 and 443 alone.
    const mgr = loadManagerConfig();
    if (mgr.proxy.enabled === null) {
        const proxyState = await dockerctl.containerState(dockerctl.PROXY_CONTAINER);
        mgr.proxy.enabled = proxyState.running || loadProxies().length > 0;
        saveManagerConfig(mgr);
        log(`reverse proxy  : ${mgr.proxy.enabled ? 'on (already in use)' : 'off (nothing configured)'}`);
    }

    duckdns.scheduleFromConfig(log);

    // Certificates are valid for 90 days; a daily attempt is what certbot's own
    // packaging recommends and is a no-op until one is close to expiry.
    const renewTimer = setInterval(
        () => {
            if (jobs.busy) return;
            if (!loadProxies().some((p) => p.ssl?.mode === 'letsencrypt')) return;
            jobs.start('Automatic certificate renewal', async (onLine) => {
                await certbot.renew({ onLine, duckdns: anyDuckdnsCredentials() });
                await nginx.reload().catch(() => {});
            });
        },
        24 * 60 * 60 * 1000,
    );
    renewTimer.unref?.();
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
