import { loadManagerConfig, saveManagerConfig } from './store.js';
import { docker, pipeDocker, containerState, JELLYFIN_CONTAINER, MEALPLAN_CONTAINER, MINECRAFT_CONTAINER, NEXTCLOUD_CONTAINER } from './dockerctl.js';
import { IMAGE, DRIVE_GUARD, DRIVE_GONE, checkDestination, loadBackupConfig, saveBackupConfig, backupSources, resolveDataVolume, run as copyNextcloudFiles } from './backup.js';
import { STACK_HOST } from './paths.js';
import { rcon } from './minecraft.js';

/**
 * Dated copies of each app's own data, kept on the backup drive, and putting
 * one of them back.
 *
 * Nextcloud's files are the exception: 83 GB as an archive every night would
 * fill the drive in a week. They are copied by backup.js instead, as a plain
 * folder that only takes what changed, straight after Nextcloud's database in
 * the same run -- so at 3 AM everything Nextcloud is copied together. What makes an
 * app the app -- Nextcloud's database, Jellyfin's users and watch history, the
 * Minecraft world, the panel's own settings -- is small by comparison and only
 * useful whole and from one moment: a database copied while it was being
 * written is not a backup of anything. So each of these is an archive made
 * from a still moment, once a night, and a few of them are kept so that a
 * mistake noticed the day after can still be undone.
 *
 * Everything lives on the drive, under one folder, one folder per app and one
 * per copy, each with a manifest.json saying what it is. Nothing about the
 * copies is remembered anywhere else, deliberately: a machine that has been
 * reinstalled from nothing finds them by looking at the drive, which is the
 * moment they matter most.
 */

/** The folder on the drive, beside the copy of Nextcloud's files. */
export const ROOT = 'Home Server backups';

/*
 * Each service and how to copy it.
 *
 * `items` are what is taken from the volume (or, for the panel, the stack
 * folder): "." for all of it. `exclude` is what is left out of an archive and
 * left alone on a restore -- caches and downloads the app rebuilds by itself,
 * which would make every copy bigger and slower for nothing.
 *
 * The two Nextclouds' program files are not taken: the image puts them back
 * on every start. Their config, the apps installed from the app store, the
 * theme, and the database are what an install cannot recreate.
 */
export const SERVICES = [
    {
        key: 'nextcloud',
        label: 'Nextcloud',
        what: 'Your files, plus the database and settings behind them: users, shares, calendars and contacts.',
        volume: 'quickstart-home-nextcloud-data',
        items: ['config', 'custom_apps', 'themes'],
        exclude: [],
        app: NEXTCLOUD_CONTAINER,
        db: 'quickstart-home-nextcloud-db',
    },
    {
        key: 'kachat',
        label: 'KaChat Nextcloud',
        what: 'Database, settings, and every file KaChat and KaPay have backed up to it.',
        volume: 'quickstart-home-kachat-data',
        items: ['config', 'custom_apps', 'themes', 'data'],
        exclude: ['data/appdata_*/preview', 'data/nextcloud.log'],
        app: 'quickstart-home-kachat-nextcloud',
        db: 'quickstart-home-kachat-db',
    },
    {
        key: 'jellyfin',
        label: 'Jellyfin',
        what: 'Users, watch history, libraries and artwork. Not the films and shows themselves, which are in Nextcloud. Jellyfin stops for about a minute while it is copied.',
        volume: 'quickstart-home-jellyfin-config',
        items: ['.'],
        exclude: ['./log'],
        app: JELLYFIN_CONTAINER,
        // SQLite, open and being written while it runs. Stopped, its files are
        // a database; running, they are a database and a journal that may or
        // may not agree.
        stopWhileCopying: true,
    },
    {
        key: 'mealplan',
        label: 'Family Hub',
        what: 'Every event, chore, week, recipe and shopping list.',
        volume: 'quickstart-home-mealplan-data',
        items: ['.'],
        exclude: [],
        app: MEALPLAN_CONTAINER,
    },
    {
        key: 'minecraft',
        label: 'Minecraft',
        what: 'The worlds, the allow list, operators and server settings. The game downloads the rest again by itself.',
        volume: 'quickstart-home-minecraft-data',
        items: ['.'],
        exclude: ['./cache', './libraries', './versions', './logs'],
        app: MINECRAFT_CONTAINER,
        // The server keeps running and players stay in: it is only told to
        // stop writing the world until the copy is done.
        pauseSaving: true,
    },
    {
        key: 'panel',
        label: 'Panel settings',
        what: 'The panel\'s passwords and every app\'s settings, the Cloudflare and Mullvad connections (.env and conf). Anyone holding the drive can read these.',
        hostDir: STACK_HOST,
        items: ['.env', 'conf'],
        exclude: [],
    },
];

