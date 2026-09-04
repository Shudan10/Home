import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COMPOSE_FILE, CONF_DIR } from './paths.js';
import { readJson, writeJson, updateEnvFile, readEnvFile } from './store.js';

/**
 * The applications this home server can run.
 *
 * Each one lives behind a compose profile, so it does not exist until it is
 * switched on, and each declares everything the rest of the panel needs to know
 * about it: which services it is made of, which container decides whether it is
 * installed, where nginx should send a domain pointed at it, and which of its
 * ports are worth publishing to the host.
 *
 * Adding another app means an entry here, a block in docker-compose.yml, a unit
 * in lifecycle.js, a target kind in nginx.js, a row in publish.js, and a tab in
 * the frontend. Six places, deliberately explicit rather than generated.
 */

export const APPS_STATE_FILE = path.join(CONF_DIR, 'apps.json');
export const APPS_PORTS_OVERRIDE = path.join(CONF_DIR, 'apps-ports.yml');

export const APPS = {
    nextcloud: {
        label: 'Nextcloud',
        // Built from the local nextcloud/Dockerfile on top of the official
        // `nextcloud:stable` image, so there is no git ref behind it and
        // "commits behind" is not a question that has an answer here. An app
        // whose compose build context is `<repo>.git#<ref>` sets `repo` and
        // flips this on, and then the branch pickers and upstream checks in
        // this file apply to it.
        tracksRepo: false,
        repo: null,
        profile: 'nextcloud',
        services: ['nextcloud-db', 'nextcloud-redis', 'nextcloud-imaginary', 'nextcloud'],
        container: 'quickstart-home-nextcloud',
        // Where nginx sends a domain pointed at this app. The hostname is the
        // one compose gives the container on the internal network, so this
        // works whether or not the port is published to the host.
        publish: {
            hostname: 'nextcloud',
            port: 80,
            websocket: false,
            // Nextcloud is a file server: an upload is a single request that can
            // run to whatever size the person is storing, so the proxy must not
            // impose a limit of its own.
            maxBodySize: '0',
        },
        // Ports the container listens on, and whether publishing them is useful.
        ports: {
            web: { port: 80, label: 'Nextcloud web', hostPort: 8080 },
        },
    },

    jellyfin: {
        label: 'Jellyfin',
        // Pulled, not built: upstream publishes an official image and nobody
        // builds a media server from source, so there is no ref behind this.
        tracksRepo: false,
        repo: null,
        profile: 'jellyfin',
        services: ['jellyfin'],
        container: 'quickstart-home-jellyfin',
        publish: {
            hostname: 'jellyfin',
            port: 8096,
            // Its web client talks to the server over a websocket for playback
            // state and remote control, so a proxy that drops upgrades leaves a
            // UI that loads and then never updates itself.
            websocket: true,
            // Streaming a film is one long response and uploading artwork is a
            // large request; neither should meet a limit invented here.
            maxBodySize: '0',
        },
        ports: {
            web: { port: 8096, label: 'Jellyfin web', hostPort: 8096 },
        },
    },
};

export const DEFAULT_APPS_CONFIG = {
    nextcloud: {
        enabled: false,
        ref: 'main',
        publish: { web: true },
        hostPort: 8080,
        adminUser: 'admin',
        trustedDomains: 'localhost',
    },
    jellyfin: {
        enabled: false,
        ref: 'main',
        publish: { web: true },
        hostPort: 8096,
        // Host directories holding films, music and photos. Mounted read-only:
        // Jellyfin only ever reads a library, and a media server with write
        // access to somebody's only copy of their photographs is a bad trade
        // for a feature nobody asked for.
        mediaPaths: [],
        // Passes /dev/dri through so transcoding uses the GPU rather than the
        // CPU. Off by default: the device does not exist on every machine, and
        // a container asking for one that is not there refuses to start.
        hardwareAcceleration: false,
    },
};

/**
 * Host ports the stack already publishes, so an app cannot be pointed at one of
 * them. Docker's own error for this arrives long after the button was pressed
 * and reads like an internal fault, which is no help at all when the fix is
 * simply to pick another number.
 */
