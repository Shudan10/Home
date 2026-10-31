import crypto from 'node:crypto';
import { containerState, docker } from './dockerctl.js';

/**
 * The Minecraft server's players: who is on, who may join, who runs it, who is
 * banned -- and the commands that change each.
 *
 * The server keeps those lists itself, in whitelist.json, ops.json and the two
 * ban files in its data volume, and it changes them on its own whenever an
 * operator types /whitelist or /ban in the game. So the panel does not keep a
 * copy. A second list the panel reconciled onto the server would undo whatever
 * was done in-game the next time it ran; reading the server's own files and
 * writing to them is the only arrangement where both agree.
 *
 * Java and Bedrock players share those files. Bedrock players arrive through
 * Geyser and Floodgate, which give each one a Java-side identity: the gamertag
 * behind a "." (Floodgate's default prefix, with spaces turned into
 * underscores) and a UUID made from their Xbox user id, which always starts
 * with sixteen zeros. That UUID is what tells the two apart in every list here.
 */

export const CONTAINER = 'quickstart-home-minecraft';
export const VOLUME = 'quickstart-home-minecraft-data';

const HELPER_IMAGE = 'alpine:3.21';
const BEDROCK_PREFIX = '.';
const FLOODGATE_UUID = /^00000000-0000-0000-/;

// What a Java Edition name can be. Mojang has allowed exactly these characters
// since 2011, and a handful of older accounts are shorter than three.
const JAVA_NAME = /^[A-Za-z0-9_]{1,16}$/;
// Xbox gamertags: letters, digits and spaces. Modern ones can carry a #1234
// suffix, but that is display only -- the lookup takes the name without it.
const GAMERTAG = /^[A-Za-z0-9 _]{1,16}$/;
// Free text that goes into an RCON command. One line, and nothing that the
// server would read as the start of another argument it does not expect.
const REASON = /^[^\r\n§]{0,100}$/;

/** A refusal worth showing as it is, rather than as a server fault. */
const userError = (message, status = 400) => Object.assign(new Error(message), { status });

export const platformOf = (uuid) => (FLOODGATE_UUID.test(String(uuid ?? '')) ? 'bedrock' : 'java');

/** How a player is named on the Java side, which is what every command takes. */
export function javaSideName(platform, name) {
    const raw = String(name ?? '').trim();
    if (platform === 'bedrock') return `${BEDROCK_PREFIX}${raw.replace(/^\./, '').replace(/ /g, '_')}`;
    return raw;
}

function checkName(platform, name) {
    const trimmed = String(name ?? '').trim();
    // People copy a Bedrock name out of the online list with its prefix on.
    const raw = platform === 'bedrock' ? trimmed.replace(/^\./, '') : trimmed;
    if (platform === 'bedrock') {
        if (!GAMERTAG.test(raw)) throw userError('A gamertag is letters, numbers and spaces, up to 16 of them. Leave off any #1234 on the end.');
    } else if (!JAVA_NAME.test(raw)) {
        throw userError('A Java Edition name is letters, numbers and underscores, up to 16 of them.');
    }
    return raw;
}

// ----------------------------------------------------------------- rcon ---

/** Minecraft's colour codes and the terminal's, neither of which a page wants. */
const stripColours = (text) => String(text ?? '').replace(/§[0-9a-fk-or]/gi, '').replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Runs one console command on the live server and returns what it said.
 *
 * Through the image's own rcon-cli, which already knows the RCON password the
 * image generated for itself. The command is one argument and no shell is
 * involved, so nothing in it is re-parsed on the way.
 */
export async function rcon(command, { timeoutMs = 20_000 } = {}) {
    const { stdout } = await docker(['exec', CONTAINER, 'rcon-cli', command], { timeoutMs });
    return stripColours(stdout).trim();
}

/*
 * The replies that mean a command did nothing. RCON has no exit status: every
 * reply comes back as text, and "That player does not exist" arrives exactly
 * the way "Made Steve a server operator" does.
 */
