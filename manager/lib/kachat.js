import crypto from 'node:crypto';
import path from 'node:path';
import * as dockerctl from './dockerctl.js';
import { CONF_DIR } from './paths.js';
import { loadManagerConfig, readEnvFile, readJson, saveManagerConfig, updateEnvFile, writeJson } from './store.js';

/*
 * KaChat Nextcloud: a second, separate Nextcloud for the KaChat and KaPay apps.
 *
 * KaChat signs in to a Nextcloud with a server address, a username and an app
 * password, and uses it for three things: photo, video and voice messages
 * (uploaded to KaChat/Media and sent as public share links), an encrypted
 * contacts backup it shares with KaPay (KaChat/kachat-contacts.json), and
 * Nextcloud Talk for calls. KaPay uses the same account for contacts and its
 * portfolio files.
 *
 * It is its own Nextcloud rather than an account in the personal one so that
 * putting it on a domain exposes nothing of that one: different containers,
 * database, volumes and image, and nothing here ever runs a command in the
 * personal Nextcloud.
 *
 * Nobody needs its web pages. The panel makes the accounts, the app passwords
 * and the share list; the tunnel only lets through what the apps call (see
 * ALLOWED_PATHS). The admin account exists because Nextcloud needs one, with
 * a long random password nobody is shown.
 */

// Its services, volumes and image are listed once, in lifecycle.js's UNITS.
export const CONTAINER = 'quickstart-home-kachat-nextcloud';
export const CONTAINERS = [CONTAINER, 'quickstart-home-kachat-db', 'quickstart-home-kachat-redis'];
/** Where the tunnel sends a name published for it, on the stack network. */
export const ORIGIN = 'http://kachat-nextcloud:80';
const INTERNAL = process.env.KACHAT_INTERNAL_URL || ORIGIN;

/*
 * What a name published for KaChat lets through, as one regular expression
 * on the path. Cloudflare's tunnel matches it per request and answers 404 to
 * everything else, so the web login, the file browser and the settings pages
 * do not exist on the internet at all.
 *
 * From KaChat's and KaPay's own code (KaspaSilver/KaChat-iPhone and
 * KaPay-iPhone, NextcloudService.swift and NextcloudTalkClient.swift):
 *   remote.php/dav/files/<user>/...       uploads, contacts, portfolio files
 *   ocs .../cloud/user, cloud/capabilities  sign-in check, Talk check
 *   ocs .../files_sharing/api/v1/shares   making the public link
 *   ocs .../core/apppassword              revoking on disconnect
 *   ocs .../apps/spreed/...               Talk calls, host and guest
 *   index.php/core/preview.png            thumbnails
 * and what a public share link needs to show a photo or play a video for
 * someone with no account: the share page, its downloads and previews, and
 * the static files the page loads. That last part was measured, not guessed:
 * a share page for a photo and one for a video, opened and played, and every
 * request they made checked against this.
 *
 * Any account's own files are allowed, not just one: RE2 has no "except", and
 * the only other account here is the admin, whose password is random and
 * 40 characters long.
 */
export const ALLOWED_PATHS =
    '^/(' +
    [
        'remote\\.php/dav/(files|uploads)/[^/]+(/|$)',
        'ocs/v[12]\\.php/(cloud/(user|capabilities)$|apps/files_sharing/api/v1/|core/apppassword$|apps/spreed/)',
        'index\\.php/core/preview',
        '(index\\.php/)?s/',
        'public\\.php/',
        // The share page's photo preview and a chat app's link preview image.
        '(index\\.php/)?apps/files_sharing/publicpreview/',
        // The placeholder avatar the share page shows a visitor.
        'avatar/guest/',
        'index\\.php/apps/(theming|viewer)/',
        '(index\\.php/)?(css|js)/',
        // Static files only, by their type: never a .php under these.
        '(core|dist|apps|custom_apps|themes)/[A-Za-z0-9._/-]*\\.(js|mjs|css|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|json|map)$',
        'status\\.php$',
        'favicon\\.ico$',
        'robots\\.txt$',
    ].join('|') +
    ')';

/*
 * Ice servers for KaChat calls. KaChat takes these from Talk and has none of
 * its own, and with none at all two phones on different networks rarely find
 * each other. STUN needs no open port anywhere: each phone asks it what its
 * own public address is, and nothing is relayed.
 */
