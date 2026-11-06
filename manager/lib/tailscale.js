/*
 * Tailscale on this machine: how it is doing, the other devices on its
 * tailnet, and HTTPS addresses for the apps.
 *
 * Only this machine. Everything here goes through the daemon already running
 * on the host, the same way the `tailscale` command does, so there is no
 * Tailscale account token to make or keep. Settings that belong to the whole
 * tailnet -- who is on it, access rules, turning HTTPS certificates on -- stay
 * in Tailscale's admin console, and the panel links there rather than asking
 * for the keys to it.
 *
 * Both halves run in a throwaway container with the host's root mounted
 * read-only, like the drive list and the status probe in host.js:
 *
 *   reading  -- the local API on the daemon's socket, with curl. Nothing to
 *               install, and it answers even where the command is missing.
 *   changing -- the host's own `tailscale` command, pointed at that socket.
 *               It is a static binary, so it runs inside the panel's image,
 *               and it is always the version that matches the daemon. Writing
 *               the serve settings by hand would mean tracking a format that
 *               is Tailscale's to change.
 *
 * The socket is under /run, not /var/run: on the host one is a symlink to the
 * other, and inside the container that link points at the container's own.
 */

import { run } from './dockerctl.js';
import { loadAppsConfig } from './apps.js';
import { readEnvFile } from './store.js';

const SOCK = '/host/run/tailscale/tailscaled.sock';
const IMAGE = 'quickstart-home/manager:1';

/*
 * Which HTTPS port each app gets on this machine's Tailscale name.
 *
 * Nextcloud takes 443 so its address has no port in it -- that is the one
 * typed into file managers and phone apps. The rest get ports of their own,
 * not their usual ones: the usual ones already answer plain http over
 * Tailscale, and putting HTTPS on the same number would break every link and
 * bookmark that uses them.
 */
export const SERVE_APPS = [
    { key: 'nextcloud', label: 'Nextcloud', port: 443 },
    { key: 'jellyfin', label: 'Jellyfin', port: 8443 },
    { key: 'mealplan', label: 'Meal Plan', port: 8444 },
    { key: 'panel', label: 'This panel', port: 8445 },
];

let deps = { run };

/** Test seam: swap how commands are run. */
export function _setDeps(next) {
    deps = { ...deps, ...next };
}

/** Runs a shell script in a throwaway container that can see the host's files. */
function inHost(script, args = [], { timeoutMs = 30_000 } = {}) {
    return deps.run('docker', ['run', '--rm', '-v', '/:/host:ro', IMAGE, 'sh', '-c', script, 'sh', ...args], { timeoutMs });
}

const READ_SCRIPT = [
    `S=${SOCK}`,
    // Installed but stopped looks, from the socket alone, exactly like not
    // installed. The daemon's binary tells them apart.
    'D=0; for b in /host/usr/sbin/tailscaled /host/usr/bin/tailscaled /host/usr/local/bin/tailscaled; do [ -e "$b" ] && D=1; done',
    'echo "installed=$D"',
    '[ -S "$S" ] || exit 0',
    'echo "---status"',
    'curl -s --max-time 5 --unix-socket "$S" http://local-tailscaled.sock/localapi/v0/status',
    'echo',
    'echo "---serve"',
    'curl -s --max-time 5 --unix-socket "$S" http://local-tailscaled.sock/localapi/v0/serve-config',
    'echo',
].join('\n');

// Found where the official packages and the install script put it.
const CLI_SCRIPT = [
    `S=${SOCK}`,
    'for b in /host/usr/bin/tailscale /host/usr/local/bin/tailscale /host/usr/sbin/tailscale; do',
    '  if [ -x "$b" ]; then exec "$b" --socket="$S" "$@"; fi',
    'done',
    'echo "The tailscale command was not found on this machine." >&2',
    'exit 127',
].join('\n');

const cli = (args, opts) => inHost(CLI_SCRIPT, args, opts);