const REFUSED = /does not exist|unknown or incomplete|incorrect argument|no player was found|unknown command|nothing changed|could not|isn't|is not (?:banned|on the whitelist|an operator)/i;

async function rconChecked(command) {
    let out;
    try {
        out = await rcon(command);
    } catch {
        throw userError('The server is running but not answering yet. It takes a minute to start; try again shortly.', 409);
    }
    if (REFUSED.test(out)) throw userError(out || 'The server refused that.');
    return out;
}

/** Whether the server is far enough up to take commands. */
export async function isReady() {
    try {
        await rcon('list', { timeoutMs: 10_000 });
        return true;
    } catch {
        return false;
    }
}

// --------------------------------------------------------- the data dir ---

/**
 * Runs a small script against the server's data directory.
 *
 * Inside the server's own container while it runs, and in a throwaway one with
 * the volume mounted while it is stopped -- so the lists can be read and
 * changed either way, and nobody has to start the server to let a friend in
 * first. The script finds the directory in $D, which is the only difference
 * between the two.
 */
function inDataDir(running, script, env = {}) {
    const envFlags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    if (running) {
        return docker(['exec', '-e', 'D=/data', ...envFlags, CONTAINER, 'sh', '-c', script], { timeoutMs: 30_000 });
    }
    return docker(
        ['run', '--rm', '-e', 'D=/d', ...envFlags, '-v', `${VOLUME}:/d`, HELPER_IMAGE, 'sh', '-c', script],
        { timeoutMs: 60_000 },
    );
}

const DATA_FILES = ['whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json', 'server.properties'];

/** Every list and the properties file, in one trip. */
async function readDataFiles(running) {
    const script = `for f in ${DATA_FILES.join(' ')}; do printf '\\n@@QSH %s\\n' "$f"; cat "$D/$f" 2>/dev/null; done`;
    const { stdout } = await inDataDir(running, script);
    const out = {};
    const parts = stdout.split(/\n@@QSH (\S+)\n/);
    for (let i = 1; i < parts.length; i += 2) out[parts[i]] = parts[i + 1] ?? '';
    return out;
}

