import path from 'node:path';
import { containerState } from './dockerctl.js';
import { CONF_DIR } from './paths.js';
import { readEnvFile, readJson, writeJson } from './store.js';

/**
 * AdGuard Home: the house's DNS, and the controls the panel puts over it.
 *
 * Every device that asks AdGuard for an address can be told "no" for an ad, a
 * tracker, an app the family has switched off for it, or -- at bedtime -- for
 * everything. AdGuard keeps nearly all of that itself (its clients, its lists,
 * its blocked services), and the panel reads and writes it through AdGuard's
 * own API rather than keeping a second copy that could disagree.
 *
 * Two things AdGuard has no notion of are kept here, in conf/adguard.json:
 * a device's internet being switched off, and its bedtime. Both are carried
 * out through AdGuard's "disallowed clients", which refuses every lookup from
 * an address, and the panel keeps that list in step once a minute. Only the
 * entries the panel put there are ever taken out again; one added by hand in
 * AdGuard's own page is left alone.
 */

export const CONTAINER = 'quickstart-home-adguard';
export const USERNAME = 'panel';

// On the stack network: its page once it is set up, and the first-run wizard
// before that. Overridable so the module can be pointed at a test instance.
const WEB = process.env.ADGUARD_URL || 'http://adguard';
const SETUP = process.env.ADGUARD_SETUP_URL || 'http://adguard:3000';

const STATE_FILE = path.join(CONF_DIR, 'adguard.json');
const DEFAULT_STATE = {
    // By AdGuard client name: { internetOff, bedtime: { on, from, to, days }, hostname }.
    devices: {},
    // The disallowed addresses the panel itself put there, so it never takes
    // out one somebody added in AdGuard's own page.
    owned: [],
    upstream: 'quad9',
    defaultsApplied: false,
};

const loadState = () => readJson(STATE_FILE, DEFAULT_STATE);
const saveState = (s) => writeJson(STATE_FILE, s);

export const password = () => readEnvFile().ADGUARD_PANEL_PASSWORD || '';

/** Where lookups go once AdGuard has decided not to block them. */
export const UPSTREAMS = {
    quad9: {
        label: 'Quad9',
        detail: 'Swiss, non-profit, and blocks known malware and phishing sites itself.',
        servers: ['https://dns.quad9.net/dns-query'],
        bootstrap: ['9.9.9.9', '149.112.112.112'],
    },
    cloudflare: {
        label: 'Cloudflare',
        detail: 'Usually the fastest. Answers everything; only your lists block anything.',
        servers: ['https://cloudflare-dns.com/dns-query'],
        bootstrap: ['1.1.1.1', '1.0.0.1'],
    },
    'cloudflare-security': {
        label: 'Cloudflare, blocking malware',
        detail: 'Cloudflare with known malware and phishing sites refused.',
        servers: ['https://security.cloudflare-dns.com/dns-query'],
        bootstrap: ['1.1.1.2', '1.0.0.2'],
    },
    mullvad: {
        label: 'Mullvad',
        detail: 'From the VPN company. Keeps no logs.',
        servers: ['https://dns.mullvad.net/dns-query'],
        bootstrap: ['194.242.2.2'],
    },
    google: {
        label: 'Google',
        detail: 'Fast and reliable, but it is Google.',
        servers: ['https://dns.google/dns-query'],
        bootstrap: ['8.8.8.8', '8.8.4.4'],
    },
};

/**
 * Blocklists worth offering by name. Any list can still be added by its
 * address; these are the ones most households want one of.
 */
export const CATALOG = [
    {
        key: 'adguard',
        name: 'AdGuard DNS filter',
        url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt',
        detail: 'Ads and trackers. On from the start, and rarely breaks anything.',
    },
    {
        // AdGuard comes with this one added and switched off.
        key: 'adaway',
        name: 'AdAway',
        url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_2.txt',
        detail: 'Ads in phone and tablet apps.',
    },
    {
        key: 'hagezi-multi',
        name: 'HaGeZi Multi Normal',
        url: 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/multi.txt',
        detail: 'Ads, trackers, telemetry and pop-ups. A good second list.',
    },
    {
        key: 'hagezi-pro',
        name: 'HaGeZi Pro',
        url: 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/pro.txt',
        detail: 'Stricter than Normal. Blocks more, and now and then something you wanted.',
    },
    {
        key: 'hagezi-tif',
        name: 'HaGeZi Threat Intelligence',
        url: 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/tif.txt',
        detail: 'Malware, phishing, scams and crypto-mining sites.',
    },
    {
        key: 'smart-tv',
        name: 'Smart TV tracking',
        url: 'https://raw.githubusercontent.com/Perflyst/PiHoleBlocklist/master/SmartTV-AGH.txt',
        detail: 'What Samsung, LG and other TVs send home about what you watch.',
    },
    {
        key: 'oisd-big',
        name: 'OISD Big',
        url: 'https://big.oisd.nl/',
        detail: 'One large, carefully kept list of ads, trackers and malware.',
    },
    {
        key: 'stevenblack',
        name: 'Steven Black',
        url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
        detail: 'A long-standing combined list of ads and malware.',
    },
];

