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

/*
 * How a value is written into .env, and read back.
 *
 * The file is read by docker compose, which has rules of its own, and a value
 * written raw is at the mercy of them: a newline ends it and starts a new
 * variable, which is how a password field becomes a way to set anything the
 * compose file reads; ` #` starts a comment and cuts it short; `$NAME` is
 * interpolated, so a hash or a password with a dollar in it reached the
 * container with a piece missing.
 *
 * So anything beyond plain characters is quoted. Single quotes first, because
 * compose takes what is between them literally -- no interpolation, no escapes
 * -- which is exactly what a stored value wants. There is no way to write a
 * single quote inside single quotes, so a value with one goes in double quotes
 * instead, which is only safe when it has nothing that compose would expand or
 * unescape there: no $, no backslash, no double quote. A value with an
 * apostrophe and one of those as well cannot be written faithfully at all, and
 * is refused rather than stored as something else.
 *
 * Line breaks and NUL are refused outright. No quoting makes them safe in a
 * file that is read a line at a time, and none of the panel's values needs one.
 */
const PLAIN_ENV_VALUE = /^[A-Za-z0-9_\-.,:/@%+=*^~!?[\]{}()<>|&;]*$/;

export class EnvValueError extends Error {
    constructor(key, message) {
        super(message);
        this.name = 'EnvValueError';
        this.key = key;
        this.status = 400;
    }
}

export function formatEnvValue(key, raw) {
    const value = String(raw ?? '');
    if (/[\r\n\0]/.test(value)) {
        throw new EnvValueError(key, `${key} cannot contain a line break, so it was not saved.`);
    }
    if (PLAIN_ENV_VALUE.test(value)) return value;
    if (!value.includes("'")) return `'${value}'`;
    if (!/[$\\"`]/.test(value)) return `"${value}"`;
    throw new EnvValueError(
        key,
        `${key} has an apostrophe together with a $, a backslash or a double quote, which the stack's settings file cannot hold as written. Leave one of them out.`,
    );
}

/** The reverse of formatEnvValue, and of what compose does with an unquoted one. */
function parseEnvValue(raw) {
    const text = raw.trim();
    if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        return text.slice(1, -1).replace(/\\([\\"nrt$])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
    }
    // Unquoted: an inline comment needs whitespace before the #, as compose
    // reads it, so a # inside a word stays part of the word.
    return text.replace(/\s+#.*$/, '');
}

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
        out[match[1]] = parseEnvValue(match[2]);
    }
    return out;
}

// Rewrites in place, preserving comments and key order. The file is a bind
// mount of a single host file, so it must never be replaced via rename.
//
// Every value is formatted before anything is written, so one that is refused
// leaves the file exactly as it was rather than half updated.
export function updateEnvFile(updates) {
    const formatted = new Map(Object.entries(updates).map(([key, value]) => [key, formatEnvValue(key, value)]));

    let raw = '';
    try {
        raw = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
        /* first write */
    }
    const lines = raw ? raw.replace(/(\r?\n)+$/, '').split(/\r?\n/) : [];
    const remaining = new Map(formatted);

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