const parseList = (text) => {
    try {
        const value = JSON.parse(text || '[]');
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
};

function parseProperties(text) {
    const out = {};
    for (const line of String(text ?? '').split('\n')) {
        const m = /^([^#=\s][^=]*)=(.*)$/.exec(line.trim());
        if (m) out[m[1].trim()] = m[2].trim();
    }
    return out;
}

/**
 * Replaces one file, owned by whoever owns the data directory.
 *
 * The server runs as an unprivileged user and these helpers run as root, so a
 * file written plainly would end up root's -- and the next /whitelist add in
 * the game would fail to save it. Written beside the target and moved into
 * place, so the server never reads half of one.
 */
async function writeDataFile(running, file, content) {
    if (!DATA_FILES.includes(file)) throw new Error(`Not a file the panel writes: ${file}`);
    const script =
        'printf %s "$QSH_DATA" | base64 -d > "$D/.qsh-tmp" && mv "$D/.qsh-tmp" "$D/$QSH_FILE" && ' +
        '(chown "$(stat -c %u:%g "$D")" "$D/$QSH_FILE" 2>/dev/null || true)';
    await inDataDir(running, script, { QSH_FILE: file, QSH_DATA: Buffer.from(content, 'utf8').toString('base64') });
}

async function editList(running, file, change) {
    const files = await readDataFiles(running);
    const next = change(parseList(files[file]));
    await writeDataFile(running, file, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Turns the allow list on or off in server.properties while the server is down.
 *
 * Works before the first start too, when the file does not exist yet: the image
 * fills a properties file in rather than replacing it, so a file holding only
 * this line comes through the first boot with the line intact.
 */
async function setWhitelistProperty(on) {
    const script =
        'f="$D/server.properties"; t="$D/.qsh-tmp"; ' +
        '{ [ -f "$f" ] && grep -v -e "^white-list=" -e "^enforce-whitelist=" "$f"; ' +
        'echo "white-list=$QSH_ON"; echo "enforce-whitelist=true"; } > "$t" && mv "$t" "$f" && ' +
        '(chown "$(stat -c %u:%g "$D")" "$f" 2>/dev/null || true)';
    await inDataDir(false, script, { QSH_ON: on ? 'true' : 'false' });
}

// ------------------------------------------------------------ name lookup ---

const dashed = (hex) => hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5').toLowerCase();

/**
 * The UUID a server in offline mode gives a name: an MD5 of "OfflinePlayer:"
 * and the name, stamped as a version 3 UUID. Same as the server works out, so
 * an entry made here matches the player who turns up.
 */
function offlineUuid(name) {
    const b = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
    b[6] = (b[6] & 0x0f) | 0x30;
    b[8] = (b[8] & 0x3f) | 0x80;
    return dashed(b.toString('hex'));
}

async function lookupJava(name, onlineMode) {
    if (!onlineMode) return { name, uuid: offlineUuid(name) };
    // Two addresses for the same answer. The older one has been "about to be
    // retired" for years and still works; the newer one is the fallback.
    const urls = [
        `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
        `https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(name)}`,
    ];
    let lastStatus = null;
    for (const url of urls) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (res.status === 404 || res.status === 204) {
                throw userError(`There is no Java Edition account called "${name}". It is the name shown in the Minecraft launcher.`);
            }
            if (!res.ok) {
                lastStatus = res.status;
                continue;
            }
            const body = await res.json();
            if (body?.id) return { name: body.name || name, uuid: dashed(body.id) };
        } catch (err) {
            if (err.status) throw err;
        }
    }
    throw userError(`Could not reach Mojang to look "${name}" up${lastStatus ? ` (it answered ${lastStatus})` : ''}. Try again in a minute.`, 502);
}

/**
 * A Bedrock player's Floodgate identity, from their gamertag.
 *
 * Floodgate's UUID is the Xbox user id in the low 64 bits and zeros above it,
 * and only Xbox knows the id. GeyserMC runs a public lookup for exactly this,
 * which is what Floodgate's own /fwhitelist uses -- and like it, it only knows
 * gamertags that have been seen on a Geyser server somewhere. A brand-new
 * account it has never met is the one case that cannot be added by name, and
 * the error says what to do instead.
 */
async function lookupBedrock(gamertag) {
    let res;
    try {
        res = await fetch(`https://api.geysermc.org/v2/xbox/xuid/${encodeURIComponent(gamertag)}`, {
            signal: AbortSignal.timeout(10_000),
        });
    } catch {
        throw userError('Could not reach GeyserMC to look that gamertag up. Try again in a minute.', 502);
    }
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    if (!body?.xuid) {
        throw userError(
            `GeyserMC does not know the gamertag "${gamertag}" yet. That happens with accounts that have never joined a server like this one. ` +
                'Turn "Only listed players can join" off for a moment, have them join, and add them from Players online.',
        );
    }
    const hex = BigInt(body.xuid).toString(16).padStart(16, '0');
    return { name: javaSideName('bedrock', gamertag), uuid: `00000000-0000-0000-${hex.slice(0, 4)}-${hex.slice(4)}` };
}

const lookup = (platform, name, cfg) =>
    platform === 'bedrock' ? lookupBedrock(name) : lookupJava(name, cfg.minecraft?.onlineMode !== false);

// --------------------------------------------------------------- reading ---

/**
 * "There are 2 of a max of 20 players online: Steve (uuid), .Bob (uuid)" --
 * the reply to `list uuids`. Vanilla and Paper word it the same way.
 */
function parseOnline(text) {
    const m = /There are (\d+) of a max(?: of)? (\d+) players online:?\s*([\s\S]*)$/i.exec(text);
    if (!m) return { online: [], max: null };
    const players = [];
    for (const part of m[3].split(/,\s*/).map((p) => p.trim()).filter(Boolean)) {
        const pm = /^(\S+)(?:\s+\(([0-9a-f-]{36})\))?$/i.exec(part);
        if (!pm) continue;
        const uuid = pm[2] ?? null;
        players.push({ name: pm[1], uuid, platform: uuid ? platformOf(uuid) : pm[1].startsWith(BEDROCK_PREFIX) ? 'bedrock' : 'java' });
    }
    return { online: players, max: Number(m[2]) };
}

const withPlatform = (rows) =>
    rows
        .filter((r) => r && (r.uuid || r.name))
        .map((r) => ({ ...r, platform: platformOf(r.uuid) }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));

/** Everything the Players page shows, in one call. */
export async function snapshot() {
    const state = await containerState(CONTAINER);
    const base = {
        installed: state.exists,
        running: state.running,
        ready: false,
        whitelistOn: false,
        online: [],
        max: null,
        whitelist: [],
        ops: [],
        bans: [],
        ipBans: [],
    };
    // Not installed means no volume, and mounting one that does not exist
    // would create it -- an empty volume nobody asked for.
    if (!state.exists) return base;

    let files = {};
    try {
        files = await readDataFiles(state.running);
    } catch (err) {
        base.error = `Could not read the server's lists: ${err.message}`;
    }
    const props = parseProperties(files['server.properties']);
    base.whitelistOn = props['white-list'] === 'true';
    base.max = Number(props['max-players']) || null;
    base.whitelist = withPlatform(parseList(files['whitelist.json']));
    base.ops = withPlatform(parseList(files['ops.json']));
    base.bans = withPlatform(parseList(files['banned-players.json']));
    base.ipBans = parseList(files['banned-ips.json']);

    if (state.running) {
        try {
            const parsed = parseOnline(await rcon('list uuids', { timeoutMs: 10_000 }));
            base.ready = true;
            base.online = parsed.online;
            if (parsed.max) base.max = parsed.max;
        } catch {
            // Still starting. The page says so rather than showing nobody on.
        }
    }
    return base;
}

// --------------------------------------------------------------- changing ---

const banDate = () => new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000');
const sameEntry = (who) => (e) =>
    (who.uuid && e.uuid === who.uuid) || String(e.name).toLowerCase() === String(who.name).toLowerCase();

/**
 * One change to who can play, and a sentence saying what happened.
 *
 * Lists are edited as files, which works whether the server is up or not, and
 * a running server is then told to reload. Operators and bans have no reload
 * command, so while the server runs those go through the console instead --
 * a file the server is not watching would be overwritten by its own copy the
 * next time anything changed.
 */
export async function act(input, cfg) {
    const state = await containerState(CONTAINER);
    if (!state.exists) throw userError('Minecraft is not installed yet.', 409);
    const running = state.running;
    const action = String(input.action ?? '');
    const platform = input.platform === 'bedrock' ? 'bedrock' : 'java';

    if (action === 'whitelist') {
        const on = Boolean(input.enabled);
        if (running) await rconChecked(`whitelist ${on ? 'on' : 'off'}`);
        else await setWhitelistProperty(on);
        return on ? 'Only players on the list can join now.' : 'Anyone who knows the address can join now.';
    }

    const reason = String(input.reason ?? '').trim();
    if (!REASON.test(reason)) throw userError('Keep the reason to one line of up to 100 characters.');

    // Someone picked from a list already has their UUID and the exact name
    // the server knows them by; only a typed name needs looking up.
    const known = input.uuid && /^[0-9a-f-]{36}$/i.test(String(input.uuid));
    const typed = known ? null : checkName(platform, input.name);
    const name = known ? String(input.name ?? '') : javaSideName(platform, typed);
    if (known && !/^\.?[A-Za-z0-9_]{1,17}$/.test(name)) throw userError('That is not a player name.');
    const resolve = async () => (known ? { name, uuid: String(input.uuid).toLowerCase() } : lookup(platform, typed, cfg));
    const needsRunning = (what) => {
        if (!running) throw userError(`The server is stopped, so there is nobody to ${what}.`, 409);
    };

    switch (action) {
        case 'allow': {
            const who = await resolve();
            await editList(running, 'whitelist.json', (list) =>
                list.some(sameEntry(who)) ? list : [...list, { uuid: who.uuid, name: who.name }],
            );
            if (running) await rcon('whitelist reload').catch(() => {});
            return `${who.name} is on the list.`;
        }
        case 'disallow': {
            const who = { name, uuid: known ? String(input.uuid).toLowerCase() : null };
            await editList(running, 'whitelist.json', (list) => list.filter((e) => !sameEntry(who)(e)));
            // With enforce-whitelist on, the reload is also what puts them out
            // of the game if they are in it right now.
            if (running) await rcon('whitelist reload').catch(() => {});
            return `${name} is off the list.`;
        }
        case 'op': {
            if (running) return rconChecked(`op ${name}`);
            const who = await resolve();
            await editList(running, 'ops.json', (list) =>
                list.some(sameEntry(who)) ? list : [...list, { uuid: who.uuid, name: who.name, level: 4, bypassesPlayerLimit: false }],
            );
            return `${who.name} will be an operator when the server starts.`;
        }
        case 'deop': {
            if (running) return rconChecked(`deop ${name}`);
            await editList(running, 'ops.json', (list) => list.filter((e) => !sameEntry({ name, uuid: input.uuid })(e)));
            return `${name} is no longer an operator.`;
        }
        case 'kick': {
            needsRunning('kick');
            return rconChecked(`kick ${name}${reason ? ` ${reason}` : ''}`);
        }
        case 'ban': {
            if (running) return rconChecked(`ban ${name}${reason ? ` ${reason}` : ''}`);
            const who = await resolve();
            await editList(running, 'banned-players.json', (list) =>
                list.some(sameEntry(who))
                    ? list
                    : [...list, { uuid: who.uuid, name: who.name, created: banDate(), source: 'Quick Start Home', expires: 'forever', reason: reason || 'Banned by an operator.' }],
            );
            return `${who.name} is banned.`;
        }
        case 'pardon': {
            if (running) return rconChecked(`pardon ${name}`);
            await editList(running, 'banned-players.json', (list) => list.filter((e) => !sameEntry({ name, uuid: input.uuid })(e)));
            return `${name} is no longer banned.`;
        }
        default:
            throw userError('Not something the panel knows how to do to a player.');
    }
}

/**
 * A line typed into the panel's console.
 *
 * The panel is already the machine's admin -- it holds the Docker socket -- so
 * this gives nobody anything new; it saves opening a terminal to type /time set
 * day. One line, and the leading slash people type out of habit is dropped
 * because the console does not want it.
 */
export async function command(text) {
    const line = String(text ?? '').trim().replace(/^\/+/, '');
    if (!line) throw userError('Type a command first.');
    if (line.length > 256 || /[\r\n]/.test(line)) throw userError('One line, up to 256 characters.');
    const state = await containerState(CONTAINER);
    if (!state.running) throw userError('The server is stopped, so there is nothing to send that to.', 409);
    try {
        return (await rcon(line, { timeoutMs: 30_000 })) || '(no reply)';
    } catch {
        throw userError('The server is running but not answering yet. It takes a minute to start; try again shortly.', 409);
    }
}

/**
 * This network's address as the internet sees it, for telling friends.
 *
 * Asked only when somebody presses the button: it is a request to a third
 * party, and the answer is only interesting once ports are forwarded.
 */
export async function publicAddress() {
    try {
        const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(String(res.status));
        const { ip } = await res.json();
        return /^[0-9a-f.:]{3,45}$/i.test(String(ip)) ? ip : null;
    } catch {
        throw userError('Could not find this network\'s public address just now.', 502);
    }
}
