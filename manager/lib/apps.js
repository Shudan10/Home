import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COMPOSE_FILE, CONF_DIR } from './paths.js';
import { readJson, writeJson, updateEnvFile, readEnvFile } from './store.js';
import { builtOn, envMap, resolveTag, tagExists } from './registry.js';

/**
 * The applications this home server can run.
 *
 * Each one lives behind a compose profile, so it does not exist until it is
 * switched on, and each declares everything the rest of the panel needs to know
 * about it: which services it is made of, which container decides whether it is
 * installed, where the tunnel sends a name published for it, and which of its
 * ports are worth publishing to the host.
 *
 * Adding another app means an entry here, a block in docker-compose.yml, a unit
 * in lifecycle.js, a row in tunnel.js's SERVICES, its container in the teardown
 * lists, and a tab in the frontend. The README lists them; deliberately
 * explicit rather than generated.
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
        // Where the tunnel sends a name published for this app: the hostname
        // compose gives the container on the stack network, so it works whether
        // or not the port is also published on the machine.
        publish: { hostname: 'nextcloud', port: 80 },
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
        // Where the tunnel sends a name published for this app: the hostname
        // compose gives the container on the stack network, so it works whether
        // or not the port is also published on the machine.
        publish: { hostname: 'jellyfin', port: 8096 },
        ports: {
            web: { port: 8096, label: 'Jellyfin web', hostPort: 8096 },
        },
    },

    mealplan: {
        label: 'Meal Plan',
        // Built from its own repository, so the branch pickers and upstream
        // checks in this file apply to it -- the only app here that they do.
        tracksRepo: true,
        repo: 'Shudan10/MealPlan',
        profile: 'mealplan',
        services: ['mealplan'],
        container: 'quickstart-home-mealplan',
        // Where the tunnel sends a name published for this app: the hostname
        // compose gives the container on the stack network, so it works whether
        // or not the port is also published on the machine.
        publish: { hostname: 'mealplan', port: 8080 },
        ports: {
            web: { port: 8080, label: 'Meal Plan web', hostPort: 8083 },
        },
    },

    minecraft: {
        label: 'Minecraft',
        // Pulled, not built: itzg/minecraft-server is the image nearly every
        // self-hosted server runs, and it fetches the server itself (Paper) and
        // the Bedrock bridge (Geyser and Floodgate) when it starts.
        tracksRepo: false,
        repo: null,
        profile: 'minecraft',
        services: ['minecraft'],
        container: 'quickstart-home-minecraft',
        // Not a web page, so there is nothing for the tunnel to publish:
        // Cloudflare's tunnel carries HTTP, and a game is raw TCP and UDP.
        // Players outside the house come in through a forwarded port instead.
        publish: null,
        ports: {
            java: { port: 25565, label: 'Java Edition', hostPort: 25565, protocol: 'tcp' },
            bedrock: { port: 19132, label: 'Bedrock Edition', hostPort: 19132, protocol: 'udp' },
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
        // Nextcloud refuses any Host it was not told about, so a default of
        // just "localhost" means it works on the machine itself and answers
        // 400 to every other device on the network -- including the phone the
        // panel's own link was opened from. The private ranges are wildcarded
        // so a LAN address works wherever it is reached from; a public name is
        // added to this list when one is attached.
        //
        // Not 172.16.*.*: Nextcloud's wildcard is per octet, so that only ever
        // covered 172.16.x.x and not the rest of the 172.16/12 private range,
        // and the only thing that was meant to come from there -- the docker
        // networks -- is a proxy, which TRUSTED_PROXIES handles. A home
        // network that really is numbered 172.x gets its own address added
        // when Nextcloud starts.
        trustedDomains: 'localhost 192.168.*.* 10.*.*.*',
        // Folders that already exist on this machine, shown inside Nextcloud
        // where they are rather than copied into it.
        //
        // The alternative is what people do by default: point the desktop sync
        // client at a folder and let it upload. That works, and on a machine
        // that is also the server it stores everything twice on one disk --
        // measured at 219GB of films held as two independent copies here, on a
        // filesystem with no way to share blocks between them. These mounts are
        // the same folder seen from both sides instead.
        sharedPaths: [],
        // Filled in when the folders are applied; see ownerGids.
        sharedGids: [],
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
    mealplan: {
        enabled: false,
        ref: 'main',
        publish: { web: true },
        hostPort: 8083,
    },
    minecraft: {
        enabled: false,
        // Mojang's licence, which the server refuses to start without. Off
        // until the person running it ticks the box: agreeing to somebody's
        // terms is theirs to do, not a default.
        eula: false,
        // The ports a game client assumes when none is typed. Moving either
        // works, but then everybody has to type it.
        javaPort: 25565,
        bedrockPort: 19132,
        // LATEST follows each new release as Paper supports it, which is also
        // what keeps Bedrock working: Geyser tracks the newest Java version.
        version: 'LATEST',
        memory: '2G',
        motd: 'A Minecraft server at home',
        gamemode: 'survival',
        difficulty: 'easy',
        hardcore: false,
        pvp: true,
        maxPlayers: 10,
        viewDistance: 10,
        simulationDistance: 10,
        spawnProtection: 16,
        allowNether: true,
        allowFlight: false,
        commandBlocks: false,
        forceGamemode: false,
        // Java players must own the game, checked with Mojang. Bedrock players
        // sign in with Xbox through Floodgate whatever this says.
        onlineMode: true,
        // Lets Xbox, PlayStation and Switch players in, through the Friends
        // tab. Off by default because it signs a Microsoft account into the
        // server, and which account that is should be somebody's decision.
        consoles: false,
        // The folder in the data volume that is the world. Changed from the
        // Worlds tab, and always a folder name: see MINECRAFT_WORLD_RE.
        level: 'world',
        // Only read when the world is first made.
        seed: '',
        levelType: 'minecraft:normal',
    },
};

/**
 * A world's folder name. It goes through .env and server.properties and sits
 * beside the server's own folders, so it stays plain.
 */
export const MINECRAFT_WORLD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const MINECRAFT_RESERVED_FOLDERS = new Set(['plugins', 'libraries', 'logs', 'versions', 'config', 'cache']);

/** What the Minecraft settings can be. The page builds its menus from the same words. */
export const MINECRAFT_CHOICES = {
    gamemode: ['survival', 'creative', 'adventure', 'spectator'],
    difficulty: ['peaceful', 'easy', 'normal', 'hard'],
    memory: ['1G', '2G', '3G', '4G', '6G', '8G', '12G', '16G'],
    levelType: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified'],
};

/**
 * Host ports the stack already publishes, so an app cannot be pointed at one of
 * them. Docker's own error for this arrives long after the button was pressed
 * and reads like an internal fault, which is no help at all when the fix is
 * simply to pick another number.
 */
