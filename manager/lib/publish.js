import { APPS, loadAppsConfig } from './apps.js';
import { loadManagerConfig, loadProxies } from './store.js';
import { TARGET_KINDS } from './nginx.js';

/**
 * What can be given a public web address: the apps first, then the panel that
 * runs all of it.
 *
 * The advanced proxy screen asks the question the other way round -- add a
 * domain, then pick an upstream from a list of ports -- which means knowing
 * which port a service answers on before you can publish it. A service is the
 * thing a person actually wants to put on a domain, so a service is what this
 * lists, and the port behind it is nobody's business but this file's.
 *
 * `kind` is the proxy target kind, so an assignment made here produces exactly
 * the proxy host the advanced screen would have produced.
 */
export const SERVICES = [
    {
        key: 'nextcloud',
        kind: 'nextcloud',
        sharedPath: '/cloud',
        label: 'Nextcloud',
        detail: 'Files, photos and calendars.',
        afterNote:
            'Nextcloud is at https://{domain}. The panel adds the name to its trusted domains for you, so it is ready to sign in to.',
    },
    {
        key: 'panel',
        kind: 'manager',
        sharedPath: '/panel',
        label: 'This control panel',
        detail: 'Everything on this page, from anywhere.',
        afterNote: 'This panel is at https://{domain}. It drives the Docker daemon, so keep the admin password somewhere safe.',
    },
];

export const serviceFor = (key) => SERVICES.find((s) => s.key === key) ?? null;

/**
 * Where a service should sit on a name, given what is already there.
 *
 * One free DuckDNS name is all most people will have, so sharing has to be the
 * easy case rather than the clever one. The first service on a name takes the
 * root; anything joining it moves to its own prefix, which nginx strips before
 * the request arrives.
 */
export function pathFor(service, domain, proxies) {
    const others = proxies.filter((p) => p.domain === domain && p.target?.kind !== service.kind);
    // Nothing else there: take the root, whoever you are.
    if (!others.length) return { path: '/', sharedWith: [] };

    const rootTaken = others.some((p) => (p.path ?? '/') === '/');
    if (!rootTaken) return { path: '/', sharedWith: others };

    if (service.rootOnly) {
        const holder = others.find((p) => (p.path ?? '/') === '/');
        const err = new Error(
            `${service.label} has to answer at the root of a name, and ${domain} already serves ${
                SERVICES.find((sv) => sv.kind === holder.target?.kind)?.label ?? 'something else'
            } there.`,
        );
        err.details = [`Give ${service.label} a name of its own, or move the other service off the root first.`];
        throw err;
    }

    return { path: service.sharedPath ?? `/${service.key}`, sharedWith: others };
}

/**
 * Whether publishing a service would reach anything today, and if not, why.
 *
 * A domain can be assigned before its service is switched on -- nginx renders
 * the vhost either way and the upstream simply answers once it exists -- so
 * this never blocks. It is the difference between "this will work" and "this is
 * ready, but nothing is listening yet", which is worth saying out loud rather
 * than leaving someone to discover through a 502.
 */
export function readiness({ appsCfg = loadAppsConfig(), panelHasPassword = true } = {}) {
    const state = {};

    for (const key of Object.keys(APPS)) {
        state[key] = appsCfg[key]?.enabled
            ? { ready: true }
            : { ready: false, reason: `${APPS[key].label} is switched off on its own tab.` };
    }

    // The panel is the one service where publishing is refused rather than
    // merely unready: without a password, a domain would hand the Docker daemon
    // to anyone who found it. nginx.validateProxy enforces this too; saying it
    // here is what stops the dropdown from looking available in the first place.
    state.panel = panelHasPassword
        ? { ready: true }
        : {
              ready: false,
              blocked: true,
              reason: 'This panel has no admin password, so it cannot go on a domain. Set one under Global settings, then come back.',
          };

    return state;
}

/** The service view: every publishable thing, with the domain it answers on. */
export function overview({ proxies = loadProxies(), panelHasPassword = true } = {}) {
    const ready = readiness({ panelHasPassword });
    // The address someone can paste into a browser, which is not the same as
    // the name when a router put a different port in front of this machine.
    const mgr = loadManagerConfig().proxy;
    const portFor = (scheme) => {
        const port = scheme === 'https' ? (mgr.publicHttpsPort ?? 443) : (mgr.publicHttpPort ?? 80);
        return Number(port) === (scheme === 'https' ? 443 : 80) ? '' : `:${Number(port)}`;
    };

    return SERVICES.map((service) => {
        // The proxy host this service owns, if one has been assigned. Matching
        // on the target kind is what makes the two screens the same data: a
        // host added by hand on the advanced screen shows up here too.
        const proxy = proxies.find((p) => p.target?.kind === service.kind) ?? null;
        return {
            ...service,
            upstreamLabel: TARGET_KINDS[service.kind]?.label ?? service.kind,
            domain: proxy?.domain ?? null,
            proxyId: proxy?.id ?? null,
            path: proxy?.path ?? null,
            url: proxy
                ? `${proxy.ssl?.mode === 'letsencrypt' ? 'https' : 'http'}://${proxy.domain}${portFor(
                      proxy.ssl?.mode === 'letsencrypt' ? 'https' : 'http',
                  )}${(proxy.path ?? '/') === '/' ? '' : proxy.path}`
                : null,
            ...ready[service.key],
        };
    });
}

/**
 * Everything that has to become true before a service answers on a domain, in
 * the order the wizard will do it.
 *
 * This is deliberately a plan rather than a checklist: someone setting up a
 * public address should not have to know that an app needs its containers
 * running, or that a certificate cannot be issued before nginx is up. They
 * should say "publish this on that name" once, see what that entails, and agree
 * to it.
 *
 * Steps already satisfied are returned with `done: true` rather than dropped,
 * so the wizard can show the whole shape of the job and tick off the parts that
 * are already in place.
 */
export function setupPlan(key, { appsCfg = loadAppsConfig(), panelHasPassword = true, proxyOn = false } = {}) {
    const service = serviceFor(key);
    if (!service) return null;

    const steps = [
        {
            key: 'proxy',
            label: 'Start the reverse proxy',
            detail: 'It takes ports 80 and 443 on this machine and serves every domain you publish.',
            done: proxyOn,
        },
    ];

    if (APPS[key]) {
        steps.push({
            key: 'app',
            label: `Switch ${APPS[key].label} on`,
            detail: 'Builds its images if they are missing, then starts its containers.',
            done: Boolean(appsCfg[key]?.enabled),
        });
    }

    steps.push({
        key: 'dns',
        label: 'Point the DuckDNS name at this machine',
        detail: "Saves the subdomain and token, then tells DuckDNS this connection's address. It keeps itself current from then on.",
        done: false,
    });
    steps.push({
        key: 'publish',
        label: `Publish ${service.label} on the name`,
        detail: 'Writes the nginx vhost for the domain.',
        done: false,
    });
    steps.push({
        key: 'certificate',
        label: "Get an HTTPS certificate from Let's Encrypt",
        detail: 'Needs the name to resolve here and port 80 open from the internet. Renewal is automatic afterwards.',
        done: false,
    });

    // The one thing the wizard cannot do for you. Publishing the panel without
    // a password hands the Docker daemon to whoever finds the address.
    const blocked =
        key === 'panel' && !panelHasPassword
            ? 'This panel has no admin password. Set one under Global settings before putting it on a domain: it holds the Docker socket, so an address without a password is the whole machine.'
            : null;

    return { service, steps, blocked };
}
