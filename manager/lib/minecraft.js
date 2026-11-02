import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { MINECRAFT_RESERVED_FOLDERS, MINECRAFT_WORLD_RE } from './apps.js';
import { containerState, docker } from './dockerctl.js';
import { STACK_LOCAL, hostPath } from './paths.js';

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

// ------------------------------------------------------------------ worlds ---

/*
 * A world is one folder in the data volume, and the server plays whichever one
 * LEVEL names. So adding a world is copying a folder in, and switching is
 * changing that name and restarting. Neither touches the world being left: it
 * stays where it is, and switching back is the same operation.
 */

const LOAD_LEVEL_DAT_UNDER = 8 * 1024 * 1024;

/** Just enough of Minecraft's NBT format to read a world's name and version. */
function readNbt(buf) {
    let p = 0;
    const str = () => {
        const n = buf.readUInt16BE(p);
        p += 2;
        const s = buf.toString('utf8', p, p + n);
        p += n;
        return s;
    };
    const skipArray = (width) => {
        const n = buf.readInt32BE(p);
        if (n < 0 || p + 4 + n * width > buf.length) throw new Error('Bad array in level.dat');
        p += 4 + n * width;
        return null;
    };
    const value = (type) => {
        switch (type) {
            case 1: p += 1; return buf.readInt8(p - 1);
            case 2: p += 2; return buf.readInt16BE(p - 2);
            case 3: p += 4; return buf.readInt32BE(p - 4);
            case 4: p += 8; return Number(buf.readBigInt64BE(p - 8));
            case 5: p += 4; return buf.readFloatBE(p - 4);
            case 6: p += 8; return buf.readDoubleBE(p - 8);
            case 7: return skipArray(1);
            case 8: return str();
            case 9: {
                const inner = buf.readInt8(p);
                const n = buf.readInt32BE(p + 1);
                p += 5;
                const out = [];
                for (let i = 0; i < n; i += 1) out.push(value(inner));
                return out;
            }
            case 10: {
                const out = {};
                for (;;) {
                    const t = buf.readInt8(p);
                    p += 1;
                    if (t === 0) return out;
                    const key = str();
                    out[key] = value(t);
                }
            }
            case 11: return skipArray(4);
            case 12: return skipArray(8);
            default: throw new Error(`Unknown NBT type ${type}`);
        }
    };
    if (buf.readInt8(p) !== 10) throw new Error('level.dat does not start with a compound tag');
    p += 1;
    str();
    return value(10);
}

/** What a level.dat says about its world. Anything unreadable is just not shown. */
export function describeLevelDat(base64) {
    try {
        const nbt = readNbt(zlib.gunzipSync(Buffer.from(base64, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }));
        const data = nbt.Data ?? {};
        return {
            levelName: typeof data.LevelName === 'string' ? data.LevelName : null,
            version: typeof data.Version?.Name === 'string' ? data.Version.Name : null,
            dataVersion: Number(data.DataVersion ?? data.Version?.Id) || null,
            lastPlayed: Number(data.LastPlayed) || null,
        };
    } catch {
        return { levelName: null, version: null, dataVersion: null, lastPlayed: null };
    }
}