const byKey = new Map(SERVICES.map((s) => [s.key, s]));
export const serviceFor = (key) => byKey.get(key) ?? null;

// ------------------------------------------------------------------ config ---

export const NIGHTLY_HOUR = 3;
/*
 * A night that started late still gets its copy -- the machine was off at 3,
 * or the panel was restarting -- but not one that would start mid-morning,
 * stopping Jellyfin while somebody is watching it.
 */
const NIGHTLY_UNTIL = 6;

export const DEFAULT_SNAPSHOT_CONFIG = {
    enabled: true,
    keep: 3,
    // Only the ones switched off are listed. A service added later is backed
    // up from the start rather than waiting for somebody to notice a box.
    services: {},
    last: {},
    lastNightly: null,
};

export function loadSnapshotConfig() {
    const saved = loadManagerConfig().snapshots ?? {};
    return { ...DEFAULT_SNAPSHOT_CONFIG, ...saved, services: { ...(saved.services ?? {}) }, last: { ...(saved.last ?? {}) } };
}

export function saveSnapshotConfig(next) {
    const cfg = loadManagerConfig();
    cfg.snapshots = { ...loadSnapshotConfig(), ...next };
    saveManagerConfig(cfg);
    return cfg.snapshots;
}

const recordLast = (key, value) => saveSnapshotConfig({ last: { ...loadSnapshotConfig().last, [key]: value } });

export const isIncluded = (cfg, key) => cfg.services[key] !== false;

export function validateSnapshotConfig(input = {}) {
    const errors = [];
    const out = {};
    if ('enabled' in input) out.enabled = Boolean(input.enabled);
    if ('keep' in input) {
        const keep = Number(input.keep);
        if (!Number.isInteger(keep) || keep < 1 || keep > 30) errors.push('Keep between 1 and 30 copies of each app.');
        else out.keep = keep;
    }
    if (input.services && typeof input.services === 'object') {
        out.services = {};
        for (const s of SERVICES) {
            if (s.key in input.services) out.services[s.key] = Boolean(input.services[s.key]);
        }
    }
    return { cfg: out, errors };
}

// -------------------------------------------------------------- timezone ---

/**
 * Takes on the host's timezone.
 *
 * The panel's container runs on UTC, which made "3 AM" mean 10 PM or 11 PM
 * here, and every copy's folder name an hour nobody recognises. Asked of the
 * host's own files rather than configured: it is already set there, by
 * whoever installed the machine. Node picks up a TZ assigned at runtime.
 */