export function reservedHostPorts() {
    const panel = Number(process.env.GUI_PORT || 8420);
    return new Map([
        [panel, 'this control panel'],
        [80, 'the reverse proxy'],
        [443, 'the reverse proxy'],
    ]);
}

export function loadAppsConfig() {
    const stored = readJson(APPS_STATE_FILE, {});

    // Defaults are filled in per app, not just when the whole file is missing.
    // A file written before an app existed has no key for it, and returning
    // that as-is hands the panel a config with a hole in it: the page that
    // reads config.<app>.ref throws, stops before it populates the rest of the
    // form, and the next save posts those empty fields back as if they were
    // real. Adding an app has to be survivable by an install that predates it.
    const cfg = structuredClone(DEFAULT_APPS_CONFIG);
    for (const [name, defaults] of Object.entries(DEFAULT_APPS_CONFIG)) {
        const saved = stored[name] ?? {};
        cfg[name] = { ...defaults, ...saved };
        // publish is a nested object, so a shallow merge would drop any key the
        // saved copy happens not to carry.
        if (defaults.publish) cfg[name].publish = { ...defaults.publish, ...(saved.publish ?? {}) };
    }

    // A saved port that is now reserved could never start, so move it forward
    // rather than leaving somebody with a setting that only fails.
    if (reservedHostPorts().has(Number(cfg.nextcloud.hostPort))) {
        cfg.nextcloud.hostPort = DEFAULT_APPS_CONFIG.nextcloud.hostPort;
    }
    return cfg;
}

export const saveAppsConfig = (cfg) => writeJson(APPS_STATE_FILE, cfg);

// ------------------------------------------------------------- validation --

// Git ref names: no "..", which is also what the panel's "something else"
// placeholder contains, so a placeholder can never be saved as a branch.
const REF_RE = /^(?!.*\.\.)[A-Za-z0-9._\/-]{1,100}$/;
const DOMAIN_LIST_RE = /^[A-Za-z0-9.\-, ]{0,300}$/;