const STUN_SERVERS = ['stun.cloudflare.com:3478', 'stun.nextcloud.com:443'];

// Apps a messenger's storage has no use for. Disabled, not removed.
const UNWANTED_APPS = ['firstrunwizard', 'dashboard', 'weather_status', 'recommendations', 'survey_client', 'nextcloud_announcements'];

const PREVIEW_PROVIDERS = [
    'OC\\Preview\\PNG',
    'OC\\Preview\\JPEG',
    'OC\\Preview\\GIF',
    'OC\\Preview\\BMP',
    'OC\\Preview\\WebP',
    'OC\\Preview\\HEIC',
    'OC\\Preview\\Movie',
    'OC\\Preview\\MP3',
];

const deps = {
    compose: dockerctl.compose,
    docker: dockerctl.docker,
    containerState: dockerctl.containerState,
    fetch: (...args) => fetch(...args),
};
/** Test seam. */
export function _setDeps(next) {
    Object.assign(deps, next);
}

class KachatError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// ----------------------------------------------------------------- state ---

const config = () => loadManagerConfig().kachat ?? {};

function saveConfig(patch) {
    const cfg = loadManagerConfig();
    cfg.kachat = { ...(cfg.kachat ?? {}), ...patch };
    saveManagerConfig(cfg);
}

/*
 * The panel's own app password for each account, used to list and stop its
 * shares through the share API -- there is no `occ` command that deletes a
 * share. Kept in the conf folder with the panel's other state, never shown.
 */
const PANEL_TOKENS_FILE = path.join(CONF_DIR, 'kachat-panel-tokens.json');
const panelTokens = () => readJson(PANEL_TOKENS_FILE, {});
const savePanelTokens = (t) => writeJson(PANEL_TOKENS_FILE, t);
const PANEL_TOKEN_NAME = 'Home panel (share list)';

const random = (n = 30) => crypto.randomBytes(n).toString('base64url').slice(0, n + 10);

/** Database and admin passwords, made once, kept in .env like the rest. */
function ensureSecrets() {
    const env = readEnvFile();
    const missing = {};
    for (const key of ['KACHAT_DB_ROOT_PASSWORD', 'KACHAT_DB_PASSWORD', 'KACHAT_ADMIN_PASSWORD']) {
        if (!(env[key] || '').trim()) missing[key] = random(40);
    }
    if (Object.keys(missing).length) updateEnvFile(missing);
}

// ------------------------------------------------------------------ occ ---

/** An `occ` command in the KaChat Nextcloud, never the personal one. */
function occ(args, { env, timeoutMs = 120_000 } = {}) {
    const envFlags = Object.keys(env ?? {}).flatMap((k) => ['-e', k]);
    return deps.docker(['exec', '-u', 'www-data', ...envFlags, CONTAINER, 'php', 'occ', ...args], { timeoutMs, env });
}

async function occJson(args) {
    const { stdout } = await occ([...args, '--output=json']);
    return JSON.parse(stdout.trim() || 'null');
}

