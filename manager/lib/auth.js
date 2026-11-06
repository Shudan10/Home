import crypto from 'node:crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'quickstart_home_session';
const SCRYPT_KEYLEN = 32;

const SESSION_SECRET =
    process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
        ? process.env.SESSION_SECRET
        : crypto.randomBytes(32).toString('hex');

// The panel binds every interface, because a home server is a thing you open
// from the sofa. That makes a password not optional: the manager holds the
// Docker socket, which is root on the host, so a panel reachable from the
// network without one hands the machine to anyone who finds the port.
//
// install.sh therefore always sets this -- it generates and prints a password
// when none is given. An empty value is still handled rather than fatal, since
// the panel has to come up far enough to say so and let one be set.
const PASSWORD_HASH = (process.env.ADMIN_PASSWORD_HASH || '').trim();

export const authConfigured = () => PASSWORD_HASH.length > 0;

/**
 * True when a password is stored but cannot possibly be verified.
 *
 * Hashes written before the separator changed reached the container truncated,
 * because docker compose interpolated the `$` in them while reading .env. The
 * panel would then refuse every password including the right one, with nothing
 * to say why. Naming the state is what turns a lockout into an instruction.
 */
export const passwordUnusable = () => {
    if (!authConfigured()) return false;
    const [scheme, saltHex, hashHex] = PASSWORD_HASH.split(/[:$]/);
    return scheme !== 'scrypt' || !saltHex || !hashHex;
};

/** True when a caller must sign in. Mirrors authConfigured, named for intent. */
export const authRequired = () => authConfigured();

export function hashPassword(password, salt = crypto.randomBytes(16)) {
    const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    // Colons, not dollars. This value is stored in .env, and docker compose
    // interpolates $NAME when it reads that file, so `scrypt$salt$hash` reached
    // the container with everything from the second $ replaced by nothing --
    // whenever the hash happened to start with a letter, which is most of the
    // time. It failed silently: the panel simply refused the right password.
    return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

const scryptAsync = (password, salt) =>
    new Promise((resolve, reject) =>
        crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key))),
    );

/**
 * Whether this is the panel's password.
 *
 * Asynchronous, on the thread pool, because scrypt is slow on purpose -- that
 * is the whole point of it -- and the synchronous version spent that time on
 * the one thread that also answers every other request. A handful of wrong
 * guesses arriving together held up the status poll, the job stream and the
 * log tiles for as long as they took to refuse.
 */
export async function verifyPassword(password) {
    if (!authConfigured()) return false;
    // `$` is the separator this used to use. Accepted so an install that set a
    // password before the change keeps working -- if compose left it intact.
    const [scheme, saltHex, hashHex] = PASSWORD_HASH.split(/[:$]/);
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    let derived;
    try {
        derived = await scryptAsync(String(password), Buffer.from(saltHex, 'hex'));
    } catch {
        return false;
    }
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== derived.length) return false;
    return crypto.timingSafeEqual(expected, derived);
}

/*
 * Sessions: "<expiry>.<random>.<hmac>", with nothing stored per session.
 *
 * The signing key is not only SESSION_SECRET. That one lives in .env and
 * survives restarts -- install.sh writes it once and keeps it -- so a cookie
 * signed with it alone stayed valid for its full twelve hours through anything,
 * including the one event that is supposed to end every session: changing the
 * password. Somebody who had the old password, or a cookie lifted from a
 * borrowed laptop, kept their way in after the owner had changed it to keep
 * them out.
 *
 * So the key is derived from the secret *and* the stored password hash. A new
 * password is a new hash, the manager restarts to read it, and every cookie
 * signed under the old one stops verifying. Clearing the password does the same.
 *
 * Signing out is the other end: a cookie being deleted by the browser is a
 * request, not a guarantee, and a copy of it would otherwise work until it
 * expired. Signed-out ids are remembered here until the moment they would have
 * expired anyway, which is as long as remembering them can matter. That list
 * is in memory, so a restart forgets it -- the one case it does not cover is a
 * restart with the same password, where the copy still has only its expiry.
 */
const SIGNING_KEY = crypto.createHmac('sha256', SESSION_SECRET).update(`session:${PASSWORD_HASH}`).digest();

const sign = (payload) => crypto.createHmac('sha256', SIGNING_KEY).update(payload).digest('hex');

/** nonce -> expiry, for sessions that were signed out before they ran out. */
const revoked = new Map();

function pruneRevoked() {
    const now = Date.now();
    for (const [nonce, expires] of revoked) if (expires <= now) revoked.delete(nonce);
}

export function issueSession() {
    const expires = Date.now() + SESSION_TTL_MS;
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = `${expires}.${nonce}`;
    return { token: `${payload}.${sign(payload)}`, expires };
}

/** The parts of a correctly signed token, or null. Says nothing about expiry. */
function verifiedParts(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [expires, nonce, sig] = parts;
    if (!/^\d+$/.test(expires) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return null;
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(sign(`${expires}.${nonce}`), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { expires: Number(expires), nonce };
}

export function validateSession(token) {
    const parts = verifiedParts(token);
    if (!parts || parts.expires <= Date.now()) return false;
    return !revoked.has(parts.nonce);
}

/** Ends a session on this side as well as in the browser. */
export function revokeSession(token) {
    const parts = verifiedParts(token);
    if (!parts || parts.expires <= Date.now()) return false;
    pruneRevoked();
    revoked.set(parts.nonce, parts.expires);
    return true;
}

/**
 * The request's cookies, by name.
 *
 * Each one is decoded on its own and kept raw when it will not decode. A
 * browser sends every cookie set for this address, including ones written by
 * whatever else has lived on it -- and a single value with a stray % in it used
 * to throw out of here, which threw out of the request handler, which took the
 * whole panel down with it.
 */
export function parseCookies(header = '') {
    // No prototype, so a cookie called __proto__ is just a cookie.
    const out = Object.create(null);
    for (const part of String(header).split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const name = part.slice(0, idx).trim();
        if (!name || Object.hasOwn(out, name)) continue;
        const raw = part.slice(idx + 1).trim();
        try {
            out[name] = decodeURIComponent(raw);
        } catch {
            out[name] = raw;
        }
    }
    return out;
}

export function sessionCookie(token, { secure }) {
    const attrs = [
        `${COOKIE_NAME}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
}

export const clearCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export const sessionToken = (req) => parseCookies(req.headers.cookie || '')[COOKIE_NAME] ?? null;

export const isAuthenticated = (req) => validateSession(sessionToken(req));

export { COOKIE_NAME };