/** The worlds in the data volume, and which one the server plays. */
export async function listWorlds(cfg) {
    const state = await containerState(CONTAINER);
    const current = cfg.minecraft.level;
    const base = { installed: state.exists, running: state.running, current, worlds: [] };
    if (!state.exists) return base;

    const script =
        'cd "$D" || exit 1; for f in */level.dat; do [ -f "$f" ] || continue; w="${f%/level.dat}"; ' +
        's=$(wc -c < "$f"); printf \'\\n@@W %s %s %s\\n\' "$w" "$(du -sk "$w" | cut -f1)" "$s"; ' +
        `[ "$s" -lt ${LOAD_LEVEL_DAT_UNDER} ] && base64 "$f" | tr -d '\\n'; done; printf '\\n'`;
    const { stdout } = await inDataDir(state.running, script);

    const rows = [];
    const parts = stdout.split(/\n@@W (\S+) (\d+) (\d+)\n/);
    for (let i = 1; i < parts.length; i += 4) {
        rows.push({ name: parts[i], bytes: Number(parts[i + 1]) * 1024, ...describeLevelDat(parts[i + 3].trim()) });
    }
    const names = new Set(rows.map((r) => r.name));
    const newest = rows.find((r) => r.name === current)?.dataVersion ?? null;
    base.worlds = rows
        // Names the panel could not switch to, and the Nether and End of an
        // older Paper world, which are part of that world rather than their own.
        .filter((r) => MINECRAFT_WORLD_RE.test(r.name) && !MINECRAFT_RESERVED_FOLDERS.has(r.name))
        .filter((r) => !names.has(r.name.replace(/_(?:nether|the_end)$/, '')) || !/_(?:nether|the_end)$/.test(r.name))
        .map((r) => ({ ...r, current: r.name === current, newer: Boolean(newest && r.dataVersion && r.dataVersion > newest) }))
        .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
    return base;
}

/*
 * Copies one world into the volume, and never over anything.
 *
 * Unpacked inside the volume, so that the last step is a rename and a half-done
 * copy is never mistaken for a world. A Bedrock world has a level.dat too, so
 * the check for one comes before the check for a world at all. The exit codes
 * are how importWorld tells these apart.
 */
export const IMPORT_SCRIPT = String.raw`
set -u
t="/d/.qsh-import-$$"
trap 'rm -rf "$t"' EXIT
mkdir -p "$t/x" || exit 1
if [ -d /in ]; then
  scan=/in
  depth="-maxdepth 3"
else
  scan="$t/x"
  depth=""
  case "$(head -c 2 /in | od -An -tx1 | tr -d ' \n')" in
    504b) echo "Unpacking the zip..."; unzip -q /in -d "$t/x" || [ $? -eq 1 ] || exit 1 ;;
    1f8b) echo "Unpacking the archive..."; tar -xzf /in -C "$t/x" -o || exit 1 ;;
    *) exit 6 ;;
  esac
  find "$t/x" -type l -delete
fi

find "$scan" $depth -type f -name level.dat ! -path '*/__MACOSX/*' > "$t/all"
[ -s "$t/all" ] || exit 4
m=$(awk -F/ '{ if (!m || NF<m) m=NF } END { print m }' "$t/all")
awk -F/ -v m="$m" 'NF==m' "$t/all" | grep -Ev '(_nether|_the_end)/level\.dat$' > "$t/roots"
[ -s "$t/roots" ] || awk -F/ -v m="$m" 'NF==m' "$t/all" | head -1 > "$t/roots"
if [ "$(wc -l < "$t/roots")" -gt 1 ]; then
  while IFS= read -r f; do basename "$(dirname "$f")"; done < "$t/roots"
  exit 5
fi
root="$(dirname "$(cat "$t/roots")")"
if [ -d "$root/db" ] || [ -f "$root/levelname.txt" ]; then exit 3; fi

name="$QSH_NAME"
if [ "$root" != "$scan" ]; then
  b="$(printf %s "$(basename "$root")" | tr -c 'A-Za-z0-9_-' '_' | cut -c1-40)"
  case "$b" in
    ""|[!A-Za-z0-9]*|plugins|libraries|logs|versions|config|cache) ;;
    *) name="$b" ;;
  esac
fi
n="$name"; i=2
while [ -e "/d/$n" ]; do n="$name-$i"; i=$((i+1)); done

echo "Adding it as $n..."
parent="$(dirname "$root")"
oldname="$(basename "$root")"
# An older Paper world keeps its Nether and End beside it. They go along under
# the names Paper looks for, so it can find them when it upgrades the world.
for part in "" _nether _the_end; do
  src="$parent/$oldname$part"
  [ -d "$src" ] || continue
  if [ "$scan" = /in ]; then
    cp -a "$src" "$t/w$part" || exit 1
    mv "$t/w$part" "/d/$n$part" || exit 1
  else
    mv "$src" "/d/$n$part" || exit 1
  fi
  rm -f "/d/$n$part/session.lock"
  find "/d/$n$part" -type l -delete
  chown -R "$(stat -c %u:%g /d)" "/d/$n$part"
done
echo "QSH_WORLD=$n"
`;