// ------------------------------------------------------------------- api --

export class AdGuardError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

async function call(method, p, body, { base = WEB, auth = true, timeoutMs = 10_000 } = {}) {
    const headers = {};
    if (auth) headers.Authorization = `Basic ${Buffer.from(`${USERNAME}:${password()}`).toString('base64')}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
        res = await fetch(`${base}${p}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        throw new AdGuardError('AdGuard Home is not answering. Is it switched on?', 503);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
        throw new AdGuardError(
            'AdGuard Home refused the panel\'s password. It may have been set up by hand; see the Settings tab.',
            502,
        );
    }
    if (!res.ok) throw new AdGuardError(`AdGuard Home said: ${text.trim() || res.status}`, 502);
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

const get = (p) => call('GET', p);
const post = (p, body = {}) => call('POST', p, body);
const put = (p, body = {}) => call('PUT', p, body);

// ----------------------------------------------------------------- setup --

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function answers(fn) {
    try {
        await fn();
        return true;
    } catch (err) {
        // Refusing the password is an answer, and not one waiting will change.
        if (err instanceof AdGuardError && err.status === 502) throw err;
        return false;
    }
}

/**
 * Takes a freshly started AdGuard through its first-run wizard -- the account
 * the panel signs in with, and where it listens -- and then sets the house
 * defaults once. Safe to run on every start: a set-up instance skips the wizard.
 */
export async function ensureSetUp(onLine = () => {}) {
    const pass = password();
    if (!pass) throw new Error('There is no AdGuard password in .env yet.');

    for (let i = 0; i < 90; i++) {
        if (await answers(() => get('/control/status'))) break;
        const wizard = await answers(() => call('GET', '/control/install/get_addresses', undefined, { base: SETUP, auth: false }));
        if (wizard) {
            onLine('Setting AdGuard Home up for the first time.');
            await call(
                'POST',
                '/control/install/configure',
                {
                    web: { ip: '0.0.0.0', port: 80 },
                    dns: { ip: '0.0.0.0', port: 53 },
                    username: USERNAME,
                    password: pass,
                },
                { base: SETUP, auth: false, timeoutMs: 30_000 },
            );
            // It moves its page from the wizard's port to 80 and restarts it.
            for (let j = 0; j < 30 && !(await answers(() => get('/control/status'))); j++) await sleep(1000);
            break;
        }
        if (i === 0) onLine('Waiting for AdGuard Home to answer.');
        await sleep(1000);
    }
    await get('/control/status');

    const state = loadState();
    if (!state.defaultsApplied) {
        onLine('Applying the house defaults: no rate limit, a bigger cache, and Quad9 for lookups.');
        await applyUpstream(state.upstream);
        // A week of lookups to look back through, rather than ninety days of
        // every device's browsing kept on disk.
        const q = await get('/control/querylog/config');
        await put('/control/querylog/config/update', { ...q, enabled: true, interval: 7 * 86_400_000 });
        state.defaultsApplied = true;
        saveState(state);
    }
    onLine('AdGuard Home is ready.');
}

/*
 * The rate limit is off. AdGuard's default is 20 lookups a second for a whole
 * /24, and every device in a house is in the same /24 -- a family evening of
 * phones, a TV and a game console reaches that, and lookups past it are dropped,
 * which looks exactly like the internet being slow. It exists to stop a server
 * on the internet being used to attack someone, which this one is not.
 *
 * Optimistic caching answers a name it has seen from cache straight away, even
 * just expired, and refreshes it behind: the commonest lookups never wait.
 */
async function applyUpstream(key) {
    const u = UPSTREAMS[key] ?? UPSTREAMS.quad9;
    const info = await get('/control/dns_info');
    await post('/control/dns_config', {
        ...info,
        upstream_dns: u.servers,
        bootstrap_dns: u.bootstrap,
        upstream_mode: 'load_balance',
        ratelimit: 0,
        cache_enabled: true,
        cache_optimistic: true,
        cache_size: Math.max(info.cache_size ?? 0, 16 * 1024 * 1024),
    });
}

