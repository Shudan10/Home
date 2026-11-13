import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { COMPOSE_FILE, CONF_DIR, ensureDirs, STACK_HOST } from './lib/paths.js';
import { loadManagerConfig, readEnvFile, saveManagerConfig, updateEnvFile } from './lib/store.js';
import * as dockerctl from './lib/dockerctl.js';
import * as apps from './lib/apps.js';
import * as backup from './lib/backup.js';
import * as snapshots from './lib/snapshots.js';
import * as mountwatch from './lib/mountwatch.js';
import * as host from './lib/host.js';
import * as selfservice from './lib/selfservice.js';
import * as tunnel from './lib/tunnel.js';
import * as tailscale from './lib/tailscale.js';
import * as mullvad from './lib/mullvad.js';
import * as kachat from './lib/kachat.js';
import * as lifecycle from './lib/lifecycle.js';
import * as minecraft from './lib/minecraft.js';
import * as adguard from './lib/adguard.js';
import * as updates from './lib/updates.js';
import { jobs, requestContext } from './lib/jobs.js';
import {
    authConfigured,
    authRequired,
    clearCookie,
    hashPassword,
    passwordUnusable,
    isAuthenticated,
    issueSession,
    revokeSession,
    sessionCookie,
    sessionToken,
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
    // A named event rather than a comment: the page cannot see comments, and
    // it needs something regular to tell a quiet stream from a dead one.
    const keepAlive = setInterval(() => !res.writableEnded && res.write('event: ping\ndata: 0\n\n'), 20_000);
    const close = () => clearInterval(keepAlive);
    req.on('close', close);
    res.on('close', close);
    return { send, onClose: (fn) => req.on('close', fn) };
}

// ------------------------------------------------------------------ helpers --

/** Where the panel's own port is published, which .env records. */
const managerBind = () => (readEnvFile().MANAGER_BIND || '0.0.0.0').trim();
const isLoopbackBind = () => ['127.0.0.1', '::1', 'localhost'].includes(managerBind());

// The services built from a Dockerfile. The rest are stock images (databases,
// cache, previews, Jellyfin, Minecraft) with nothing to build, and asking
// compose to build them is an error rather than a no-op.
//
// This went missing in the move to the tunnel while both of its uses stayed,
// so Apply settings and Update failed on every app with a ReferenceError.
const BUILDABLE_SERVICES = new Set(['nextcloud', 'mealplan']);

/**
 * Notes when an app's image was built. Every app is built on, or pulled as, a
 * published image, so there is no commit to record: only the date is kept.
 */
async function recordBuild(name) {
    apps.writeBuildRecord(name, { sha: null, ref: null, builtAt: new Date().toISOString() });
}

/**
 * This machine's address on the home network, which AdGuard Home's DNS is
 * published on: every device is told to ask there. Saved with the app's
 * settings, so the override written at boot carries it too.
 */
async function refreshAdguardAddress(onLine = () => {}) {
    const ip = await host.lanAddress().catch(() => null);
    const cfg = apps.loadAppsConfig();
    if (!ip || cfg.adguard.dnsAddress === ip) return false;
    cfg.adguard.dnsAddress = ip;
    apps.saveAppsConfig(cfg);
    apps.renderAppsPortsOverride(cfg);
    onLine(`AdGuard Home will answer on ${ip}, this machine's address on the home network.`);
    return true;
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

/*
 * The names Nextcloud has to trust that are not typed by anybody: its public
 * name on the tunnel, this machine's Tailscale name and address, and the
 * machine's own address on a home network numbered 172.x (the default list
 * covers 192.168 and 10 with wildcards, and not that).
 *
 * Re-added every time Nextcloud starts rather than only when each appears.
 * Uninstalling puts the panel's Nextcloud settings back to their defaults, so
 * a reinstall began with none of them -- the tunnel name answered "untrusted
 * domain" until it was unpublished and published again, and the Tailscale
 * names never came back at all, because the check that adds them remembered
 * having done so already.
 */
async function wantedTrustedNames() {
    const names = [];
    const origin = publicOriginFor('nextcloud');
    if (origin) names.push(new URL(origin).hostname);
    const ts = await host.tailscale().catch(() => null);
    if (ts) names.push(ts.name, ts.ip);
    const lan = await host.lanAddress().catch(() => null);
    if (lan?.startsWith('172.')) names.push(lan);
    return names.filter(Boolean);
}

/**
 * The address Nextcloud puts in links it makes with no request to copy one
 * from -- e-mails, and anything a background job sends.
 *
 * The public name when there is one. Otherwise the Tailscale HTTPS address if
 * that is on for Nextcloud, which is the next most reachable thing, and then
 * this machine's address on the home network at Nextcloud's port. localhost is
 * the last resort only: in an e-mail it is a link to whatever device opens it.
 */
async function nextcloudCliUrl() {
    const origin = publicOriginFor('nextcloud');
    if (origin) return origin;
    const ts = await tailscale.status().catch(() => null);
    const served = ts?.serve?.find((a) => a.key === 'nextcloud');
    if (served?.on && !served.broken && served.url) return served.url;
    const cfg = apps.loadAppsConfig();
    const lan = await host.lanAddress().catch(() => null);
    if (lan && cfg.nextcloud.publish.web) {
        const port = Number(cfg.nextcloud.hostPort);
        return `http://${lan}${port === 80 ? '' : `:${port}`}`;
    }
    return null;
}

async function reconcileNextcloud(onLine = () => {}) {
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

    // Read after the wait, not before it: waiting can take minutes, and other
    // requests save settings in the meantime.
    const { cfg, added } = apps.addTrustedDomains(await wantedTrustedNames());
    if (added.length) onLine(`Adding ${added.join(', ')} to Nextcloud's trusted domains.`);
    // The timer that keeps Tailscale trusted pushes again on its next tick
    // rather than trusting a memory from before this (re)start.
    tailscaleTrusted = null;

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
        await apps.syncNextcloudUrls(dockerctl.docker, await nextcloudCliUrl(), onLine);
    } catch (err) {
        onLine(`Could not set the public address: ${err.message}`);
    }
    // Background jobs from the panel's timer rather than on page loads; see
    // runNextcloudCron below. Idempotent, so set on every start.
    try {
        await apps.setNextcloudCronMode(dockerctl.docker);
        nextcloudCron.modeSet = true;
    } catch (err) {
        onLine(`Could not switch background jobs to cron: ${err.message}`);
    }
}

/*
 * Applies what is saved for one app, as it is when the job runs.
 *
 * The settings are read here, at the start of the job, and not handed in from
 * the request that queued it. A job can wait behind a forty-minute build, and
 * a copy taken at the click is a copy of the settings as they were then: it
 * was saved back at the end, undoing every change made to the other apps --
 * or to this one -- while it waited. What is saved now is what was asked for
 * last, so that is what is applied.
 */