export async function adoptHostTimezone(log = () => {}) {
    if (process.env.TZ) return process.env.TZ;
    try {
        const { stdout } = await docker(
            ['run', '--rm', '-v', '/:/host:ro', IMAGE, 'sh', '-c', 'cat /host/etc/timezone 2>/dev/null || readlink /host/etc/localtime'],
            { timeoutMs: 30_000 },
        );
        const zone = stdout.trim().split('\n')[0].replace(/^.*zoneinfo\//, '');
        // Throws on a name ICU does not know, which leaves UTC in place.
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        process.env.TZ = zone;
        log(`backups        : using this machine's timezone, ${zone}`);
        return zone;
    } catch {
        return null;
    }
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A folder name that sorts by time and that NTFS and FAT can both store. */
const stampFor = (d) => `${localDate(d)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const ID_RE = /^([a-z]+)\/(\d{4}-\d{2}-\d{2}_\d{6})(_before-restore)?$/;

// ------------------------------------------------------- on the drive ---

/*
 * Every command that touches the drive runs in a throwaway container with the
 * drive's mount point at /dest-root and the host root beside it for the guard,
 * which refuses to go on if what is mounted turns out to be the internal disk
 * (a drive pulled since it was checked). Inside, $b is the backups folder and
 * the script's own arguments follow; nothing that varies is part of a script.
 */
function onDrive(target, script, args = [], { mounts = [], readOnly = false, interactive = false } = {}) {
    return [
        'run', '--rm',
        ...(interactive ? ['-i'] : []),
        ...mounts.flatMap((m) => ['-v', m]),
        '-v', `${target.anchor}:/dest-root${readOnly ? ':ro' : ''}`,
        '-v', '/:/host:ro',
        IMAGE, 'sh', '-c',
        `set -eu\n${DRIVE_GUARD}\nb="/dest-root/\${1:+$1/}${ROOT}"\nshift\n${script}`,
        'sh', target.rest, ...args,
    ];
}

async function driveTarget() {
    const { destination } = loadBackupConfig();
    if (!destination) throw new Error('No backup drive is chosen yet. Pick one at the top of the Backups page.');
    return checkDestination(destination);
}

function driveError(err) {
    if (err?.code === DRIVE_GONE) return new Error('The backup drive went away part way through. Plug it back in and try again.');
    return err;
}

/** Which of the services' volumes exist: an app never installed has nothing to copy. */
async function existingVolumes() {
    try {
        const { stdout } = await docker(['volume', 'ls', '--format', '{{.Name}}'], { timeoutMs: 20_000 });
        return new Set(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
    } catch {
        return new Set();
    }
}

const isPresent = (s, volumes) => Boolean(s.hostDir) || volumes.has(s.volume);

const sourceMount = (s, { readOnly }) => `${s.hostDir ?? s.volume}:/vol${readOnly ? ':ro' : ''}`;

/**
 * Every copy on the drive, newest first per service. Read from the drive each
 * time, so it is the truth about what can be restored -- including copies made
 * by an earlier install of this machine.
 */
export async function listCopies() {
    const target = await driveTarget();
    const script = [
        '[ -d "$b" ] || exit 0',
        'for d in "$b"/*/*/; do',
        '  d=${d%/}',
        '  case "$d" in *.partial) continue;; esac',
        '  [ -f "$d/manifest.json" ] || continue',
        '  printf "@@%s\\t%s\\n" "${d#$b/}" "$(du -sk "$d" | cut -f1)"',
        '  cat "$d/manifest.json"; echo',
        'done',
    ].join('\n');
    let stdout;
    try {
        ({ stdout } = await docker(onDrive(target, script, [], { readOnly: true }), { timeoutMs: 60_000 }));
    } catch (err) {
        throw driveError(err);
    }
    const out = {};
    for (const chunk of stdout.split('@@').slice(1)) {
        const nl = chunk.indexOf('\n');
        const [id, kb] = chunk.slice(0, nl).split('\t');
        const m = ID_RE.exec(id);
        if (!m || !byKey.has(m[1])) continue;
        let manifest = {};
        try {
            manifest = JSON.parse(chunk.slice(nl + 1).trim());
        } catch {
            continue;
        }
        (out[m[1]] ??= []).push({
            id,
            createdAt: manifest.createdAt ?? null,
            kind: manifest.kind ?? (m[3] ? 'before-restore' : 'manual'),
            bytes: Number(kb) * 1024,
            hasDatabase: Boolean(manifest.database),
        });
    }
    for (const list of Object.values(out)) list.sort((a, b) => (a.id < b.id ? 1 : -1));
    return out;
}

// ----------------------------------------------------------------- backup ---

async function dumpDatabase(s, target, file, onLine) {
    if (!(await containerState(s.db)).running) {
        throw new Error(`${s.label}'s database is not running, so it cannot be copied. Start ${s.label} first.`);
    }
    // In the database's own container, with the root password it already
    // has; the panel never holds it. One transaction, so the dump is the
    // database at one instant while Nextcloud carries on.
    const dump = [
        'exec', s.db, 'sh', '-c',
        'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump -uroot --single-transaction --quick --routines --triggers --events --add-drop-database --databases nextcloud',
    ];
    const write = onDrive(target, 'set -o pipefail\ngzip -c > "$b/$1"', [file], { interactive: true });
    await pipeDocker(dump, write, { onLine, timeoutMs: 2 * 60 * 60_000 });
}