// -------------------------------------------------------------- overview --

const isBlockedReason = (r) =>
    /^Filtered/.test(r || '') && r !== 'FilteredSafeSearch' && r !== 'FilteredRewrite';

/** The house today: whether it is on, and how much it has done. */
export async function overview() {
    const [status, stats, clients] = await Promise.all([get('/control/status'), get('/control/stats'), get('/control/clients')]);
    const names = clientNames(clients);
    const pair = (o) => Object.entries(o)[0];
    const lan = (stats.top_clients ?? []).map(pair).filter(([ip]) => isHouseAddress(ip));
    return {
        protection: protectionOf(status),
        version: status.version,
        queries: stats.num_dns_queries ?? 0,
        blocked:
            (stats.num_blocked_filtering ?? 0) + (stats.num_replaced_safebrowsing ?? 0) + (stats.num_replaced_parental ?? 0),
        // Seconds, from AdGuard; milliseconds are what anyone reads.
        avgMs: Math.round((stats.avg_processing_time ?? 0) * 10000) / 10,
        topBlocked: (stats.top_blocked_domains ?? []).slice(0, 8).map(pair).map(([domain, count]) => ({ domain, count })),
        topDevices: lan.slice(0, 8).map(([ip, count]) => ({ ip, name: names.get(ip) || null, count })),
        houseDevices: lan.length,
        hourly: {
            queries: (stats.dns_queries ?? []).slice(-24),
            blocked: (stats.blocked_filtering ?? []).slice(-24),
        },
    };
}

function protectionOf(status) {
    const until = status.protection_disabled_duration
        ? Date.now() + Number(status.protection_disabled_duration)
        : null;
    return { enabled: Boolean(status.protection_enabled), until };
}

/** On, off, or off for a while. `minutes` of 0 means until it is turned back on. */
export async function setProtection({ enabled, minutes = 0 }) {
    const body = { enabled: Boolean(enabled) };
    if (!enabled && minutes > 0) body.duration = Math.round(minutes) * 60_000;
    await post('/control/protection', body);
    return protectionOf(await get('/control/status'));
}

// --------------------------------------------------------------- devices --

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const isIp = (s) => IPV4.test(s) || (/^[0-9a-f:]+$/i.test(s) && s.includes(':'));
const isCidr = (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/([12]?\d|3[0-2])$/.test(s);
const isMac = (s) => /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(s);
const isIdOk = (s) => isIp(s) || isCidr(s) || isMac(s);

/**
 * An address a device in the house would have: the home network or Tailscale.
 * Docker's own (172.16/12) are the panel and the server talking to themselves.
 */
const isHouseAddress = (ip) =>
    /^(192\.168\.|10\.)/.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);

function clientNames(clients) {
    const names = new Map();
    for (const a of clients.auto_clients ?? []) {
        if (a.source !== 'etc/hosts' && a.name) names.set(a.ip, a.name);
    }
    for (const c of clients.clients ?? []) for (const id of c.ids ?? []) names.set(id, c.name);
    return names;
}