/** Splits the read script's output into its parts. */
export function parseProbe(stdout) {
    const text = String(stdout ?? '');
    const installed = /installed=1/.test(text);
    const part = (name) => {
        const m = text.split(`---${name}\n`)[1];
        if (m === undefined) return undefined;
        const body = m.split('\n---')[0].trim();
        if (!body) return null;
        try {
            return JSON.parse(body);
        } catch {
            return null;
        }
    };
    return { installed, status: part('status'), serve: part('serve') };
}

// Go's zero time, which is what LastSeen holds for a device that is online
// now or has never been seen.
const realTime = (t) => (t && !String(t).startsWith('0001-') ? t : null);

const firstLabel = (dnsName) => String(dnsName ?? '').replace(/\.$/, '').split('.')[0] || null;
const ipv4 = (ips = []) => ips.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? null;
const ipv6 = (ips = []) => ips.find((a) => a.includes(':')) ?? null;

function device(node, users, self = false) {
    const dnsName = String(node.DNSName ?? '').replace(/\.$/, '') || null;
    // The MagicDNS label is the name: it is what the device answers to, and
    // what the admin console shows. HostName is whatever the OS calls itself,
    // which on an iPhone is "localhost".
    const name = firstLabel(dnsName) || node.HostName || 'unknown';
    let connection = null;
    if (!self && node.Online) {
        if (node.CurAddr) connection = 'direct';
        else if (node.Relay) connection = `relayed (${node.Relay})`;
    }
    return {
        id: node.ID ?? node.PublicKey ?? name,
        name,
        hostName: node.HostName ?? null,
        dnsName,
        os: node.OS ?? null,
        ip: ipv4(node.TailscaleIPs),
        ipv6: ipv6(node.TailscaleIPs),
        online: self ? true : Boolean(node.Online),
        lastSeen: realTime(node.LastSeen),
        connection,
        owner: users?.[String(node.UserID)]?.LoginName ?? null,
        exitNode: Boolean(node.ExitNode),
        keyExpiry: realTime(node.KeyExpiry),
        self,
    };
}

/**
 * What Tailscale serves on each HTTPS port, read out of its serve settings:
 * { 443: { target: 'http://127.0.0.1:8081', funnel: false }, ... }.
 *
 * Only the simple case is understood -- one proxy at "/" -- because that is
 * all the panel makes. Anything else on a port is reported as there, with no
 * target, so the panel knows to leave it alone.
 */
export function servedPorts(serve, dnsName) {
    const out = {};
    if (!serve || typeof serve !== 'object') return out;
    for (const [hostPort, web] of Object.entries(serve.Web ?? {})) {
        const i = hostPort.lastIndexOf(':');
        const host = hostPort.slice(0, i);
        const port = Number(hostPort.slice(i + 1));
        // Serve settings can also hold Tailscale Services, under names other
        // than this machine's own. Those are not this machine's to show.
        if (dnsName && host !== dnsName) continue;
        const handlers = web?.Handlers ?? {};
        const paths = Object.keys(handlers);
        const root = handlers['/'];
        out[port] = {
            target: paths.length === 1 && root?.Proxy ? root.Proxy : null,
            other: paths.length !== 1 || !root?.Proxy,
            funnel: Boolean(serve.AllowFunnel?.[hostPort]),
        };
    }
    // A port forwarded as raw TCP is just as taken.
    for (const [port, tcp] of Object.entries(serve.TCP ?? {})) {
        if (!out[port] && !tcp?.HTTPS) out[Number(port)] = { target: null, other: true, funnel: false };
    }
    return out;
}

/** The local port each app is reachable on, or why it cannot be served. */
function appPorts() {
    const cfg = loadAppsConfig();
    const env = readEnvFile();
    const port = (key) => (cfg[key]?.publish?.web ? Number(cfg[key].hostPort) || null : null);
    return {
        nextcloud: port('nextcloud'),
        jellyfin: port('jellyfin'),
        mealplan: port('mealplan'),
        panel: Number(env.GUI_PORT) || 8420,
    };
}

