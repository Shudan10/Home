import { loadManagerConfig, saveManagerConfig } from './store.js';

const UPDATE_URL = 'https://www.duckdns.org/update';
const IP_SERVICES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];

export async function publicIp() {
    for (const url of IP_SERVICES) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) continue;
            const ip = (await res.text()).trim();
            if (/^[0-9a-fA-F.:]+$/.test(ip)) return ip;
        } catch {
            /* try the next one */
        }
    }
    return null;
}

export const DUCKDNS_SUFFIX = '.duckdns.org';

export const isDuckdnsName = (domain) => String(domain || '').trim().toLowerCase().endsWith(DUCKDNS_SUFFIX);

/**
 * The name DuckDNS actually knows about, which stops being the same thing as
 * the hostname as soon as subdomains are involved.
 *
 * DuckDNS answers for every label beneath a registered name -- register
 * `restohome` and `cloud.restohome.duckdns.org` resolves to whatever
 * `restohome` points at, for free and with nothing to set up. Its API, though,
 * only knows `restohome`: send it `cloud.restohome` and it updates nothing and
 * reports no error, which is the failure this exists to prevent.
 *
 * So the account is the last label before the suffix, and everything in front
 * of it is a subdomain that comes along for free.
 */
export function duckdnsAccount(domain) {
    const name = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
    if (!name.endsWith(DUCKDNS_SUFFIX)) return null;
    const labels = name.slice(0, -DUCKDNS_SUFFIX.length).split('.').filter(Boolean);
    return labels.length ? labels[labels.length - 1] : null;
}

/**
 * Strips hostnames down to the DuckDNS account labels, so every form is
 * accepted: `restohome`, `restohome.duckdns.org`, and
 * `cloud.restohome.duckdns.org` all mean the account `restohome`.
 *
 * This list is what gets sent to the update API, so it must hold accounts and
 * never subdomains. Deduplicated, because two published subdomains of one
 * account are still one thing to refresh.
 */
export const normalizeDomains = (input) => [
    ...new Set(
        String(input || '')
            .split(/[\s,]+/)
            .map((d) => {
                const raw = d.trim().toLowerCase();
                if (!raw) return '';
                // A bare label is already an account name; anything ending in
                // the suffix has to give up its subdomains first.
                return raw.endsWith(DUCKDNS_SUFFIX) ? (duckdnsAccount(raw) ?? '') : raw.split('.').pop();
            })
            .filter(Boolean),
    ),
];

/**
 * A subdomain plus a token is the whole condition for refreshing. There is no
 * separate on switch, because a record that is not kept current is worse than
 * no record at all -- it points at an address the machine has since lost.
 */
export const isConfigured = (dd) => Boolean(normalizeDomains(dd?.domains).length && dd?.token);

export async function update({ domains, token, ip } = {}) {
    const cfg = loadManagerConfig();
    const list = normalizeDomains(domains ?? cfg.duckdns.domains);
    const useToken = token ?? cfg.duckdns.token;

    if (!list.length) throw new Error('No DuckDNS subdomain configured.');
    if (!useToken) throw new Error('No DuckDNS token configured.');

    const url = new URL(UPDATE_URL);
    url.searchParams.set('domains', list.join(','));
    url.searchParams.set('token', useToken);
    // An empty ip makes DuckDNS use the source address of this request, which
    // is the right answer for the common case of a node behind a home router.
    url.searchParams.set('ip', ip ?? '');
    url.searchParams.set('verbose', 'true');

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.text()).trim();
    const ok = body.startsWith('OK');

    const next = loadManagerConfig();
    next.duckdns.lastRunAt = new Date().toISOString();
    next.duckdns.lastResult = ok ? `OK (${body.split('\n').slice(1).join(' ').trim() || 'no change'})` : `FAILED: ${body}`;
    saveManagerConfig(next);

    if (!ok) throw new Error(`DuckDNS rejected the update: ${body || 'empty response'}`);
    return { ok, body, domains: list.map((d) => `${d}.duckdns.org`) };
}

let timer = null;

/** (Re)arms the periodic refresh from the saved config. Safe to call anytime. */
export function scheduleFromConfig(log = () => {}) {
    if (timer) clearInterval(timer);
    timer = null;

    const cfg = loadManagerConfig();
    if (!isConfigured(cfg.duckdns)) return;

    const minutes = Math.max(5, Number(cfg.duckdns.intervalMinutes) || 5);
    const tick = () =>
        update().then(
            (r) => log(`duckdns: refreshed ${r.domains.join(', ')}`),
            (err) => log(`duckdns: ${err.message}`),
        );

    timer = setInterval(tick, minutes * 60_000);
    timer.unref?.();
    tick();
}