async function archive(s, target, file, onLine) {
    // Only what exists is archived -- an older Nextcloud may have no themes
    // folder -- and the exclusions go in as a file of patterns.
    const script = [
        'set -o pipefail',
        'out="$b/$1"; printf "%s\\n" "$2" > /tmp/exclude; shift 2',
        'cd /vol',
        'n=$#',
        'for i in "$@"; do [ -e "$i" ] && set -- "$@" "$i"; done',
        'shift $n',
        '[ $# -gt 0 ] || { echo "There is nothing in it to copy." >&2; exit 1; }',
        'tar -czf "$out" --numeric-owner -X /tmp/exclude "$@"',
    ].join('\n');
    await docker(onDrive(target, script, [file, s.exclude.join('\n'), ...s.items], { mounts: [sourceMount(s, { readOnly: true })] }), {
        onLine,
        timeoutMs: 4 * 60 * 60_000,
    });
}

/**
 * Runs `fn` with the service holding still: Jellyfin stopped, Minecraft not
 * saving. Whatever was paused is resumed however `fn` ends.
 */
async function heldStill(s, onLine, fn) {
    const running = s.app ? (await containerState(s.app)).running : false;
    if (s.stopWhileCopying && running) {
        onLine(`Stopping ${s.label} while it is copied...`);
        await docker(['stop', '-t', '60', s.app], { timeoutMs: 120_000 });
        try {
            return await fn();
        } finally {
            onLine(`Starting ${s.label} again...`);
            await docker(['start', s.app], { timeoutMs: 120_000 }).catch((err) => onLine(`${s.label} did not start again: ${err.message}`));
        }
    }
    if (s.pauseSaving && running) {
        let paused = false;
        try {
            await rcon('save-off');
            paused = true;
            await rcon('save-all flush', { timeoutMs: 180_000 });
            onLine('The world is saved and paused while it is copied; players can keep playing.');
        } catch {
            onLine('The server did not answer, so the world is copied as it is on disk.');
        }
        try {
            return await fn();
        } finally {
            if (paused) await rcon('save-on').catch(() => onLine('Could not tell the server to start saving again; restart Minecraft.'));
        }
    }
    return fn();
}

/** One copy of one service. Returns its id and size. */
async function copyService(s, target, { kind, onLine }) {
    const now = new Date();
    const id = `${s.key}/${stampFor(now)}${kind === 'before-restore' ? '_before-restore' : ''}`;
    const work = `${id}.partial`;

    // Made beside where it will end up and renamed into place only when
    // whole, so a copy that dies -- the drive pulled, the machine off --
    // leaves a .partial nobody lists rather than a copy that looks fine.
    await docker(onDrive(target, 'rm -rf "$b/$1"; mkdir -p "$b/$1"', [work]), { timeoutMs: 60_000 });
    try {
        if (s.db) {
            onLine(`${s.label}: copying the database...`);
            await dumpDatabase(s, target, `${work}/database.sql.gz`, onLine);
        }
        onLine(`${s.label}: copying its files...`);
        await heldStill(s, onLine, () => archive(s, target, `${work}/files.tar.gz`, onLine));

        const manifest = {
            format: 1,
            service: s.key,
            label: s.label,
            kind,
            createdAt: now.toISOString(),
            database: s.db ? 'database.sql.gz' : null,
            files: 'files.tar.gz',
            items: s.items,
        };
        const { stdout } = await docker(
            onDrive(target, 'printf "%s\\n" "$2" > "$b/$1.partial/manifest.json"\nmv "$b/$1.partial" "$b/$1"\ndu -sk "$b/$1" | cut -f1', [id, JSON.stringify(manifest, null, 2)]),
            { timeoutMs: 120_000 },
        );
        return { id, bytes: Number(stdout.trim()) * 1024 || null };
    } catch (err) {
        await docker(onDrive(target, 'rm -rf "$b/$1"', [work]), { timeoutMs: 120_000 }).catch(() => {});
        throw driveError(err);
    }
}

/**
 * Removes the oldest copies beyond `keep`. Copies made just before a restore
 * are counted on their own, so restoring three times in an evening cannot
 * push the nightly copies off the drive -- and neither kind can push out the
 * other.
 */
async function prune(s, target, keep, onLine) {
    const { stdout } = await docker(
        onDrive(target, '[ -d "$b/$1" ] || exit 0\ncd "$b/$1" && for d in */; do echo "${d%/}"; done', [s.key], { readOnly: true }),
        { timeoutMs: 60_000 },
    );
    const names = stdout.split('\n').map((l) => l.trim()).filter((n) => ID_RE.test(`${s.key}/${n}`));
    const old = [];
    for (const before of [false, true]) {
        const kind = names.filter((n) => n.endsWith('_before-restore') === before).sort().reverse();
        old.push(...kind.slice(keep));
    }
    if (!old.length) return;
    onLine(`${s.label}: removing ${old.length} older cop${old.length === 1 ? 'y' : 'ies'} (keeping ${keep}).`);
    await docker(onDrive(target, 'cd "$b/$1"; shift; for d in "$@"; do rm -rf "./$d"; done', [s.key, ...old]), { timeoutMs: 10 * 60_000 });
}