const IMPORT_HELPER = 'quickstart-home/manager:1';

function worldNameFrom(raw) {
    const cleaned = path
        .basename(String(raw ?? '').replace(/\\/g, '/').replace(/\/+$/, ''))
        .replace(/\.(?:zip|tar\.gz|tgz)$/i, '')
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^[^A-Za-z0-9]+/, '')
        .slice(0, 30);
    return !cleaned || MINECRAFT_RESERVED_FOLDERS.has(cleaned) ? 'imported-world' : cleaned;
}

/** Brings a world in from a folder or archive at this path on the host. */
export async function importWorld({ source, suggestedName, onLine = () => {} }) {
    const state = await containerState(CONTAINER);
    if (!state.exists) throw userError('Minecraft is not installed yet.', 409);

    const captured = [];
    const onOutput = (line) => {
        captured.push(line);
        if (!line.startsWith('QSH_WORLD=')) onLine(line);
    };
    try {
        await docker(
            [
                'run', '--rm',
                '-e', `QSH_NAME=${worldNameFrom(suggestedName)}`,
                // --mount, not -v: for a path that is not there, -v makes an
                // empty root-owned folder and carries on. This refuses.
                '--mount', `type=bind,source=${source},target=/in,readonly`,
                '-v', `${VOLUME}:/d`,
                IMPORT_HELPER, 'sh', '-c', IMPORT_SCRIPT,
            ],
            { onLine: onOutput, timeoutMs: 3 * 60 * 60_000 },
        );
    } catch (err) {
        const found = captured.filter((l) => l && !l.startsWith('Unpacking')).join(', ');
        const messages = {
            3: 'That is a Bedrock world. This server runs Java Edition worlds, and Bedrock players see them through Geyser, so it has to be converted first. Chunker (chunker.app) converts Bedrock worlds to Java.',
            4: 'There is no Minecraft world in that. A world is a folder with a file called level.dat directly inside it.',
            5: `That holds more than one world (${found}). Add them one at a time.`,
            6: 'That is not a format the panel can read. Use a .zip or .tar.gz of the world folder.',
        };
        if (messages[err.code]) throw userError(messages[err.code]);
        if (/bind source path does not exist/i.test(err.message)) {
            throw userError('That path does not exist on this machine. Give it as this machine sees it.');
        }
        throw err;
    }
    const name = captured.find((l) => l.startsWith('QSH_WORLD='))?.slice('QSH_WORLD='.length);
    if (!name) throw new Error('The copy finished without saying what it added.');
    onLine(`Added "${name}". The Worlds tab switches to it.`);
    return { name };
}

// Files the browser sends wait here, in the stack directory, because that is
// somewhere both this container and a helper container can reach.
const UPLOAD_DIR = path.join(STACK_LOCAL, 'uploads');
const MAX_UPLOAD = 100 * 1024 * 1024 * 1024;

