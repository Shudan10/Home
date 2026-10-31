import crypto from 'node:crypto';
import * as cf from './cloudflare.js';
import * as dockerctl from './dockerctl.js';
import { APPS, loadAppsConfig } from './apps.js';
import { DEFAULT_MANAGER_CONFIG, loadManagerConfig, readEnvFile, saveManagerConfig, updateEnvFile } from './store.js';

/*
 * Public addresses, through a Cloudflare Tunnel.
 *
 * A small connector (cloudflared) runs beside the apps and dials out to
 * Cloudflare. Requests for a published name arrive down that connection and
 * the connector hands each one to the app it belongs to on the Docker network.
 * Nothing listens on the internet here: no forwarded ports, no router
 * settings, no certificates to renew -- Cloudflare serves HTTPS at its edge --
 * and it works behind a carrier that never gave this house an address of its
 * own. That is what makes it something a person can set up without first
 * learning what port forwarding is.
 *
 * It replaces DuckDNS, nginx and Let's Encrypt, which between them needed a
 * forwarded port, a token that kept the name pointed here, a proxy, and a
 * certificate that silently stopped renewing the day that token was lost.
 */

export const TUNNEL_CONTAINER = 'quickstart-home-tunnel';
const TUNNEL_PROFILE = 'tunnel';

// An app's address on the stack network, from its entry in APPS, so the two
// cannot drift apart.
const appOrigin = (key) => `http://${APPS[key].publish.hostname}:${APPS[key].publish.port}`;

/**
 * What can be published. The apps reach each other by the hostnames compose
 * gives them on the stack's network, so these work whether or not an app's
 * port is also published on the machine.
 */
export const SERVICES = [
    {
        key: 'nextcloud',
        label: 'Nextcloud',
        detail: 'Files, photos and calendars.',
        origin: appOrigin('nextcloud'),
        app: 'nextcloud',
        note: 'Web uploads larger than 100 MB in one piece are refused by Cloudflare on its free plan. The Nextcloud apps split uploads into smaller parts, so this mostly matters for very old clients.',
    },
    {
        key: 'jellyfin',
        label: 'Jellyfin',
        detail: 'Films, TV and music.',
        origin: appOrigin('jellyfin'),
        app: 'jellyfin',
        // Said before publishing rather than discovered afterwards.
        warning:
            "Cloudflare's terms limit serving a lot of video through its network on the free plan. Jellyfin through a tunnel works and is common, but streaming films is exactly what Cloudflare reserves the right to slow down or stop.",
    },
    {
        key: 'mealplan',
        label: 'Meal Plan',
        detail: 'What the family is eating this week.',
        origin: appOrigin('mealplan'),
        app: 'mealplan',
        note: 'Meal Plan has its own family password. On a phone, open the address and use Add to Home Screen.',
    },
    {
        key: 'panel',
        label: 'This control panel',
        detail: 'Everything on this page, from anywhere.',
        origin: 'http://manager:8080',
        warning:
            'This panel can run anything on this machine: it holds the Docker socket, which is root. On the internet its admin password is the only thing in the way, so make it a long one.',
    },
    {
        key: 'custom',
        label: 'Something else on your network',
        detail: 'Any web page this machine can reach, by its address and port.',
        origin: null,
    },
];

export const serviceFor = (key) => SERVICES.find((s) => s.key === key) ?? null;

// ------------------------------------------------------------------ state ---

const config = () => loadManagerConfig().tunnel ?? structuredClone(DEFAULT_MANAGER_CONFIG.tunnel);

function saveTunnel(next) {
    const cfg = loadManagerConfig();
    cfg.tunnel = next;
    saveManagerConfig(cfg);
}

const apiToken = () => (readEnvFile().CLOUDFLARE_API_TOKEN || '').trim();

export const isConnected = () => Boolean(config().tunnelId && apiToken());

/** The address a service answers on, or null. The first route wins if it has several. */
export function originFor(serviceKey) {
    const route = config().routes.find((r) => r.service === serviceKey);
    return route ? `https://${route.hostname}` : null;
}