const HOURS_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (hhmm) => {
    const m = HOURS_RE.exec(hhmm);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fromMs = (ms) => {
    const minutes = Math.round(ms / 60_000);
    return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "Allowed between" hours, read back off AdGuard's schedule. */
function hoursOf(schedule) {
    const day = DAYS.map((d) => schedule?.[d]).find((r) => r && r.end > r.start);
    return day ? { from: fromMs(day.start), to: day.end >= 86_400_000 ? '24:00' : fromMs(day.end) } : null;
}

/** Whether a bedtime is in force at `now`. A bedtime belongs to the night it starts on. */
export function inBedtime(b, now = new Date()) {
    if (!b?.on) return false;
    const from = toMinutes(b.from);
    const to = toMinutes(b.to);
    if (from === null || to === null || from === to) return false;
    const days = Array.isArray(b.days) && b.days.length ? b.days : [0, 1, 2, 3, 4, 5, 6];
    const m = now.getHours() * 60 + now.getMinutes();
    const today = now.getDay();
    const yesterday = (today + 6) % 7;
    if (from < to) return days.includes(today) && m >= from && m < to;
    return (days.includes(today) && m >= from) || (days.includes(yesterday) && m < to);
}

function filteringOf(c) {
    if (c.use_global_settings) return 'house';
    if (!c.filtering_enabled && !c.parental_enabled && !c.safe_search?.enabled) return 'off';
    if (c.filtering_enabled && c.parental_enabled && c.safe_search?.enabled) return 'strict';
    return 'custom';
}

/**
 * Every device in the house: the ones given a name here, and the ones that
 * have only been seen asking for addresses.
 */
export async function devices() {
    const [clients, stats, log, access] = await Promise.all([
        get('/control/clients'),
        get('/control/stats'),
        get('/control/querylog?limit=1000'),
        get('/control/access/list'),
    ]);
    const state = loadState();
    const now = new Date();
    const counts = new Map((stats.top_clients ?? []).map((o) => Object.entries(o)[0]));
    const seen = new Map();
    for (const e of log.data ?? []) {
        const s = seen.get(e.client) ?? { last: e.time, blocked: 0 };
        if (isBlockedReason(e.reason)) s.blocked += 1;
        seen.set(e.client, s);
    }
    const auto = new Map();
    for (const a of clients.auto_clients ?? []) if (a.source !== 'etc/hosts' && a.name) auto.set(a.ip, a.name);
    const disallowed = new Set(access.disallowed_clients ?? []);

    const activity = (ips) => {
        let queries = 0;
        let blocked = 0;
        let last = null;
        for (const ip of ips) {
            queries += Number(counts.get(ip) ?? 0);
            const s = seen.get(ip);
            if (s) {
                blocked += s.blocked;
                if (!last || s.last > last) last = s.last;
            }
        }
        return { queries, recentBlocked: blocked, lastSeen: last };
    };

    const out = [];
    const claimed = new Set();
    for (const c of clients.clients ?? []) {
        const ips = (c.ids ?? []).filter(isIp);
        ips.forEach((ip) => claimed.add(ip));
        const meta = state.devices[c.name] ?? {};
        const bedtimeNow = inBedtime(meta.bedtime, now);
        out.push({
            key: c.name,
            name: c.name,
            ids: c.ids ?? [],
            hostname: meta.hostname || ips.map((ip) => auto.get(ip)).find(Boolean) || null,
            saved: true,
            filtering: filteringOf(c),
            services: c.use_global_blocked_services ? null : c.blocked_services ?? [],
            appHours: c.use_global_blocked_services ? null : hoursOf(c.blocked_services_schedule),
            internetOff: Boolean(meta.internetOff),
            bedtime: meta.bedtime ?? null,
            bedtimeNow,
            cutOff: ips.some((ip) => disallowed.has(ip)),
            ...activity(ips),
        });
    }
    const unnamed = new Set([...counts.keys(), ...seen.keys(), ...auto.keys()]);
    for (const ip of unnamed) {
        if (claimed.has(ip) || !isIp(ip) || !isHouseAddress(ip)) continue;
        out.push({
            key: ip,
            name: null,
            ids: [ip],
            hostname: auto.get(ip) || null,
            saved: false,
            filtering: 'house',
            services: null,
            appHours: null,
            internetOff: false,
            bedtime: null,
            bedtimeNow: false,
            cutOff: disallowed.has(ip),
            ...activity([ip]),
        });
    }
    // Named first, then the busiest.
    out.sort((a, b) => Number(b.saved) - Number(a.saved) || b.queries - a.queries || String(a.key).localeCompare(b.key));
    return { devices: out, timezone: process.env.TZ || 'UTC' };
}

let servicesCache = null;

/** The apps and sites AdGuard knows how to block by name, with their icons. */
export async function services() {
    if (servicesCache && Date.now() - servicesCache.at < 6 * 3_600_000) return servicesCache.value;
    const all = await get('/control/blocked_services/all');
    const value = {
        services: (all.blocked_services ?? []).map((s) => ({ id: s.id, name: s.name, group: s.group_id, icon: s.icon_svg })),
        groups: (all.groups ?? []).map((g) => g.id),
    };
    servicesCache = { at: Date.now(), value };
    return value;
}

const serviceNames = () =>
    services()
        .then((s) => new Map(s.services.map((x) => [x.id, x.name])))
        .catch(() => new Map());

const NAME_RE = /^[\p{L}\p{N} '._()&+-]{1,40}$/u;

function scheduleFor(hours) {
    const zone = process.env.TZ || 'Local';
    if (!hours) return { time_zone: zone };
    const from = toMinutes(hours.from);
    const to = hours.to === '24:00' ? 1440 : toMinutes(hours.to);
    const range = { start: from * 60_000, end: to * 60_000 };
    return { time_zone: zone, ...Object.fromEntries(DAYS.map((d) => [d, range])) };
}

/**
 * Names a device and sets what it may do, or changes one already named.
 * `key` is its current name, or its address if it has none yet.
 */
export async function saveDevice(input) {
    const errors = [];
    const name = String(input.name ?? '').trim();
    if (!NAME_RE.test(name)) errors.push('A device name is 1 to 40 letters, numbers, spaces and simple punctuation.');
    const ids = [...new Set((input.ids ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
    if (!ids.length) errors.push('A device needs at least one address.');
    for (const id of ids) if (!isIdOk(id)) errors.push(`"${id}" is not an IP address, network or MAC address.`);

    const filtering = String(input.filtering ?? 'house');
    if (!['house', 'strict', 'off', 'custom'].includes(filtering)) errors.push('Unknown filtering choice.');

    let svc = null;
    if (Array.isArray(input.services)) {
        const known = new Set((await services()).services.map((s) => s.id));
        svc = [...new Set(input.services.map(String))].filter((id) => known.has(id));
    }
    let hours = null;
    if (svc && input.appHours) {
        const from = toMinutes(input.appHours.from);
        const to = input.appHours.to === '24:00' ? 1440 : toMinutes(input.appHours.to);
        if (from === null || to === null || from >= to) {
            errors.push('Allowed hours run from an earlier time to a later one on the same day, like 16:00 to 20:00.');
        } else {
            hours = { from: input.appHours.from, to: input.appHours.to };
        }
    }

    let bedtime = null;
    if (input.bedtime) {
        const b = input.bedtime;
        const from = toMinutes(b.from);
        const to = toMinutes(b.to);
        const days = [...new Set((b.days ?? []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
        if (b.on && (from === null || to === null || from === to)) errors.push('Bedtime needs a start and an end, like 21:00 to 07:00.');
        else if (b.on && !days.length) errors.push('Pick at least one night for bedtime.');
        bedtime = { on: Boolean(b.on), from: b.from || '21:00', to: b.to || '07:00', days: days.length ? days : [0, 1, 2, 3, 4, 5, 6] };
    }
    if (errors.length) {
        const err = new AdGuardError(errors.join(' '), 400);
        err.details = errors;
        throw err;
    }

    const [clients, house] = await Promise.all([get('/control/clients'), houseFilters()]);
    const key = String(input.key ?? '');
    const existing = (clients.clients ?? []).find((c) => c.name === key) ?? null;
    if (name !== key && (clients.clients ?? []).some((c) => c.name === name)) {
        throw new AdGuardError(`There is already a device called "${name}".`, 409);
    }

    const safeSearch = (on) => ({ enabled: on, bing: true, duckduckgo: true, ecosia: true, google: true, pixabay: true, yandex: true, youtube: true });
    const base = {
        name,
        ids,
        tags: existing?.tags ?? [],
        upstreams: existing?.upstreams ?? [],
        ignore_querylog: existing?.ignore_querylog ?? false,
        ignore_statistics: existing?.ignore_statistics ?? false,
    };
    const filters =
        filtering === 'house'
            ? {
                  use_global_settings: true,
                  filtering_enabled: true,
                  parental_enabled: house.adult,
                  safebrowsing_enabled: house.malware,
                  safe_search: safeSearch(house.safeSearch),
              }
            : filtering === 'strict'
              ? { use_global_settings: false, filtering_enabled: true, parental_enabled: true, safebrowsing_enabled: true, safe_search: safeSearch(true) }
              : filtering === 'off'
                ? { use_global_settings: false, filtering_enabled: false, parental_enabled: false, safebrowsing_enabled: false, safe_search: safeSearch(false) }
                : {
                      // Set in AdGuard's own page: kept exactly as it is.
                      use_global_settings: existing?.use_global_settings ?? true,
                      filtering_enabled: existing?.filtering_enabled ?? true,
                      parental_enabled: existing?.parental_enabled ?? false,
                      safebrowsing_enabled: existing?.safebrowsing_enabled ?? false,
                      safe_search: existing?.safe_search ?? safeSearch(false),
                  };
    const apps = svc
        ? { use_global_blocked_services: false, blocked_services: svc, blocked_services_schedule: scheduleFor(hours) }
        : { use_global_blocked_services: true, blocked_services: [], blocked_services_schedule: scheduleFor(null) };
    const data = { ...base, ...filters, ...apps };

    if (existing) await post('/control/clients/update', { name: key, data });
    else await post('/control/clients/add', data);

    const state = loadState();
    const meta = { ...(state.devices[key] ?? {}) };
    if (key !== name) delete state.devices[key];
    if (input.internetOff !== undefined) meta.internetOff = Boolean(input.internetOff);
    if (bedtime) meta.bedtime = bedtime;
    // The name the router gave it, so it can be followed to a new address.
    const autoNames = new Map((clients.auto_clients ?? []).filter((a) => a.source !== 'etc/hosts').map((a) => [a.ip, a.name]));
    meta.hostname = meta.hostname || ids.map((ip) => autoNames.get(ip)).find(Boolean) || null;
    state.devices[name] = meta;
    saveState(state);

    await reconcile();
    return { ok: true };
}

/** Cuts a device off, or lets it back on, without touching anything else about it. */
export async function setInternet(name, off) {
    const clients = await get('/control/clients');
    if (!(clients.clients ?? []).some((c) => c.name === name)) throw new AdGuardError('Give the device a name first.', 404);
    const state = loadState();
    state.devices[name] = { ...(state.devices[name] ?? {}), internetOff: Boolean(off) };
    saveState(state);
    await reconcile();
}

/** Forgets a named device. It goes back to following the house's settings. */
export async function forgetDevice(name) {
    await post('/control/clients/delete', { name });
    const state = loadState();
    delete state.devices[name];
    saveState(state);
    await reconcile();
}

/**
 * Brings AdGuard's disallowed list in step with who should be cut off right
 * now -- switched off by hand, or in bedtime -- and follows a named device to
 * a new address when the router has handed it one.
 */
export async function reconcile(now = new Date()) {
    const state = loadState();
    const clients = await get('/control/clients');

    // A device the router has moved: the name it had then is now on an
    // address the device's entry does not list. Its old address goes, so
    // whoever is handed it next does not inherit its bedtime.
    // Only a name one device answers to: a house of phones all called
    // "iPhone" would otherwise pass one child's bedtime to another.
    const byName = new Map();
    const dupes = new Set();
    for (const a of clients.auto_clients ?? []) {
        if (a.source === 'etc/hosts' || !a.name || !isHouseAddress(a.ip)) continue;
        const n = a.name.toLowerCase();
        if (byName.has(n) && byName.get(n) !== a.ip) dupes.add(n);
        byName.set(n, a.ip);
    }
    for (const n of dupes) byName.delete(n);
    for (const c of clients.clients ?? []) {
        const host = state.devices[c.name]?.hostname;
        const ip = host && byName.get(host.toLowerCase());
        if (!ip || (c.ids ?? []).includes(ip)) continue;
        const ids = [...(c.ids ?? []).filter((id) => !IPV4.test(id)), ip];
        await post('/control/clients/update', { name: c.name, data: { ...c, ids } }).catch(() => {});
        c.ids = ids;
    }

    const want = new Set();
    for (const c of clients.clients ?? []) {
        const meta = state.devices[c.name];
        if (!meta) continue;
        if (meta.internetOff || inBedtime(meta.bedtime, now)) {
            // Addresses only: AdGuard's access list has no use for a MAC.
            for (const id of c.ids ?? []) if (isIp(id) || isCidr(id)) want.add(id);
        }
    }

    const access = await get('/control/access/list');
    const current = access.disallowed_clients ?? [];
    const owned = new Set(state.owned ?? []);
    const foreign = current.filter((x) => !owned.has(x));
    const next = [...new Set([...foreign, ...want])];
    const same = next.length === current.length && next.every((x) => current.includes(x));
    if (!same) {
        await post('/control/access/set', {
            allowed_clients: access.allowed_clients ?? [],
            disallowed_clients: next,
            blocked_hosts: access.blocked_hosts ?? [],
        });
    }
    const nextOwned = [...want].filter((x) => !foreign.includes(x));
    if (nextOwned.join() !== (state.owned ?? []).join()) {
        state.owned = nextOwned;
        saveState(state);
    }
}

let ticker = null;

/**
 * Keeps bedtimes on time. Once a minute, and only while AdGuard is running:
 * a stopped one has nobody to cut off.
 */
export function startScheduler(log = () => {}, isEnabled = () => true) {
    if (ticker) return;
    let lastError = '';
    ticker = setInterval(async () => {
        try {
            if (!isEnabled() || !(await containerState(CONTAINER)).running) return;
            await reconcile();
            lastError = '';
        } catch (err) {
            // Said once, not every minute.
            if (err.message !== lastError) log(`adguard: ${err.message}`);
            lastError = err.message;
        }
    }, 60_000);
    ticker.unref?.();
}

// ----------------------------------------------------------------- house --

async function houseFilters() {
    const [safe, parental, safebrowsing] = await Promise.all([
        get('/control/safesearch/status'),
        get('/control/parental/status'),
        get('/control/safebrowsing/status'),
    ]);
    return { safeSearch: Boolean(safe.enabled), adult: Boolean(parental.enabled), malware: Boolean(safebrowsing.enabled) };
}

/** The panel's allow and block lists are its own simple rules among AdGuard's. */
const ALLOW_RE = /^@@\|\|([a-z0-9.-]+)\^\$important$/;
const BLOCK_RE = /^\|\|([a-z0-9.-]+)\^$/;

function splitRules(rules) {
    const allow = [];
    const block = [];
    const other = [];
    for (const r of rules ?? []) {
        const a = ALLOW_RE.exec(r);
        const b = BLOCK_RE.exec(r);
        if (a) allow.push(a[1]);
        else if (b) block.push(b[1]);
        else if (r.trim()) other.push(r);
    }
    return { allow, block, other };
}

/** Everything that applies to the whole house. */
export async function house() {
    const state = loadState();
    const [status, filters, svc, filtering, dns] = await Promise.all([
        get('/control/status'),
        houseFilters(),
        get('/control/blocked_services/get'),
        get('/control/filtering/status'),
        get('/control/dns_info'),
    ]);
    const lists = (filtering.filters ?? []).map((f) => {
        const known = CATALOG.find((c) => c.url === f.url);
        return {
            url: f.url,
            name: f.name,
            enabled: Boolean(f.enabled),
            rules: f.rules_count ?? 0,
            updated: f.last_updated ?? null,
            catalog: known?.key ?? null,
            detail: known?.detail ?? null,
        };
    });
    for (const c of CATALOG) {
        if (!lists.some((l) => l.url === c.url)) {
            lists.push({ url: c.url, name: c.name, enabled: false, rules: 0, updated: null, catalog: c.key, detail: c.detail });
        }
    }
    const { allow, block, other } = splitRules(filtering.user_rules);
    const upstream =
        Object.entries(UPSTREAMS).find(([, u]) => u.servers.join() === (dns.upstream_dns ?? []).join())?.[0] ?? 'custom';
    return {
        protection: protectionOf(status),
        ...filters,
        services: svc.ids ?? [],
        servicesHours: hoursOf(svc.schedule),
        lists,
        allow,
        block,
        otherRules: other.length,
        upstream,
        upstreams: Object.entries(UPSTREAMS).map(([key, u]) => ({ key, label: u.label, detail: u.detail })),
        rateLimit: dns.ratelimit ?? 0,
        savedUpstream: state.upstream,
    };
}

/** Changes the house-wide switches that were sent, and nothing else. */
export async function setHouse(input) {
    if (input.safeSearch !== undefined) {
        const s = await get('/control/safesearch/status');
        await put('/control/safesearch/settings', { ...s, enabled: Boolean(input.safeSearch) });
    }
    if (input.adult !== undefined) await post(`/control/parental/${input.adult ? 'enable' : 'disable'}`);
    if (input.malware !== undefined) await post(`/control/safebrowsing/${input.malware ? 'enable' : 'disable'}`);
    if (Array.isArray(input.services)) {
        const known = new Set((await services()).services.map((s) => s.id));
        const ids = [...new Set(input.services.map(String))].filter((id) => known.has(id));
        let hours = null;
        if (input.servicesHours) {
            const from = toMinutes(input.servicesHours.from);
            const to = input.servicesHours.to === '24:00' ? 1440 : toMinutes(input.servicesHours.to);
            if (from === null || to === null || from >= to) {
                throw new AdGuardError('Allowed hours run from an earlier time to a later one, like 16:00 to 20:00.', 400);
            }
            hours = input.servicesHours;
        }
        await put('/control/blocked_services/update', { ids, schedule: scheduleFor(hours) });
    }
    if (input.upstream !== undefined) {
        if (!UPSTREAMS[input.upstream]) throw new AdGuardError('Unknown DNS provider.', 400);
        await applyUpstream(input.upstream);
        const state = loadState();
        state.upstream = input.upstream;
        saveState(state);
    }
    return house();
}

const URL_RE = /^https:\/\/[^\s"'<>]{4,500}$/;

/** Switches a list on or off, adding it first if it is one from the catalog. */
export async function setList({ url, enabled }) {
    const filtering = await get('/control/filtering/status');
    const have = (filtering.filters ?? []).find((f) => f.url === url);
    if (!have) {
        const known = CATALOG.find((c) => c.url === url);
        if (!known) throw new AdGuardError('That list is not one AdGuard has.', 404);
        if (!enabled) return;
        // Downloading and reading a big list takes a while.
        await call('POST', '/control/filtering/add_url', { name: known.name, url, whitelist: false }, { timeoutMs: 120_000 });
        return;
    }
    await call(
        'POST',
        '/control/filtering/set_url',
        { url, whitelist: false, data: { name: have.name, url, enabled: Boolean(enabled) } },
        { timeoutMs: 120_000 },
    );
}

export async function addList({ name, url }) {
    const n = String(name ?? '').trim() || 'My list';
    const u = String(url ?? '').trim();
    if (!URL_RE.test(u)) throw new AdGuardError('A list address starts with https://.', 400);
    if (!NAME_RE.test(n)) throw new AdGuardError('Give the list a short name.', 400);
    await call('POST', '/control/filtering/add_url', { name: n, url: u, whitelist: false }, { timeoutMs: 120_000 });
}

export async function removeList(url) {
    await post('/control/filtering/remove_url', { url, whitelist: false });
}

export async function refreshLists() {
    return call('POST', '/control/filtering/refresh', { whitelist: false }, { timeoutMs: 180_000 });
}

/** "example.com", from whatever was pasted: a link, a name, a *.wildcard. */
export function cleanDomain(raw) {
    let d = String(raw ?? '').trim().toLowerCase();
    d = d.replace(/^[a-z]+:\/\//, '').replace(/[/?#:].*$/, '').replace(/^\*\./, '').replace(/\.$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || d.length > 253) return null;
    return d;
}

/**
 * Puts a site on the allow list or the block list, or takes it off both
 * (`list` null). A site is only ever on one of them.
 */
export async function setDomain({ domain, list }) {
    const d = cleanDomain(domain);
    if (!d) throw new AdGuardError(`"${domain}" is not a website name.`, 400);
    if (list !== null && list !== 'allow' && list !== 'block') throw new AdGuardError('Unknown list.', 400);
    const filtering = await get('/control/filtering/status');
    const rules = (filtering.user_rules ?? []).filter((r) => {
        const a = ALLOW_RE.exec(r);
        const b = BLOCK_RE.exec(r);
        return !((a && a[1] === d) || (b && b[1] === d));
    });
    if (list === 'allow') rules.push(`@@||${d}^$important`);
    if (list === 'block') rules.push(`||${d}^`);
    await post('/control/filtering/set_rules', { rules });
    return { domain: d };
}

/** Why a site is or is not blocked, in words. */
export async function checkDomain(domain) {
    const d = cleanDomain(domain);
    if (!d) throw new AdGuardError(`"${domain}" is not a website name.`, 400);
    const [r, names] = await Promise.all([get(`/control/filtering/check_host?name=${encodeURIComponent(d)}`), serviceNames()]);
    return { domain: d, ...describe(r.reason, r.service_name, r.rules?.[0]?.text, names) };
}

const REASONS = {
    FilteredBlackList: 'Blocked by a blocklist',
    FilteredBlockedService: 'Blocked app',
    FilteredParental: 'Adult site',
    FilteredSafeBrowsing: 'Malware or phishing',
    FilteredSafeSearch: 'Safe search',
    NotFilteredAllowList: 'On the allow list',
    NotFilteredWhiteList: 'On the allow list',
    Rewrite: 'Rewritten',
    RewriteEtcHosts: 'Rewritten',
    RewriteRule: 'Rewritten',
};

function describe(reason, service, rule, serviceNames = new Map()) {
    const blocked = isBlockedReason(reason);
    let why = REASONS[reason] ?? (blocked ? 'Blocked' : 'Allowed');
    if (reason === 'FilteredBlockedService' && service) why = `Blocked app: ${serviceNames.get(service) ?? service}`;
    return { blocked, why, rule: rule ?? null };
}

/** The latest lookups, newest first, in words. */
export async function activity({ search = '', blocked = false, olderThan = '', limit = 100 } = {}) {
    const q = new URLSearchParams({ limit: String(Math.min(Math.max(Number(limit) || 100, 10), 500)) });
    if (search) q.set('search', String(search).slice(0, 200));
    if (blocked) q.set('response_status', 'blocked');
    if (olderThan) q.set('older_than', String(olderThan));
    const [log, clients, svcNames] = await Promise.all([get(`/control/querylog?${q}`), get('/control/clients'), serviceNames()]);
    const names = clientNames(clients);
    return {
        rows: (log.data ?? []).map((e) => ({
            time: e.time,
            ip: e.client,
            device: e.client_info?.name || names.get(e.client) || null,
            domain: e.question?.name ?? '',
            type: e.question?.type ?? '',
            ms: Math.round(Number(e.elapsedMs ?? 0) * 10) / 10,
            cached: Boolean(e.cached),
            ...describe(e.reason, e.service_name, e.rules?.[0]?.text, svcNames),
        })),
        oldest: log.oldest || null,
    };
}