export function reservedHostPorts() {
    // Read from .env as well as this process's environment: the panel's port
    // can be moved, and .env is what the next start of this container uses.
    const panel = Number(readEnvFile().GUI_PORT || process.env.GUI_PORT || 8420);
    // Only the panel. 80 and 443 were held for the nginx proxy an older
    // version ran; publishing goes through the tunnel now, and nothing here
    // listens on either.
    return new Map([[panel, 'this control panel']]);
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
// Asterisks allowed: Nextcloud's trusted-domain matching takes wildcards, and
// a home server needs them to accept its own address on a network whose
// numbering it does not control.
//
// Checked one name at a time, with no limit on the length of the whole list.
// There used to be one, of 300 characters, and the panel itself is what grows
// this list -- every public name, the Tailscale name and address -- so an
// install that had been given a few names reached it on its own, and from then
// on every save of Nextcloud's settings was refused for a list nobody typed.
const TRUSTED_DOMAIN_RE = /^[A-Za-z0-9*](?:[A-Za-z0-9.*-]{0,252})$/;
const MAX_TRUSTED_DOMAINS = 100;

// A media folder is a host path, so it has to be absolute and it has to be safe
// to paste into the generated compose override. Spaces are allowed -- "My
// Movies" is an ordinary directory name -- but quotes, colons, newlines and
// control characters are not: the override writes each mount as a quoted
// "source:target:ro" string, and any of those would break out of it.
//
// Nor $, ` or a backslash. Compose interpolates $NAME inside that file too, so
// a folder called "$HOME" mounted whatever HOME was; a backslash is an escape
// inside a double-quoted YAML string; and a backtick has no business in a path
// that also travels through shell scripts in throwaway containers.
const MEDIA_PATH_RE = /^\/[^\0-\x1f\x7f"':$`\\]*$/;

/** Whether a host path can be mounted and handed to a script safely. */
export const isSafeHostPath = (p) => typeof p === 'string' && MEDIA_PATH_RE.test(p) && !p.split('/').includes('..');
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
function mountsUnder(prefix, paths) {
    const used = new Set();
    return paths.map((path) => {
        const base = (path.split('/').filter(Boolean).pop() || 'folder').replace(/[^A-Za-z0-9._-]+/g, '-');
        let name = base;
        for (let i = 2; used.has(name); i += 1) name = `${base}-${i}`;
        used.add(name);
        return { path, target: `${prefix}/${name}`, name };
    });
}

export const mediaMounts = (paths) => mountsUnder('/media', paths);

/**
 * The same idea for Nextcloud, under a prefix of its own.
 *
 * Not /media: that is Jellyfin's, and the two containers are unrelated. Not
 * anywhere under /var/www/html either -- that is the application and its data
 * directory, and a bind mount landing inside it would be indistinguishable to
 * Nextcloud from files it believes it owns.
 */
export const sharedMounts = (paths) => mountsUnder('/external', paths);

function validateMediaPaths(input, errors, label = 'Jellyfin') {
    const seen = new Set();
    const out = [];

    for (const entry of Array.isArray(input) ? input : []) {
        const path = normalizeMediaPath(entry);
        if (!path) continue;
        if (out.length >= MAX_MEDIA_PATHS) {
            errors.push(`That is more than ${MAX_MEDIA_PATHS} folders, which is more than this is meant for.`);
            break;
        }
        if (!path.startsWith('/')) {
            errors.push(`"${path}" is not a full path. It has to start with a / and be the path on this machine.`);
        } else if (!MEDIA_PATH_RE.test(path)) {
            errors.push(`"${path}" contains a character that cannot be used in a folder path here (quotes, colons, $, \` or backslashes).`);
        } else if (path.split('/').includes('..')) {
            errors.push(`"${path}" contains "..", so write the real path instead.`);
        } else if (path === '/') {
            errors.push(`Mounting the whole filesystem into ${label} is not something this will do. Pick the folder you actually mean.`);
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
                // The paths go in as arguments rather than pasted into the
                // script, so no character in one can become shell syntax; one
                // verdict per line comes out, in the same order.
                'for p in "$@"; do [ -d "/host$p" ] && echo yes || echo no; done',
                'sh',
                ...paths,
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

/**
 * Checks a whole apps document and returns the clean version of it.
 *
 * `lockedAdminUser` is the admin account Nextcloud was installed with, once it
 * has been installed: see below.
 */
export function validateAppsConfig(input, { lockedAdminUser = null } = {}) {
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

    /*
     * The admin account's name is Nextcloud's business once it is installed.
     *
     * It is only read by the first-time install, which creates the account
     * with it; after that, changing it here renames nothing -- it only makes
     * the panel show, and try to reset the password of, an account that does
     * not exist. So it is fixed from then on, and the way to have another name
     * is to make that user in Nextcloud itself.
     */
    const user = String(n.adminUser ?? 'admin').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) errors.push('Nextcloud admin user is invalid.');
    else if (lockedAdminUser && user !== lockedAdminUser) {
        errors.push(
            `Nextcloud is already installed with the admin account "${lockedAdminUser}", and that name cannot be changed from here: ` +
                'Nextcloud only reads it when it first installs. Add another user in Nextcloud itself, or uninstall Nextcloud to start again with a different name.',
        );
    } else cfg.nextcloud.adminUser = user;

    // Stored space separated whatever was typed. NEXTCLOUD_TRUSTED_DOMAINS is
    // read by a shell `for` loop over an unquoted variable, so it splits on
    // whitespace and a comma would stay stuck to the hostname before it.
    const domains = [...new Set(String(n.trustedDomains ?? 'localhost').split(/[\s,]+/).filter(Boolean))];
    const badDomains = domains.filter((d) => !TRUSTED_DOMAIN_RE.test(d));
    if (badDomains.length) {
        errors.push(
            `Trusted domains may only contain hostnames and addresses, separated by spaces or commas: ${badDomains.slice(0, 3).map((d) => `"${d.slice(0, 40)}"`).join(', ')} cannot be one.`,
        );
    } else if (domains.length > MAX_TRUSTED_DOMAINS) {
        errors.push(`That is more than ${MAX_TRUSTED_DOMAINS} trusted domains, which is more than this is meant for.`);
    } else {
        cfg.nextcloud.trustedDomains = domains.join(' ') || 'localhost';
    }

    cfg.nextcloud.sharedPaths = validateMediaPaths(n.sharedPaths, errors, 'Nextcloud');
    // Not user input -- discovered from the filesystem when the folders are
    // applied, and carried through a save so it is not lost.
    cfg.nextcloud.sharedGids = (Array.isArray(n.sharedGids) ? n.sharedGids : [])
        .map(Number)
        .filter((g) => Number.isInteger(g) && g > 0);

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

    // --- Meal Plan ---
    const mp = input.mealplan ?? {};
    cfg.mealplan.enabled = Boolean(mp.enabled);
    cfg.mealplan.publish = { web: mp.publish?.web !== false };

    // The ref is interpolated into a compose build context, so it has to stay
    // inside what a git ref can contain.
    const mpref = String(mp.ref ?? 'main').trim();
    if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(mpref)) errors.push('That is not a valid branch or tag name.');
    else cfg.mealplan.ref = mpref;

    const mport = Number(mp.hostPort ?? DEFAULT_APPS_CONFIG.mealplan.hostPort);
    const mtaken = reservedHostPorts().get(mport);
    // Checked against both of the other apps rather than just the previous one:
    // with three of them a single pairwise comparison leaves a pair unchecked,
    // and the collision only shows up later as a container that will not start.
    const clash = [
        cfg.nextcloud.publish.web && mport === Number(cfg.nextcloud.hostPort) ? 'Nextcloud' : null,
        cfg.jellyfin.publish.web && mport === Number(cfg.jellyfin.hostPort) ? 'Jellyfin' : null,
    ].find(Boolean);

    if (!Number.isInteger(mport) || mport < 1024 || mport > 65535) {
        errors.push('Meal Plan port must be between 1024 and 65535.');
    } else if (clash && cfg.mealplan.publish.web) {
        errors.push(`Port ${mport} is where ${clash} is published, so Meal Plan cannot take it too.`);
    } else if (mtaken && cfg.mealplan.publish.web) {
        errors.push(
            `Port ${mport} is already used by ${mtaken}, so Meal Plan cannot start on it. Pick another one, ` +
                `for example ${mport + 1}.`,
        );
    } else {
        cfg.mealplan.hostPort = mport;
    }

    validateMinecraft(input.minecraft ?? {}, cfg, errors);

    return { cfg, errors };
}

/*
 * The server's message under its name in the multiplayer list. It travels
 * through .env unquoted, where a # starts a comment and a $ starts a variable,
 * so those are kept out along with line breaks. An apostrophe is fine except
 * as the first character, where compose would read it as an opening quote --
 * "Bob's world" is the message half of all servers want. The section sign is
 * allowed: it is how Minecraft writes colours (§a is green).
 */
const MOTD_RE = /^(?!')[\p{L}\p{N} .,!?&()\-:+*@%/§|~^_<>[\]{}']{0,59}$/u;
const SEED_RE = /^[A-Za-z0-9_-]{0,32}$/;
const MC_VERSION_RE = /^(LATEST|\d+\.\d+(\.\d+)?)$/;

function validateMinecraft(m, cfg, errors) {
    const d = DEFAULT_APPS_CONFIG.minecraft;
    const out = cfg.minecraft;
    const bool = (key) => (m[key] === undefined ? d[key] : Boolean(m[key]));
    const pick = (key, label) => {
        const value = String(m[key] ?? d[key]);
        if (MINECRAFT_CHOICES[key].includes(value)) return value;
        errors.push(`${label} must be one of: ${MINECRAFT_CHOICES[key].join(', ')}.`);
        return d[key];
    };
    const int = (key, label, lo, hi) => {
        const value = Number(m[key] ?? d[key]);
        if (Number.isInteger(value) && value >= lo && value <= hi) return value;
        errors.push(`${label} must be a whole number from ${lo} to ${hi}.`);
        return d[key];
    };

    out.enabled = Boolean(m.enabled);
    out.eula = Boolean(m.eula);
    for (const key of ['hardcore', 'pvp', 'allowNether', 'allowFlight', 'commandBlocks', 'forceGamemode', 'onlineMode', 'consoles']) {
        out[key] = bool(key);
    }
    out.gamemode = pick('gamemode', 'Game mode');
    out.difficulty = pick('difficulty', 'Difficulty');
    out.memory = pick('memory', 'Memory');
    out.levelType = pick('levelType', 'World type');
    out.maxPlayers = int('maxPlayers', 'Max players', 1, 200);
    out.viewDistance = int('viewDistance', 'View distance', 3, 32);
    out.simulationDistance = int('simulationDistance', 'Simulation distance', 3, 32);
    out.spawnProtection = int('spawnProtection', 'Spawn protection', 0, 256);

    const version = String(m.version ?? d.version).trim().toUpperCase();
    if (!MC_VERSION_RE.test(version)) errors.push('Minecraft version is LATEST or a release number like 1.21.4.');
    else out.version = version;

    const motd = String(m.motd ?? d.motd).trim();
    if (!MOTD_RE.test(motd)) {
        errors.push('The server message can be up to 59 characters, without double quotes, #, $ or line breaks, and cannot start with an apostrophe.');
    } else {
        out.motd = motd;
    }

    const level = String(m.level ?? d.level).trim();
    if (!MINECRAFT_WORLD_RE.test(level) || MINECRAFT_RESERVED_FOLDERS.has(level)) errors.push(`"${level}" cannot be a world's folder name.`);
    else out.level = level;

    const seed = String(m.seed ?? '').trim();
    if (!SEED_RE.test(seed)) errors.push('A seed is a number or a word: letters, digits, - and _, up to 32 of them.');
    else out.seed = seed;

    // The Java port is TCP, so it shares a space with every web app's; the
    // Bedrock port is UDP, which nothing else in this stack uses.
    const webPorts = [
        ['Nextcloud', cfg.nextcloud.publish.web && cfg.nextcloud.hostPort],
        ['Jellyfin', cfg.jellyfin.publish.web && cfg.jellyfin.hostPort],
        ['Meal Plan', cfg.mealplan.publish.web && cfg.mealplan.hostPort],
    ];
    const jport = Number(m.javaPort ?? d.javaPort);
    const jtaken = reservedHostPorts().get(jport);
    const jclash = webPorts.find(([, p]) => p && Number(p) === jport)?.[0];
    if (!Number.isInteger(jport) || jport < 1024 || jport > 65535) {
        errors.push('The Java Edition port must be between 1024 and 65535.');
    } else if (jclash) {
        errors.push(`Minecraft and ${jclash} both want port ${jport}. Give one of them another number.`);
    } else if (jtaken) {
        errors.push(`Port ${jport} is already used by ${jtaken}, so Minecraft cannot take it.`);
    } else {
        out.javaPort = jport;
    }

    const bport = Number(m.bedrockPort ?? d.bedrockPort);
    if (!Number.isInteger(bport) || bport < 1024 || bport > 65535) {
        errors.push('The Bedrock Edition port must be between 1024 and 65535.');
    } else {
        out.bedrockPort = bport;
    }
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
 * but the hook is what lets an app say why plainly, at the moment somebody
 * asks for it, rather than failing later. Minecraft is the first that does:
 * without the licence accepted the server prints one line and exits, and a
 * switch that flips on and straight back off explains nothing.
 */
export function appBlockers(name, cfg = loadAppsConfig()) {
    if (name === 'minecraft' && !cfg.minecraft?.eula) {
        return ["Minecraft only starts once you have accepted Mojang's EULA. Tick the box under Minecraft → Settings."];
    }
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
        // Signs Meal Plan's session cookies. Separate from the panel's on
        // purpose; see the comment on its SESSION_SECRET in docker-compose.yml.
        MEALPLAN_SESSION_SECRET: () => randomSecret(32),
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
        ...minecraftEnv(cfg.minecraft),
    });
}

/**
 * The Minecraft settings, as the variables the image turns into
 * server.properties on every start.
 *
 * Every start rather than once, which is what makes these settings and not
 * suggestions: change the difficulty here and the next start has it. The one
 * exception is the world's shape -- seed and type are only read the first time
 * a world is made, which the page says next to them.
 */
function minecraftEnv(m) {
    const yes = (v) => (v ? 'true' : 'false');
    return {
        MINECRAFT_EULA: m.eula ? 'TRUE' : 'FALSE',
        MINECRAFT_VERSION: m.version,
        MINECRAFT_LEVEL: m.level,
        MINECRAFT_MEMORY: m.memory,
        MINECRAFT_MOTD: m.motd,
        MINECRAFT_MODE: m.gamemode,
        MINECRAFT_DIFFICULTY: m.difficulty,
        MINECRAFT_HARDCORE: yes(m.hardcore),
        MINECRAFT_PVP: yes(m.pvp),
        MINECRAFT_MAX_PLAYERS: String(m.maxPlayers),
        MINECRAFT_VIEW_DISTANCE: String(m.viewDistance),
        MINECRAFT_SIMULATION_DISTANCE: String(m.simulationDistance),
        MINECRAFT_SPAWN_PROTECTION: String(m.spawnProtection),
        MINECRAFT_ALLOW_NETHER: yes(m.allowNether),
        MINECRAFT_ALLOW_FLIGHT: yes(m.allowFlight),
        MINECRAFT_COMMAND_BLOCKS: yes(m.commandBlocks),
        MINECRAFT_FORCE_GAMEMODE: yes(m.forceGamemode),
        MINECRAFT_ONLINE_MODE: yes(m.onlineMode),
        MINECRAFT_SEED: m.seed,
        MINECRAFT_LEVEL_TYPE: m.levelType,
    };
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
    const published = { nextcloud: [], jellyfin: [], mealplan: [], minecraft: [] };

    if (composeDefines('nextcloud')) {
        blocks.push('  nextcloud:');
        blocks.push('    ports:');
        if (cfg.nextcloud.publish.web) {
            blocks.push(`      - "0.0.0.0:${cfg.nextcloud.hostPort}:80/tcp"`);
            published.nextcloud = [cfg.nextcloud.hostPort];
        } else {
            blocks.push('      []');
        }

        // Shared folders, mounted where Nextcloud's external storage will look
        // for them. Read-write: unlike Jellyfin, the point of showing a folder
        // in Nextcloud is being able to work with what is in it, and a mount
        // that is read-only at the Docker layer produces errors in the web UI
        // that name no cause. Whether a given folder is writable is decided per
        // mount inside Nextcloud instead, where it can say so.
        // Filtered again here as well as at validation: this file is merged
        // into every compose call, so a path saved by an older version that
        // would now be refused must not reach it either.
        const shared = sharedMounts((cfg.nextcloud.sharedPaths ?? []).filter(isSafeHostPath));
        if (shared.length) {
            blocks.push('    volumes:');
            for (const m of shared) blocks.push(`      - "${m.path}:${m.target}"`);
        }
        // Without this, browsing a shared folder works and uploading into it
        // returns 403 -- see ownerGids for why.
        const gids = cfg.nextcloud.sharedGids ?? [];
        if (gids.length) {
            blocks.push('    group_add:');
            for (const g of gids) blocks.push(`      - "${g}"`);
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
        const mounts = mediaMounts((cfg.jellyfin.mediaPaths ?? []).filter(isSafeHostPath));
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

    if (composeDefines('mealplan')) {
        blocks.push('  mealplan:');
        // The branch is part of the build context, so changing it here is what
        // makes "track this branch" mean anything -- without it the panel would
        // record a ref and keep rebuilding the same commit.
        blocks.push('    build:');
        blocks.push(`      context: https://github.com/${APPS.mealplan.repo}.git#${cfg.mealplan.ref}`);
        blocks.push('    ports:');
        if (cfg.mealplan.publish.web) {
            blocks.push(`      - "0.0.0.0:${cfg.mealplan.hostPort}:8080/tcp"`);
            published.mealplan = [cfg.mealplan.hostPort];
        } else {
            blocks.push('      []');
        }
    }

    if (composeDefines('minecraft')) {
        // Always published: a game server nobody can connect to is not a
        // setting anyone wants. Java on TCP, Bedrock on UDP, and the container
        // side of each stays at the default so neither Paper nor Geyser needs
        // its own configuration touched when the host side moves.
        blocks.push('  minecraft:');
        blocks.push('    ports:');
        blocks.push(`      - "0.0.0.0:${cfg.minecraft.javaPort}:25565/tcp"`);
        blocks.push(`      - "0.0.0.0:${cfg.minecraft.bedrockPort}:19132/udp"`);
        published.minecraft = [cfg.minecraft.javaPort, cfg.minecraft.bedrockPort];
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

/**
 * Runs an `occ` command as the web user inside the Nextcloud container.
 *
 * `env` names variables to hand to the container, by name only. Their values
 * go in the environment of the docker command itself (dockerctl.run's `env`),
 * and docker copies a variable named without a value from there -- so a
 * password reaches `occ` without ever being on a command line, where every
 * user on the host could read it from the process list while it ran.
 */
function occArgs(args, { env = [] } = {}) {
    const envFlags = env.flatMap((k) => ['-e', k]);
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
    // Clear stale trailing entries. With --error-if-not-exists `occ` exits
    // non-zero once there is nothing at an index, which is the signal to stop
    // rather than an error -- without it, deleting a key that is not there
    // succeeds, and this ran its whole bound every time. Bounded generously,
    // since the list can now shrink by more than a handful at once.
    for (let i = wanted.length; i < wanted.length + MAX_TRUSTED_DOMAINS; i++) {
        try {
            await docker(occArgs(['config:system:delete', 'trusted_domains', String(i), '--error-if-not-exists']));
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
/*
 * Base-image checks, for the apps that come from a Docker Hub tag rather than a
 * repository: Nextcloud is built FROM `nextcloud:stable`, Jellyfin is
 * `jellyfin/jellyfin:<tag>` as published. Their Update buttons used to stay lit
 * whether or not anything had changed upstream, which is how a PHP security fix
 * went unnoticed for a week.
 */

/** The Docker Hub tag an app is made from. */
async function upstreamImage(name, docker) {
    if (name === 'nextcloud') {
        // Read from the Dockerfile rather than written down here a second time,
        // so the check follows the FROM if it is ever changed.
        try {
            const file = path.join(path.dirname(COMPOSE_FILE), 'nextcloud', 'Dockerfile');
            const from = resolveFrom(fs.readFileSync(file, 'utf8'), readEnvFile());
            if (from) return from;
        } catch {
            /* fall through */
        }
        return `nextcloud:${readEnvFile().NEXTCLOUD_TAG || 'stable'}`;
    }
    if (name === 'jellyfin') {
        // The tag an Update would fetch, which is the .env pin -- the same
        // expression compose itself uses. Not the tag the container happens to
        // have been created from: after pinning `latest` back to `10.11`, that
        // still says `latest`, and the check went on offering a major upgrade
        // the pin exists to refuse.
        return `jellyfin/jellyfin:${readEnvFile().JELLYFIN_VERSION || 'latest'}`;
    }
    if (name === 'minecraft') {
        // Same rule as Jellyfin's: the tag an Update would fetch.
        return `itzg/minecraft-server:${readEnvFile().MINECRAFT_IMAGE_VERSION || 'latest'}`;
    }
    throw new Error(`${APPS[name]?.label ?? name} is not made from a Docker Hub image.`);
}

/**
 * The image a Dockerfile's first FROM names, with its build arguments filled in.
 *
 * Nextcloud's is `FROM nextcloud:${NEXTCLOUD_TAG}`: compose passes the tag from
 * .env as a build argument, and the ARG line above the FROM holds the default
 * for when .env has none. Both are read here the same way, so the check asks
 * Docker Hub about the tag a build would actually use. Null when a variable is
 * left unresolved, rather than a guess.
 */
export function resolveFrom(dockerfile, env = {}) {
    const defaults = {};
    for (const line of String(dockerfile).split('\n')) {
        const arg = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(\S*))?\s*$/i.exec(line);
        if (arg) {
            defaults[arg[1]] = (arg[2] ?? '').replace(/^"(.*)"$/, '$1');
            continue;
        }
        const from = /^\s*FROM\s+(\S+)/i.exec(line);
        if (!from) continue;
        let unresolved = false;
        const image = from[1].replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, fallback, bare) => {
            const key = braced ?? bare;
            const value = env[key] || defaults[key] || fallback || '';
            if (!value) unresolved = true;
            return value;
        });
        return unresolved ? null : image;
    }
    return null;
}

/** The versions worth showing for an app, read from an image's env and labels. */
function imageVersions(name, env, labels) {
    if (name === 'nextcloud') return [['PHP', env.PHP_VERSION], ['Nextcloud', env.NEXTCLOUD_VERSION]];
    if (name === 'jellyfin') return [['Jellyfin', labels['org.opencontainers.image.version']]];
    // The image's own version, not Minecraft's: the game is downloaded by the
    // container when it starts, so no image says which one it will be.
    if (name === 'minecraft') return [['Java', env.JAVA_VERSION]];
    return [];
}

const major = (v) => String(v ?? '').match(/^\d+/)?.[0] ?? null;

/**
 * Whether the running container is built on the version of its base tag that
 * Docker Hub has now.
 *
 * Compared by layers rather than by a recorded digest. The build pulls the base
 * without tagging it locally, so there is no digest to record -- but an image
 * built FROM a base starts with exactly that base's layers, and a pulled image
 * is those layers. So "is the tag's current layer list the start of the running
 * image's?" answers the question for both, needs nothing written at build time,
 * and is right for an image rebuilt by hand outside the panel too.
 */
export async function checkBaseImage(name, docker) {
    const app = APPS[name];
    const image = await upstreamImage(name, docker);
    const upstream = await resolveTag(image);

    let local = null;
    try {
        const { stdout: id } = await docker(['inspect', '-f', '{{.Image}}', app.container], { timeoutMs: 15_000 });
        const { stdout } = await docker(['image', 'inspect', id.trim(), '-f', '{{json .}}'], { timeoutMs: 15_000 });
        local = JSON.parse(stdout);
    } catch {
        local = null;
    }

    const upVersions = imageVersions(name, upstream.env, upstream.labels);
    const base = {
        image,
        digest: upstream.digest,
        shortSha: (upstream.digest ?? '').replace(/^sha256:/, '').slice(0, 12),
        date: upstream.created,
    };
    if (!local) {
        return {
            ...base,
            neverBuilt: true,
            updateAvailable: false,
            versions: upVersions.map(([label, latest]) => ({ label, running: null, latest: latest ?? null })),
        };
    }

    const runVersions = imageVersions(name, envMap(local.Config?.Env), local.Config?.Labels ?? {});
    const versions = upVersions.map(([label, latest], i) => ({
        label,
        running: runVersions[i]?.[1] ?? null,
        latest: latest ?? null,
    }));
    // A major version change is called out rather than presented like a patch:
    // both apps migrate their database on the way up, and neither comes back.
    const majorChanges = versions.filter((v) => v.running && v.latest && major(v.running) !== major(v.latest));

    const result = {
        ...base,
        neverBuilt: false,
        updateAvailable: !builtOn(local.RootFS?.Layers ?? [], upstream.diffIds),
        versions,
        majorChanges: majorChanges.map((v) => v.label),
    };

    /*
     * Nextcloud partway up a staircase.
     *
     * An Update that would cross more than one major version is taken one
     * major at a time (see nextcloudTagFor), which pins the build to that
     * major's own tag. Checked against only that tag, a Nextcloud that has
     * just reached it reads as up to date -- and nothing would ever say that
     * another press is needed to carry on to stable.
     */
    if (name === 'nextcloud' && !/:stable$/.test(image)) {
        try {
            const stable = await resolveTag('nextcloud:stable');
            const running = runVersions[1]?.[1];
            const latest = stable.env.NEXTCLOUD_VERSION;
            if (running && latest && Number(major(latest)) > Number(major(running))) {
                result.updateAvailable = true;
                result.versions = [...versions.filter((v) => v.label !== 'Nextcloud'), { label: 'Nextcloud', running, latest }];
                result.majorChanges = [...new Set([...result.majorChanges, 'Nextcloud'])];
                result.steppedFrom = image;
            }
        } catch {
            /* the pinned tag's answer stands */
        }
    }
    return result;
}

/**
 * The Nextcloud major version the data volume holds, or null.
 *
 * Read from version.php in the volume rather than asked of `occ`, so it works
 * with the container stopped or gone -- which is exactly when an Update or a
 * reinstall over kept data needs to know it. The array is the version the
 * database was last upgraded to, which is what matters for the next step.
 */
export async function nextcloudInstalledMajor(docker) {
    try {
        const { stdout } = await docker(
            ['run', '--rm', '-v', 'quickstart-home-nextcloud-data:/v:ro', 'alpine:3.21', 'cat', '/v/version.php'],
            { timeoutMs: 60_000 },
        );
        const m = /\$OC_Version\s*=\s*(?:array\(|\[)\s*(\d+)/.exec(stdout);
        return m ? Number(m[1]) : null;
    } catch {
        return null;
    }
}

/**
 * Which `nextcloud:` tag the next build should start from.
 *
 * Nextcloud upgrades one major version at a time and refuses anything else:
 * a 29 that is handed a 31 image stops at boot with "Updates between multiple
 * major versions are unsupported", and stays stopped. `stable` moves a major
 * every few months, so a Nextcloud left alone for a while would be broken by
 * its own Update button.
 *
 * So when stable is more than one major ahead of what is installed, the build
 * uses the next major's own tag instead, and the next press of Update carries
 * on from there. Docker Hub is asked whether that tag exists before it is
 * used; if it cannot be checked, stable is left in place and the reason said.
 */
export async function nextcloudTagFor(docker, onLine = () => {}) {
    const installed = await nextcloudInstalledMajor(docker);
    if (!installed) return { tag: 'stable', installed: null };
    let upstream = null;
    try {
        upstream = Number(major((await resolveTag('nextcloud:stable')).env.NEXTCLOUD_VERSION)) || null;
    } catch (err) {
        onLine(`Could not ask Docker Hub which version nextcloud:stable is (${err.message}).`);
    }
    if (!upstream || upstream <= installed + 1) return { tag: 'stable', installed, upstream };

    const step = String(installed + 1);
    const exists = await tagExists(`nextcloud:${step}`).catch(() => false);
    if (!exists) {
        onLine(`nextcloud:stable is version ${upstream} and this Nextcloud is ${installed}, but nextcloud:${step} could not be found on Docker Hub to step through. Leaving the update for now.`);
        return { tag: null, installed, upstream };
    }
    onLine(
        `This Nextcloud is version ${installed} and the newest is ${upstream}. Nextcloud can only move up one major version at a time, ` +
            `so this update goes to ${step}. Press Update again afterwards to continue.`,
    );
    return { tag: step, installed, upstream, stepped: true };
}

/*
 * Database housekeeping after Nextcloud has moved to a new version.
 *
 * The image runs `occ upgrade` itself when it starts on a newer version, and
 * that is all it runs. The rest is what Nextcloud's own admin overview then
 * nags about -- missing indices, columns and primary keys that an upgrade adds
 * the definitions for but leaves to be created, because on a big instance they
 * can take a while -- plus the repair steps, and the apps, which are updated
 * separately from the server and are what breaks first when they are not.
 *
 * Each one is attempted and reported on its own. None is worth failing an
 * update that has already succeeded: a Nextcloud with a missing index works,
 * just slower, and the next update tries again.
 */
const NEXTCLOUD_AFTER_UPDATE = [
    { args: ['db:add-missing-indices'], label: 'Adding missing database indices' },
    { args: ['db:add-missing-columns'], label: 'Adding missing database columns' },
    { args: ['db:add-missing-primary-keys'], label: 'Adding missing primary keys' },
    { args: ['maintenance:repair'], label: 'Running the repair steps' },
    { args: ['app:update', '--all'], label: 'Updating apps' },
];

export async function nextcloudAfterUpdate(docker, onLine = () => {}) {
    for (const step of NEXTCLOUD_AFTER_UPDATE) {
        onLine(`${step.label}...`);
        try {
            await docker(occArgs(step.args), { onLine, timeoutMs: 30 * 60_000 });
        } catch (err) {
            onLine(`${step.label} did not finish: ${summarizeError(err.message)}`);
        }
    }
}

/**
 * Has Nextcloud run its background jobs from the system's cron rather than on
 * page loads. The panel is that cron: see the timer in server.js.
 */
export async function setNextcloudCronMode(docker) {
    await docker(occArgs(['background:cron']), { timeoutMs: 60_000 });
}

/** One run of Nextcloud's background jobs, as cron would start it. */
export async function runNextcloudCron(docker, { timeoutMs = 15 * 60_000 } = {}) {
    await docker(['exec', '-u', 'www-data', NEXTCLOUD_CONTAINER, 'php', '-f', '/var/www/html/cron.php'], { timeoutMs });
}

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

/**
 * Tells Nextcloud the address the outside reaches it on.
 *
 * Nextcloud builds absolute URLs -- redirects, asset links, the address it
 * prints for clients -- and it works them out from the request unless told
 * otherwise. Behind a proxy that is enough only when the proxy is on the
 * default port. On anything else it drops the port and downgrades to http, so
 * signing in redirects to `http://name/login`: no TLS, no port, and on a
 * network where something else holds 443, a different machine entirely.
 *
 * `origin` null means the name was taken away again, and the overwrites go with
 * it -- leaving them behind would send a locally-reached Nextcloud out to a
 * domain that no longer points at it.
 */
export async function syncNextcloudUrls(docker, origin, onLine = () => {}) {
    // Deliberately not overwritehost or overwriteprotocol.
    //
    // Those force one origin onto every request, which is right for the proxy
    // and wrong for everything else: with them set, opening Nextcloud on the
    // machine's own address redirects straight back out to the public name, so
    // the local address stops working the moment a domain is attached. They
    // are also not needed -- the proxy forwards the real host and port, and
    // Nextcloud honours the forwarded protocol, so each way in generates links
    // for the way it came in. Removed here as well as unset, because an
    // earlier version of this panel did set them.
    for (const key of ['overwriteprotocol', 'overwritehost']) {
        await docker(occArgs(['config:system:delete', key])).catch(() => {});
    }

    // This one has no request to read an origin from -- it is what background
    // jobs put in links they send by e-mail -- so it does want the public
    // address, and falls back to the local one when there is not one.
    const cli = origin ?? 'http://localhost';
    await docker(occArgs(['config:system:set', 'overwrite.cli.url', '--value', cli]));
    onLine(`Links sent by e-mail will point at ${cli}.`);
}

/**
 * Waits until Nextcloud can actually answer `occ`.
 *
 * A running container is not the same as a usable Nextcloud. The first boot
 * installs the database and upgrades the schema, and until that finishes every
 * `occ` call fails -- so anything applied the moment the container starts is
 * applied to nothing. Polling `occ status` is the honest readiness signal,
 * because it is the same command the settings below have to use.
 */
export async function waitForNextcloud(docker, { timeoutMs = 5 * 60_000, onWaiting = () => {} } = {}) {
    const deadline = Date.now() + timeoutMs;
    let announced = false;

    while (Date.now() < deadline) {
        try {
            const { stdout } = await docker(occArgs(['status', '--output=json']), { timeoutMs: 30_000 });
            if (JSON.parse(stdout.trim()).installed === true) return true;
        } catch {
            /* not up yet */
        }
        if (!announced) {
            announced = true;
            onWaiting();
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
}

/**
 * Turns on the previews the stack is already carrying the machinery for.
 *
 * Nextcloud ships a conservative default -- PNG, JPEG, GIF, BMP, XBitmap,
 * WebP, Krita, MarkDown, TXT, OpenDocument -- and nothing outside it is
 * generated. So installing ffmpeg in the image and running an Imaginary
 * container beside it, which is what this stack does, achieves precisely
 * nothing on its own: videos still show a generic icon, an iPhone's HEIC
 * photos show a generic icon, and Imaginary sits there answering 401 to
 * nobody. The provider list is the switch, and this is it being thrown.
 *
 * Imaginary goes first because it covers the whole image set in one process,
 * HEIC and HEIF included, which is the thing the default cannot do. The native
 * image providers are kept after it rather than dropped: Nextcloud tries
 * matching providers in order and moves on when one returns nothing, so they
 * are a fallback for a day when Imaginary is unhealthy, and cost nothing on
 * every other day.
 *
 * Applied with `occ` for the same reason the trusted domains are: these live
 * in config.php, the image only writes that during first-time install, and a
 * container that is already installed will never run that branch again.
 */
const PREVIEW_PROVIDERS = [
    // Everything image-shaped, including the formats the default list cannot
    // touch: heic, heif, tiff, svg+xml, illustrator.
    'OC\\Preview\\Imaginary',
    'OC\\Preview\\ImaginaryPDF',
    // Video thumbnails. This is the one that needs the ffmpeg baked into our
    // image; without the binary the provider is registered and silently
    // produces nothing.
    'OC\\Preview\\Movie',
    // Fallbacks, in case Imaginary is not answering.
    'OC\\Preview\\PNG',
    'OC\\Preview\\JPEG',
    'OC\\Preview\\GIF',
    'OC\\Preview\\BMP',
    'OC\\Preview\\XBitmap',
    'OC\\Preview\\WebP',
    // Non-image things worth a thumbnail, carried over from the default list so
    // enabling this does not quietly take them away.
    'OC\\Preview\\MP3',
    'OC\\Preview\\TXT',
    'OC\\Preview\\MarkDown',
    'OC\\Preview\\OpenDocument',
    'OC\\Preview\\Krita',
];

/*
 * The apps a fresh Nextcloud is expected to have.
 *
 * A bare Nextcloud is files and nothing else -- no calendar, no contacts, no
 * notes. Every one of these is a thing somebody sets up a home server *for*,
 * and finding them means knowing the app store exists and picking the right
 * entry out of it. So they arrive with it.
 *
 * Only on first install. Re-running this on every start would put back an app
 * the owner had deliberately removed, and an install that will not stay
 * uninstalled is worse than one that never happened.
 */
const NEXTCLOUD_BUNDLE = [
    { id: 'contacts', label: 'Contacts' },
    { id: 'calendar', label: 'Calendar' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'notes', label: 'Notes' },
    { id: 'spreed', label: 'Talk' },
];

/*
 * The marker lives in Nextcloud's own config rather than in the panel's, so it
 * has exactly the right lifetime: uninstalling Nextcloud takes its database and
 * this with it, and the next install is genuinely a first install again. A flag
 * in the panel's apps.json would outlive the thing it describes and quietly
 * suppress the bundle on a rebuilt instance.
 */
const BUNDLE_MARKER = 'quickstart_home_bundled_apps';

/**
 * Installs the bundled apps, once, and says what it did.
 *
 * Each app is attempted on its own and a failure is reported rather than
 * thrown. These downloads come from the Nextcloud app store over the internet,
 * and one app being unavailable for this version is a normal thing that must
 * not take the other five down with it -- or fail the install job, which by
 * this point has a perfectly good Nextcloud running.
 */
export async function installBundledApps(docker, onLine = () => {}) {
    try {
        const { stdout } = await docker(occArgs(['config:system:get', BUNDLE_MARKER]));
        if (stdout.trim()) return { skipped: true };
    } catch {
        // Unset, which is what a first install looks like. `occ` exits non-zero
        // for a key that is not there, so this is the normal path, not an error.
    }

    onLine('Installing the apps a new Nextcloud should come with...');
    const installed = [];
    const failed = [];

    for (const app of NEXTCLOUD_BUNDLE) {
        try {
            // `app:install` fails on an app that is already present, which is
            // true for anything shipped in the image. `app:enable` is the part
            // that must succeed, and it is idempotent, so it decides the
            // verdict and the install is allowed to have been a no-op.
            await docker(occArgs(['app:install', app.id]), { timeoutMs: 5 * 60_000 }).catch(() => {});
            await docker(occArgs(['app:enable', app.id]), { timeoutMs: 2 * 60_000 });
            installed.push(app.label);
        } catch (err) {
            failed.push(`${app.label} (${summarizeError(err)})`);
        }
    }

    if (installed.length) onLine(`Installed: ${installed.join(', ')}.`);
    if (failed.length) {
        onLine(`Could not install: ${failed.join('; ')}.`);
    }

    /*
     * Marked only when the whole set went in.
     *
     * The obvious version of this marks itself done regardless, so it can never
     * put back an app the owner deliberately removed. But these are downloads
     * from apps.nextcloud.com, and that host is not always reachable -- on the
     * machine this was written on it refuses connections outright while the
     * rest of the internet is fine. Marking done after a failed run would mean
     * a Nextcloud that missed the store once never gets its apps at all, and
     * the panel would never mention it again.
     *
     * So a partial run stays unmarked and is retried on the next start. That
     * cannot fight the owner over a removed app, because reaching this point at
     * all requires an earlier run to have failed -- once a run succeeds the
     * marker is set and nothing here touches the apps again.
     */
    if (failed.length) {
        onLine('Leaving these to try again next time Nextcloud starts.');
        return { skipped: false, installed, failed, marked: false };
    }
    await docker(occArgs(['config:system:set', BUNDLE_MARKER, '--value', new Date().toISOString()])).catch(() => {});
    return { skipped: false, installed, failed, marked: true };
}

/*
 * Shows the shared folders inside Nextcloud, without copying anything.
 *
 * Nextcloud's external storage points a mount point in the file tree at a
 * directory the server can already see -- here, the bind mounts under
 * /external. The files stay exactly where they are on the disk, which is the
 * whole point: the folder Jellyfin reads and the folder Nextcloud shows are the
 * same bytes, not two copies kept in step.
 *
 * Reconciled rather than appended. The mount list in Nextcloud is the thing
 * that has to end up matching the panel's config, so anything this created
 * before and is no longer configured has to go -- otherwise removing a folder
 * from the panel leaves it on display in Nextcloud, pointing at a mount that
 * the next container restart will not provide.
 *
 * Only mounts this panel made are touched. They are recognised by their target
 * being under /external, so a mount somebody added by hand in Nextcloud's own
 * admin page is left alone.
 */
export async function syncExternalStorage(docker, cfg, onLine = () => {}) {
    const wanted = sharedMounts(cfg.nextcloud.sharedPaths ?? []);

    if (!wanted.length) {
        const existing = await listPanelMounts(docker);
        for (const m of existing) await docker(occArgs(['files_external:delete', String(m.id), '-y'])).catch(() => {});
        if (existing.length) onLine(`Removed ${existing.length} shared folder(s) from Nextcloud.`);
        return;
    }

    // Enabling is idempotent and cheap, and doing it here means the feature
    // needs no separate setup step: asking for a folder is asking for this.
    await docker(occArgs(['app:enable', 'files_external']), { timeoutMs: 120_000 }).catch(() => {});

    const existing = await listPanelMounts(docker);
    const byTarget = new Map(existing.map((m) => [m.datadir, m]));

    for (const m of wanted) {
        if (byTarget.has(m.target)) {
            byTarget.delete(m.target);
            continue;
        }
        await docker(
            occArgs(['files_external:create', m.name, 'local', 'null::null', '-c', `datadir=${m.target}`]),
            { timeoutMs: 120_000 },
        );
        onLine(`Shared "${m.path}" into Nextcloud as "${m.name}".`);
    }

    // Whatever is left was ours and is no longer wanted.
    for (const stale of byTarget.values()) {
        await docker(occArgs(['files_external:delete', String(stale.id), '-y'])).catch(() => {});
        onLine(`Stopped sharing "${stale.datadir}".`);
    }
}

/** The external mounts this panel is responsible for, and where each points. */
async function listPanelMounts(docker) {
    try {
        const { stdout } = await docker(occArgs(['files_external:list', '--output=json', '--show-password']));
        const rows = JSON.parse(stdout.slice(stdout.indexOf('[')));
        return rows
            .map((r) => ({
                id: r.mount_id ?? r.id,
                datadir: r.configuration?.datadir ?? r.config?.datadir ?? null,
            }))
            .filter((r) => typeof r.datadir === 'string' && r.datadir.startsWith('/external/'));
    } catch {
        return [];
    }
}


/**
 * The group that owns each shared folder, so Nextcloud can be put in it.
 *
 * Nextcloud runs as www-data, uid 33. A folder on the host belongs to the
 * person who made it, usually uid 1000, and is mode 775 -- so www-data falls
 * through to "other", gets r-x, and every upload fails with 403 while browsing
 * works perfectly. That combination is confusing enough to be worth preventing
 * rather than explaining.
 *
 * Adding the folder's own group to the container is the least invasive fix
 * available. Changing ownership would mean rewriting thousands of files and
 * would take them away from the person who owns them; running the container as
 * uid 1000 would break the data volume the image sets up as 33. This leaves
 * both sides owning what they already own.
 */
export async function ownerGids(docker, paths) {
    if (!paths.length) return [];
    // Arguments, not interpolated, for the same reason as verifyHostPaths.
    const script = 'for p in "$@"; do stat -c %g "/host$p" 2>/dev/null; done';
    try {
        const { stdout } = await docker(
            ['run', '--rm', '-v', '/:/host:ro', 'quickstart-home/manager:1', 'sh', '-c', script, 'sh', ...paths],
            { timeoutMs: 30_000 },
        );
        const gids = stdout.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
        return [...new Set(gids)];
    } catch {
        return [];
    }
}

export async function syncPreviewSettings(docker, onLine = () => {}) {
    const env = readEnvFile();

    for (const [i, provider] of PREVIEW_PROVIDERS.entries()) {
        await docker(occArgs(['config:system:set', 'enabledPreviewProviders', String(i), '--value', provider]));
    }
    // Indices are positional, so a list that used to be longer would keep its
    // tail. `occ` exits non-zero once there is nothing at an index (asked to,
    // with --error-if-not-exists), which is the signal to stop.
    for (let i = PREVIEW_PROVIDERS.length; i < PREVIEW_PROVIDERS.length + 10; i++) {
        try {
            await docker(occArgs(['config:system:delete', 'enabledPreviewProviders', String(i), '--error-if-not-exists']));
        } catch {
            break;
        }
    }

    // Where Imaginary is, and the shared secret it refuses requests without.
    // The hostname is the one compose gives it on the internal network, so this
    // never depends on a published port.
    await docker(occArgs(['config:system:set', 'preview_imaginary_url', '--value', 'http://nextcloud-imaginary:9000/']));
    // Not `config:system:set --value <secret>`, which would put the secret on
    // a command line. `config:import` reads JSON from a file instead, and the
    // file is written by the shell's own printf -- a builtin, so no process is
    // started with the secret in its arguments. A private temporary file
    // rather than a pipe: occ reads stdin without waiting, so a pipe could be
    // read before anything was in it. The secret is base64url, so it needs no
    // escaping inside the JSON string.
    if (env.NEXTCLOUD_IMAGINARY_SECRET && /^[A-Za-z0-9_-]+$/.test(env.NEXTCLOUD_IMAGINARY_SECRET)) {
        await docker(
            [
                'exec', '-u', 'www-data', '-e', 'QSH_IMAGINARY_KEY', NEXTCLOUD_CONTAINER, 'sh', '-c',
                't=$(mktemp) || exit 1; ' +
                    'printf \'{"system":{"preview_imaginary_key":"%s"}}\' "$QSH_IMAGINARY_KEY" > "$t"; ' +
                    'php occ config:import "$t"; rc=$?; rm -f "$t"; exit $rc',
            ],
            { env: { QSH_IMAGINARY_KEY: env.NEXTCLOUD_IMAGINARY_SECRET } },
        );
    }

    onLine('Previews: images and iPhone HEIC via Imaginary, video thumbnails via ffmpeg.');
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
    // Checked here as well as in the route: this is stored in .env, which is
    // read a line at a time, and a quote is the one character that file cannot
    // always hold as typed. Refused before Nextcloud is touched, so the two
    // never disagree about what the password is.
    const problem = adminPasswordProblem(password);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    const { user } = nextcloudAdmin();
    await docker(occArgs(['user:resetpassword', '--password-from-env', user], { env: ['OC_PASS'] }), {
        timeoutMs: 120_000,
        env: { OC_PASS: password },
    });
    updateEnvFile({ NEXTCLOUD_ADMIN_PASSWORD: password });
}

/** Why a new Nextcloud admin password cannot be used, or null. */
export function adminPasswordProblem(password) {
    const text = String(password ?? '');
    if (text.length < 10) return 'The password needs to be at least 10 characters.';
    if (text.length > 200) return 'That password is too long.';
    if (/[\r\n\0]/.test(text)) return 'The password cannot contain a line break.';
    if (/['"`\\]/.test(text)) return 'Leave quotes, backticks and backslashes out of the password: the stack keeps it in a settings file that cannot always hold them as typed.';
    return null;
}

// ------------------------------------------------------- trusted domains ----

/** The trusted-domain list as a list. */
export const trustedDomainList = (cfg) => String(cfg.nextcloud.trustedDomains || '').split(/[\s,]+/).filter(Boolean);

/**
 * Adds names to Nextcloud's trusted domains in the panel's config, and says
 * which were new. Saved and written to .env when anything changed; pushing the
 * list into a running Nextcloud is the caller's, since only it knows whether
 * now is a good moment.
 *
 * Always loaded fresh rather than taking a config from the caller: this runs
 * from timers and from jobs that were queued a while ago, and saving a copy
 * read before the wait would quietly undo whatever was saved during it.
 */
export function addTrustedDomains(names) {
    const cfg = loadAppsConfig();
    const have = new Set(trustedDomainList(cfg));
    const add = names.filter((n) => n && TRUSTED_DOMAIN_RE.test(n) && !have.has(n));
    if (add.length) {
        cfg.nextcloud.trustedDomains = [...have, ...add].slice(0, MAX_TRUSTED_DOMAINS).join(' ');
        saveAppsConfig(cfg);
        writeAppsEnv(cfg);
    }
    return { cfg, added: add };
}

/*
 * Two kinds of entry an older version left in the list.
 *
 * *.duckdns.org names, from when publishing went through DuckDNS. That is
 * gone, its names no longer lead here, and all they still do is take up room
 * in a list the panel keeps adding to.
 *
 * And 172.16.*.*, the old default, which looked like it covered the 172.16/12
 * private range and only covered its first /16 (Nextcloud's wildcards are per
 * part). The docker networks it was there for are proxies, which
 * TRUSTED_PROXIES covers; a home network that genuinely uses 172.x addresses
 * gets the machine's own address trusted when Nextcloud starts.
 *
 * Done once, recorded in manager.json, so somebody who deliberately puts
 * 172.16.*.* back is not overruled on every start.
 */
export function migrateTrustedDomains(loadManager, saveManager) {
    const mgr = loadManager();
    if (mgr.migrations?.trustedDomains2026) return { changed: false, removed: [] };
    const cfg = loadAppsConfig();
    const before = trustedDomainList(cfg);
    const keep = before.filter((d) => !/(^|\.)duckdns\.org$/i.test(d) && d !== '172.16.*.*');
    const removed = before.filter((d) => !keep.includes(d));
    if (removed.length) {
        cfg.nextcloud.trustedDomains = keep.join(' ') || 'localhost';
        saveAppsConfig(cfg);
        writeAppsEnv(cfg);
    }
    mgr.migrations = { ...(mgr.migrations ?? {}), trustedDomains2026: true };
    saveManager(mgr);
    return { changed: removed.length > 0, removed };
}

// ------------------------------------------------------ jellyfin hardware ----

/*
 * Turning the GPU on in Jellyfin as well as handing it over.
 *
 * The checkbox passes /dev/dri into the container, and on its own that does
 * nothing: Jellyfin transcodes with whatever its Playback settings say, and a
 * new install says "none". So the box was ticked, the device was there, and
 * every stream still went through the processor.
 *
 * Set once, on the way from off to on, and only over "none": a choice somebody
 * made in Jellyfin's own settings -- QSV, a different render node -- is theirs
 * and stays. VAAPI because it is what works across Intel and AMD on Linux, and
 * this machine's GPU is AMD. The record of having done it lives next to the
 * panel's other state and is cleared when the box is unticked, so ticking it
 * again is a new transition.
 */
const JELLYFIN_HWACCEL_FILE = path.join(CONF_DIR, 'jellyfin-hwaccel.json');
const JELLYFIN_CONFIG_VOLUME = 'quickstart-home-jellyfin-config';
const RENDER_NODE = '/dev/dri/renderD128';

export function clearJellyfinHwaccelMark() {
    fs.rmSync(JELLYFIN_HWACCEL_FILE, { force: true });
}

/** The encoding.xml with VAAPI switched on, or null when it should be left as it is. */
export function withVaapi(xml) {
    const type = /<HardwareAccelerationType>\s*([^<]*?)\s*<\/HardwareAccelerationType>/.exec(xml);
    if (type && type[1].toLowerCase() !== 'none' && type[1] !== '') return null;
    let out = type
        ? xml.replace(type[0], '<HardwareAccelerationType>vaapi</HardwareAccelerationType>')
        : xml.replace(/<\/EncodingOptions>/, '  <HardwareAccelerationType>vaapi</HardwareAccelerationType>\n</EncodingOptions>');
    if (out === xml) return null;
    out = /<VaapiDevice>[^<]*<\/VaapiDevice>/.test(out)
        ? out.replace(/<VaapiDevice>[^<]*<\/VaapiDevice>/, `<VaapiDevice>${RENDER_NODE}</VaapiDevice>`)
        : out.replace(/<VaapiDevice\s*\/>/, `<VaapiDevice>${RENDER_NODE}</VaapiDevice>`);
    if (!out.includes(`<VaapiDevice>${RENDER_NODE}</VaapiDevice>`)) {
        out = out.replace(/<\/EncodingOptions>/, `  <VaapiDevice>${RENDER_NODE}</VaapiDevice>\n</EncodingOptions>`);
    }
    return out;
}

/**
 * Applies the above if it is due. Jellyfin rewrites its settings files from
 * memory as it runs, so the edit is made with it stopped; it is stopped here
 * if need be, and left for the caller's `up` to start again.
 */
export async function syncJellyfinHwaccel(docker, cfg, onLine = () => {}) {
    if (!cfg.jellyfin.hardwareAcceleration) {
        clearJellyfinHwaccelMark();
        return { changed: false };
    }
    if (fs.existsSync(JELLYFIN_HWACCEL_FILE)) return { changed: false };

    try {
        await docker(['run', '--rm', '-v', '/:/host:ro', 'alpine:3.21', 'test', '-c', `/host${RENDER_NODE}`], { timeoutMs: 60_000 });
    } catch {
        onLine(`There is no ${RENDER_NODE} on this machine, so Jellyfin's transcoding setting is left as it is.`);
        return { changed: false };
    }

    const file = '/config/config/encoding.xml';
    let xml;
    try {
        ({ stdout: xml } = await docker(['run', '--rm', '-v', `${JELLYFIN_CONFIG_VOLUME}:/config:ro`, 'alpine:3.21', 'cat', file], { timeoutMs: 60_000 }));
    } catch {
        // Jellyfin writes this the first time it starts. Until then there is
        // nothing to change, and the next apply looks again.
        onLine('Jellyfin has not written its transcoding settings yet. Apply again after it has started once to switch the GPU on in them.');
        return { changed: false };
    }

    const next = withVaapi(xml);
    const mark = () => writeJson(JELLYFIN_HWACCEL_FILE, { setAt: new Date().toISOString(), device: RENDER_NODE });
    if (!next) {
        onLine('Jellyfin already has a hardware transcoding choice of its own, so it is kept.');
        mark();
        return { changed: false };
    }

    const container = APPS.jellyfin.container;
    let wasRunning = false;
    try {
        const { stdout } = await docker(['inspect', '-f', '{{.State.Running}}', container], { timeoutMs: 15_000 });
        wasRunning = stdout.trim() === 'true';
    } catch {
        wasRunning = false;
    }
    if (wasRunning) {
        onLine('Stopping Jellyfin for a moment to switch its transcoding to the GPU.');
        await docker(['stop', container], { timeoutMs: 2 * 60_000 });
    }

    // The new file goes in through the environment, not the command line,
    // and replaces the old one with the same owner, in one rename.
    await docker(
        [
            'run', '--rm', '-e', 'QSH_XML', '-v', `${JELLYFIN_CONFIG_VOLUME}:/config`, 'alpine:3.21', 'sh', '-c',
            'f=/config/config/encoding.xml; t="$f.qsh"; printf "%s" "$QSH_XML" > "$t" && ' +
                'chown "$(stat -c %u:%g "$f")" "$t" && chmod "$(stat -c %a "$f")" "$t" && mv "$t" "$f"',
        ],
        { timeoutMs: 60_000, env: { QSH_XML: next } },
    );
    mark();
    onLine(`Jellyfin will transcode on the GPU (VAAPI, ${RENDER_NODE}). This can be changed under Dashboard, Playback in Jellyfin.`);
    return { changed: true, wasRunning };
}
