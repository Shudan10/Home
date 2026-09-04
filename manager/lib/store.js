import fs from 'node:fs';
import path from 'node:path';
import { DOMAINS_FILE, ENV_FILE, MANAGER_CONFIG_FILE, PROXIES_FILE } from './paths.js';

// ---------------------------------------------------------------- defaults --

export const DEFAULT_MANAGER_CONFIG = {
    duckdns: { enabled: false, domains: '', token: '', intervalMinutes: 5, lastResult: null, lastRunAt: null },
    updates: { lastCheckedAt: null, latestKnown: null, autoCheck: true },
    // The reverse proxy claims ports 80 and 443, so it stays off until someone
    // actually wants a domain. null means "not decided yet" and is resolved
    // once, on first boot, from whether the stack is already using it.
    proxy: {
        enabled: null,
        // What the outside world reaches this machine on, which is not always
        // what nginx binds. A router can send external 8443 to this machine's
        // 443, and it has to, on a network where 443 already belongs to
        // something else. The panel needs the outside numbers to write a
        // redirect that lands in the right place and to show an address that
        // can be pasted into a browser.
        publicHttpPort: 80,
        publicHttpsPort: 443,
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

export const loadProxies = () => readJson(PROXIES_FILE, []);
export const saveProxies = (list) => writeJson(PROXIES_FILE, list);

export const loadDomains = () => readJson(DOMAINS_FILE, []);
export const saveDomains = (list) => writeJson(DOMAINS_FILE, list);

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