const urlFor = (dnsName, port) => `https://${dnsName}${port === 443 ? '' : `:${port}`}`;

let cache = { at: 0, value: null };
const TTL_MS = 15_000;

export function forget() {
    cache = { at: 0, value: null };
}

/**
 * Everything the Tailscale tab shows, in one read.
 *
 * `installed`/`running` say which of the three starting points this is: not
 * on this machine, on it but signed out or stopped, or up.
 */
export async function status({ force = false } = {}) {
    if (!force && cache.value && Date.now() - cache.at < TTL_MS) return cache.value;

    let probe;
    try {
        const { stdout } = await inHost(READ_SCRIPT, [], { timeoutMs: 20_000 });
        probe = parseProbe(stdout);
    } catch (err) {
        return { installed: false, running: false, error: `Could not ask Tailscale: ${err.message}` };
    }

    const s = probe.status;
    const value = {
        installed: probe.installed || Boolean(s),
        running: s?.BackendState === 'Running',
        state: s?.BackendState ?? null,
        version: String(s?.Version ?? '').split('-')[0] || null,
        // Only set while it waits for somebody to sign in.
        authURL: s?.AuthURL || null,
    };
    if (!s?.Self) {
        cache = { at: Date.now(), value };
        return value;
    }

    const users = s.User ?? {};
    const self = device(s.Self, users, true);
    const tailnet = s.CurrentTailnet ?? {};
    value.self = self;
    value.account = users[String(s.Self.UserID)]?.LoginName ?? tailnet.Name ?? null;
    value.tailnet = tailnet.Name ?? null;
    value.magicDNS = Boolean(tailnet.MagicDNSEnabled);
    value.health = (s.Health ?? []).filter(Boolean);
    // CertDomains is filled in once HTTPS certificates are on for the tailnet,
    // which is a switch in the admin console and the one thing this cannot do.
    value.https = { enabled: Array.isArray(s.CertDomains) && s.CertDomains.length > 0, domain: s.CertDomains?.[0] ?? null };

    // Mullvad's exit nodes are peers too, once a device has the add-on: a few
    // hundred of them, one per city and server. They are locations to pick on
    // a phone, not devices of yours, so they are counted and not listed.
    const isMullvad = (p) => /\.mullvad\.ts\.net\.?$/.test(String(p.DNSName ?? ''));
    const peers = Object.values(s.Peer ?? {});
    value.mullvadLocations = peers.filter(isMullvad).length;
    value.devices = [
        self,
        ...peers
            .filter((p) => !isMullvad(p))
            .map((p) => device(p, users))
            .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    ];

    // This machine sending its own internet traffic through an exit node. On
    // a server that is almost never wanted: the Cloudflare connector, image
    // pulls and every app's outgoing traffic go out through it too.
    const exit = s.ExitNodeStatus;
    if (exit?.ID) {
        const node = peers.find((p) => p.ID === exit.ID);
        value.exitNode = {
            name: node ? (isMullvad(node) ? String(node.DNSName).split('.')[0] : device(node, users).name) : exit.ID,
            mullvad: Boolean(node && isMullvad(node)),
            online: Boolean(exit.Online),
        };
    }

    const served = servedPorts(probe.serve, self.dnsName);
    const ports = appPorts();
    value.serve = SERVE_APPS.map((app) => {
        const local = ports[app.key];
        const there = served[app.port];
        const target = local ? `http://127.0.0.1:${local}` : null;
        // Ours: one proxy to this machine's loopback, on the port this app is
        // given. Anything else on that port was set up by hand and stays.
        const ours = Boolean(there?.target?.startsWith('http://127.0.0.1:'));
        const entry = {
            key: app.key,
            label: app.label,
            port: app.port,
            localPort: local,
            on: ours,
            // Pointing at a port the app is no longer on, after it was moved.
            stale: ours && target !== null && there.target !== target,
            // On, but the app's network port has since been turned off, so
            // the address has nothing to reach.
            broken: ours && target === null,
            funnel: Boolean(there?.funnel),
            url: self.dnsName ? urlFor(self.dnsName, app.port) : null,
            blocked: null,
        };
        if (there && !ours) {
            entry.blocked = `Port ${app.port} is already used by something else set up with tailscale serve${there.target ? ` (${there.target})` : ''}. The panel leaves it alone.`;
        } else if (!local && !ours) {
            entry.blocked = `${app.label} is not on a port of this machine, so there is nothing to point HTTPS at. Turn on its network port in its settings first.`;
        }
        return entry;
    });

    cache = { at: Date.now(), value };
    return value;
}