/**
 * Nextcloud's files, after its database. Its own record of how it went is
 * kept by backup.js; a failure here fails Nextcloud's row too, because a
 * database without the files it describes is half a backup.
 */
async function copyFiles(onLine) {
    if (!backupSources().length) await resolveDataVolume();
    if (!backupSources().length) return;
    onLine('Nextcloud: copying your files (only what changed since last time)...');
    try {
        await copyNextcloudFiles(onLine);
    } catch (err) {
        saveBackupConfig({ lastRunAt: new Date().toISOString(), lastOk: false, lastResult: err.message });
        throw new Error(`The database was copied, but your files were not: ${err.message}`);
    }
}

/**
 * Copies every service that is switched on and installed (or just `only`).
 * One failing does not stop the rest; the job fails at the end, naming them.
 */
export async function backUp({ kind = 'manual', only = null, onLine = () => {} } = {}) {
    const target = await driveTarget();
    const cfg = loadSnapshotConfig();
    const volumes = await existingVolumes();
    const chosen = only ? [serviceFor(only)].filter(Boolean) : SERVICES.filter((s) => isIncluded(cfg, s.key));
    const failed = [];
    let copied = 0;

    for (const s of chosen) {
        if (!isPresent(s, volumes)) {
            if (only) throw new Error(`${s.label} is not installed, so there is nothing to back up.`);
            continue;
        }
        onLine(`\n> ${s.label}`);
        try {
            const { id, bytes } = await copyService(s, target, { kind, onLine });
            await prune(s, target, cfg.keep, onLine).catch((err) => onLine(`Could not remove older copies: ${err.message}`));
            if (s.key === 'nextcloud') await copyFiles(onLine);
            recordLast(s.key, { at: new Date().toISOString(), ok: true, id, bytes, result: 'Backed up.' });
            onLine(`${s.label}: done.`);
            copied += 1;
        } catch (err) {
            recordLast(s.key, { at: new Date().toISOString(), ok: false, result: err.message });
            onLine(`${s.label}: failed. ${err.message}`);
            failed.push(s.label);
            // Nothing else will get further on a drive that has gone.
            if (/drive went away|not on a drive of its own/.test(err.message)) break;
        }
    }
    if (failed.length) throw new Error(`Could not back up ${failed.join(', ')}. The log above says why.`);
    onLine(`\nBacked up ${copied} app${copied === 1 ? '' : 's'} to ${loadBackupConfig().destination}/${ROOT}.`);
    return { copied };
}

// ---------------------------------------------------------------- restore ---

