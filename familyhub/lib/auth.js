import crypto from 'node:crypto';
import net from 'node:net';
import { promisify } from 'node:util';

/*
 * Lifted from the Quick Start Home panel, with the pieces that only the panel
 * needed taken out. Kept as its own copy rather than imported: this app ships
 * as a separate image with no access to the panel's source tree, and the whole
 * stack's rule is zero npm dependencies.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'mealplan_session';
const SCRYPT_KEYLEN = 32;

const SESSION_SECRET =
    process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
        ? process.env.SESSION_SECRET
        : crypto.randomBytes(32).toString('hex');

const PASSWORD_HASH = (process.env.MEALPLAN_PASSWORD_HASH || '').trim();

/*
 * What sessions are actually signed with: the secret and the password hash
 * together.
 *
 * A session is stateless, so there is no list of them to empty when the
 * password changes -- and the secret outlives a password change, because the
 * panel keeps it in .env. Folding the hash into the key does the emptying
 * instead: a new password is a new key, and every cookie signed under the old
 * one stops verifying. Which is the point of changing the password after a
 * phone has gone missing.
 */
const SESSION_KEY = `${SESSION_SECRET}:${PASSWORD_HASH}`;

const scrypt = promisify(crypto.scrypt);

export const authConfigured = () => PASSWORD_HASH.length > 0;
export const authRequired = () => authConfigured();

/**
 * A stored hash that cannot be verified, which is not the same as a wrong
 * password and must not be reported as one.
 *
 * The panel hit this for real: compose interpolates `$NAME` when it reads
 * .env, so a `scrypt$salt$hash` value arrived truncated and every password was
 * refused including the right one. Colons are used here for that reason, and
 * this check names the state if an old-style value ever turns up.
 */
export const passwordUnusable = () => {
    if (!authConfigured()) return false;
    const [scheme, saltHex, hashHex] = PASSWORD_HASH.split(/[:$]/);
    return scheme !== 'scrypt' || !saltHex || !hashHex;
};

export function hashPassword(password, salt = crypto.randomBytes(16)) {
    const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/*
 * Async scrypt, not scryptSync. A derivation is tens of milliseconds of CPU,
 * and the sync one spends them on the event loop -- so somebody hammering the
 * login form stalled every other request, the family's included. The async one
 * runs on libuv's thread pool and the server keeps answering meanwhile.
 */
export async function verifyPassword(password) {
    if (!authConfigured()) return false;
    const [scheme, saltHex, hashHex] = PASSWORD_HASH.split(/[:$]/);
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    let derived;
    try {
        derived = await scrypt(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
    } catch {
        return false;
    }
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== derived.length) return false;
    return crypto.timingSafeEqual(expected, derived);
}

/*
 * Stateless sessions: "<expiry>.<random>.<hmac>". Nothing to persist, and a
 * restart without a fixed secret invalidates everything, which is the safe
 * direction to fail in. So does a password change -- see SESSION_KEY.
 *
 * The month-long expiry is the one real departure from the panel's twelve
 * hours. This is a phone on a home screen that someone opens to ask what is for
 * dinner; a login prompt every morning would mean nobody uses it.
 */
export function issueSession() {
    const expires = Date.now() + SESSION_TTL_MS;
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = `${expires}.${nonce}`;
    const sig = crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('hex');
    return { token: `${payload}.${sig}`, expires };
}

export function validateSession(token) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [expires, nonce, sig] = parts;
    const expected = crypto.createHmac('sha256', SESSION_KEY).update(`${expires}.${nonce}`).digest('hex');
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return Number(expires) > Date.now();
}

/*
 * Each value decoded on its own, and a bad one skipped.
 *
 * decodeURIComponent throws on a stray `%`, and the browser sends every cookie
 * for the host, not just ours -- so one malformed cookie set by something else
 * on the same address used to throw out of here, past the request's error
 * handling, and take the whole server down with it.
 */
export function parseCookies(header = '') {
    const out = {};
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        try {
            out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
        } catch {
            // Not ours to fix, and not a reason to refuse the request.
        }
    }
    return out;
}