async function waitReady(onLine, timeoutMs = 10 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    let said = false;
    while (Date.now() < deadline) {
        try {
            const s = await occJson(['status']);
            if (s?.installed === true && !s.maintenance) return true;
        } catch {
            /* not up yet */
        }
        if (!said) {
            said = true;
            onLine('Waiting for it to finish setting itself up. The first start takes a minute or two...');
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
}

const USERNAME_RE = /^[a-z][a-z0-9._-]{1,31}$/;

export function checkUsername(name) {
    const u = String(name ?? '').trim().toLowerCase();
    if (!USERNAME_RE.test(u)) {
        throw new KachatError('A username is 2 to 32 characters: lower-case letters, numbers, dots, dashes and underscores, starting with a letter.');
    }
    if (u === 'admin') throw new KachatError('"admin" is taken by Nextcloud itself. Pick another name.');
    return u;
}

// -------------------------------------------------------------- settings ---

/**
 * Everything this Nextcloud should be set to. Safe to run again: each step
 * sets a value rather than adding to it.
 */
async function configure(onLine = () => {}) {
    const host = publicHost();
    const domains = ['localhost', 'kachat-nextcloud', host].filter(Boolean);
    for (const [i, d] of domains.entries()) await occ(['config:system:set', 'trusted_domains', String(i), '--value', d]);
    for (let i = domains.length; i < domains.length + 5; i++) await occ(['config:system:delete', 'trusted_domains', String(i)]).catch(() => {});
    await occ(['config:system:set', 'overwrite.cli.url', '--value', host ? `https://${host}` : 'http://kachat-nextcloud']);

    for (const [i, p] of PREVIEW_PROVIDERS.entries()) {
        await occ(['config:system:set', 'enabledPreviewProviders', String(i), '--value', p]);
    }
    // Background jobs from the panel's timer, not from page loads: there are
    // almost no page loads here, so ajax mode would mean they never ran.
    await occ(['background:cron']).catch(() => {});

    for (const app of UNWANTED_APPS) await occ(['app:disable', app]).catch(() => {});

    // Talk, for KaChat calls. From the app store the first time.
    try {
        await occ(['app:install', 'spreed'], { timeoutMs: 5 * 60_000 }).catch(() => {});
        await occ(['app:enable', 'spreed'], { timeoutMs: 2 * 60_000 });
        const have = (await occJson(['talk:stun:list']).catch(() => [])) ?? [];
        const listed = new Set((Array.isArray(have) ? have : Object.values(have)).map(String));
        for (const s of STUN_SERVERS) if (!listed.has(s)) await occ(['talk:stun:add', s]).catch(() => {});
    } catch (err) {
        onLine(`Could not set up Talk, so KaChat calls are off for now (${err.message}). It is tried again on the next start.`);
    }

    // Public links on, nothing else shared from here.
    await occ(['config:app:set', 'core', 'shareapi_allow_links', '--value', 'yes']).catch(() => {});
    await occ(['config:app:set', 'core', 'shareapi_allow_public_upload', '--value', 'no']).catch(() => {});
    await occ(['config:app:set', 'core', 'shareapi_allow_resharing', '--value', 'no']).catch(() => {});
}

/** The public name, if one is published for KaChat. */
export function publicHost() {
    const route = (loadManagerConfig().tunnel?.routes ?? []).find((r) => r.service === 'kachat');
    return route?.hostname ?? null;
}

/** After a name is published or taken off: the links it makes follow. */
export async function applyPublicHost(onLine = () => {}) {
    if (!(await deps.containerState(CONTAINER)).running) return;
    await configure(onLine);
    const host = publicHost();
    onLine(host ? `KaChat Nextcloud now answers on https://${host}.` : 'KaChat Nextcloud has no public name now.');
}

// ------------------------------------------------------------- lifecycle ---

/*
 * Installing, the switch and uninstalling are the panel's usual ones
 * (lifecycle.js), like every other app. Three things are KaChat's own: the
 * secrets it needs before its first build, the setup it does the first time
 * it is started, and what it leaves behind when it is removed.
 */

/** Before install: the database and admin passwords compose reads. */
export { ensureSecrets };

/**
 * Every start. Waits for Nextcloud, reapplies the settings, and the first
 * time also makes the account the apps sign in to -- there is nothing to set
 * up in a container that has never run, which is why it happens here and
 * not at install.
 */
export async function afterStart(onLine = () => {}) {
    if (!(await waitReady(onLine))) {
        onLine('KaChat Nextcloud did not finish starting in time, so its settings were left for the next start.');
        return;
    }
    const first = !isInstalled();
    if (first) onLine('Setting it up for KaChat: Talk for calls, previews for photos and videos, public links...');
    await configure(onLine);
    if (first) {
        const existing = (await occJson(['user:list']).catch(() => ({}))) ?? {};
        // Reinstalled over kept data: its accounts are already there.
        if (!Object.keys(existing).some((u) => u !== 'admin')) await addAccount('kachat', onLine);
        saveConfig({ installedAt: new Date().toISOString() });
        onLine('Ready. Make an app password on its page and put it in KaChat.');
    }
}

/**
 * After uninstall. The panel's own record of it goes; with its data, so do
 * its passwords and the panel's tokens, which would mean nothing to a fresh
 * one. Kept data keeps them, so installing again picks everything back up.
 */
export function forget({ keepData = false } = {}, onLine = () => {}) {
    const cfg = loadManagerConfig();
    delete cfg.kachat;
    saveManagerConfig(cfg);
    if (keepData) return;
    // Each on its own: one that fails must not leave the other behind.
    try {
        updateEnvFile({ KACHAT_DB_ROOT_PASSWORD: '', KACHAT_DB_PASSWORD: '', KACHAT_ADMIN_PASSWORD: '' });
    } catch (err) {
        onLine(`Could not clear its passwords from .env: ${err.message}`);
    }
    try {
        savePanelTokens({});
    } catch (err) {
        onLine(`Could not clear the panel's tokens for it: ${err.message}`);
    }
}

// --------------------------------------------------------------- accounts ---

export async function addAccount(username, onLine = () => {}) {
    const user = checkUsername(username);
    const existing = await occJson(['user:list']).catch(() => ({}));
    if (existing && Object.hasOwn(existing, user)) throw new KachatError(`There is already an account called "${user}".`, 409);
    // A login password nobody is told: the apps use app passwords, and there
    // is no web login on the internet to type one into.
    await occ(['user:add', '--password-from-env', '--display-name', user, user], { env: { OC_PASS: random(40) } });
    await occ(['user:setting', user, 'files', 'quota', '20 GB']).catch(() => {});
    // The panel's own token, for listing and stopping this account's shares.
    const token = await makeAppPassword(user, PANEL_TOKEN_NAME);
    savePanelTokens({ ...panelTokens(), [user]: token });
    onLine(`Made the account "${user}", with 20 GB of space.`);
    return { username: user };
}

export async function removeAccount(username, onLine = () => {}) {
    const user = checkUsername(username);
    await occ(['user:delete', user]);
    const t = panelTokens();
    delete t[user];
    savePanelTokens(t);
    onLine(`Removed "${user}" and everything in it.`);
}

const QUOTA_RE = /^(none|\d{1,5} ?(MB|GB|TB))$/i;

export async function setQuota(username, quota) {
    const user = checkUsername(username);
    const q = String(quota ?? '').trim();
    if (!QUOTA_RE.test(q)) throw new KachatError('Space is a number with MB, GB or TB, like "20 GB", or "none" for no limit.');
    await occ(['user:setting', user, 'files', 'quota', q.toLowerCase() === 'none' ? 'none' : q.toUpperCase().replace(/(\d)([A-Z])/, '$1 $2')]);
}

async function makeAppPassword(user, name) {
    const { stdout } = await occ(['user:auth-tokens:add', '--name', name, user]);
    // "app password:\n<token>" -- the last non-empty line is the token.
    const token = String(stdout).trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (!token || token.length < 20) throw new KachatError('Nextcloud did not hand back an app password.', 502);
    return token;
}

/** A new app password for an app. Shown once, by the page; never kept here. */
export async function addAppPassword(username, label) {
    const user = checkUsername(username);
    const name = String(label ?? '').trim().slice(0, 60) || 'KaChat';
    if (name === PANEL_TOKEN_NAME) throw new KachatError('That name is the panel\'s own. Pick another.');
    return { name, password: await makeAppPassword(user, name) };
}

export async function revokeAppPassword(username, id) {
    const user = checkUsername(username);
    const list = await appPasswords(user, { includePanel: true });
    const token = list.find((t) => String(t.id) === String(id));
    if (!token) throw new KachatError('There is no such app password.', 404);
    if (token.name === PANEL_TOKEN_NAME) throw new KachatError('That one is the panel\'s own, for the share list.');
    await occ(['user:auth-tokens:delete', user, String(id)]);
}

async function appPasswords(user, { includePanel = false } = {}) {
    const raw = (await occJson(['user:auth-tokens:list', user]).catch(() => [])) ?? [];
    return (Array.isArray(raw) ? raw : Object.values(raw))
        .filter((t) => Number(t.type) === 1 || t.type === undefined)
        .filter((t) => includePanel || t.name !== PANEL_TOKEN_NAME)
        .map((t) => ({
            id: t.id,
            name: t.name,
            lastActivity: t.lastActivity ? new Date(Number(t.lastActivity) * 1000).toISOString() : null,
        }));
}

// ----------------------------------------------------------------- shares ---

async function ocs(user, method, pathAndQuery, body) {
    const token = panelTokens()[user];
    if (!token) throw new KachatError(`The panel has no way in to "${user}" to read its shares.`, 409);
    const res = await deps.fetch(`${INTERNAL}${pathAndQuery}`, {
        method,
        headers: {
            Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
            'OCS-APIRequest': 'true',
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
        signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new KachatError(data?.ocs?.meta?.message || `Nextcloud answered ${res.status}.`, res.status);
    return data?.ocs?.data;
}

/** Every public link this account has made, newest first. */
export async function shares(username) {
    const user = checkUsername(username);
    const host = publicHost();
    const list = (await ocs(user, 'GET', '/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json')) ?? [];
    return list
        .filter((s) => Number(s.share_type) === 3)
        .map((s) => ({
            id: s.id,
            name: String(s.file_target ?? s.path ?? '').split('/').pop(),
            path: s.path,
            mime: s.mimetype,
            fileId: s.file_source ?? s.item_source,
            created: s.stime ? new Date(Number(s.stime) * 1000).toISOString() : null,
            expires: s.expiration || null,
            // Rewritten to the public name: a link made by the panel's own
            // request would otherwise carry the internal address.
            url: host && s.token ? `https://${host}/s/${s.token}` : s.url,
        }))
        .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

export async function stopSharing(username, id) {
    const user = checkUsername(username);
    if (!/^\d+$/.test(String(id))) throw new KachatError('There is no such share.', 404);
    await ocs(user, 'DELETE', `/ocs/v2.php/apps/files_sharing/api/v1/shares/${id}?format=json`);
}

/** A thumbnail for the share list, fetched as the account. */
export async function preview(username, fileId) {
    const user = checkUsername(username);
    if (!/^\d+$/.test(String(fileId))) throw new KachatError('No such file.', 404);
    const token = panelTokens()[user];
    if (!token) throw new KachatError('No way in.', 409);
    const res = await deps.fetch(`${INTERNAL}/index.php/core/preview?fileId=${fileId}&x=160&y=160&a=1`, {
        headers: { Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` },
        signal: AbortSignal.timeout(20_000),
    });
    const type = res.headers.get('content-type') || '';
    // Only ever an image back to the page: this is served from the panel's
    // own origin, so anything else here would be a page the panel vouched for.
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type.split(';')[0].trim())) throw new KachatError('No preview.', res.ok ? 502 : res.status);
    return { type: type.split(';')[0].trim(), body: Buffer.from(await res.arrayBuffer()) };
}

// ----------------------------------------------------------------- status ---

export const isInstalled = () => Boolean(config().installedAt);

export async function status() {
    const states = Object.fromEntries(await Promise.all(CONTAINERS.map(async (c) => [c, await deps.containerState(c).catch(() => ({ exists: false }))])));
    const main = states[CONTAINER];
    const out = {
        // Installed is the container existing, as for every app. Set up is
        // the first start having finished, which is when it has an account.
        installed: Boolean(main?.exists),
        setUp: Boolean(main?.exists) && isInstalled(),
        running: Boolean(main?.running),
        containers: states,
        publicHost: publicHost(),
        server: publicHost() ? `https://${publicHost()}` : null,
    };
    if (!out.running || !out.setUp) return out;

    try {
        const users = (await occJson(['user:list'])) ?? {};
        out.accounts = await Promise.all(
            Object.keys(users)
                .filter((u) => u !== 'admin')
                .map(async (u) => {
                    const info = await occJson(['user:info', u]).catch(() => ({}));
                    return {
                        username: u,
                        quota: info?.quota ?? null,
                        used: info?.storage?.used ?? null,
                        appPasswords: await appPasswords(u),
                        panelAccess: Boolean(panelTokens()[u]),
                    };
                }),
        );
    } catch (err) {
        out.error = `Could not read the accounts: ${err.message}`;
    }
    try {
        const talk = await occJson(['app:list']);
        out.talk = { enabled: Boolean(talk?.enabled?.spreed), version: talk?.enabled?.spreed ?? null };
        const stun = (await occJson(['talk:stun:list']).catch(() => [])) ?? [];
        out.talk.stun = Array.isArray(stun) ? stun : Object.values(stun);
        const turn = (await occJson(['talk:turn:list']).catch(() => [])) ?? [];
        out.talk.turn = (Array.isArray(turn) ? turn : Object.values(turn)).length;
    } catch {
        out.talk = null;
    }
    return out;
}

/** Background jobs, every five minutes from the panel's timer. */
export async function runCron() {
    if (!isInstalled() || !(await deps.containerState(CONTAINER)).running) return;
    await deps.docker(['exec', '-u', 'www-data', CONTAINER, 'php', '-f', '/var/www/html/cron.php'], { timeoutMs: 15 * 60_000 });
}