// A media folder is a host path, so it has to be absolute and it has to be safe
// to paste into the generated compose override. Spaces are allowed -- "My
// Movies" is an ordinary directory name -- but quotes, colons, newlines and
// control characters are not: the override writes each mount as a quoted
// "source:target:ro" string, and any of those would break out of it.
const MEDIA_PATH_RE = /^\/[^\0-\x1f"':]*$/;
const MAX_MEDIA_PATHS = 24;

/** '/srv/Media/Films/' and '/srv/Media/Films' are the same folder. */
const normalizeMediaPath = (value) => {
    const raw = String(value ?? '').trim();
    if (raw === '/') return '/';
    return raw.replace(/\/+$/, '');
};

/**
 * Where a host folder appears inside the container.
 *
 * Named after the folder rather than numbered, because this is what shows up in
 * Jellyfin's own "add a library" file picker, and /media/Films is answerable
 * where /media/1 is not. Duplicates are suffixed, since two different paths can
 * easily end in the same word.
 */
export function mediaMounts(paths) {
    const used = new Set();
    return paths.map((path) => {
        const base = (path.split('/').filter(Boolean).pop() || 'media').replace(/[^A-Za-z0-9._-]+/g, '-');
        let name = base;
        for (let i = 2; used.has(name); i += 1) name = `${base}-${i}`;
        used.add(name);
        return { path, target: `/media/${name}`, name };
    });
}

function validateMediaPaths(input, errors) {
    const seen = new Set();
    const out = [];

    for (const entry of Array.isArray(input) ? input : []) {
        const path = normalizeMediaPath(entry);
        if (!path) continue;
        if (out.length >= MAX_MEDIA_PATHS) {
            errors.push(`That is more than ${MAX_MEDIA_PATHS} media folders, which is more than this is meant for.`);
            break;
        }
        if (!path.startsWith('/')) {
            errors.push(`"${path}" is not a full path. It has to start with a / and be the path on this machine.`);
        } else if (!MEDIA_PATH_RE.test(path)) {
            errors.push(`"${path}" contains a character that cannot be used in a folder path here (quotes and colons).`);
        } else if (path.split('/').includes('..')) {
            errors.push(`"${path}" contains "..", so write the real path instead.`);
        } else if (path === '/') {
            errors.push('Mounting the whole filesystem into Jellyfin is not something this will do. Pick the folder your media is actually in.');
        } else if (seen.has(path)) {
            errors.push(`"${path}" is listed twice.`);
        } else {
            seen.add(path);
            out.push(path);
        }
    }
    return out;
}

/**
 * Whether these folders actually exist on the host.
 *
 * Worth its own check because of how Docker fails here: a bind mount whose
 * source is missing is not an error, it is a *creation* -- the daemon makes an
 * empty root-owned directory at that path and mounts that. So a typo does not
 * produce a complaint, it produces a Jellyfin with an empty library, a
 * directory nobody meant to make, and no clue connecting the two.
 *
 * The probe mounts the host root read-only into a throwaway container, which
 * cannot create anything, and asks about each path. It grants no access the
 * manager does not already have -- it holds the Docker socket, which is root on
 * this machine -- and it is the only way to see the host filesystem from in
 * here.
 */
export async function verifyHostPaths(docker, paths) {
    if (!paths.length) return [];
    try {
        const { stdout } = await docker(
            [
                'run',
                '--rm',
                '-v',
                '/:/host:ro',
                'alpine:3.21',
                'sh',
                '-c',
                // NUL-separated in, one verdict per line out, so a path with a
                // space or a newline in it cannot be split into two arguments.
                paths.map((p) => `[ -d "/host${p.replace(/"/g, '')}" ] && echo yes || echo no`).join('; '),
            ],
            { timeoutMs: 60_000 },
        );
        const verdicts = stdout.trim().split('\n');
        return paths.map((path, i) => ({ path, exists: verdicts[i] === 'yes' }));
    } catch {
        // Could not check. Treated as "no opinion" rather than "missing": a
        // failure to run the probe is not evidence about somebody's disk, and
        // refusing the save on it would make a broken docker into a broken form.
        return paths.map((path) => ({ path, exists: null }));
    }
}

export function validateAppsConfig(input) {
    const errors = [];
    const cfg = structuredClone(DEFAULT_APPS_CONFIG);

    const n = input.nextcloud ?? {};
    cfg.nextcloud.enabled = Boolean(n.enabled);
    // The ref is interpolated into a compose build context, so it has to stay
    // inside the characters git refs are allowed to use.
    const nref = String(n.ref ?? 'main').trim();
    if (!REF_RE.test(nref)) errors.push('Nextcloud branch or tag contains invalid characters.');
    else cfg.nextcloud.ref = nref;

    cfg.nextcloud.publish = { web: n.publish?.web !== false };

    const port = Number(n.hostPort ?? DEFAULT_APPS_CONFIG.nextcloud.hostPort);
    const taken = reservedHostPorts().get(port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        errors.push('Nextcloud port must be between 1024 and 65535.');
    } else if (taken && cfg.nextcloud.publish.web) {
        errors.push(
            `Port ${port} is already used by ${taken}, so Nextcloud cannot start on it. Pick another one, ` +
                `for example ${port + 1}.`,
        );
    } else {
        cfg.nextcloud.hostPort = port;
    }

    const user = String(n.adminUser ?? 'admin').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) errors.push('Nextcloud admin user is invalid.');
    else cfg.nextcloud.adminUser = user;

    const domains = String(n.trustedDomains ?? 'localhost').trim();
    if (!DOMAIN_LIST_RE.test(domains)) {
        errors.push('Trusted domains may only contain hostnames, separated by spaces or commas.');
    } else {
        // Stored space separated whatever was typed. NEXTCLOUD_TRUSTED_DOMAINS is
        // read by a shell `for` loop over an unquoted variable, so it splits on
        // whitespace and a comma would stay stuck to the hostname before it.
        cfg.nextcloud.trustedDomains = domains.split(/[\s,]+/).filter(Boolean).join(' ') || 'localhost';
    }

    // --- Jellyfin ---
    const j = input.jellyfin ?? {};
    cfg.jellyfin.enabled = Boolean(j.enabled);
    cfg.jellyfin.publish = { web: j.publish?.web !== false };
    cfg.jellyfin.hardwareAcceleration = Boolean(j.hardwareAcceleration);

    const jport = Number(j.hostPort ?? DEFAULT_APPS_CONFIG.jellyfin.hostPort);
    const jtaken = reservedHostPorts().get(jport);
    if (!Number.isInteger(jport) || jport < 1024 || jport > 65535) {
        errors.push('Jellyfin port must be between 1024 and 65535.');
    } else if (jport === Number(cfg.nextcloud.hostPort) && cfg.jellyfin.publish.web && cfg.nextcloud.publish.web) {
        errors.push(`Port ${jport} is where Nextcloud is published, so Jellyfin cannot take it too.`);
    } else if (jtaken && cfg.jellyfin.publish.web) {
        errors.push(
            `Port ${jport} is already used by ${jtaken}, so Jellyfin cannot start on it. Pick another one, ` +
                `for example ${jport + 1}.`,
        );
    } else {
        cfg.jellyfin.hostPort = jport;
    }

    cfg.jellyfin.mediaPaths = validateMediaPaths(j.mediaPaths, errors);

    return { cfg, errors };
}