// ------------------------------------------------------------- validation ---

// One DNS label. Cloudflare's free certificate covers example.com and
// *.example.com, and nothing deeper: a.b.example.com would be published and
// then refuse every HTTPS connection until a paid certificate was bought for
// it. Refusing the dot here is cheaper than explaining that afterwards.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function hostnameFor(subdomain, zone) {
    const sub = String(subdomain ?? '').trim().toLowerCase().replace(/\.+$/, '');
    if (!sub || sub === '@') return zone.name;
    if (sub.includes('.')) {
        throw Object.assign(new Error(`Use one word in front of ${zone.name}, like "meals". A name with more dots than that needs a paid Cloudflare certificate before HTTPS works on it.`), { status: 400 });
    }
    if (!LABEL.test(sub)) {
        throw Object.assign(new Error('A name can only use letters, numbers and dashes, and cannot start or end with a dash.'), { status: 400 });
    }
    return `${sub}.${zone.name}`;
}

/**
 * Checks the address of a "something else" service.
 *
 * Only scheme, host and port: Cloudflare routes a whole hostname to a service
 * and cannot add a path. And never localhost, because inside the connector's
 * container that means the connector itself.
 */
export function customOrigin(raw) {
    let url;
    try {
        url = new URL(String(raw ?? '').trim());
    } catch {
        throw Object.assign(new Error('Enter the address the way you would open it in a browser at home, like http://192.168.1.20:8123.'), { status: 400 });
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('The address has to start with http:// or https://.'), { status: 400 });
    if (url.pathname !== '/' || url.search || url.hash) {
        throw Object.assign(new Error('Leave the path off: a public name always opens at the top of the site, so enter just the address and port.'), { status: 400 });
    }
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw Object.assign(new Error("Use this machine's network address, like 192.168.1.20, not localhost. The tunnel runs in its own container, where localhost is the tunnel itself."), { status: 400 });
    }
    return `${url.protocol}//${url.host}`;
}

// ------------------------------------------------------------ the connector --

const deps = { compose: dockerctl.compose, containerState: dockerctl.containerState };
/** Test seam: lets the tests run this without touching real containers. */
export function _setDeps(next) {
    Object.assign(deps, next);
}

async function startConnector(onLine) {
    // Recreated rather than restarted: the run token reaches the connector as
    // an environment variable, and a container's environment is fixed when it
    // is created.
    await deps.compose(['up', '-d', '--force-recreate', 'tunnel'], { onLine, profile: TUNNEL_PROFILE, timeoutMs: 5 * 60_000 });
}

async function removeConnector(onLine) {
    await deps.compose(['rm', '--stop', '--force', 'tunnel'], { onLine, profile: TUNNEL_PROFILE, timeoutMs: 2 * 60_000 }).catch(() => {});
}

function ingressFor(routes) {
    return routes.map((r) => ({
        hostname: r.hostname,
        service: r.origin,
        // Devices at home with their own HTTPS almost always have a
        // certificate they made themselves, which the connector would refuse.
        // The hop being trusted here is the one inside this house.
        originRequest: r.origin.startsWith('https://') ? { noTLSVerify: true } : {},
    }));
}