export function sessionCookie(token, { secure }) {
    const attrs = [
        `${COOKIE_NAME}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
}

export const clearCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// ------------------------------------------------------- login throttling --

/*
 * Who is asking, as far as the login limiter is concerned.
 *
 * The socket address is all a direct connection gets. A forwarding header is
 * believed only when the connection itself comes from a private or loopback
 * address -- the tunnel's container, Tailscale serve, a proxy on this machine --
 * because anyone else could write whatever they liked in it and be a new
 * client on every attempt. Behind such a proxy the last X-Forwarded-For entry
 * is the one it added, the hop nearest to us; anything to its left was sent by
 * the client and proves nothing. Cloudflare's own header wins when it is there,
 * since through the tunnel every request arrives from the same container.
 */
export const isPrivateAddress = (addr) => {
    const ip = String(addr || '').replace(/^::ffff:/i, '');
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    if (net.isIPv6(ip)) {
        const lower = ip.toLowerCase();
        return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
    }
    return false;
};

export function clientAddress(req) {
    const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
    if (!isPrivateAddress(peer)) return peer || 'unknown';
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(cf)) return cf;
    const hops = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
    const nearest = hops.at(-1);
    if (nearest && net.isIP(nearest)) return nearest;
    return peer || 'unknown';
}

/*
 * Five wrong passwords in fifteen minutes and that client waits out the rest
 * of the fifteen. Generous for a family member who has forgotten it, and a
 * wall for a script: a few hundred guesses a day instead of a few per second.
 *
 * The overall cap is for the script that rotates addresses, or that sits
 * behind the tunnel where every request might claim to be someone new. Past
 * it nobody can sign in for a while, which sounds worse than it is: sessions
 * last a month, so the phones already signed in carry on regardless. Kept in
 * memory, so a restart forgets -- fine for a limiter, whose job is the next
 * quarter of an hour.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_CLIENT = 5;
const LOGIN_MAX_OVERALL = 50;
const LOGIN_MAX_TRACKED = 10_000;

const failures = new Map(); // client -> [timestamp, ...]
let overall = []; // every failure, for the overall cap

const recent = (list, now) => list.filter((t) => now - t < LOGIN_WINDOW_MS);

/** Milliseconds until this client may try again, or 0 if it may now. */
export function loginRetryAfter(client, now = Date.now()) {
    overall = recent(overall, now);
    if (overall.length >= LOGIN_MAX_OVERALL) return LOGIN_WINDOW_MS - (now - overall[0]);
    const mine = recent(failures.get(client) ?? [], now);
    if (mine.length) failures.set(client, mine);
    else failures.delete(client);
    if (mine.length >= LOGIN_MAX_PER_CLIENT) return LOGIN_WINDOW_MS - (now - mine[0]);
    return 0;
}

/*
 * Every attempt is counted as a failure the moment it starts, and taken back
 * if the password turns out right. Counting only once scrypt has said no left
 * a gap the width of the check: fifty guesses sent at once all passed the
 * limiter before the first of them had failed.
 */
export function noteLoginAttempt(client, now = Date.now()) {
    // A flood of made-up addresses must not grow this without end. Expired
    // entries go first; if that is not enough, the oldest ones do.
    if (failures.size >= LOGIN_MAX_TRACKED) {
        for (const [key, list] of failures) if (!recent(list, now).length) failures.delete(key);
        for (const key of failures.keys()) {
            if (failures.size < LOGIN_MAX_TRACKED) break;
            failures.delete(key);
        }
    }
    failures.set(client, [...recent(failures.get(client) ?? [], now), now]);
    overall.push(now);
    return now;
}

/** The right password: this client starts clean, and its attempt is uncounted. */
export function noteLoginSuccess(client, attempt) {
    failures.delete(client);
    const idx = overall.indexOf(attempt);
    if (idx >= 0) overall.splice(idx, 1);
}

export const isAuthenticated = (req) => validateSession(parseCookies(req.headers.cookie || '')[COOKIE_NAME]);

export { COOKIE_NAME };