async function applyAppConfig(name, onLine = () => {}) {
    const app = apps.APPS[name];
    if (name === 'adguard') await refreshAdguardAddress(onLine);
    let cfg = apps.loadAppsConfig();

    // Which group owns each shared folder, so the container can be put in it.
    // Done here rather than in validation because it reads the filesystem, and
    // it has to happen before the override is written. Only that one field is
    // written back, to a copy read just now.
    if (name === 'nextcloud') {
        const gids = await apps.ownerGids(dockerctl.docker, cfg.nextcloud.sharedPaths ?? []);
        if (gids.length) {
            cfg = apps.loadAppsConfig();
            cfg.nextcloud.sharedGids = gids;
            apps.saveAppsConfig(cfg);
            onLine(`Shared folders are owned by group ${gids.join(', ')}; Nextcloud will run as a member.`);
        }
    }
    const settings = cfg[name];

    apps.ensureSecrets();
    apps.writeAppsEnv(cfg);
    apps.renderAppsPortsOverride(cfg);

    if (!settings.enabled) {
        onLine(`${app.label} disabled - removing its containers.`);
        await dockerctl.compose(['rm', '-sf', ...app.services], { onLine, profile: app.profile, timeoutMs: 10 * 60_000 });
        return { enabled: false };
    }

    /*
     * Minecraft's settings are saved, not started. Applying them recreates the
     * container, which is a restart that puts everybody out of the game -- fine
     * when it is running and they asked, and wrong when it is off: changing the
     * difficulty is not a request to switch the server on. A stopped one picks
     * the new settings up when its switch next starts it, which recreates it.
     */
    if (name === 'minecraft') {
        if (!(await dockerctl.containerState(app.container)).running) {
            onLine('Saved. Minecraft is stopped, so it uses these the next time it starts.');
            return { enabled: true };
        }
        onLine('Restarting Minecraft with the new settings. Players are disconnected for about a minute.');
        await minecraft.syncConsoleBridge(settings.consoles, onLine);
        // Forced: the console bridge is a file in the world volume, not part of
        // the container's configuration, so switching only it on or off would
        // otherwise leave compose with nothing to recreate.
        await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', ...app.services], {
            onLine,
            profile: app.profile,
            timeoutMs: 10 * 60_000,
        });
        onLine('Minecraft is starting with the new settings.');
        return { enabled: true };
    }

    // Turning the GPU on in Jellyfin's own settings, the first time the box is
    // ticked. Done before `up`, which starts it again if this had to stop it.
    if (name === 'jellyfin') {
        await apps.syncJellyfinHwaccel(dockerctl.docker, cfg, onLine).catch((err) => {
            onLine(`Could not switch Jellyfin's transcoding to the GPU: ${err.message}`);
        });
    }

    // Only the services that have something to build. An empty list is not a
    // no-op: `compose build` with no names builds every service that is
    // active, which includes this panel.
    const buildable = app.services.filter((sv) => BUILDABLE_SERVICES.has(sv));
    if (buildable.length) {
        onLine('Building images if needed...');
        await dockerctl.compose(['build', ...buildable], {
            onLine,
            profile: app.profile,
            timeoutMs: 120 * 60_000,
        });
    }

    onLine('Starting containers...');
    await dockerctl.compose(['up', '-d', ...app.services], { onLine, profile: app.profile, timeoutMs: 20 * 60_000 });

    await recordBuild(name);

    // Nextcloud reads its trusted domains only while installing, so a change
    // made later has to be applied to the running instance or it silently does
    // nothing. Failure here is worth reporting but not worth failing the job:
    // the container is up either way.
    if (name === 'nextcloud') await reconcileNextcloud(onLine);
    if (name === 'adguard') await adguard.ensureSetUp(onLine);

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

    // Its trusted name and the address its links carry follow the published
    // one. lib/kachat.js does it, in the KaChat Nextcloud only.
    if (key === 'kachat') {
        await kachat.applyPublicHost(onLine).catch((err) => onLine(`KaChat Nextcloud was not updated: ${err.message}`));
        return;
    }

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

    // No domain means a name was taken away rather than given: there is
    // nothing to trust, only the public address below to refresh. Without the
    // check this added the word "null" to Nextcloud's trusted domains.
    const { cfg, added } = apps.addTrustedDomains(domain ? [domain] : []);
    if (added.length) onLine(`Adding ${domain} to Nextcloud's trusted domains.`);

    // Only meaningful against a running container; a stopped one picks both of
    // these up the next time it starts, via reconcileNextcloud.
    if ((await dockerctl.containerState(apps.APPS.nextcloud.container)).running) {
        await apps.syncTrustedDomains(dockerctl.docker, cfg, onLine).catch((err) => {
            onLine(`Could not update the trusted domains: ${err.message}`);
        });
        await apps.syncNextcloudUrls(dockerctl.docker, origin ?? (await nextcloudCliUrl()), onLine).catch((err) => {
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

/*
 * Wrong passwords, counted.
 *
 * Half a second per wrong guess was the only brake, and a script that asks
 * twenty at a time does not notice half a second. On the house network that
 * is somebody's laptop; with the panel published, it is the internet. So each
 * client gets five wrong guesses in fifteen minutes and is then told to wait,
 * and all clients together get a larger allowance, so that a guesser spread
 * over many addresses is slowed down too. The second limit can lock the owner
 * out for a quarter of an hour during an attack, which is the trade: an
 * attacker who can cause that is one who would otherwise be guessing freely.
 *
 * "Client" is the address the request came from -- except through the tunnel,
 * where every request arrives from the connector container, and the visitor's
 * own address is in the CF-Connecting-IP header Cloudflare sets. That header
 * is believed only from the connector: from anywhere else it is just
 * something a client typed.
 */
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_PER_CLIENT = 5;
const LOGIN_GLOBAL = 50;
const loginFailures = new Map(); // client -> [timestamps]
let globalFailures = [];

const recent = (list, now = Date.now()) => list.filter((t) => now - t < LOGIN_WINDOW_MS);

let tunnelAddress = { at: 0, value: null };

/** The connector's address on the stack network, looked up by its name there. */
async function connectorAddress() {
    if (Date.now() - tunnelAddress.at < 60_000) return tunnelAddress.value;
    let value = null;
    try {
        value = (await dns.promises.lookup('tunnel', { family: 4 })).address;
    } catch {
        value = null;
    }
    tunnelAddress = { at: Date.now(), value };
    return value;
}

const plainAddress = (a) => String(a ?? '').replace(/^::ffff:/, '');

async function clientId(req) {
    const peer = plainAddress(req.socket.remoteAddress);
    const forwarded = String(req.headers['cf-connecting-ip'] ?? '').trim();
    if (forwarded && net.isIP(forwarded) && peer && peer === (await connectorAddress())) return forwarded;
    return peer || 'unknown';
}

function loginLimited(client) {
    const now = Date.now();
    globalFailures = recent(globalFailures, now);
    const mine = recent(loginFailures.get(client) ?? [], now);
    if (mine.length) loginFailures.set(client, mine);
    else loginFailures.delete(client);
    if (mine.length >= LOGIN_PER_CLIENT) {
        return { minutes: Math.ceil((LOGIN_WINDOW_MS - (now - mine[0])) / 60_000), everyone: false };
    }
    if (globalFailures.length >= LOGIN_GLOBAL) {
        return { minutes: Math.ceil((LOGIN_WINDOW_MS - (now - globalFailures[0])) / 60_000), everyone: true };
    }
    return null;
}

function recordLoginFailure(client) {
    const now = Date.now();
    const mine = [...recent(loginFailures.get(client) ?? [], now), now];
    loginFailures.set(client, mine);
    globalFailures = [...recent(globalFailures, now), now];
    // Bounded, so a flood from many addresses cannot grow this without end.
    if (loginFailures.size > 5000) loginFailures.delete(loginFailures.keys().next().value);
    // The address and the count, never what was typed.
    log(`login          : wrong password from ${client} (${mine.length} in the last 15 minutes, ${globalFailures.length} from everyone)`);
}

route(
    'POST',
    /^\/api\/login$/,
    async (req, res) => {
        const body = await readBody(req);
        if (!authRequired()) return sendJson(res, 200, { ok: true, required: false });
        const client = await clientId(req);
        const limited = loginLimited(client);
        if (limited) {
            const wait = `${limited.minutes} minute${limited.minutes === 1 ? '' : 's'}`;
            return fail(
                res,
                429,
                limited.everyone
                    ? `Too many wrong passwords have been tried on this panel recently, so signing in is paused for everyone. Try again in ${wait}.`
                    : `Too many wrong passwords from this device. Try again in ${wait}.`,
                { retryAfterMinutes: limited.minutes },
            );
        }
        if (!(await verifyPassword(String(body.password ?? '')))) {
            recordLoginFailure(client);
            // Constant-ish delay so the endpoint is not a fast password oracle.
            await new Promise((r) => setTimeout(r, 500));
            return fail(res, 401, 'Incorrect password.');
        }
        // A right password forgives this client's earlier typos.
        loginFailures.delete(client);
        const { token } = issueSession();
        const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure }) });
    },
    { auth: false },
);

// Ended here as well as in the browser, so a copy of the cookie stops working
// too. See revokeSession.
route(
    'POST',
    /^\/api\/logout$/,
    async (req, res) => {
        revokeSession(sessionToken(req));
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
    },
    { auth: false },
);

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

    const followers = new Map(); // name -> { stop, startedAt, exited }
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
            // Every tile starts empty again, so every log starts again too.
            // Only restarting the one that changed left the rest blank until
            // their containers next happened to print something.
            for (const name of [...followers.keys()]) detach(name);
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
            // A `docker logs` that ended while its container kept running is
            // picked up again, from new lines only: the tile already has the
            // rest. One for a stopped container ends by itself, and stays ended.
            const revive = follower?.exited && c.state.running;
            if (follower && follower.startedAt === c.state.startedAt && !revive) continue;
            detach(c.name);
            const entry = { startedAt: c.state.startedAt, exited: false };
            entry.stop = dockerctl.streamLogs(c.name, (line) => send('line', { key: c.key, line }), {
                tail: revive ? 0 : 60,
                onExit: () => {
                    entry.exited = true;
                },
            });
            followers.set(c.name, entry);
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
route('GET', /^\/api\/backup$/, async (req, res, match, url) => {
    // ?drives=0 skips the look for drives, which starts a container: a page
    // that only needs the settings and the last result should not pay for it.
    const drives = url.searchParams.get('drives') === '0' ? null : await backup.listDestinations();
    // The folders come from Nextcloud's shared folders, so the page shows what
    // will be copied rather than asking for it a second time.
    sendJson(res, 200, { config: backup.loadBackupConfig(), drives, sources: backup.backupSources() });
});

/** What the files mirror can leave out, read from the machine. A container, and du over every file. */
route('GET', /^\/api\/backup\/folders$/, async (req, res) => {
    try {
        sendJson(res, 200, { sources: await backup.listFolders(), excluded: backup.loadBackupConfig().excluded ?? [] });
    } catch (err) {
        sendJson(res, 200, { sources: [], error: err.message });
    }
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
        lastSkipped: prev.lastSkipped,
    });
    sendJson(res, 200, { ok: true, config: saved });
});

// ----------------------------------------------------------- app backups --

/*
 * The Backups page's other half: dated copies of each app's own data, made
 * nightly, and putting one back. See lib/snapshots.js.
 */
route('GET', /^\/api\/snapshots$/, async (req, res) => {
    sendJson(res, 200, await snapshots.status());
});

/** What is on the drive. Read from the drive, which takes a container. */
route('GET', /^\/api\/snapshots\/copies$/, async (req, res) => {
    try {
        sendJson(res, 200, { copies: await snapshots.listCopies() });
    } catch (err) {
        sendJson(res, 200, { copies: {}, error: err.message });
    }
});