async function waitForDatabase(s, onLine) {
    if (!(await containerState(s.db)).running) {
        onLine(`Starting ${s.label}'s database...`);
        await docker(['start', s.db], { timeoutMs: 120_000 });
    }
    for (let i = 0; i < 60; i++) {
        try {
            await docker(['exec', s.db, 'sh', '-c', 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-admin -uroot ping'], { timeoutMs: 15_000 });
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    throw new Error(`${s.label}'s database did not come up, so nothing was restored into it.`);
}

const occ = (s, args, opts) => docker(['exec', '-u', 'www-data', s.app, 'php', 'occ', ...args], opts);

async function waitForOcc(s) {
    for (let i = 0; i < 100; i++) {
        try {
            const { stdout } = await occ(s, ['status', '--output=json'], { timeoutMs: 30_000 });
            if (JSON.parse(stdout.trim()).installed === true) return true;
        } catch {
            /* still starting, or upgrading itself */
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
}

/**
 * Puts files the copy on the drive has, and Nextcloud does not, back where they
 * were. Never overwrites: a file that is there now is newer than the copy or
 * the same as it. Owned like the folder it goes into, because the drive is
 * usually NTFS and remembers no owners at all.
 */
async function putBackFiles(onLine) {
    await resolveDataVolume();
    const cfg = loadBackupConfig();
    const files = await checkDestination(cfg.destination);
    for (const src of backupSources()) {
        const name = src.split('/').filter(Boolean).pop() || 'root';
        onLine(`\n> Putting back files missing from ${src}`);
        const script = [
            DRIVE_GUARD,
            'from="/dest-root/${1:+$1/}$2"',
            '[ -d "$from" ] || { echo "There is no copy of this folder on the drive."; exit 0; }',
            'rsync -a --ignore-existing --info=stats1 --chown="$(stat -c %u:%g /dst)" --exclude=lost+found "$from/" /dst/',
        ].join('\n');
        await docker(
            ['run', '--rm', '-v', `${src}:/dst`, '-v', `${files.anchor}:/dest-root:ro`, '-v', '/:/host:ro', IMAGE, 'sh', '-c', `set -eu\n${script}`, 'sh', files.rest, name],
            { onLine, timeoutMs: 12 * 60 * 60_000 },
        );
    }
}

async function unpack(s, target, id, onLine) {
    // Whole-volume services lose everything but what the archive leaves out
    // (caches, logs), then take the archive. The two Nextclouds lose only the
    // folders the archive has, so their program files stay.
    const whole = s.items.includes('.');
    const script = [
        'src="$b/$1/files.tar.gz"; printf "%s\\n" "$2" > /tmp/exclude; shift 2',
        '[ -f "$src" ] || { echo "This copy has no files archive." >&2; exit 1; }',
        // Read through once before anything is removed: a damaged archive is
        // found while the current data is still all there.
        'gzip -t "$src" || { echo "This copy is damaged, so nothing was changed." >&2; exit 1; }',
        'cd /vol',
        whole
            ? 'for e in ./* ./.[!.]* ./..?*; do [ -e "$e" ] || continue; grep -qxF "$e" /tmp/exclude && continue; rm -rf "$e"; done'
            : 'for i in "$@"; do rm -rf "./$i"; done',
        'tar -xzf "$src" --numeric-owner -C /vol',
    ].join('\n');
    await docker(onDrive(target, script, [id, s.exclude.join('\n'), ...s.items], { mounts: [sourceMount(s, { readOnly: false })], readOnly: true }), {
        onLine,
        timeoutMs: 4 * 60 * 60_000,
    });
}

/**
 * Puts one copy back.
 *
 * First, unless asked not to, the service as it is now is copied, so that the
 * restore itself can be undone from the same list. Then the service is
 * stopped, its data replaced, and started again if it was running.
 *
 * `restartPanel` is called for the panel's own settings, which are only read
 * when the panel starts.
 */
export async function restore({ id, putBack = false, saveFirst = true, onLine = () => {}, restartPanel = async () => {} }) {
    const m = ID_RE.exec(String(id ?? ''));
    const s = m && serviceFor(m[1]);
    if (!s) throw new Error('That is not a backup this panel made.');
    const target = await driveTarget();

    const copies = (await listCopies())[s.key] ?? [];
    const copy = copies.find((c) => c.id === id);
    if (!copy) throw new Error('That copy is not on the drive any more.');

    if (saveFirst) {
        onLine(`\n> Saving ${s.label} as it is now, so this can be undone`);
        try {
            const saved = await copyService(s, target, { kind: 'before-restore', onLine });
            await prune(s, target, loadSnapshotConfig().keep, onLine).catch(() => {});
            onLine(`Saved as ${saved.id}.`);
        } catch (err) {
            throw new Error(
                `Could not save ${s.label} as it is now (${err.message}), so nothing was restored. ` +
                    'If it is broken badly enough that it cannot be copied, restore again without saving it first.',
            );
        }
    }

    onLine(`\n> Restoring ${s.label} from ${new Date(copy.createdAt).toLocaleString()}`);
    const wasRunning = s.app ? (await containerState(s.app)).running : false;
    if (wasRunning) {
        onLine(`Stopping ${s.label}...`);
        await docker(['stop', '-t', '120', s.app], { timeoutMs: 180_000 });
    }

    try {
        if (s.db && copy.hasDatabase) {
            await waitForDatabase(s, onLine);
            onLine('Putting the database back...');
            const read = onDrive(target, 'set -o pipefail\ngunzip -c "$b/$1/database.sql.gz"', [id], { readOnly: true });
            const load = ['exec', '-i', s.db, 'sh', '-c', 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot'];
            await pipeDocker(read, load, { onLine, timeoutMs: 4 * 60 * 60_000 });
        }
        onLine('Putting the files back...');
        await unpack(s, target, id, onLine);
        if (putBack && s.key === 'nextcloud') await putBackFiles(onLine);
    } catch (err) {
        // Started again either way: a half-restored app that is running says
        // what is wrong with it, one left stopped only says it is stopped.
        if (wasRunning) await docker(['start', s.app], { timeoutMs: 120_000 }).catch(() => {});
        throw driveError(err);
    }

    if (s.key === 'panel') {
        onLine('Restarting the panel so it reads its restored settings. This page reconnects by itself.');
        await restartPanel();
        return { id };
    }

    if (wasRunning || s.db) {
        onLine(`Starting ${s.label}...`);
        await docker(['start', s.app], { timeoutMs: 120_000 });
    }

    if (s.db) {
        onLine(`Waiting for ${s.label} to come up...`);
        if (await waitForOcc(s)) {
            // A copy made while an update was running would come back in
            // maintenance mode, with every page saying so.
            await occ(s, ['maintenance:mode', '--off'], { timeoutMs: 60_000 }).catch(() => {});
            // Tells phones and the desktop client their copy is out of date,
            // so they ask again rather than trusting what they had.
            await occ(s, ['maintenance:data-fingerprint'], { timeoutMs: 60_000 }).catch(() => {});
            // Files changed since the copy are on disk but not in the restored
            // database; a scan is what makes Nextcloud see them again.
            onLine('Checking every file against the restored database. This can take a few minutes...');
            await occ(s, ['files:scan', '--all'], { onLine, timeoutMs: 6 * 60 * 60_000 }).catch((err) =>
                onLine(`The file check did not finish: ${err.message}`),
            );
        } else {
            onLine(`${s.label} has not finished starting. Its own page shows how it is getting on.`);
        }
    }
    onLine(`\n${s.label} is restored.`);
    return { id };
}

// ----------------------------------------------------------------- status ---

export async function status() {
    const cfg = loadSnapshotConfig();
    const volumes = await existingVolumes();
    return {
        config: { enabled: cfg.enabled, keep: cfg.keep, hour: NIGHTLY_HOUR, timezone: process.env.TZ || 'UTC' },
        nextRunAt: nextRun(cfg),
        root: ROOT,
        services: SERVICES.map((s) => ({
            key: s.key,
            label: s.label,
            what: s.what,
            present: isPresent(s, volumes),
            included: isIncluded(cfg, s.key),
            last: cfg.last[s.key] ?? null,
            ...(s.key === 'nextcloud' ? { files: filesStatus() } : {}),
        })),
    };
}

function filesStatus() {
    const b = loadBackupConfig();
    return {
        hasFiles: backupSources().length > 0,
        mirrorDeletes: Boolean(b.mirrorDeletes),
        lastRunAt: b.lastRunAt,
        lastOk: b.lastOk,
        lastSkipped: b.lastSkipped ?? 0,
        lastError: b.lastOk === false ? b.lastResult : null,
    };
}

function nextRun(cfg) {
    if (!cfg.enabled || !loadBackupConfig().destination) return null;
    const now = new Date();
    const at = new Date(now);
    at.setHours(NIGHTLY_HOUR, 0, 0, 0);
    if (cfg.lastNightly === localDate(now) || now.getHours() >= NIGHTLY_UNTIL) at.setDate(at.getDate() + 1);
    else if (now > at) return now.toISOString();
    return at.toISOString();
}

// --------------------------------------------------------------- schedule ---

let timer = null;

/**
 * Once a minute, asks whether tonight's copy is due. Marked as done before it
 * runs, so a run that fails is reported and not retried every minute until
 * six; the next night tries again.
 */
export function schedule(enqueue, log = () => {}) {
    if (timer) clearInterval(timer);
    const tick = () => {
        try {
            const cfg = loadSnapshotConfig();
            if (!cfg.enabled || !loadBackupConfig().destination) return;
            const now = new Date();
            if (now.getHours() < NIGHTLY_HOUR || now.getHours() >= NIGHTLY_UNTIL) return;
            const today = localDate(now);
            if (cfg.lastNightly === today) return;
            saveSnapshotConfig({ lastNightly: today });
            enqueue();
        } catch (err) {
            log(`backups        : ${err.message}`);
        }
    };
    timer = setInterval(tick, 60_000);
    timer.unref?.();
}