/**
 * Whether this machine has a GPU to hand to a container.
 *
 * `/dev/dri` is what the kernel exposes for render devices, and a `devices:`
 * entry naming a path that is not there stops the container from starting --
 * so this is checked before the setting is accepted rather than discovered as
 * a Jellyfin that will not come up. Same read-only probe as the media folders,
 * for the same reason: the manager cannot see the host filesystem otherwise.
 */
export async function hasRenderDevice(docker) {
    try {
        await docker(['run', '--rm', '-v', '/:/host:ro', 'alpine:3.21', 'test', '-d', '/host/dev/dri'], {
            timeoutMs: 60_000,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Reasons an app cannot be switched on right now.
 *
 * Nothing blocks Nextcloud today -- it depends on nothing else in the stack --
 * but the hook is what lets a future app say "this needs the proxy running"
 * plainly, at the moment somebody asks for it, rather than failing later.
 */
export function appBlockers() {
    return [];
}

// ---------------------------------------------------------------- secrets --

const randomSecret = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

/**
 * Database passwords and shared secrets are generated once and then left alone
 * -- regenerating them would lock the apps out of their own existing volumes.
 */
export function ensureSecrets() {
    const env = readEnvFile();
    const updates = {};
    const need = {
        NEXTCLOUD_DB_PASSWORD: () => randomSecret(24),
        NEXTCLOUD_DB_ROOT_PASSWORD: () => randomSecret(24),
        NEXTCLOUD_IMAGINARY_SECRET: () => randomSecret(24),
        NEXTCLOUD_ADMIN_PASSWORD: () => randomSecret(18),
    };
    for (const [key, make] of Object.entries(need)) {
        if (!env[key]) updates[key] = make();
    }
    if (Object.keys(updates).length) updateEnvFile(updates);
    return { ...env, ...updates };
}

/** Writes the non-secret settings the compose file reads for these services. */
export function writeAppsEnv(cfg) {
    updateEnvFile({
        NEXTCLOUD_ADMIN_USER: cfg.nextcloud.adminUser,
        NEXTCLOUD_TRUSTED_DOMAINS: cfg.nextcloud.trustedDomains,
    });
}

// -------------------------------------------------------------- port file --

/**
 * Whether the base compose file actually defines a service.
 *
 * This override is merged into every compose command, so a block naming a
 * service the base file has never heard of does not break one app: it makes the
 * whole project invalid ("neither an image nor a build context specified"), and
 * every compose call the panel makes stops working.
 *
 * That state is reachable whenever the manager is newer than the stack files on
 * disk, which is exactly what an update looks like from the inside. Skipping the
 * block is the graceful version: the app cannot publish a port until its service
 * exists, and nothing else is affected.
 */
function composeDefines(service) {
    try {
        return new RegExp(`^\\s{2}${service}:\\s*$`, 'm').test(fs.readFileSync(COMPOSE_FILE, 'utf8'));
    } catch {
        // Unreadable compose file: write nothing rather than risk poisoning it.
        return false;
    }
}

export function renderAppsPortsOverride(cfg) {
    const header = [
        '# Generated by the Quick Start Home panel - edits here are overwritten.',
        '#',
        '# Everything about the optional applications that is only knowable once',
        '# somebody has said so: which ports are published, which host folders are',
        '# mounted, and whether a GPU is passed through.',
    ];
    const blocks = [];
    const published = { nextcloud: [], jellyfin: [] };

    if (composeDefines('nextcloud')) {
        blocks.push('  nextcloud:');
        blocks.push('    ports:');
        if (cfg.nextcloud.publish.web) {
            blocks.push(`      - "0.0.0.0:${cfg.nextcloud.hostPort}:80/tcp"`);
            published.nextcloud = [cfg.nextcloud.hostPort];
        } else {
            blocks.push('      []');
        }
    }

    if (composeDefines('jellyfin')) {
        blocks.push('  jellyfin:');
        blocks.push('    ports:');
        if (cfg.jellyfin.publish.web) {
            blocks.push(`      - "0.0.0.0:${cfg.jellyfin.hostPort}:8096/tcp"`);
            published.jellyfin = [cfg.jellyfin.hostPort];
        } else {
            blocks.push('      []');
        }

        // Compose merges volumes by their target path rather than replacing the
        // list, so naming only the media here keeps the config and cache
        // volumes the base file declares.
        const mounts = mediaMounts(cfg.jellyfin.mediaPaths ?? []);
        if (mounts.length) {
            blocks.push('    volumes:');
            // `ro` is not a default worth leaving to chance: this is somebody's
            // media library, and Jellyfin never needs to write to it.
            for (const m of mounts) blocks.push(`      - "${m.path}:${m.target}:ro"`);
        }

        // Only written when asked for. A `devices:` entry naming a device that
        // does not exist stops the container from starting at all, which is a
        // worse outcome than software transcoding.
        if (cfg.jellyfin.hardwareAcceleration) {
            blocks.push('    devices:');
            blocks.push('      - "/dev/dri:/dev/dri"');
        }
    }

    // `services:` is only written when something goes under it. A bare
    // `services:` key parses as null, which compose rejects outright with
    // "services must be a mapping" -- and this file is merged into every
    // compose call the panel makes, so that one line would break all of them.
    // Reachable whenever composeDefines finds nothing, which is exactly the
    // case this file already takes care to survive. A comment-only override is
    // valid YAML and merges to nothing, which is the intended no-op.
    const lines = blocks.length ? [...header, 'services:', ...blocks] : header;

    fs.mkdirSync(CONF_DIR, { recursive: true });
    fs.writeFileSync(APPS_PORTS_OVERRIDE, `${lines.join('\n')}\n`, 'utf8');
    return published;
}

// --------------------------------------------------------------- upstream --

const ghHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'quickstart-home-manager',
    'X-GitHub-Api-Version': '2022-11-28',
};

/**
 * The branches and tags a repository actually has, so the branch to track can
 * be picked from a list rather than typed from memory.
 *
 * GitHub allows sixty unauthenticated calls an hour per address, and this costs
 * two of them, so the answer is held for a while. Refreshing is an explicit
 * action in the panel rather than something that happens on every page load.
 */
const refsCache = new Map();
const REFS_CACHE_MS = 10 * 60_000;

async function ghList(url, take) {
    const res = await fetch(url, { headers: ghHeaders, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
        const hint = res.status === 403 ? ' (GitHub rate limit, try again shortly)' : '';
        throw new Error(`GitHub returned ${res.status}${hint}`);
    }
    return (await res.json()).map(take);
}

export async function listRefs(name, { force = false } = {}) {
    const app = APPS[name];
    if (!app) throw new Error(`Unknown app "${name}".`);
    if (!app.tracksRepo) throw new Error(`${app.label} is not built from a git repository.`);

    const hit = refsCache.get(name);
    if (!force && hit && Date.now() - hit.at < REFS_CACHE_MS) return hit.value;

    const base = `https://api.github.com/repos/${app.repo}`;
    // Tags are a nice-to-have; a repository with none is normal, and a failure
    // to list them should not cost the branches too.
    const [branches, tags] = await Promise.all([
        ghList(`${base}/branches?per_page=100`, (b) => b.name),
        ghList(`${base}/tags?per_page=100`, (t) => t.name).catch(() => []),
    ]);

    const value = { repo: app.repo, branches, tags };
    refsCache.set(name, { at: Date.now(), value });
    return value;
}

/**
 * How far the tracked branch has moved since the running image was built. These
 * projects publish no releases, so the honest unit is "commits behind", not a
 * version number.
 */
export async function checkUpstream(name, cfg) {
    const app = APPS[name];
    if (!app) throw new Error(`Unknown app "${name}".`);
    if (!app.tracksRepo) throw new Error(`${app.label} is not built from a git repository.`);
    const ref = cfg[name].ref;

    const res = await fetch(`https://api.github.com/repos/${app.repo}/commits/${encodeURIComponent(ref)}`, {
        headers: ghHeaders,
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        const hint = res.status === 403 ? ' (GitHub API rate limit - try again shortly)' : '';
        throw new Error(`GitHub returned ${res.status} for ${app.repo}@${ref}${hint}`);
    }
    const commit = await res.json();

    return {
        repo: app.repo,
        ref,
        latestSha: commit.sha,
        shortSha: String(commit.sha).slice(0, 7),
        message: (commit.commit?.message || '').split('\n')[0].slice(0, 200),
        author: commit.commit?.author?.name || null,
        date: commit.commit?.author?.date || null,
        url: commit.html_url,
    };
}

/** The commit an image was actually built from, if the build recorded one. */
export function buildRecordFile(name) {
    return path.join(CONF_DIR, `${name}-build.json`);
}

export function readBuildRecord(name) {
    return readJson(buildRecordFile(name), { sha: null, ref: null, builtAt: null });
}

export function writeBuildRecord(name, record) {
    writeJson(buildRecordFile(name), record);
}

/**
 * How the last attempt to start or stop an app turned out.
 *
 * Without this, an app whose build failed looks exactly like one that is still
 * building: switched on, no container, and a panel that says "starting up"
 * forever. The job that failed is in memory only, so it is gone the moment the
 * manager restarts, and the reason for the failure goes with it.
 */
const lastRunFile = (name) => path.join(CONF_DIR, `${name}-lastrun.json`);

export function readLastRun(name) {
    return readJson(lastRunFile(name), { ok: null, error: null, at: null, enabled: null });
}

export function writeLastRun(name, record) {
    writeJson(lastRunFile(name), { ...record, error: summarizeError(record.error), at: new Date().toISOString() });
}

/**
 * Picks the one line worth showing out of a failed build.
 *
 * A broken `docker compose build` reports itself with a page of context: the
 * Dockerfile excerpt, the layer graph, the numbered step. The sentence that
 * says what actually went wrong is somewhere in the middle, so it gets found
 * and the rest is left to the log.
 */
export function summarizeError(error) {
    if (!error) return null;
    const lines = String(error)
        .split('\n')
        // BuildKit stamps every line with its step number and a timestamp
        // ("#25 6.607 error: ..."), which hides the start of the real message.
        .map((l) => l.trim().replace(/^#\d+\s+[\d.]+\s+/, ''))
        .filter(Boolean);

    const pick =
        // A compiler or tool saying why, which is the most useful thing there is.
        lines.find((l) => /^error(\[[^\]]+\])?:/i.test(l)) ??
        // BuildKit's summary of which step died.
        lines.find((l) => l.startsWith('failed to solve:')) ??
        lines[0];

    const trimmed = pick.length > 240 ? `${pick.slice(0, 237)}...` : pick;
    return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
}

// ------------------------------------------------------- nextcloud runtime --

/**
 * Nextcloud settings that only take effect at install time.
 *
 * The image reads NEXTCLOUD_TRUSTED_DOMAINS once, inside the branch that runs
 * the first-time install. Change the value afterwards and nothing happens: the
 * container is already installed, so that branch never runs again. The panel
 * would look like it had applied a setting it had not.
 *
 * The same is true of the admin password, which is only used to create the
 * account. Both are therefore applied with `occ` against the running container,
 * which is what the install would have done.
 *
 * Everything here needs the container up. A stopped Nextcloud simply defers:
 * whatever is in the config is applied the next time this runs.
 */
export const NEXTCLOUD_CONTAINER = APPS.nextcloud.container;

/** Runs an `occ` command as the web user inside the Nextcloud container. */
function occArgs(args, { env = {} } = {}) {
    const envFlags = Object.keys(env).flatMap((k) => ['-e', `${k}=${env[k]}`]);
    return ['exec', '-u', 'www-data', ...envFlags, NEXTCLOUD_CONTAINER, 'php', 'occ', ...args];
}

/**
 * Rewrites the trusted-domain list to match the config.
 *
 * Indices are positional, so the list is written from 0 upward and anything
 * left over from a longer previous list is removed. Without that, shortening
 * the list would leave the dropped names still trusted.
 */
export async function syncTrustedDomains(docker, cfg, onLine = () => {}) {
    const wanted = String(cfg.nextcloud.trustedDomains || 'localhost')
        .split(/[\s,]+/)
        .filter(Boolean);
    if (!wanted.length) return;

    for (const [i, domain] of wanted.entries()) {
        await docker(occArgs(['config:system:set', 'trusted_domains', String(i), '--value', domain]));
    }
    // Clear stale trailing entries. `occ` exits non-zero once there is nothing
    // at an index, which is the signal to stop rather than an error.
    for (let i = wanted.length; i < wanted.length + 10; i++) {
        try {
            await docker(occArgs(['config:system:delete', 'trusted_domains', String(i)]));
        } catch {
            break;
        }
    }
    onLine(`Trusted domains: ${wanted.join(', ')}`);
}

/**
 * Which Nextcloud is actually running.
 *
 * The honest version number for this app, and the one a git sha was standing in
 * for badly: the image is built on `nextcloud:stable`, so what is installed is
 * whatever that tag pointed at on the day it was built. Nextcloud knows, so it
 * gets asked.
 *
 * Only answerable while the container is up. A stopped one returns null and the
 * panel falls back to saying when the image was built.
 */
export async function nextcloudVersion(docker) {
    try {
        const { stdout } = await docker(
            ['exec', '-u', 'www-data', NEXTCLOUD_CONTAINER, 'php', 'occ', 'status', '--output=json'],
            { timeoutMs: 30_000 },
        );
        const status = JSON.parse(stdout.trim());
        return status.versionstring || null;
    } catch {
        return null;
    }
}

/** The admin account's name and password, as the panel needs to show them. */
export function nextcloudAdmin() {
    const env = readEnvFile();
    return {
        user: env.NEXTCLOUD_ADMIN_USER || 'admin',
        password: env.NEXTCLOUD_ADMIN_PASSWORD || '',
    };
}

/**
 * Changes the admin password on the running instance and records the new one.
 *
 * `occ` takes it from the environment rather than an argument, so it never
 * appears in the container's process list.
 */
export async function setNextcloudAdminPassword(docker, password) {
    const { user } = nextcloudAdmin();
    await docker(occArgs(['user:resetpassword', '--password-from-env', user], { env: { OC_PASS: password } }), {
        timeoutMs: 120_000,
    });
    updateEnvFile({ NEXTCLOUD_ADMIN_PASSWORD: password });
}