/** One backup or restore log, as text. Names are checked against the folder's own pattern. */
route('GET', /^\/api\/snapshots\/logs\/([^/]+)$/, async (req, res, match) => {
    const text = snapshots.readLog(decodeURIComponent(match[1]));
    if (text === null) return fail(res, 404, 'There is no such log.');
    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
});

route('PUT', /^\/api\/snapshots$/, async (req, res) => {
    const { cfg, errors } = snapshots.validateSnapshotConfig((await readBody(req)) ?? {});
    if (errors.length) return fail(res, 400, errors[0], { details: errors });
    if (cfg.enabled && !backup.loadBackupConfig().destination) {
        return fail(res, 400, 'Pick a drive to back up to first.');
    }
    snapshots.saveSnapshotConfig(cfg);
    sendJson(res, 200, { ok: true, ...(await snapshots.status()) });
});

route('POST', /^\/api\/snapshots\/run$/, async (req, res) => {
    const body = (await readBody(req)) ?? {};
    const only = body.service ? String(body.service) : null;
    if (only && only !== snapshots.FILES_KEY && !snapshots.serviceFor(only)) return fail(res, 404, 'There is no such app to back up.');
    // Lets a mirror remove more than MAX_DELETES files this once: the button
    // the page shows after a run held them back. Nextcloud's files only.
    const allowDeletes = body.allowDeletes === true && only === snapshots.FILES_KEY;
    const job = enqueueSnapshots({ kind: 'manual', only, allowDeletes });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// After the kept number is lowered: the page has already listed what goes.
route('POST', /^\/api\/snapshots\/remove-extra$/, async (req, res) => {
    const job = jobs.start('Remove older backup copies', (onLine) => snapshots.removeExtraCopies({ onLine }), {
        key: 'snapshots:remove-extra',
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/snapshots\/restore$/, async (req, res) => {
    const body = (await readBody(req)) ?? {};
    const id = String(body.id ?? '');
    const service = snapshots.serviceFor(id.split('/')[0]);
    if (!service) return fail(res, 400, 'That is not a backup this panel made.');
    const job = jobs.start(`Restore ${service.label}`, (onLine) =>
        snapshots.restore({
            id,
            putBack: Boolean(body.putBack),
            saveFirst: body.saveFirst !== false,
            onLine,
            restartPanel: () => selfservice.restartManager(),
        }),
    // Keeps Nextcloud's cron and the other timers off the app while it is
    // stopped and being put back. Not cancellable: stopped half way, an app
    // would be left with part of its data replaced and part not.
    { app: service.key, noCancel: true });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// Keyed, so the nightly run asked for while a manual one waits is the same run.
function enqueueSnapshots({ kind, only = null, allowDeletes = false }) {
    const name = only === snapshots.FILES_KEY ? "Mirror Nextcloud's files" : only ? `Back up ${snapshots.serviceFor(only).label}` : 'Back up app data';
    return jobs.start(name, (onLine) => snapshots.backUp({ kind, only, allowDeletes, onLine }), {
        key: `snapshots:${only ?? 'all'}`,
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
/*
 * What else already has a port on this machine.
 *
 * Moving the panel onto a port something else holds does not fail when it is
 * asked for: the panel restarts, Docker cannot publish the port, and the
 * container that was the panel is gone with nothing in its place -- reachable
 * only from a terminal. So the move is refused up front, for anything this
 * stack publishes and for anything at all that is listening on the host.
 *
 * The apps are known from their settings, including the ones that are off
 * (their port is waiting for them). Everything else is read from the host's
 * own socket table, in a throwaway container on the host's network: that sees
 * every listener on the machine, whether Docker made it or not.
 */
async function portsInUse() {
    const taken = new Map();
    const cfg = apps.loadAppsConfig();
    const add = (port, what) => {
        const n = Number(port);
        if (Number.isInteger(n) && n > 0 && !taken.has(n)) taken.set(n, what);
    };
    for (const name of ['nextcloud', 'jellyfin', 'mealplan']) {
        if (cfg[name].publish?.web) add(cfg[name].hostPort, apps.APPS[name].label);
    }
    if (cfg.adguard.publish?.web) add(cfg.adguard.hostPort, "AdGuard Home's page");
    add(cfg.minecraft.javaPort, 'Minecraft (Java Edition)');
    add(cfg.minecraft.bedrockPort, 'Minecraft (Bedrock Edition)');

    for (const c of dockerctl.STACK_CONTAINERS) {
        if (c.name === dockerctl.MANAGER_CONTAINER) continue;
        for (const p of await dockerctl.publishedPorts(c.name)) {
            add(String(p.host ?? '').split(':').pop(), c.label);
        }
    }

    try {
        const { stdout } = await dockerctl.docker(
            ['run', '--rm', '--network', 'host', 'quickstart-home/manager:1', 'cat', '/proc/net/tcp', '/proc/net/tcp6'],
            { timeoutMs: 30_000 },
        );
        for (const line of stdout.split('\n')) {
            // "  sl  local_address rem_address   st ..." -- 0A is LISTEN.
            const cols = line.trim().split(/\s+/);
            if (cols[3] !== '0A') continue;
            add(parseInt(cols[1].split(':').pop(), 16), 'another program on this machine');
        }
    } catch (err) {
        log(`panel port     : could not read the host's listening ports: ${err.message}`);
    }
    return taken;
}

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
    const current = Number(env.GUI_PORT) || 8420;
    if (wanted === current) return sendJson(res, 200, { ok: true, unchanged: true });

    const taken = (await portsInUse()).get(wanted);
    if (taken) {
        return fail(res, 409, `Port ${wanted} is already used by ${taken}, so the panel cannot move there.`, {
            details: ['Pick another port. Moving onto a port that is taken would leave the panel unable to start.'],
        });
    }

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

route('PUT', /^\/api\/apps\/(nextcloud|jellyfin|mealplan|minecraft|adguard)$/, async (req, res, match) => {
    const name = match[1];
    const body = await readBody(req);

    // Validate the whole document so one app's edit cannot corrupt another's
    // stored settings, then apply only the app that was asked for.
    const current = apps.loadAppsConfig();
    const merged = { ...current, [name]: { ...current[name], ...(body.config ?? {}) } };
    // The admin account is fixed once Nextcloud has made it; see the validator.
    const installed = (await dockerctl.containerState(apps.APPS.nextcloud.container)).exists;
    const lockedAdminUser = installed ? readEnvFile().NEXTCLOUD_ADMIN_USER || current.nextcloud.adminUser : null;
    const { cfg, errors } = apps.validateAppsConfig(merged, { lockedAdminUser });
    if (errors.length) return fail(res, 400, 'The configuration has problems.', { details: errors });

    // Minecraft's apply only starts a server that is already running, so its
    // blockers -- the licence -- only matter then. Otherwise the box could not
    // be ticked and saved along with everything else on the same page.
    const blockers = apps.appBlockers(name, cfg);
    const starting = name !== 'minecraft' || (await dockerctl.containerState(apps.APPS.minecraft.container)).running;
    if (blockers.length && starting) {
        return fail(res, 409, `${apps.APPS[name].label} cannot start yet.`, { details: blockers });
    }

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
    const verb = name === 'minecraft' ? 'Apply settings to' : cfg[name].enabled ? 'Start' : 'Stop';
    // Keyed, so saving twice while the first is still waiting is one apply:
    // the job reads the saved settings when it runs, so the second save is
    // already in it and running it twice would only do the same work again.
    const job = jobs.start(`${verb} ${apps.APPS[name].label}`, async (onLine) => {
        const enabled = apps.loadAppsConfig()[name].enabled;
        // Remember how this turned out. The job itself only lives in memory, so
        // without a record on disk a failed build is indistinguishable from one
        // that is still running as soon as the manager restarts.
        apps.writeLastRun(name, { ok: null, error: null, enabled });

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
            const result = await applyAppConfig(name, capture);
            apps.writeLastRun(name, { ok: true, error: null, enabled });
            return result;
        } catch (err) {
            apps.writeLastRun(name, {
                ok: false,
                error: `${output.join('\n')}\n${err.message}`,
                enabled,
            });
            throw err;
        }
    }, { key: `apply:${name}`, app: name });
    sendJson(res, 202, { ok: true, jobId: job.id, config: cfg });
});

route('GET', /^\/api\/apps\/nextcloud\/admin$/, async (req, res) => {
    // The same value sitting in the stack's .env, behind the same password as
    // the rest of the panel. It is the only way to reach a fresh install.
    sendJson(res, 200, apps.nextcloudAdmin());
});

route('POST', /^\/api\/apps\/nextcloud\/admin\/password$/, async (req, res) => {
    const body = await readBody(req);
    const password = String(body.password ?? '');

    // Nextcloud's own minimum is 10 characters, and the stack's .env has to be
    // able to hold it. Checking here means a bad one is refused before the
    // container is touched, rather than after a failed occ run.
    const problem = apps.adminPasswordProblem(password);
    if (problem) return fail(res, 400, problem);

    const state = await dockerctl.containerState(apps.APPS.nextcloud.container);
    if (!state.running) return fail(res, 409, 'Nextcloud is not running, so its password cannot be changed yet.');

    try {
        await apps.setNextcloudAdminPassword(dockerctl.docker, password);
        sendJson(res, 200, { ok: true });
    } catch (err) {
        fail(res, err.status ?? 500, `Nextcloud refused the change: ${err.message}`);
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

    const job = jobs.start('Applying the Family Hub password', async (onLine) => {
        await lifecycle.setRunning('mealplan', true, onLine);
    }, { key: 'mealplan-password', app: 'mealplan' });
    sendJson(res, 202, { ok: true, jobId: job.id, restarting: true });
});

route('GET', /^\/api\/apps\/(nextcloud|jellyfin|mealplan|minecraft|adguard)\/check$/, async (req, res, match) => {
    try {
        sendJson(res, 200, await updates.checkApp(match[1]));
    } catch (err) {
        fail(res, 502, err.message);
    }
});

route('POST', /^\/api\/apps\/(nextcloud|jellyfin|mealplan|minecraft|adguard)\/update$/, async (req, res, match) => {
    const name = match[1];
    if (!apps.loadAppsConfig()[name].enabled) return fail(res, 409, `${apps.APPS[name].label} is switched off.`);

    const app = apps.APPS[name];
    const buildable = app.services.filter((sv) => BUILDABLE_SERVICES.has(sv));
    // The stock images an app is made of besides the one built here --
    // Nextcloud's database, cache and preview server. A rebuild with --pull
    // refreshes only the built image's base, so these used to stay on
    // whatever version they were first installed with, for good.
    const stock = app.services.filter((sv) => !BUILDABLE_SERVICES.has(sv));
    const job = jobs.start(`Update ${app.label}`, async (onLine) => {
        // Read when the job runs, not when it was asked for.
        const cfg = apps.loadAppsConfig();
        if (name === 'nextcloud') {
            // One major version at a time; see nextcloudTagFor.
            const { tag } = await apps.nextcloudTagFor(dockerctl.docker, onLine);
            if (!tag) return;
            if ((readEnvFile().NEXTCLOUD_TAG || 'stable') !== tag) updateEnvFile({ NEXTCLOUD_TAG: tag });
        }
        if (buildable.length) {
            if (stock.length) {
                onLine(`Downloading the newest ${stock.join(', ')} images...`);
                await dockerctl.compose(['pull', ...stock], {
                    onLine,
                    profile: app.profile,
                    timeoutMs: 60 * 60_000,
                });
            }
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
            if (name === 'minecraft') await minecraft.syncConsoleBridge(cfg.minecraft.consoles, onLine);
            await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', ...app.services], {
                onLine,
                profile: app.profile,
                timeoutMs: 20 * 60_000,
            });
            // Nextcloud upgrades its database as it starts on the new
            // version; the housekeeping that upgrade leaves for later is done
            // now, once it answers again, and then its settings are reapplied
            // as on any start.
            if (name === 'nextcloud') {
                if (await apps.waitForNextcloud(dockerctl.docker, {
                    timeoutMs: 20 * 60_000,
                    onWaiting: () => onLine('Waiting for Nextcloud to finish upgrading itself...'),
                })) {
                    await apps.nextcloudAfterUpdate(dockerctl.docker, onLine);
                } else {
                    onLine('Nextcloud did not come back in time for the database housekeeping; the next update does it.');
                }
                await reconcileNextcloud(onLine);
            }
        } else {
            // Recreated without starting, because a container keeps the image it
            // was made from. Left alone, this one would still be on the old image
            // and the app would go on reporting the update just installed.
            await dockerctl.compose(['create', '--force-recreate', ...app.services], {
                onLine,
                profile: app.profile,
                timeoutMs: 20 * 60_000,
            });
            onLine(`${app.label} is stopped, so it stays stopped. It runs the new image when you start it.`);
        }
        await recordBuild(name);
        await updates.rescan(name);
    }, { app: name });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/apps\/(nextcloud|jellyfin|mealplan|minecraft|adguard)\/(start|stop|restart)$/, async (req, res, match) => {
    const [, name, action] = match;
    const app = apps.APPS[name];
    if (action !== 'stop' && apps.appBlockers(name).length) {
        return fail(res, 409, `${app.label} cannot start yet.`, { details: apps.appBlockers(name) });
    }
    const job = jobs.start(`${action} ${app.label}`, async (onLine) => {
        if (name === 'jellyfin' && action !== 'stop') {
            await apps.syncJellyfinHwaccel(dockerctl.docker, apps.loadAppsConfig(), onLine).catch((err) => {
                onLine(`Could not switch Jellyfin's transcoding to the GPU: ${err.message}`);
            });
        }
        // A Minecraft restart is a recreate, because `restart` brings back the
        // container as it was created -- with the settings it had then, not
        // the ones saved since. It is also how Paper and Geyser get updated:
        // both are downloaded fresh as the server starts.
        const verb =
            action === 'start'
                ? ['up', '-d']
                : name === 'minecraft' && action === 'restart'
                  ? ['up', '-d', '--no-deps', '--force-recreate']
                  : [action];
        if (name === 'minecraft' && action !== 'stop') {
            await minecraft.syncConsoleBridge(apps.loadAppsConfig().minecraft.consoles, onLine);
        }
        await dockerctl.compose([...verb, ...app.services], { onLine, profile: app.profile, timeoutMs: 10 * 60_000 });
        if (name === 'nextcloud' && action !== 'stop') await reconcileNextcloud(onLine);
        if (name === 'adguard' && action !== 'stop') await adguard.ensureSetUp(onLine);
    }, { key: `power:${name}:${action}`, app: name });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// ---------------------------------------------------------------- adguard --

/*
 * The Home network page: AdGuard Home, controlled from here. Answered on the
 * spot rather than queued, like Minecraft's player lists -- each is one call to
 * AdGuard's own API, and "let the kids' tablet back on" should not wait behind
 * a rebuild. lib/adguard.js has the rest.
 */
function adguardRoute(method, re, fn) {
    route(method, re, async (req, res, match, url) => {
        if (!apps.loadAppsConfig().adguard.enabled) return fail(res, 409, 'AdGuard Home is not installed.');
        try {
            const body = method === 'GET' ? {} : ((await readBody(req)) ?? {});
            sendJson(res, 200, (await fn({ body, match, url })) ?? { ok: true });
        } catch (err) {
            const status = err instanceof adguard.AdGuardError ? err.status : 500;
            fail(res, status, err.message, err.details ? { details: err.details } : {});
        }
    });
}

adguardRoute('GET', /^\/api\/adguard\/overview$/, () => adguard.overview());
adguardRoute('POST', /^\/api\/adguard\/protection$/, ({ body }) =>
    adguard.setProtection({ enabled: body.enabled === true, minutes: Number(body.minutes) || 0 }),
);
adguardRoute('GET', /^\/api\/adguard\/devices$/, () => adguard.devices());
adguardRoute('GET', /^\/api\/adguard\/services$/, () => adguard.services());
adguardRoute('POST', /^\/api\/adguard\/devices$/, ({ body }) => adguard.saveDevice(body));
adguardRoute('POST', /^\/api\/adguard\/devices\/internet$/, async ({ body }) => {
    await adguard.setInternet(String(body.name ?? ''), body.off === true);
});
adguardRoute('POST', /^\/api\/adguard\/devices\/forget$/, async ({ body }) => {
    await adguard.forgetDevice(String(body.name ?? ''));
});
adguardRoute('GET', /^\/api\/adguard\/house$/, () => adguard.house());
adguardRoute('PUT', /^\/api\/adguard\/house$/, ({ body }) => adguard.setHouse(body));
adguardRoute('PUT', /^\/api\/adguard\/lists$/, async ({ body }) => {
    await adguard.setList({ url: String(body.url ?? ''), enabled: body.enabled === true });
});
adguardRoute('POST', /^\/api\/adguard\/lists$/, async ({ body }) => {
    await adguard.addList(body);
});
adguardRoute('POST', /^\/api\/adguard\/lists\/remove$/, async ({ body }) => {
    await adguard.removeList(String(body.url ?? ''));
});
adguardRoute('POST', /^\/api\/adguard\/lists\/refresh$/, () => adguard.refreshLists());
adguardRoute('POST', /^\/api\/adguard\/domains$/, ({ body }) =>
    adguard.setDomain({ domain: body.domain, list: body.list ?? null }),
);
adguardRoute('GET', /^\/api\/adguard\/check$/, ({ url }) => adguard.checkDomain(url.searchParams.get('domain') ?? ''));
adguardRoute('GET', /^\/api\/adguard\/activity$/, ({ url }) =>
    adguard.activity({
        search: url.searchParams.get('search') ?? '',
        blocked: url.searchParams.get('blocked') === '1',
        olderThan: url.searchParams.get('older') ?? '',
        limit: Number(url.searchParams.get('limit')) || 100,
    }),
);
// What the panel signs in to AdGuard's own page with, behind the panel's own
// password like Nextcloud's admin one -- and what the router should hand out.
adguardRoute('GET', /^\/api\/adguard\/account$/, async () => ({
    username: adguard.USERNAME,
    password: adguard.password(),
    dnsAddress: apps.loadAppsConfig().adguard.dnsAddress || null,
}));

// ---------------------------------------------------------------- minecraft --

/*
 * Who is on, who may join, who runs the server and who is banned. Answered on
 * the spot rather than queued: each is one console command or one small file,
 * and a queue entry for "let Sam in" would be more ceremony than the change.
 * lib/minecraft.js has why the server's own files are the record.
 */
route('GET', /^\/api\/apps\/minecraft\/players$/, async (req, res) => sendJson(res, 200, await minecraft.snapshot()));

route('POST', /^\/api\/apps\/minecraft\/players$/, async (req, res) => {
    const body = await readBody(req);
    try {
        const message = await minecraft.act(body ?? {}, apps.loadAppsConfig());
        sendJson(res, 200, { ok: true, message });
    } catch (err) {
        fail(res, err.status ?? 500, err.message);
    }
});

route('POST', /^\/api\/apps\/minecraft\/command$/, async (req, res) => {
    const body = await readBody(req);
    try {
        sendJson(res, 200, { ok: true, output: await minecraft.command(body.command) });
    } catch (err) {
        fail(res, err.status ?? 500, err.message);
    }
});

/*
 * Xbox, PlayStation and Switch: whether the bridge is signed in, and the code
 * to sign it in with when it is not. lib/minecraft.js has how it works.
 */
route('GET', /^\/api\/apps\/minecraft\/consoles$/, async (req, res) =>
    sendJson(res, 200, await minecraft.consoleStatus(apps.loadAppsConfig())));

/** Signs the bridge out, so the next start asks for an account again. */
route('POST', /^\/api\/apps\/minecraft\/consoles\/reset$/, async (req, res) => {
    try {
        await minecraft.resetConsoleAccount();
    } catch (err) {
        return fail(res, err.status ?? 500, err.message);
    }
    const app = apps.APPS.minecraft;
    if (!(await dockerctl.containerState(app.container)).running) return sendJson(res, 200, { ok: true, restarting: false });
    const job = jobs.start('Restart Minecraft to sign in again', async (onLine) => {
        await minecraft.syncConsoleBridge(apps.loadAppsConfig().minecraft.consoles, onLine);
        await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', ...app.services], {
            onLine,
            profile: app.profile,
            timeoutMs: 10 * 60_000,
        });
    }, { key: 'minecraft-console-reset', app: 'minecraft' });
    sendJson(res, 202, { ok: true, restarting: true, jobId: job.id });
});

/*
 * The worlds in the server's volume. Adding one is a job, since a world can be
 * gigabytes, and it only ever adds: nothing here can overwrite or delete one.
 */
route('GET', /^\/api\/apps\/minecraft\/worlds$/, async (req, res) => {
    try {
        sendJson(res, 200, await minecraft.listWorlds(apps.loadAppsConfig()));
    } catch (err) {
        fail(res, err.status ?? 500, err.message);
    }
});

// Before readBody on purpose: the body is the file, and it is not JSON.
route('POST', /^\/api\/apps\/minecraft\/worlds\/upload$/, async (req, res, match, url) => {
    let saved;
    try {
        saved = await minecraft.saveUpload(req);
    } catch (err) {
        if (res.destroyed) return;
        return fail(res, err.status ?? 500, err.message);
    }
    const suggestedName = url.searchParams.get('filename') ?? '';
    const job = jobs.start('Add a Minecraft world', async (onLine) => {
        try {
            return await minecraft.importWorld({ source: saved.source, suggestedName, onLine });
        } finally {
            fs.rmSync(saved.file, { force: true });
        }
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/apps\/minecraft\/worlds\/import$/, async (req, res) => {
    const body = await readBody(req);
    let source;
    try {
        source = minecraft.checkImportPath(body.path);
    } catch (err) {
        return fail(res, err.status ?? 400, err.message);
    }
    const job = jobs.start('Add a Minecraft world', async (onLine) =>
        minecraft.importWorld({ source, suggestedName: source, onLine }));
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/apps\/minecraft\/worlds\/switch$/, async (req, res) => {
    const body = await readBody(req);
    const cfg = apps.loadAppsConfig();
    const { worlds, running } = await minecraft.listWorlds(cfg);
    const target = worlds.find((w) => w.name === body.name);
    if (!target) return fail(res, 404, 'That world is not on this server.');
    if (target.current) return sendJson(res, 200, { ok: true, message: `${target.name} is already the world in use.` });

    // Only the world changes, on settings read at the moment it is applied.
    // The job can wait behind others, and saving the copy read above would put
    // back whatever else was changed in the meantime.
    const apply = () => {
        const fresh = apps.loadAppsConfig();
        fresh.minecraft.level = target.name;
        apps.saveAppsConfig(fresh);
        apps.writeAppsEnv(fresh);
        return fresh;
    };
    if (!running) {
        apply();
        return sendJson(res, 200, { ok: true, message: `Minecraft will play ${target.name} the next time it starts.` });
    }
    const app = apps.APPS.minecraft;
    const job = jobs.start(`Switch Minecraft to ${target.name}`, async (onLine) => {
        const fresh = apply();
        onLine(`Switching to ${target.name}. The current world is saved and kept.`);
        await minecraft.syncConsoleBridge(fresh.minecraft.consoles, onLine);
        await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', ...app.services], {
            onLine,
            profile: app.profile,
            timeoutMs: 10 * 60_000,
        });
    }, { app: 'minecraft' });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('GET', /^\/api\/apps\/minecraft\/public-address$/, async (req, res) => {
    try {
        sendJson(res, 200, { address: await minecraft.publicAddress() });
    } catch (err) {
        fail(res, err.status ?? 502, err.message);
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

    // Counted with the sign-in attempts: this is a password check too, and one
    // a stolen session could otherwise use to guess at the real one.
    const client = await clientId(req);
    if (authConfigured()) {
        const limited = loginLimited(client);
        if (limited) return fail(res, 429, `Too many wrong passwords. Try again in ${limited.minutes} minute${limited.minutes === 1 ? '' : 's'}.`);
        if (!(await verifyPassword(String(body.current || '')))) {
            recordLoginFailure(client);
            return fail(res, 403, 'That is not the current password.');
        }
    }

    if (body.clear) {
        if (!authConfigured()) return sendJson(res, 200, { ok: true, unchanged: true });
        // Removing the password is only sane while the panel is on loopback and
        // reachable no other way; anything else leaves the Docker socket open.
        // A custom tunnel route pointing back at the panel counts as publishing
        // it, and so does a Tailscale HTTPS address, which every device on the
        // tailnet can open.
        const names = tunnel.panelHostnames();
        if (names.length) {
            return fail(res, 409, `This panel is published at ${names.join(', ')}, so it cannot have its password removed.`, {
                details: ['Unpublish it first, or keep the password.'],
            });
        }
        const ts = await tailscale.status({ force: true }).catch(() => null);
        if (ts?.serve?.find((a) => a.key === 'panel')?.on) {
            return fail(res, 409, 'This panel has a Tailscale HTTPS address, so it cannot have its password removed.', {
                details: ['Turn that address off on the Tailscale page first, or keep the password.'],
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
        // Which Nextcloud to build: stable for a new one, and for one being
        // reinstalled over data it kept, no more than one major version past
        // what that data was last upgraded to. A leftover step from an earlier
        // update is not carried into a fresh install either.
        if (key === 'nextcloud') {
            const { tag } = await apps.nextcloudTagFor(dockerctl.docker, onLine);
            const want = tag ?? 'stable';
            if ((readEnvFile().NEXTCLOUD_TAG || 'stable') !== want) updateEnvFile({ NEXTCLOUD_TAG: want });
        }
        if (key === 'adguard') await refreshAdguardAddress(onLine);
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

        // Its database and admin passwords, before compose first reads them.
        if (key === 'kachat') kachat.ensureSecrets();

        await lifecycle.install(key, onLine);
        // Installing is what builds the image, so it is what has something to
        // record. Without this the Updates tab says "not built yet" about an
        // app that was just built.
        if (apps.APPS[key]) {
            await recordBuild(key);
            await updates.rescan(key);
        }
    }, { app: key });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/services\/([a-z-]+)\/(start|stop)$/, async (req, res, match) => {
    const unit = lifecycle.unitFor(match[1]);
    if (!unit) return fail(res, 404, 'No such service.');

    const running = match[2] === 'start';
    const state = await lifecycle.status(match[1]);
    if (!state.installed) return fail(res, 409, `${unit.label} is not installed yet.`);
    if (running && match[1] === 'adguard') await refreshAdguardAddress();
    // Said before anything is queued, so the switch springs back with the
    // reason rather than starting something that exits a second later.
    const blockers = running ? apps.appBlockers(match[1]) : [];
    if (blockers.length) return fail(res, 409, `${unit.label} cannot start yet.`, { details: blockers });

    const job = jobs.start(`${running ? 'Start' : 'Stop'} ${unit.label}`, async (onLine) => {
        // Placed before the server comes up, because Geyser only looks for
        // extensions while it is starting.
        if (running && match[1] === 'minecraft') {
            await minecraft.syncConsoleBridge(apps.loadAppsConfig().minecraft.consoles, onLine);
        }
        if (running && match[1] === 'jellyfin') {
            await apps.syncJellyfinHwaccel(dockerctl.docker, apps.loadAppsConfig(), onLine).catch((err) => {
                onLine(`Could not switch Jellyfin's transcoding to the GPU: ${err.message}`);
            });
        }
        await lifecycle.setRunning(match[1], running, onLine);
        // Settings that live inside the app rather than in compose have to be
        // reapplied to the container that has just come up.
        if (running && match[1] === 'nextcloud') await reconcileNextcloud(onLine);
        // The first start is also when it sets itself up and makes its account.
        if (running && match[1] === 'kachat') await kachat.afterStart(onLine);
        if (running && match[1] === 'adguard') await adguard.ensureSetUp(onLine);
    }, { key: `power:${match[1]}:${running ? 'start' : 'stop'}`, app: match[1] });
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

    // A name on the internet pointing at nothing is a broken link in every
    // chat it was sent in; it is taken off first, on purpose.
    if (key === 'kachat' && tunnel.originFor('kachat')) {
        return fail(res, 409, 'Take its name off the internet first, under Tunnel & domains.');
    }

    const keepData = body.keepData === true;
    const job = jobs.start(`Uninstall ${unit.label}`, async (onLine) => {
        const removed = await lifecycle.uninstall(key, { keepData, onLine });
        if (key === 'kachat') kachat.forget({ keepData }, onLine);
        updates.forget(key);

        // Back to how it looked before it was ever installed.
        const appsCfg = apps.loadAppsConfig();
        if (appsCfg[key]) {
            appsCfg[key] = structuredClone(apps.DEFAULT_APPS_CONFIG[key]);
            apps.saveAppsConfig(appsCfg);
            apps.writeAppsEnv(appsCfg);
            apps.renderAppsPortsOverride(appsCfg);
            onLine('Its settings are back to their defaults.');
        }
        // What the panel remembers having done to the old one does not hold
        // for the next: the names are pushed again, background jobs set to
        // cron again, the GPU switched on again.
        if (key === 'nextcloud') {
            tailscaleTrusted = null;
            nextcloudCron.modeSet = false;
            nextcloudCron.succeeded = false;
        }
        if (key === 'jellyfin') apps.clearJellyfinHwaccelMark();
        return removed;
    }, { app: key });
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
        sendJson(res, 200, await updates.checkPanel({ repo, ref }));
    } catch (err) {
        fail(res, 400, err.message);
    }
});

// What the background scan has found, for the banner along the top of the panel.
route('GET', /^\/api\/system\/updates$/, async (req, res) => {
    sendJson(res, 200, { items: await updates.pending() });
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

/*
 * What this install set up outside the machine, taken down before the machine
 * side goes.
 *
 * The teardown removes containers, images, volumes and files, and that is all
 * it can reach. The DNS records it made in Cloudflare, the device it added to
 * the Mullvad account, and the HTTPS addresses Tailscale is serving for it are
 * not on this machine, and they used to outlive it: public names that
 * resolved to a tunnel with nothing behind it, one of the account's five
 * Mullvad devices taken by a machine that was gone, and Tailscale still
 * answering on ports for apps that no longer existed.
 *
 * Best effort, each part on its own, with what happened said in the log. None
 * of it is allowed to stop the teardown: somebody removing everything wants it
 * removed, and a Cloudflare that is not answering is not a reason to leave it
 * all behind.
 */
async function cleanUpOutside(onLine) {
    if (tunnel.isConnected()) {
        onLine('Removing the public names from Cloudflare...');
        await tunnel.disconnect(onLine).catch((err) => onLine(`Could not disconnect from Cloudflare: ${err.message}. Remove the names under DNS in your Cloudflare account.`));
    }
    if (mullvad.isConnected()) {
        onLine('Removing the Mullvad exit node from your Mullvad account...');
        await mullvad.remove(onLine).catch((err) => onLine(`Could not remove the Mullvad exit node: ${err.message}`));
    }
    const ts = await tailscale.status({ force: true }).catch(() => null);
    for (const app of ts?.serve ?? []) {
        if (!app.on) continue;
        await tailscale
            .serveOff(app.key, onLine)
            .then(() => onLine(`Turned off Tailscale HTTPS for ${app.label}.`))
            .catch((err) => onLine(`Could not turn off Tailscale HTTPS for ${app.label}: ${err.message}`));
    }
}

route('POST', /^\/api\/system\/teardown$/, async (req, res) => {
    const body = await readBody(req);
    // Typed rather than clicked. This removes every app, its data and this
    // panel, and there is no undo anywhere in the flow.
    if (String(body.confirm || '') !== 'DELETE EVERYTHING') {
        return fail(res, 400, 'Type DELETE EVERYTHING to confirm.');
    }

    // A job from the start now, rather than a container launched by the
    // request: the cleanup outside the machine comes first and takes a while,
    // and the overlay is where it reports. The removal itself runs in a
    // container of its own, because it has to delete the image this panel is
    // running from and docker will not remove an image a running container is
    // using. Its output is the only account of what happened, so it is
    // followed and republished here -- right up until the step that removes
    // this panel and takes the log with it.
    const job = jobs.start('Remove everything', async (onLine) => {
        onLine('Removing everything this stack put on the machine. Docker itself is left installed.');
        await cleanUpOutside(onLine);

        const started = await selfservice.teardown();
        log(`teardown started in ${started.container}; this panel is about to go away`);
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

    sendJson(res, 202, { ok: true, jobId: job.id });
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
        for (const key of ['nextcloud', 'jellyfin', 'kachat']) {
            if (tunnel.originFor(key)) await notifyPublished(key, new URL(tunnel.originFor(key)).hostname, onLine);
        }
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/tunnel\/routes$/, async (req, res) => {
    const body = await readBody(req);
    // An answer on the spot rather than a queued job that fails. publish()
    // checks again, and that check is the one that matters. The origin goes
    // along so a custom address that is really this panel -- the manager by
    // name, or this machine on the panel's port -- needs a password the same
    // as the panel's own entry does.
    const blocked = tunnel.blockedReason(body.service, body.service === 'custom' ? body.origin : null);
    if (blocked) return fail(res, 409, blocked);
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
        if (['nextcloud', 'jellyfin', 'kachat'].includes(route.service)) await notifyPublished(route.service, null, onLine);
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/tunnel\/disconnect$/, async (req, res) => {
    const job = jobs.start('Disconnecting from Cloudflare', async (onLine) => {
        await tunnel.disconnect(onLine);
        for (const key of ['nextcloud', 'jellyfin', 'kachat']) await notifyPublished(key, null, onLine).catch(() => {});
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// ---------------------------------------------------------------- tailscale --

/*
 * This machine on Tailscale: its status, the tailnet's devices, and HTTPS
 * addresses for the apps. lib/tailscale.js has the why. Reading is cheap and
 * cached briefly; ?fresh skips the cache, for the Check again button.
 */
route('GET', /^\/api\/tailscale$/, async (req, res, match, url) =>
    sendJson(res, 200, await tailscale.status({ force: url.searchParams.has('fresh') })),
);

route('POST', /^\/api\/tailscale\/serve\/(nextcloud|jellyfin|mealplan|panel)$/, async (req, res, match) => {
    const key = match[1];
    const on = (await readBody(req)).on === true;
    // Every device on the tailnet can open a Tailscale HTTPS address, so the
    // panel gets one only with a password, the same as a public name.
    if (on && key === 'panel' && !authConfigured()) {
        return fail(res, 409, 'This panel has no admin password. Set one under Global settings before giving it a Tailscale address: it holds the Docker socket, so an address without a password is the whole machine.');
    }
    // Refused on the spot when it cannot work, rather than as a job that fails.
    if (on) {
        const st = await tailscale.status();
        if (!st.running) return fail(res, 409, 'Tailscale is not running on this machine.');
        if (!st.https?.enabled) return fail(res, 409, 'Turn on HTTPS certificates for your tailnet first.');
        const blocked = st.serve?.find((a) => a.key === key)?.blocked;
        if (blocked) return fail(res, 409, blocked);
    }
    const label = tailscale.SERVE_APPS.find((a) => a.key === key).label;
    const job = jobs.start(`${on ? 'Turning on' : 'Turning off'} Tailscale HTTPS for ${label}`, async (onLine) => {
        const result = on ? await tailscale.serveOn(key, onLine) : await tailscale.serveOff(key, onLine);
        // With no public name, Nextcloud's links in e-mails point at this
        // address when it exists, so they follow it on and off.
        if (key === 'nextcloud' && !publicOriginFor('nextcloud')) {
            if ((await dockerctl.containerState(apps.APPS.nextcloud.container)).running) {
                await apps.syncNextcloudUrls(dockerctl.docker, await nextcloudCliUrl(), onLine).catch((err) => {
                    onLine(`Could not update the address Nextcloud puts in e-mails: ${err.message}`);
                });
            }
        }
        return result;
    }, { key: `tailscale:${key}:${on ? 'on' : 'off'}`, app: key === 'nextcloud' ? 'nextcloud' : null });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

/*
 * The Mullvad exit node: lib/mullvad.js has the why. Setting up, moving city
 * and removing are jobs, since each waits on Mullvad and on a container.
 */
route('GET', /^\/api\/mullvad$/, async (req, res) => {
    const ts = await tailscale.status().catch(() => ({}));
    sendJson(res, 200, await mullvad.status(ts.devices ?? []));
});

route('GET', /^\/api\/mullvad\/locations$/, async (req, res) => {
    try {
        sendJson(res, 200, { locations: await mullvad.locations() });
    } catch (err) {
        fail(res, err.status ?? 502, err.message);
    }
});

route('POST', /^\/api\/mullvad\/connect$/, async (req, res) => {
    const body = await readBody(req);
    if (!String(body.account ?? '').replace(/\D/g, '')) return fail(res, 400, 'Type your Mullvad account number first.');
    if (!body.location) return fail(res, 400, 'Pick a city.');
    const job = jobs.start('Setting up the Mullvad exit node', (onLine) => mullvad.connect(body.account, body.location, onLine));
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/mullvad\/location$/, async (req, res) => {
    const body = await readBody(req);
    if (!mullvad.isConnected()) return fail(res, 409, 'Set it up first.');
    if (!body.location) return fail(res, 400, 'Pick a city.');
    const job = jobs.start('Moving the Mullvad exit node', (onLine) => mullvad.setLocation(body.location, onLine));
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/mullvad\/remove$/, async (req, res) => {
    const job = jobs.start('Removing the Mullvad exit node', (onLine) => mullvad.remove(onLine));
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// ------------------------------------------------------------- kachat ---

/*
 * KaChat Nextcloud: lib/kachat.js has the why. Installing, the switch and
 * uninstalling go through /api/services like every app; these are the rest,
 * answered on the spot -- an app password has to come back in the answer,
 * since it is shown once and never kept.
 */
const kachatTry = (fn) => async (req, res, match, url) => {
    try {
        const out = await fn(req, res, match, url);
        if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
        fail(res, err.status ?? 500, err.message);
    }
};

route('GET', /^\/api\/kachat$/, kachatTry(() => kachat.status()));

route('POST', /^\/api\/kachat\/accounts$/, kachatTry(async (req) => kachat.addAccount((await readBody(req)).username)));

route('DELETE', /^\/api\/kachat\/accounts\/([a-z0-9._-]+)$/, kachatTry((req, res, m) => kachat.removeAccount(m[1])));

route('PUT', /^\/api\/kachat\/accounts\/([a-z0-9._-]+)\/quota$/, kachatTry(async (req, res, m) => kachat.setQuota(m[1], (await readBody(req)).quota)));

route('POST', /^\/api\/kachat\/accounts\/([a-z0-9._-]+)\/app-passwords$/, kachatTry(async (req, res, m) => kachat.addAppPassword(m[1], (await readBody(req)).name)));

route('DELETE', /^\/api\/kachat\/accounts\/([a-z0-9._-]+)\/app-passwords\/(\d+)$/, kachatTry((req, res, m) => kachat.revokeAppPassword(m[1], m[2])));

route('GET', /^\/api\/kachat\/accounts\/([a-z0-9._-]+)\/shares$/, kachatTry(async (req, res, m) => ({ shares: await kachat.shares(m[1]) })));

route('DELETE', /^\/api\/kachat\/accounts\/([a-z0-9._-]+)\/shares\/(\d+)$/, kachatTry((req, res, m) => kachat.stopSharing(m[1], m[2])));

route('GET', /^\/api\/kachat\/accounts\/([a-z0-9._-]+)\/preview\/(\d+)$/, async (req, res, m) => {
    try {
        const img = await kachat.preview(m[1], m[2]);
        res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        res.end(img.body);
    } catch (err) {
        res.writeHead(err.status === 404 ? 404 : 502);
        res.end();
    }
});

route('GET', /^\/api\/kachat\/accounts\/([a-z0-9._-]+)\/files$/, kachatTry(async (req, res, m) => kachat.folder(m[1])));

// Always a download, never shown in the panel's page: a file an app put in
// the account is not something the panel's own origin should render.
route('GET', /^\/api\/kachat\/accounts\/([a-z0-9._-]+)\/file$/, async (req, res, m, url) => {
    let file;
    try {
        file = await kachat.download(m[1], url.searchParams.get('path'));
    } catch (err) {
        return fail(res, err.status ?? 500, err.message);
    }
    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        ...(file.length ? { 'Content-Length': file.length } : {}),
    });
    Readable.fromWeb(file.body).on('error', () => res.destroy()).pipe(res);
});

/**
 * Lets Nextcloud answer on this machine's Tailscale name and address.
 *
 * Nextcloud turns away any Host it has not been told about, with an "untrusted
 * domain" page, and it has never heard of a *.ts.net name or a 100.x address.
 * Everything else here already answers over Tailscale -- the apps listen on
 * every interface -- so this is the one thing needed for "over Tailscale" to
 * be true of Nextcloud as well.
 *
 * Checked at start and every five minutes, since Tailscale can be signed in to
 * at any time. Only ever adds: a name stays trusted after Tailscale goes, which
 * is harmless, rather than being removed while somebody's device is using it.
 */
let tailscaleTrusted = null;

async function trustTailscale() {
    // Another job may be rebuilding or reconfiguring Nextcloud; occ calls
    // underneath that would race it. The next tick picks this up.
    if (jobs.busy) return;
    const ts = await host.tailscale();
    if (!ts) return;
    const key = `${ts.name}|${ts.ip}`;
    if (key === tailscaleTrusted) return;

    const { cfg, added } = apps.addTrustedDomains([ts.name, ts.ip]);
    if (added.length) log(`tailscale      : trusting ${added.join(' and ')} in Nextcloud`);
    // Pushed into Nextcloud whether or not the list just changed: if the last
    // push failed, the names are already in the panel's list, and judging by
    // that alone would mean never trying again. A stopped Nextcloud picks the
    // list up when it next starts.
    if ((await dockerctl.containerState(apps.APPS.nextcloud.container)).running) {
        try {
            await apps.syncTrustedDomains(dockerctl.docker, cfg);
        } catch (err) {
            log(`tailscale      : could not update Nextcloud yet, will retry: ${err.message}`);
            return;
        }
    }
    tailscaleTrusted = key;
}

/*
 * Nextcloud's background jobs, run from here.
 *
 * Nextcloud has jobs it runs in the background -- expiring the trash and old
 * versions, sending notification e-mails, cleaning up file locks, generating
 * previews ahead of time -- and three ways to trigger them. Out of the box it
 * is "AJAX", which runs one job whenever somebody happens to have the web page
 * open, and on a home server that is nearly never: the admin overview then
 * reports that background jobs have not run for days, and the trash grows. The
 * official image has no cron inside it to do better.
 *
 * So the panel is the cron: every five minutes, the same `php cron.php` a
 * crontab would run, as the web user, in the running container. Skipped when
 * Nextcloud is not running or a job is working on it, and never two at once --
 * a slow run (a big preview backlog) simply makes the next tick a no-op.
 * Failures are logged; success only the first time, so the log says it works
 * without saying so 288 times a day.
 */
const nextcloudCron = { running: false, modeSet: false, succeeded: false };

async function runNextcloudCron() {
    if (nextcloudCron.running || jobs.touches('nextcloud')) return;
    if (!(await dockerctl.containerState(apps.APPS.nextcloud.container)).running) return;
    nextcloudCron.running = true;
    try {
        // Once per panel start (and after every start of Nextcloud, in
        // reconcileNextcloud): tells Nextcloud that cron is how its jobs run,
        // so it stops trying to run them on page loads as well.
        if (!nextcloudCron.modeSet) {
            await apps.setNextcloudCronMode(dockerctl.docker);
            nextcloudCron.modeSet = true;
        }
        await apps.runNextcloudCron(dockerctl.docker, { timeoutMs: 15 * 60_000 });
        if (!nextcloudCron.succeeded) log('nextcloud cron : background jobs ran; they run every five minutes from now on');
        nextcloudCron.succeeded = true;
    } catch (err) {
        log(`nextcloud cron : background jobs did not run: ${err.message.split('\n').slice(-3).join(' ')}`);
    } finally {
        nextcloudCron.running = false;
    }
}

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

/*
 * Moves Nextcloud's Redis off the volume it no longer has.
 *
 * Redis here is a cache and a lock table, and nothing in it needs to outlive a
 * restart, so the compose file now gives it a small tmpfs at /data and tells
 * it not to save. An install made before that has a container created with an
 * anonymous volume at /data -- which compose keeps reusing for as long as the
 * container exists, and which, once the container is replaced some other way,
 * becomes a volume with a random name that nobody knows to delete.
 *
 * So the old container is removed together with that volume (`rm -v` takes
 * only anonymous volumes, never a named one), and brought back the new way if
 * it was running. Only when the compose file on disk already says tmpfs:
 * a panel newer than its stack files would otherwise recreate it with the
 * volume again, on every start. Never while a job is running or waiting --
 * that could be a Nextcloud build that is about to start Redis itself -- and
 * retried until the queue is idle. Once done there is no volume to find, so
 * it does nothing on every start after.
 */
const REDIS_CONTAINER = 'quickstart-home-nextcloud-redis';

function composeWantsTmpfsRedis() {
    try {
        const text = fs.readFileSync(COMPOSE_FILE, 'utf8');
        const block = /^ {2}nextcloud-redis:\s*$([\s\S]*?)(?=^ {2}[A-Za-z0-9_-]+:\s*$|^\S)/m.exec(text)?.[1] ?? '';
        return /^\s{4}tmpfs:/m.test(block);
    } catch {
        return false;
    }
}

async function migrateRedisVolume(attempt = 0) {
    if (!composeWantsTmpfsRedis()) return;
    if (jobs.busy || jobs.pending.length) {
        // Deferred, not dropped: half a minute at a time, for up to a day.
        if (attempt < 2880) setTimeout(() => migrateRedisVolume(attempt + 1).catch(() => {}), 30_000).unref?.();
        return;
    }
    let mounts;
    try {
        ({ stdout: mounts } = await dockerctl.docker(
            ['inspect', '-f', '{{range .Mounts}}{{.Type}}|{{.Destination}}|{{.Name}}{{println}}{{end}}', REDIS_CONTAINER],
            { timeoutMs: 15_000 },
        ));
    } catch {
        return; // not installed
    }
    const old = mounts.split('\n').map((l) => l.trim().split('|')).find(([type, dest]) => type === 'volume' && dest === '/data');
    if (!old) return;

    const { running } = await dockerctl.containerState(REDIS_CONTAINER);
    log(`migration      : Nextcloud's Redis keeps its cache in memory now; removing its old volume ${old[2] || ''}`.trimEnd());
    try {
        await dockerctl.docker(['rm', '-fv', REDIS_CONTAINER], { timeoutMs: 60_000 });
        if (running) {
            await dockerctl.compose(['up', '-d', '--no-deps', 'nextcloud-redis'], { profile: 'nextcloud', timeoutMs: 5 * 60_000 });
            log('migration      : Redis is running again, on tmpfs');
        } else {
            log('migration      : Redis was stopped, so it is recreated the next time Nextcloud starts');
        }
    } catch (err) {
        log(`migration      : could not move Redis off its volume: ${err.message}`);
    }
}

// ------------------------------------------------------------------- server --

// Node gives a whole request five minutes by default, which an upload of a
// large world over Wi-Fi can outlast. headersTimeout stays at its default, so a
// client that never finishes sending its headers is still dropped.
const WHOLE_REQUEST_TIMEOUT_MS = 12 * 60 * 60_000;

/*
 * Which names the panel answers to while it has no password.
 *
 * DNS rebinding: a web page anywhere on the internet can make the browser
 * that opened it send requests to an address on the home network, by giving
 * its own name a second, private address. To the panel those requests are
 * ordinary same-origin ones -- they carry the attacker's name in Host, and
 * nothing else gives them away. With a password that gains the page nothing,
 * since it never has the session cookie. Without one it is the Docker socket,
 * from a web page, on a machine bound to 127.0.0.1 for safety.
 *
 * So with no password set, a request has to name the panel by something the
 * panel can recognise as its own: an IP address, localhost, a .local or
 * .ts.net name, this machine's hostname (on any local domain the router adds
 * to it), the manager's name on the stack network, or a name this install
 * published. PANEL_ALLOWED_HOSTS in .env adds more, space or comma separated,
 * for a name the router's DNS gives the machine that none of those cover.
 *
 * Not applied once there is a password. Then it would protect nothing the
 * cookie does not already, and would lock out whoever reaches the panel by a
 * name this list cannot know about.
 */
let machineName = os.hostname().toLowerCase();
host.hostname().then((n) => {
    if (n) machineName = String(n).toLowerCase();
}).catch(() => {});

function hostOnly(header) {
    const raw = String(header ?? '').trim().toLowerCase();
    if (!raw) return '';
    if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']') > 0 ? raw.indexOf(']') : undefined);
    return raw.replace(/:\d*$/, '').replace(/\.$/, '');
}

function hostAllowed(header) {
    const name = hostOnly(header);
    // HTTP/1.0 without a Host is not something a browser sends.
    if (!name) return true;
    if (net.isIP(name)) return true;
    if (name === 'localhost' || name.endsWith('.localhost')) return true;
    if (name.endsWith('.local') || name.endsWith('.ts.net')) return true;
    if (['manager', 'quickstart-home-manager', machineName, os.hostname().toLowerCase()].includes(name)) return true;
    if (machineName && name.split('.')[0] === machineName) return true;
    const extra = String(readEnvFile().PANEL_ALLOWED_HOSTS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    return [...tunnel.publishedHostnames(), ...extra].includes(name);
}

// The base for reading the path out of the request line. Never the Host
// header, which is the client's to fill in: an unparseable one used to throw
// straight out of the handler.
const URL_BASE = 'http://panel.invalid';

async function handle(req, res) {
    let url;
    try {
        url = new URL(req.url, URL_BASE);
        if (url.origin !== URL_BASE) throw new Error('absolute URL for another host');
    } catch {
        return fail(res, 400, 'That request could not be understood.');
    }

    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';

    if (!isApi) return serveStatic(req, res, url.pathname);

    const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!match) return fail(res, 404, 'Not found');

    if (!authConfigured() && url.pathname !== '/healthz' && !hostAllowed(req.headers.host)) {
        return fail(
            res,
            421,
            `This panel has no password, so it only answers to its own addresses, and "${hostOnly(req.headers.host).slice(0, 100)}" is not one of them. Open it by this machine's IP address or name, or set a password.`,
        );
    }

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
        // A refusal with a status of its own -- a value .env cannot hold, say
        // -- is the client's mistake and is answered as one.
        const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
        if (!res.headersSent) fail(res, status, err.message || 'Internal error');
    }
}

/*
 * Nothing a request does may take the process with it.
 *
 * The handler is async, so anything it threw outside the try above -- and
 * cookie parsing and URL parsing both used to -- became an unhandled
 * rejection, which Node answers by exiting. One malformed header from anything
 * on the network was enough to stop the panel, every running job with it.
 */
const server = http.createServer({ requestTimeout: WHOLE_REQUEST_TIMEOUT_MS }, (req, res) => {
    handle(req, res).catch((err) => {
        log('request crashed', String(req.url).slice(0, 200), err);
        try {
            if (!res.headersSent) fail(res, 500, 'Internal error');
            else res.destroy();
        } catch {
            /* the socket is already gone */
        }
    });
});

// A malformed request line or header is answered here, by Node, before any
// handler sees it. Logged once and closed rather than left to the default.
server.on('clientError', (err, socket) => {
    if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
});

/*
 * The last line of defence, for whatever escapes everything above.
 *
 * A rejection nobody handled is a bug in some job or timer, and it is logged
 * and survived: the state it leaves is that one operation's, and the queue
 * moves on. An exception is harder to call, because it can leave anything
 * half-done -- so one is logged and survived as well, but a run of them is
 * taken as the process being in a state it cannot get out of, and it exits.
 * Docker's restart policy then starts a clean one.
 */
process.on('unhandledRejection', (reason) => {
    log('unhandled rejection (kept running):', reason);
});

let recentCrashes = [];
process.on('uncaughtException', (err) => {
    const now = Date.now();
    recentCrashes = [...recentCrashes.filter((t) => now - t < 60_000), now];
    log('uncaught exception:', err);
    if (recentCrashes.length >= 10) {
        log('ten uncaught exceptions in a minute; exiting so Docker starts a fresh panel');
        process.exit(1);
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
    // In the background: it can wait for the job queue to empty.
    migrateRedisVolume().catch((err) => log(`migration      : Redis check failed: ${err.message}`));
    try {
        const migrated = apps.migrateTrustedDomains(loadManagerConfig, saveManagerConfig);
        if (migrated.changed) log(`migration      : removed ${migrated.removed.join(', ')} from Nextcloud's trusted domains`);
    } catch (err) {
        log(`migration      : could not tidy Nextcloud's trusted domains: ${err.message}`);
    }

    // A little after start, so it does not compete with everything else the
    // panel does as it comes up, then every five minutes.
    setTimeout(() => trustTailscale().catch(() => {}), 20_000).unref?.();
    setInterval(() => {
        trustTailscale().catch(() => {});
        // An app moved to another port takes its Tailscale HTTPS address along.
        if (!jobs.busy) tailscale.reconcile(log).catch(() => {});
    }, 5 * 60_000).unref?.();
    minecraft.clearUploads();

    // Nextcloud's background jobs: a minute after start, then every five.
    setTimeout(() => runNextcloudCron().catch(() => {}), 60_000).unref?.();
    setInterval(() => runNextcloudCron().catch(() => {}), 5 * 60_000).unref?.();
    // The KaChat Nextcloud's background jobs: expired shares, previews.
    setInterval(() => !jobs.busy && kachat.runCron().catch(() => {}), 5 * 60_000).unref?.();
    // What KaChat Nextcloud's starts apply, applied to one already running
    // without waiting for its next start: no Talk, and CORS for KaChat's site.
    setTimeout(() => !jobs.busy && kachat.reapply().catch(() => {}), 60_000).unref?.();

    // Queued rather than run directly, so the nightly copy shares the one-at-
    // a-time queue with everything else and cannot start while an image is
    // building or a container is being recreated underneath it. Nextcloud's
    // files are copied in the same run, straight after its database.
    // Resolved first: without it a Nextcloud that keeps its own files has no
    // files to copy.
    await backup.resolveDataVolume();
    // 3 in the morning here, not in UTC.
    await snapshots.adoptHostTimezone(log);
    snapshots.schedule(() => enqueueSnapshots({ kind: 'nightly' }), log);

    // A bind mount is resolved once, when the container starts. Unplug the
    // drive Jellyfin reads from and plug it back in and the host is looking at
    // the drive while Jellyfin is still holding the mount that went away --
    // reporting an empty library rather than an error. This notices and
    // restarts it.
    mountwatch.watch(log, () => jobs.busy);

    updates.start(log);

    // Bedtimes, and devices the router has moved to a new address.
    adguard.startScheduler(log, () => apps.loadAppsConfig().adguard.enabled);
}

bootstrap()
    .then(() => {
        // A port that cannot be had is not survivable, and is not an uncaught
        // exception to be shrugged off either: say so and stop.
        server.on('error', (err) => {
            console.error('cannot listen', err);
            process.exit(1);
        });
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
