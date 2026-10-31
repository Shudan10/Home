import fs from 'node:fs';
import path from 'node:path';
import { ENV_FILE, MANAGER_CONFIG_FILE } from './paths.js';

// ---------------------------------------------------------------- defaults --

export const DEFAULT_MANAGER_CONFIG = {
    updates: { lastCheckedAt: null, latestKnown: null, autoCheck: true },
    // The Cloudflare tunnel every published app goes through. The two tokens
    // are not here: they live in the stack's .env, which only this panel can
    // read, rather than in a JSON file that a backup copies around.
    tunnel: {
        // Picked once and kept through a disconnect, so the tunnel this install
        // makes in Cloudflare is the one it finds again on reconnecting, and a
        // second install on the same account makes a second tunnel rather than
        // fighting over the first.
        installId: null,
        accountId: null,
        accountName: null,
        tunnelId: null,
        tunnelName: null,
        // The domains the token can publish on: [{ id, name }].
        zones: [],
        // [{ hostname, zoneId, service, origin, createdAt }]
        routes: [],
    },
};

// ------------------------------------------------------------------- io ----

export function readJson(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return mergeDefaults(JSON.parse(raw), fallback);
    } catch {
        return structuredClone(fallback);
    }
}

export function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// Recursive defaults fill so a config written by an older version keeps working
// after new keys are added. Arrays are replaced wholesale, not merged.
function mergeDefaults(value, defaults) {
    if (Array.isArray(defaults)) return Array.isArray(value) ? value : structuredClone(defaults);
    if (defaults && typeof defaults === 'object') {
        const out = {};
        for (const key of Object.keys(defaults)) {
            out[key] = mergeDefaults(value?.[key], defaults[key]);
        }
        // Preserve unknown keys so nothing the user set is silently dropped.
        for (const key of Object.keys(value ?? {})) {
            if (!(key in out)) out[key] = value[key];
        }
        return out;
    }
    return value === undefined ? structuredClone(defaults) : value;
}

export const loadManagerConfig = () => readJson(MANAGER_CONFIG_FILE, DEFAULT_MANAGER_CONFIG);
export const saveManagerConfig = (cfg) => writeJson(MANAGER_CONFIG_FILE, cfg);

// ------------------------------------------------------------- .env file ----

export function readEnvFile() {
    const out = {};
    let raw;
    try {
        raw = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
        return out;
    }
    for (const line of raw.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        out[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
    return out;
}

// Rewrites in place, preserving comments and key order. The file is a bind
// mount of a single host file, so it must never be replaced via rename.
export function updateEnvFile(updates) {
    let raw = '';
    try {
        raw = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
        /* first write */
    }
    const lines = raw.split(/\r?\n/);
    const remaining = new Map(Object.entries(updates));

    const next = lines.map((line) => {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (!match || !remaining.has(match[1])) return line;
        const key = match[1];
        const value = remaining.get(key);
        remaining.delete(key);
        return `${key}=${value}`;
    });

    for (const [key, value] of remaining) next.push(`${key}=${value}`);
    fs.writeFileSync(ENV_FILE, `${next.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}
