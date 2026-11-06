import crypto from 'node:crypto';
import * as dockerctl from './dockerctl.js';
import { loadManagerConfig, readEnvFile, saveManagerConfig, updateEnvFile } from './store.js';

/*
 * A Mullvad exit node for the tailnet, on your own Mullvad account.
 *
 * One container (manager/mullvad/) is both a WireGuard tunnel to Mullvad and a
 * Tailscale device that offers itself as an exit node. A phone or laptop that
 * picks it as its exit node stays on the tailnet, so the apps here keep
 * working, while what it does on the internet leaves through Mullvad. Neither
 * of them needs the Mullvad app: the account is used here, once.
 *
 * The panel does what the Mullvad app would: swaps the account number for a
 * session, registers a WireGuard key as one of the account's devices, and
 * picks a server in the city chosen. Changing city keeps the key and the
 * Tailscale sign-in; only the server it connects to changes.
 *
 * Secrets -- the account number and the WireGuard private key -- live in the
 * stack's .env like the Cloudflare tokens, not in manager.json.
 */

export const MULLVAD_CONTAINER = 'quickstart-home-mullvad';
const PROFILE = 'mullvad';
const VOLUME = 'quickstart-home-mullvad-tailscale';
const API = (process.env.MULLVAD_API_BASE || 'https://api.mullvad.net').replace(/\/+$/, '');

const deps = {
    compose: dockerctl.compose,
    docker: dockerctl.docker,
    containerState: dockerctl.containerState,
    fetch: (...args) => fetch(...args),
};
/** Test seam: lets the tests run this without Mullvad or containers. */
export function _setDeps(next) {
    Object.assign(deps, next);
}

class MullvadError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// --------------------------------------------------------------- the API ---

// Mullvad's error codes, as a sentence that says what to do.
const ERRORS = {
    INVALID_ACCOUNT: 'Mullvad does not know that account number. It is the 16 digits on your Mullvad account page.',
    TOO_MANY_DEVICES: 'Your Mullvad account already has its five devices. Remove one at mullvad.net (Account → Devices), or log out of the Mullvad app on a phone or laptop you will not use it on any more, then try again.',
    MAX_DEVICES_REACHED: 'Your Mullvad account already has its five devices. Remove one at mullvad.net (Account → Devices), or log out of the Mullvad app on a phone or laptop you will not use it on any more, then try again.',
    INVALID_ACCESS_TOKEN: 'Mullvad did not accept the session. Try again.',
};

async function call(method, path, { token, body } = {}) {
    let res;
    try {
        res = await deps.fetch(`${API}${path}`, {
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(20_000),
        });
    } catch (err) {
        throw new MullvadError(`Could not reach Mullvad: ${err.cause?.code || err.message}`, 502);
    }
    if (res.status === 204) return null;
    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    if (!res.ok) {
        const code = data?.code;
        throw new MullvadError(ERRORS[code] ?? data?.detail ?? data?.error ?? `Mullvad answered ${res.status}.`, res.status);
    }
    return data;
}

const cleanAccount = (raw) => String(raw ?? '').replace(/\D/g, '');

async function session(account) {
    const r = await call('POST', '/auth/v1/token', { body: { account_number: account } });
    if (!r?.access_token) throw new MullvadError('Mullvad did not return a session.', 502);
    return r.access_token;
}

/** A WireGuard key pair, as the base64 strings WireGuard and Mullvad use. */
export function wireguardKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const b64 = (u) => Buffer.from(u, 'base64url').toString('base64');
    return { privateKey: b64(privateKey.export({ format: 'jwk' }).d), publicKey: b64(publicKey.export({ format: 'jwk' }).x) };
}

// ------------------------------------------------------------- locations ---

let relayCache = { at: 0, value: null };
let homeCache = null;

async function relays() {
    if (relayCache.value && Date.now() - relayCache.at < 60 * 60_000) return relayCache.value;
    const data = await call('GET', '/app/v1/relays');
    relayCache = { at: Date.now(), value: data };
    return data;
}

/**
 * Roughly where this house is, to put the nearest cities first. Asked of
 * Mullvad's own "am I on Mullvad" service, from here, before anything goes
 * through Mullvad -- so it answers with the home connection's location.
 */