/** Writes an upload to disk as it arrives, since a world can be far bigger than memory. */
export async function saveUpload(req) {
    const state = await containerState(CONTAINER);
    if (!state.exists) throw userError('Minecraft is not installed yet.', 409);
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const id = crypto.randomUUID();
    const file = path.join(UPLOAD_DIR, id);
    let size = 0;
    const limit = new Transform({
        transform(chunk, _encoding, done) {
            size += chunk.length;
            done(size > MAX_UPLOAD ? userError('That file is over the 100 GB limit.', 413) : null, chunk);
        },
    });
    try {
        await pipeline(req, limit, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
        fs.rmSync(file, { force: true });
        throw err;
    }
    if (!size) {
        fs.rmSync(file, { force: true });
        throw userError('That file is empty.');
    }
    return { file, source: hostPath('uploads', id) };
}

/** Anything an interrupted upload or import left behind. Run at startup. */
export function clearUploads() {
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
}

/**
 * Checks a typed path before it goes near a mount. The comma matters: --mount
 * is a comma-separated list, so one in a path would start another option.
 */
export function checkImportPath(raw) {
    const value = String(raw ?? '').trim().replace(/(.)\/+$/, '$1');
    if (!value.startsWith('/')) throw userError('Give the full path, starting with a /, as this machine sees it.');
    if (/[\0-\x1f,]/.test(value) || value.split('/').includes('..')) throw userError('That path contains a character this cannot use, such as a comma.');
    if (value === '/') throw userError('That is the whole machine. Give the world folder itself.');
    return value;
}

// ---------------------------------------------------------------- consoles ---

/*
 * Xbox, PlayStation and Switch players.
 *
 * Their Minecraft has no Add Server button -- only the handful of featured
 * servers, and whatever friends are playing. MCXboxBroadcast uses the second
 * door: it signs a Microsoft account into this server, advertises the world as
 * that account's game session, and relays anyone who joins it through Xbox
 * Live's own connection to Geyser. So a console player adds one gamertag as a
 * friend and the server appears under Friends, on any console, with nothing
 * changed on the console itself and no port forwarded for it.
 *
 * It is a Geyser extension, which lives in a folder the image does not manage,
 * so the panel puts it there itself before each start -- fresh each time, the
 * same way the image fetches Geyser, because the two have to keep up with
 * Bedrock's releases together.
 */
const BRIDGE_URL = 'https://github.com/MCXboxBroadcast/Broadcaster/releases/latest/download/MCXboxBroadcastExtension.jar';
const EXTENSIONS = 'plugins/Geyser-Spigot/extensions';
const BRIDGE_JAR = `${EXTENSIONS}/MCXboxBroadcastExtension.jar`;
// Its sign-in and friend list. Deleting this is signing out.
const BRIDGE_DATA = `${EXTENSIONS}/mcxboxbroadcast`;

/**
 * Puts the console bridge in place, or takes it away, ahead of a start.
 *
 * A failed download is reported and not thrown: Java and Bedrock players do
 * not need the bridge, and a server that will not start because GitHub was
 * slow would be a worse outcome than one where only consoles wait.
 */
export async function syncConsoleBridge(enabled, onLine = () => {}) {
    const state = await containerState(CONTAINER);
    if (!state.exists) return;
    const owner = '(chown -R "$(stat -c %u:%g "$D")" "$D/plugins" 2>/dev/null || true)';
    if (!enabled) {
        await inDataDir(state.running, `rm -f "$D/${BRIDGE_JAR}"`).catch(() => {});
        return;
    }
    onLine('Fetching the console bridge (MCXboxBroadcast) so Xbox, PlayStation and Switch players can join...');
    const script =
        `mkdir -p "$D/${EXTENSIONS}" && t="$D/${EXTENSIONS}/.qsh-download" && ` +
        '{ { command -v curl >/dev/null 2>&1 && curl -fsSL -o "$t" "$QSH_URL"; } || wget -qO "$t" "$QSH_URL"; } && ' +
        // A jar is a zip, and a zip starts with PK. Anything else is an error
        // page, and installing that would stop Geyser loading at all.
        '[ "$(head -c 2 "$t")" = "PK" ] && ' +
        `mv "$t" "$D/${BRIDGE_JAR}" && ${owner}`;
    try {
        await inDataDir(state.running, script, { QSH_URL: BRIDGE_URL });
        onLine('Console bridge is in place.');
    } catch (err) {
        await inDataDir(state.running, `rm -f "$D/${EXTENSIONS}/.qsh-download"`).catch(() => {});
        onLine(`Could not fetch the console bridge, so consoles cannot join this time: ${err.message}`);
    }
}

/** Forgets the Microsoft account the bridge signed in with, so another can be used. */
export async function resetConsoleAccount() {
    const state = await containerState(CONTAINER);
    if (!state.exists) throw userError('Minecraft is not installed yet.', 409);
    await inDataDir(state.running, `rm -rf "$D/${BRIDGE_DATA}"`);
}

/**
 * Where the console bridge has got to, read from what it printed.
 *
 * The bridge only talks through the server log, in plain sentences: the code to
 * sign in with, the account it signed in as, and what went wrong. Whichever it
 * said most recently is where it is now, so a code stops being shown the moment
 * something later has happened to it.
 *
 * Failing to sign in is worth telling apart because the bridge never recovers
 * by itself. It logs the failure and goes quiet until the server restarts, and
 * it only saves the account once every step has worked -- so each attempt after
 * a failure starts again from a new code.
 */
export async function consoleStatus(cfg) {
    const enabled = Boolean(cfg.minecraft?.consoles);
    const state = await containerState(CONTAINER);
    const base = { enabled, installed: state.exists, running: state.running, state: 'off' };
    if (!enabled) return base;
    if (!state.running) return { ...base, state: 'stopped' };

    let text = '';
    try {
        const { stdout, stderr } = await docker(['logs', '--tail', '4000', '--since', state.startedAt, CONTAINER], { timeoutMs: 15_000 });
        text = stripColours(`${stdout}${stderr}`);
    } catch {
        return { ...base, state: 'starting' };
    }
    const lines = text.split('\n');
    const last = (re) => {
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const m = re.exec(lines[i]);
            if (m) return { i, m };
        }
        return null;
    };

    const code = last(/To sign in, use a web browser to open the page (\S+) and enter the code (\S+) to authenticate/);
    const ok = last(/Successfully authenticated as (.+?) \((\d+)\) with (\d+)\/(\d+) friends/);
    const age = last(/requiring age verification/);
    const live = last(/Creation of Xbox LIVE session was successful/);
    // The bridge's errors are logged at WARN, with the reason on the next line.
    const authFailed = last(/\[mcxboxbroadcast\].*(?:Failed to get\/refresh auth token|Failed to refresh tokens|Re-auth still failed)/i);
    const sessionFailed = last(/\[mcxboxbroadcast\].*(?:Failed to create xbox session|extension will not start)/i);

    const reasonFor = (hit) => {
        const context = lines.slice(hit.i, hit.i + 2).join('\n');
        const reason = /error message: (.+)/.exec(context)?.[1] ?? lines[hit.i + 1]?.replace(/^[\w.$]+(?:Exception|Error):\s*/, '') ?? hit.m[0];
        return { context, reason: reason.trim().slice(0, 240) };
    };

    const latest = [code, ok, age, authFailed].filter(Boolean).sort((a, b) => b.i - a.i)[0];
    if (!latest) {
        return sessionFailed ? { ...base, state: 'error', error: reasonFor(sessionFailed).reason } : { ...base, state: 'starting' };
    }
    if (latest === code) return { ...base, state: 'sign-in', url: code.m[1], code: code.m[2] };
    if (latest === age) return { ...base, state: 'age' };
    if (latest === authFailed) {
        const { context, reason } = reasonFor(authFailed);
        return /XO_E_ACCOUNT_CREATION_REQUIRED/.test(context)
            ? { ...base, state: 'no-profile' }
            : { ...base, state: 'error', error: reason };
    }

    const account = {
        gamertag: ok.m[1].trim(),
        friends: Number(ok.m[3]),
        maxFriends: Number(ok.m[4]),
    };
    if (sessionFailed && sessionFailed.i > ok.i && !(live && live.i > sessionFailed.i)) {
        return { ...base, ...account, state: 'error', error: reasonFor(sessionFailed).reason };
    }
    return { ...base, ...account, state: live && live.i > ok.i ? 'ready' : 'connecting' };
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