class TailscaleError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const commandError = (err) =>
    String(err.stderr || err.stdout || err.message || '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-3)
        .join(' ');

/**
 * Turns HTTPS on for one app: https://<this machine>.<tailnet>.ts.net[:port]
 * goes to the app's port on this machine.
 *
 * Tailscale fetches and renews the certificate itself, and keeps the setting
 * across reboots. It adds X-Forwarded-Proto on the way through, which is how
 * Nextcloud -- trusting the docker gateway the request arrives from -- knows
 * to make https links rather than http ones.
 */
export async function serveOn(key, onLine = () => {}) {
    const st = await status({ force: true });
    if (!st.running) throw new TailscaleError('Tailscale is not running on this machine.', 409);
    if (!st.https?.enabled) {
        throw new TailscaleError('HTTPS certificates are not on for your tailnet yet. Turn them on in the admin console first (the steps are on this page).', 409);
    }
    const app = st.serve.find((a) => a.key === key);
    if (!app) throw new TailscaleError('There is no such app.', 404);
    if (app.blocked) throw new TailscaleError(app.blocked, 409);

    const target = `http://127.0.0.1:${app.localPort}`;
    onLine(`Serving ${target} at ${app.url}`);
    try {
        // --bg keeps it after this command exits, and across reboots. --yes so
        // it never stops to ask a question there is nobody here to answer.
        const { stdout } = await cli(['serve', '--bg', '--yes', `--https=${app.port}`, target], { timeoutMs: 60_000 });
        for (const line of String(stdout).split('\n').filter(Boolean)) onLine(line);
    } catch (err) {
        throw new TailscaleError(`Tailscale would not set that up: ${commandError(err)}`, 502);
    } finally {
        forget();
    }
    onLine(`${app.label} is at ${app.url}. The first visit can take a few seconds while Tailscale gets its certificate.`);
    return { url: app.url };
}

/** Turns it off again. Only ever removes a setting the panel would have made. */
export async function serveOff(key, onLine = () => {}) {
    const st = await status({ force: true });
    const app = st.serve?.find((a) => a.key === key);
    if (!app) throw new TailscaleError('There is no such app.', 404);
    if (!app.on) return { removed: false };
    onLine(`Removing ${app.url}`);
    try {
        await cli(['serve', '--yes', `--https=${app.port}`, 'off'], { timeoutMs: 60_000 });
    } catch (err) {
        throw new TailscaleError(`Tailscale would not remove it: ${commandError(err)}`, 502);
    } finally {
        forget();
    }
    return { removed: true };
}

/**
 * Re-points any HTTPS address still aimed at a port its app has moved off.
 * Called on the panel's periodic tick, so changing an app's port does not
 * leave its Tailscale address answering with an error.
 */
export async function reconcile(log = () => {}) {
    const st = await status({ force: true });
    if (!st.running || !st.https?.enabled) return;
    for (const app of st.serve ?? []) {
        if (!app.stale) continue;
        try {
            await cli(['serve', '--bg', '--yes', `--https=${app.port}`, `http://127.0.0.1:${app.localPort}`], { timeoutMs: 60_000 });
            log(`tailscale      : ${app.label} moved to port ${app.localPort}; its HTTPS address follows`);
        } catch (err) {
            log(`tailscale      : could not re-point ${app.label}: ${commandError(err)}`);
        }
    }
    forget();
}