async function home() {
    if (homeCache) return homeCache;
    try {
        const r = await deps.fetch('https://am.i.mullvad.net/json', { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        if (!j.mullvad_exit_ip && Number.isFinite(j.latitude)) homeCache = { latitude: j.latitude, longitude: j.longitude };
    } catch {
        /* sorted by name instead */
    }
    return homeCache;
}

function distanceKm(a, b) {
    const rad = (d) => (d * Math.PI) / 180;
    const h =
        Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
        Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Every city Mullvad has WireGuard servers in, nearest first: [{ id, label, servers, km }]. */
export async function locations() {
    const [data, here] = await Promise.all([relays(), home()]);
    const counts = {};
    for (const r of data.wireguard?.relays ?? []) if (r.active) counts[r.location] = (counts[r.location] ?? 0) + 1;
    const list = Object.entries(counts).map(([id, servers]) => {
        const loc = data.locations?.[id] ?? {};
        return {
            id,
            label: `${loc.city ?? id}, ${loc.country ?? ''}`.replace(/, $/, ''),
            servers,
            km: here && Number.isFinite(loc.latitude) ? Math.round(distanceKm(here, loc)) : null,
        };
    });
    list.sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity) || a.label.localeCompare(b.label));
    return list;
}

/** One working server in a city, weighted the way Mullvad weights them. */
async function pickRelay(location) {
    const data = await relays();
    const pool = (data.wireguard?.relays ?? []).filter((r) => r.active && r.location === location);
    if (!pool.length) throw new MullvadError('Mullvad has no working servers in that city right now. Pick another.', 409);
    let n = Math.random() * pool.reduce((s, r) => s + (r.weight || 1), 0);
    const relay = pool.find((r) => (n -= r.weight || 1) <= 0) ?? pool[0];
    const loc = data.locations?.[location] ?? {};
    return {
        hostname: relay.hostname,
        publicKey: relay.public_key,
        endpoint: `${relay.ipv4_addr_in}:51820`,
        label: `${loc.city ?? location}, ${loc.country ?? ''}`.replace(/, $/, ''),
    };
}

// ----------------------------------------------------------------- state ---

const config = () => loadManagerConfig().mullvad ?? {};

function saveConfig(next) {
    const cfg = loadManagerConfig();
    cfg.mullvad = next;
    saveManagerConfig(cfg);
}

const account = () => (readEnvFile().MULLVAD_ACCOUNT || '').trim();
export const isConnected = () => Boolean(config().deviceId && account() && readEnvFile().MULLVAD_WG_PRIVATE_KEY);

async function start(onLine) {
    // Recreated, not restarted: the server it connects to reaches it as
    // environment, which is fixed when a container is made. --build because
    // the image is made here, from manager/mullvad/, the first time.
    await deps.compose(['up', '-d', '--build', '--force-recreate', 'mullvad'], { onLine, profile: PROFILE, timeoutMs: 10 * 60_000 });
}

// ---------------------------------------------------------------- actions ---

/**
 * Sets it up: checks the account, registers a key on it, picks a server in
 * `location`, and starts the exit node. Tailscale then wants signing in once,
 * which the page shows.
 */
export async function connect(rawAccount, location, onLine = () => {}) {
    const acct = cleanAccount(rawAccount);
    if (acct.length < 10) throw new MullvadError('Type your Mullvad account number. It is 16 digits.');
    onLine('Checking the account with Mullvad...');
    const token = await session(acct);
    const me = await call('GET', '/accounts/v1/accounts/me', { token }).catch(() => null);
    if (me?.expiry && new Date(me.expiry) < new Date()) {
        throw new MullvadError(`That Mullvad account ran out on ${new Date(me.expiry).toLocaleDateString()}. Add time to it at mullvad.net first.`, 409);
    }

    const relay = await pickRelay(location);

    /*
     * The new device first, then the settings, and only then the old device.
     *
     * Setting up again replaces the device rather than taking a second of the
     * account's five -- but the old one used to be deleted first, so a
     * registration that then failed (Mullvad busy, the network dropping, the
     * account at its limit from elsewhere) left an exit node whose key Mullvad
     * no longer knew, and nothing to fall back to. This way a failure leaves
     * the working setup exactly as it was.
     *
     * The one case that needs the old slot is an account already at its five,
     * where the new device cannot be added until the old one goes. Only then is
     * the old one removed first, and the page says so.
     */
    const prev = config();
    // A key made here and never shown anywhere: Mullvad only ever sees the
    // public half.
    const keys = wireguardKeys();
    onLine('Adding this machine to your Mullvad account as a device...');
    const register = () => call('POST', '/accounts/v1/devices', { token, body: { pubkey: keys.publicKey, hijack_dns: false } });
    let device;
    let oldRemoved = false;
    try {
        device = await register();
    } catch (err) {
        const full = err.message === ERRORS.MAX_DEVICES_REACHED;
        if (!full || !prev.deviceId) throw err;
        onLine('The account has no free device slot, so the device this machine used before is removed first to make room.');
        await call('DELETE', `/accounts/v1/devices/${prev.deviceId}`, { token }).catch(() => {});
        oldRemoved = true;
        device = await register();
    }
    if (!device?.ipv4_address) throw new MullvadError('Mullvad did not give the device an address.', 502);
    onLine(`Mullvad named it "${device.name}". That is the name it has under Devices on your Mullvad account page.`);

    updateEnvFile({
        MULLVAD_ACCOUNT: acct,
        MULLVAD_WG_PRIVATE_KEY: keys.privateKey,
        MULLVAD_WG_ADDRESS: device.ipv4_address,
        MULLVAD_WG_ADDRESS6: device.ipv6_address ?? '',
        MULLVAD_PEER_PUBLIC_KEY: relay.publicKey,
        MULLVAD_ENDPOINT: relay.endpoint,
    });
    saveConfig({ deviceId: device.id, deviceName: device.name, location, locationLabel: relay.label, relay: relay.hostname });

    // Best effort: the new device works whether or not this does, and a
    // leftover is something the account page can remove.
    if (prev.deviceId && !oldRemoved && prev.deviceId !== device.id) {
        try {
            await call('DELETE', `/accounts/v1/devices/${prev.deviceId}`, { token });
            onLine(`Removed the device this machine used before${prev.deviceName ? ` ("${prev.deviceName}")` : ''}.`);
        } catch (err) {
            onLine(`Could not remove the old device "${prev.deviceName ?? prev.deviceId}" (${err.message}). Remove it at mullvad.net under Devices.`);
        }
    }

    onLine(`Connecting through ${relay.hostname} (${relay.label})...`);
    await start(onLine);
    onLine('Started. Sign it in to your tailnet from the Mullvad VPN page to finish.');
    return { device: device.name, relay: relay.hostname };
}

/** Moves it to another city. Same key, same Tailscale sign-in. */
export async function setLocation(location, onLine = () => {}) {
    if (!isConnected()) throw new MullvadError('Set it up first.', 409);
    const relay = await pickRelay(location);
    updateEnvFile({ MULLVAD_PEER_PUBLIC_KEY: relay.publicKey, MULLVAD_ENDPOINT: relay.endpoint });
    saveConfig({ ...config(), location, locationLabel: relay.label, relay: relay.hostname });
    onLine(`Switching to ${relay.hostname} (${relay.label})...`);
    await start(onLine);
    return { relay: relay.hostname };
}

/**
 * Takes it all down: signs the exit node out of the tailnet, removes its
 * device from the Mullvad account, and forgets the account here.
 */
export async function remove(onLine = () => {}) {
    const c = config();
    const state = await deps.containerState(MULLVAD_CONTAINER).catch(() => ({ running: false }));
    if (state.running) {
        onLine('Signing the exit node out of your tailnet...');
        await deps.docker(['exec', MULLVAD_CONTAINER, 'tailscale', 'logout'], { timeoutMs: 30_000 }).catch(() => {});
    }
    if (c.deviceId && account()) {
        onLine('Removing its device from your Mullvad account...');
        try {
            const token = await session(account());
            await call('DELETE', `/accounts/v1/devices/${c.deviceId}`, { token });
        } catch (err) {
            onLine(`Could not remove it from Mullvad (${err.message}). Remove "${c.deviceName}" at mullvad.net under Devices.`);
        }
    }
    onLine('Stopping it...');
    await deps.compose(['rm', '--stop', '--force', 'mullvad'], { onLine, profile: PROFILE, timeoutMs: 2 * 60_000 }).catch(() => {});
    await deps.docker(['volume', 'rm', '-f', VOLUME], { timeoutMs: 30_000 }).catch(() => {});
    updateEnvFile({
        MULLVAD_ACCOUNT: '',
        MULLVAD_WG_PRIVATE_KEY: '',
        MULLVAD_WG_ADDRESS: '',
        MULLVAD_WG_ADDRESS6: '',
        MULLVAD_PEER_PUBLIC_KEY: '',
        MULLVAD_ENDPOINT: '',
    });
    saveConfig({});
    onLine('Removed. If home-mullvad still shows in the Tailscale admin console, remove it there too.');
}

// ---------------------------------------------------------------- status ---

let expiryCache = { at: 0, value: null };

async function accountExpiry() {
    if (Date.now() - expiryCache.at < 30 * 60_000) return expiryCache.value;
    let value = null;
    try {
        const me = await call('GET', '/accounts/v1/accounts/me', { token: await session(account()) });
        value = me?.expiry ?? null;
    } catch {
        value = null;
    }
    expiryCache = { at: Date.now(), value };
    return value;
}

/**
 * What the page shows. Read from inside the exit node: whether the tunnel to
 * Mullvad has shaken hands lately, what address the internet sees through it,
 * and where its Tailscale sign-in is. `peers` is this machine's own view of
 * the tailnet, which is where "approved as an exit node" shows.
 */
export async function status(peers = []) {
    const c = config();
    const connected = isConnected();
    const out = { connected, deviceName: c.deviceName ?? null, location: c.location ?? null, locationLabel: c.locationLabel ?? null, relay: c.relay ?? null };
    if (!connected) return out;

    const container = await deps.containerState(MULLVAD_CONTAINER).catch(() => ({ exists: false, running: false }));
    out.container = container;
    out.expiry = await accountExpiry();
    if (!container.running) return out;

    const script = [
        'echo "---wg"; wg show wg0 latest-handshakes 2>/dev/null',
        'echo "---exit"; curl -s --max-time 8 --interface wg0 https://am.i.mullvad.net/json 2>/dev/null; echo',
        'echo "---ts"; tailscale status --json 2>/dev/null',
    ].join('; ');
    let text = '';
    try {
        ({ stdout: text } = await deps.docker(['exec', MULLVAD_CONTAINER, 'sh', '-c', script], { timeoutMs: 25_000 }));
    } catch (err) {
        text = String(err.stdout ?? '');
    }
    const part = (name) => (text.split(`---${name}\n`)[1] ?? '').split('\n---')[0].trim();

    const shake = Number(part('wg').split(/\s+/)[1] || 0);
    out.handshakeAgo = shake ? Math.round(Date.now() / 1000 - shake) : null;
    // WireGuard renews every two minutes while it carries anything, and the
    // keepalive makes sure it always does.
    out.tunnelUp = out.handshakeAgo !== null && out.handshakeAgo < 200;
    try {
        const e = JSON.parse(part('exit'));
        out.exit = { ip: e.ip, city: e.city, country: e.country, mullvad: Boolean(e.mullvad_exit_ip), server: e.mullvad_exit_ip_hostname ?? null };
    } catch {
        out.exit = null;
    }
    try {
        const ts = JSON.parse(part('ts'));
        out.tailscale = {
            state: ts.BackendState,
            authURL: ts.AuthURL || null,
            name: String(ts.Self?.DNSName ?? '').replace(/\.$/, '').split('.')[0] || null,
            dnsName: String(ts.Self?.DNSName ?? '').replace(/\.$/, '') || null,
            id: ts.Self?.ID ?? null,
        };
        const seen = peers.find((p) => p.id === out.tailscale.id);
        // Offered is not the same as usable: an exit node has to be approved
        // once in the admin console, and until then nobody can pick it.
        out.tailscale.approved = Boolean(seen?.exitNodeOption);
        out.tailscale.keyExpiry = seen?.keyExpiry ?? null;
    } catch {
        out.tailscale = null;
    }
    return out;
}