async function waitForHealthy(token, t, onLine) {
    for (let i = 0; i < 15; i++) {
        const s = await cf.tunnelStatus(token, t.accountId, t.tunnelId).catch(() => null);
        if (s?.status === 'healthy') {
            onLine(`The tunnel is up, with ${s.connections} connection${s.connections === 1 ? '' : 's'} to Cloudflare.`);
            return true;
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
    onLine('The connector started, but Cloudflare has not reported the tunnel as healthy yet. Give it a minute; the status on this page will catch up.');
    return false;
}

// ------------------------------------------------------------- operations ---

/**
 * Connects this install to a Cloudflare account, given an API token.
 *
 * Every step is safe to repeat: the tunnel is found by name before one is
 * made, so connecting twice, or again after a disconnect, ends with the same
 * single tunnel and the routes it had.
 */
export async function connect(token, onLine = () => {}) {
    token = String(token ?? '').trim();
    if (!token) throw Object.assign(new Error('Paste the API token from Cloudflare first.'), { status: 400 });

    onLine('Checking the token with Cloudflare...');
    const zones = await cf.listZones(token);
    if (!zones.length) {
        throw Object.assign(
            new Error(
                'That token works, but it cannot see any domain. Give it Zone > Zone > Read and Zone > DNS > Edit on your domain, and check the domain shows as Active in Cloudflare.',
            ),
            { status: 400 },
        );
    }

    // A tunnel belongs to one account. The domains on that account are the
    // ones it can publish on; anything the token sees elsewhere is said, not
    // silently dropped.
    const accountId = zones[0].accountId;
    const mine = zones.filter((z) => z.accountId === accountId);
    if (mine.length < zones.length) {
        onLine(`The token can see domains in more than one Cloudflare account. Using ${zones[0].accountName || accountId}, which has ${mine.map((z) => z.name).join(', ')}.`);
    }
    onLine(`Domains available: ${mine.map((z) => z.name).join(', ')}.`);

    const prev = config();
    const installId = prev.installId || crypto.randomBytes(3).toString('hex');
    const tunnelName = `quickstart-home-${installId}`;

    onLine(`Finding or creating the tunnel "${tunnelName}"...`);
    const tunnel = await cf.ensureTunnel(token, accountId, tunnelName);
    onLine(tunnel.created ? 'Created it.' : 'Found it from before, so it is being reused.');

    // Routes only carry over to the same tunnel: ones made against another
    // tunnel have DNS records pointing at that one, not this.
    const routes = prev.tunnelId === tunnel.id ? prev.routes : [];
    const next = {
        installId,
        accountId,
        accountName: zones[0].accountName ?? null,
        tunnelId: tunnel.id,
        tunnelName,
        zones: mine.map((z) => ({ id: z.id, name: z.name })),
        routes,
    };

    updateEnvFile({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_TUNNEL_TOKEN: tunnel.token });
    saveTunnel(next);

    await cf.putIngress(token, accountId, tunnel.id, ingressFor(routes));
    onLine('Starting the connector...');
    await startConnector(onLine);
    await waitForHealthy(token, next, onLine);
    return next;
}

/**
 * Gives a service a public name.
 *
 * DNS first, then the route, and the DNS undone if the route fails, so a
 * failure never leaves a name that resolves to the tunnel and is then turned
 * away by it.
 */
export async function publish({ service: key, subdomain, zoneId, origin: rawOrigin }, onLine = () => {}) {
    const t = config();
    const token = apiToken();
    if (!t.tunnelId || !token) throw Object.assign(new Error('Connect a Cloudflare account first.'), { status: 409 });

    const service = serviceFor(key);
    if (!service) throw Object.assign(new Error(`There is nothing called "${key}" to publish.`), { status: 400 });
    const zone = t.zones.find((z) => z.id === zoneId);
    if (!zone) throw Object.assign(new Error('Pick one of your domains.'), { status: 400 });

    const hostname = hostnameFor(subdomain, zone);
    const origin = key === 'custom' ? customOrigin(rawOrigin) : service.origin;

    const taken = t.routes.find((r) => r.hostname === hostname);
    if (taken) {
        if (taken.service === key && taken.origin === origin) return { hostname, url: `https://${hostname}`, already: true };
        throw Object.assign(new Error(`${hostname} is already in use for ${serviceFor(taken.service)?.label ?? taken.service}. Take that off first, or pick another name.`), { status: 409 });
    }

    onLine(`Pointing ${hostname} at the tunnel...`);
    const record = await cf.pointAtTunnel(token, zone.id, hostname, t.tunnelId);
    onLine(record.reused ? 'Its DNS record was already in place.' : 'DNS record added.');

    const routes = [...t.routes, { hostname, zoneId: zone.id, service: key, origin, createdAt: new Date().toISOString() }];
    try {
        await cf.putIngress(token, t.accountId, t.tunnelId, ingressFor(routes));
    } catch (err) {
        if (!record.reused) await cf.removeRecord(token, zone.id, hostname, t.tunnelId).catch(() => {});
        throw err;
    }
    saveTunnel({ ...t, routes });
    onLine(`${service.label} is at https://${hostname}.`);

    if (service.app && !loadAppsConfig()[service.app]?.enabled) {
        onLine(`${APPS[service.app].label} is switched off, so that address will show an error until it is started.`);
    }
    return { hostname, url: `https://${hostname}`, service: key };
}

/** Takes a name off. The DNS record goes too, if it is still the one this made. */
export async function unpublish(hostname, onLine = () => {}) {
    const t = config();
    const token = apiToken();
    const route = t.routes.find((r) => r.hostname === hostname);
    if (!route) throw Object.assign(new Error(`${hostname} is not published.`), { status: 404 });

    const routes = t.routes.filter((r) => r.hostname !== hostname);
    await cf.putIngress(token, t.accountId, t.tunnelId, ingressFor(routes));
    saveTunnel({ ...t, routes });
    onLine(`${hostname} no longer reaches ${serviceFor(route.service)?.label ?? route.service}.`);

    const rm = await cf.removeRecord(token, route.zoneId, hostname, t.tunnelId).catch((err) => ({ removed: false, reason: err.message }));
    onLine(rm.removed ? 'Its DNS record is removed.' : `Its DNS record was not removed: ${rm.reason}.`);
    return route;
}

/**
 * Disconnects from Cloudflare: names off, connector gone, tokens forgotten.
 *
 * The tunnel itself is left in the account, empty. It costs nothing, and
 * connecting again finds and reuses it rather than making a new one.
 */
export async function disconnect(onLine = () => {}) {
    const t = config();
    const token = apiToken();
    if (token && t.tunnelId) {
        for (const r of t.routes) {
            const rm = await cf.removeRecord(token, r.zoneId, r.hostname, t.tunnelId).catch((err) => ({ removed: false, reason: err.message }));
            onLine(rm.removed ? `Removed ${r.hostname}.` : `Left ${r.hostname} in DNS: ${rm.reason}.`);
        }
        await cf.putIngress(token, t.accountId, t.tunnelId, []).catch(() => {});
    }
    onLine('Stopping the connector...');
    await removeConnector(onLine);
    updateEnvFile({ CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_TUNNEL_TOKEN: '' });
    saveTunnel({ ...structuredClone(DEFAULT_MANAGER_CONFIG.tunnel), installId: t.installId });
    onLine('Disconnected. The tunnel is left, empty, in your Cloudflare account, and connecting again picks it back up.');
}

/** Everything the Tunnel page shows. Cloudflare's own view is asked for live. */
export async function status() {
    const t = config();
    const token = apiToken();
    const connected = Boolean(t.tunnelId && token);
    const appsCfg = loadAppsConfig();

    let cloudflare = null;
    if (connected) {
        try {
            cloudflare = await cf.tunnelStatus(token, t.accountId, t.tunnelId);
        } catch (err) {
            cloudflare = { status: 'unknown', connections: 0, error: err.message };
        }
    }
    const container = await deps.containerState(TUNNEL_CONTAINER).catch(() => ({ exists: false, running: false }));

    return {
        connected,
        accountName: t.accountName,
        tunnelName: t.tunnelName,
        zones: t.zones,
        cloudflare,
        container,
        routes: t.routes.map((r) => ({
            ...r,
            url: `https://${r.hostname}`,
            label: serviceFor(r.service)?.label ?? r.service,
            // Published but not running is worth a word on the row: the name
            // works and shows an error, which reads like the tunnel is broken.
            appOff: Boolean(serviceFor(r.service)?.app && !appsCfg[serviceFor(r.service).app]?.enabled),
        })),
        services: SERVICES.map(({ key, label, detail, warning, note }) => ({ key, label, detail, warning, note })),
    };
}
