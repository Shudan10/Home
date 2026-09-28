import { loadManagerConfig, saveManagerConfig } from './store.js';
import { docker } from './dockerctl.js';
import { loadAppsConfig } from './apps.js';

/**
 * Copies folders from this machine onto a drive plugged into it.
 *
 * Deliberately a copy and not a sync. The obvious tool for this is the
 * Nextcloud desktop client, and it is the wrong one: a sync propagates
 * deletions, so a file removed or corrupted on the live side is removed from
 * the copy too, usually within seconds -- which is the exact failure a backup
 * exists to survive. It is also watching a removable drive, and a sync client
 * whose folder vanishes on unplug is a client watching every file disappear at
 * once.
 *
 * So: rsync, one pass, no daemon, nothing to misread when the drive is pulled.
 */

const IMAGE = 'quickstart-home/manager:1';

/** Where removable drives appear once the desktop has mounted them. */
const SEARCH_ROOTS = ['/media', '/run/media', '/mnt'];

export const DEFAULT_BACKUP_CONFIG = {
    enabled: false,
    destination: '',
    intervalMinutes: 15,
    // Off, and it stays off unless somebody deliberately asks. With this on the
    // copy becomes a mirror, and a mirror of a folder you just deleted
    // something from is a folder with that thing deleted from it.
    mirrorDeletes: false,
    lastRunAt: null,
    lastResult: null,
    lastOk: null,
};

/**
 * What this backs up: the folders Nextcloud is serving, and nothing else.
 *
 * Derived rather than configured. A second list of paths to keep in step with
 * the first is a list that drifts, and the failure is silent -- a folder added
 * to Nextcloud and not to the backup is a folder nobody notices is unprotected
 * until they need it.
 */
export function backupSources() {
    return [...(loadAppsConfig().nextcloud.sharedPaths ?? [])];
}

export function loadBackupConfig() {
    const cfg = loadManagerConfig();
    const saved = { ...(cfg.backup ?? {}) };
    // This used to be measured in hours, back when a run was assumed to be
    // expensive. Anything saved then is carried over rather than silently
    // reset to the new default.
    if (saved.intervalMinutes == null && saved.intervalHours != null) {
        saved.intervalMinutes = Math.max(MIN_INTERVAL, Number(saved.intervalHours) * 60);
    }
    delete saved.intervalHours;
    return { ...DEFAULT_BACKUP_CONFIG, ...saved };
}

/*
 * Five minutes is the floor.
 *
 * Not because a check is expensive -- it is one second against 8,000 files --
 * but because the copy it may start is not, and a new run beginning while a
 * 40GB rip is still being written would spend its time copying a file that is
 * changing underneath it.
 */
export const MIN_INTERVAL = 5;

export function saveBackupConfig(next) {
    const cfg = loadManagerConfig();
    cfg.backup = { ...DEFAULT_BACKUP_CONFIG, ...(cfg.backup ?? {}), ...next };
    saveManagerConfig(cfg);
    return cfg.backup;
}

/**
 * Drives currently plugged in, with how much room each has.
 *
 * The host's mount table is not visible from in here, and neither are its
 * disks. What is reachable is the filesystem itself, through a throwaway
 * container with the host root mounted read-only -- so this looks where desktop
 * Linux actually mounts removable media and reports what it finds. `df` against
 * a bind-mounted path reports the underlying filesystem, so the free space is
 * the drive's own rather than the container's.
 */
export async function listDestinations() {
    // Two things have to be excluded or the list is worse than useless.
    //
    // /media and /media/<user> are directories on the internal disk that other
    // things get mounted *under*. They look like drives to a glob, and backing
    // up to one copies the disk onto itself. They are recognised by sharing a
    // filesystem with the host root.
    //
    // And an optical disc is a mounted filesystem with a size, so a Blu-ray
    // left in the drive is offered as a destination with 0 bytes free. It is
    // excluded by filesystem type rather than by writability: this probe mounts
    // the host read-only and runs as root, so `test -w` answers yes to
    // everything and discriminates nothing.
    const script =
        `root_fs=$(df -P /host 2>/dev/null | awk 'NR==2 {print $1}')\n` +
        SEARCH_ROOTS.map((r) => `
        for d in /host${r}/*/ /host${r}/*/*/; do
          [ -d "$d" ] || continue
          case "$d" in */lost+found/) continue;; esac
          set -- $(df -PT "$d" 2>/dev/null | awk 'NR==2 {print $1" "$2}')
          [ "$1" = "$root_fs" ] && continue
          case "$2" in iso9660|udf|squashfs|tmpfs|devtmpfs|overlay) continue;; esac
          df -P -k "$d" 2>/dev/null | awk -v p="$d" 'NR==2 {print p"\\t"$2"\\t"$4}'
        done`).join('\n');

    try {
        const { stdout } = await docker(
            ['run', '--rm', '-v', '/:/host:ro', IMAGE, 'sh', '-c', script],
            { timeoutMs: 30_000 },
        );
        const seen = new Set();
        const out = [];
        for (const line of stdout.split('\n')) {
            const [raw, totalK, freeK] = line.split('\t');
            if (!raw || !totalK) continue;
            // Back to the path as the host knows it, and without the trailing
            // slash the shell glob leaves behind.
            const path = raw.replace(/^\/host/, '').replace(/\/+$/, '');
            if (!path || seen.has(path)) continue;
            // Anything on the root filesystem is this machine's own disk, not a
            // drive plugged into it. Offering it would make "back up" mean
            // "copy to the disk you are backing up", which protects nothing.
            seen.add(path);
            out.push({ path, total: Number(totalK) * 1024, free: Number(freeK) * 1024 });
        }
        return out;
    } catch {
        return [];
    }
}

export function validateBackupConfig(input) {
    const errors = [];
    const out = { ...DEFAULT_BACKUP_CONFIG };

    out.enabled = Boolean(input.enabled);
    out.mirrorDeletes = Boolean(input.mirrorDeletes);
    const sources = backupSources();

    const dest = String(input.destination ?? '').trim().replace(/\/+$/, '');
    if (dest && !dest.startsWith('/')) errors.push('The destination has to be a full path starting with /.');
    else if (dest.split('/').includes('..')) errors.push('The destination contains "..", so write the real path instead.');
    else out.destination = dest;

    const mins = Number(input.intervalMinutes ?? DEFAULT_BACKUP_CONFIG.intervalMinutes);
    if (!Number.isFinite(mins) || mins < MIN_INTERVAL || mins > 43200) {
        errors.push(`The interval has to be between ${MIN_INTERVAL} minutes and 30 days.`);
    } else {
        out.intervalMinutes = Math.round(mins);
    }

    if (out.enabled && !out.destination) errors.push('Pick a drive to back up to first.');
    if (out.enabled && !sources.length) {
        errors.push('Nextcloud has no shared folders yet, so there is nothing to back up. Add one under Settings.');
    }

    // Copying a folder into itself, or into something inside itself, is a loop
    // that fills the disk. Cheap to check and miserable to discover.
    for (const s of sources) {
        if (out.destination === s || out.destination.startsWith(`${s}/`)) {
            errors.push(`The destination is inside "${s}", which would copy that folder into itself.`);
        }
    }
    return { cfg: out, errors };
}

/**
 * One pass of the copy, reporting as it goes.
 *
 * Runs in a throwaway container with the sources read-only and the destination
 * writable, which is the only way to touch host paths from in here and also
 * means the copy cannot modify what it is reading.
 *
 * The destination not being there is the normal case, not a fault: it is a
 * drive somebody unplugged. It stops rather than writing, because a bind mount
 * whose source is missing is silently *created* by Docker as an empty
 * directory -- so without this check an unplugged drive would produce a
 * cheerful backup onto the internal disk.
 */
export async function run(onLine = () => {}) {
    const cfg = loadBackupConfig();
    const sources = backupSources();
    if (!cfg.destination) throw new Error('No backup drive is set.');
    if (!sources.length) throw new Error('Nextcloud has no shared folders, so there is nothing to back up.');

    // The destination itself may legitimately not exist yet -- a first run
    // creates it. Its parent must, and that is the check that matters: the
    // parent existing is what proves the drive is actually mounted. Without it
    // Docker would create the bind mount source on the internal disk and the
    // backup would cheerfully run onto the disk it is meant to protect.
    const parent = cfg.destination.replace(/\/[^/]+\/?$/, '') || '/';
    if (!(await pathExists(cfg.destination)) && !(await pathExists(parent))) {
        throw new Error(
            `${cfg.destination} is not there, and neither is ${parent}. ` +
                'If that is a removable drive, plug it in and open it once so the system mounts it.',
        );
    }

    /*
     * Progress that actually arrives.
     *
     * rsync draws progress by rewriting one line with carriage returns and no
     * newline, and the line splitter feeding the overlay only emits on \n -- so
     * the whole thing arrives as a single line when the copy ends. Piping
     * through `tr` turns each redraw into its own line, which streams.
     *
     * --no-inc-recursive costs an upfront scan of the tree, and buys a total
     * that is the real total. Without it rsync counts as it goes, so the
     * percentage walks backwards as more files are found, which is worse than
     * no percentage at all.
     */
    const flags = [
        '-aH',
        '--info=progress2',
        '--no-inc-recursive',
        '--stats',
        '--exclude=.nextcloudsync.log',
        '--exclude=lost+found',
    ];
    if (cfg.mirrorDeletes) flags.push('--delete');

    /*
     * rsync's "some files could not be transferred" is not a failed backup.
     *
     * 23 and 24 mean the copy ran and finished and some individual files did
     * not make it -- most often because the destination filesystem cannot store
     * the name. A drive formatted NTFS or FAT rejects : ? * " < > and |, all of
     * which are ordinary characters on Linux, so a handful of documents fail
     * while a quarter of a terabyte copies perfectly.
     *
     * Reporting that as "failed" is worse than unhelpful: it says the backup
     * did not happen when it almost entirely did, and it hides which files
     * actually need attention behind an alarm about everything.
     */
    const PARTIAL = new Set([23, 24]);
    const skipped = [];

    const leaf = cfg.destination.split('/').filter(Boolean).pop() || '';
    for (const src of sources) {
        const name = src.split('/').filter(Boolean).pop() || 'root';
        onLine(`\n> ${src}`);
        // Trailing slash on the source: copy the contents into <dest>/<name>,
        // rather than nesting another <name> inside it on every run.
        // A non-zero exit rejects, so there is no code to test here -- the
        // throw is the failure path, and the job it runs under reports it.
        try {
        await docker(
            [
                'run', '--rm',
                '-v', `${src}:/src/${name}:ro`,
                // Mount the drive, not the target folder: the folder may not
                // exist yet, and a bind mount source that is missing is created
                // by Docker rather than refused -- on the internal disk.
                '-v', `${parent}:/dest-root`,
                IMAGE, 'sh', '-c',
                // pipefail so the exit status is rsync's and not `tr`'s --
                // otherwise a failed copy pipes into a successful tr and the
                // whole thing reports success.
                `set -o pipefail; mkdir -p "/dest-root/${leaf}/${name}" && ` +
                    `rsync ${flags.join(' ')} "/src/${name}/" "/dest-root/${leaf}/${name}/" | tr '\\r' '\\n'`,
            ],
            { onLine, timeoutMs: 12 * 60 * 60_000 },
        );
        } catch (err) {
            if (!PARTIAL.has(err.code)) throw err;
            // Pull the names out of rsync's own complaint, so the report names
            // the files rather than the exit code.
            for (const m of String(err.stderr || err.stdout || '').matchAll(/"\/dest[^"]*\/\.?([^/"]+?)\.[A-Za-z0-9]{6}"/g)) {
                if (!skipped.includes(m[1])) skipped.push(m[1]);
            }
            onLine(`\nSome files in ${src} could not be written to the drive.`);
        }
    }

    const stamp = new Date().toISOString();
    if (skipped.length) {
        const note =
            `Copied to ${cfg.destination}, but ${skipped.length} file(s) could not be written: ` +
            `${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}. ` +
            'Usually their names contain characters the drive\'s filesystem cannot store, such as : or ?.';
        saveBackupConfig({ lastRunAt: stamp, lastOk: true, lastResult: note });
        onLine(`\n${note}`);
        return { ok: true, skipped };
    }
    saveBackupConfig({ lastRunAt: stamp, lastOk: true, lastResult: `Copied ${sources.length} folder(s) to ${cfg.destination}.` });
    onLine(`\nBacked up to ${cfg.destination}.`);
    return { ok: true, skipped: [] };
}

/** Whether a host path is there, asked from a container that can see the host. */
async function pathExists(p) {
    try {
        const { stdout } = await docker(
            ['run', '--rm', '-v', '/:/host:ro', IMAGE, 'sh', '-c', `[ -d "/host${p}" ] && echo yes || echo no`],
            { timeoutMs: 20_000 },
        );
        return stdout.trim().endsWith('yes');
    } catch {
        return false;
    }
}


/**
 * Would a copy actually move anything?
 *
 * Asked with --dry-run, which walks the same trees and writes nothing. It costs
 * about a second against 8,000 files, so it is cheap enough to ask every few
 * minutes -- and asking is what keeps a frequent schedule quiet. Without it a
 * check every five minutes is 288 jobs a day in the log and 288 notifications,
 * for a backup that had nothing to do 287 of those times.
 *
 * Any failure answers "no". A drive that is unplugged, or busy, is not a reason
 * to start a real run that would only fail more loudly.
 */
export async function hasChanges() {
    const cfg = loadBackupConfig();
    const sources = backupSources();
    if (!cfg.destination || !sources.length) return false;

    const parent = cfg.destination.replace(/\/[^/]+\/?$/, '') || '/';
    const leaf = cfg.destination.split('/').filter(Boolean).pop() || '';

    for (const src of sources) {
        const name = src.split('/').filter(Boolean).pop() || 'root';
        try {
            const { stdout } = await docker(
                [
                    'run', '--rm',
                    '-v', `${src}:/src/${name}:ro`,
                    '-v', `${parent}:/dest-root`,
                    IMAGE, 'sh', '-c',
                    `rsync -aHn --stats --exclude=.nextcloudsync.log --exclude=lost+found ` +
                        `"/src/${name}/" "/dest-root/${leaf}/${name}/" 2>/dev/null | grep "^Number of regular files transferred:"`,
                ],
                { timeoutMs: 10 * 60_000 },
            );
            if (Number(stdout.split(':').pop().trim().replace(/,/g, '')) > 0) return true;
        } catch {
            return false;
        }
    }
    return false;
}

// ------------------------------------------------------------------ schedule

let timer = null;

/**
 * (Re)arms the periodic copy. Safe to call whenever the config changes.
 *
 * A missing drive is not an error worth shouting about here -- the whole point
 * of a removable drive is that it is sometimes removed -- so a scheduled run
 * that finds nothing plugged in records why and waits for the next one.
 */
export function scheduleFromConfig(log = () => {}, enqueue = null) {
    if (timer) clearInterval(timer);
    timer = null;

    const cfg = loadBackupConfig();
    if (!cfg.enabled || !cfg.destination || !backupSources().length) return;

    const tick = async () => {
        try {
            // Nothing to copy means nothing to announce. This is the whole
            // reason a five-minute schedule is reasonable.
            if (!(await hasChanges())) return;
            if (enqueue) enqueue();
            else await run((line) => log(`backup: ${line}`));
        } catch (err) {
            saveBackupConfig({ lastRunAt: new Date().toISOString(), lastOk: false, lastResult: err.message });
            log(`backup: ${err.message}`);
        }
    };

    timer = setInterval(tick, Math.max(MIN_INTERVAL, cfg.intervalMinutes) * 60_000);
    timer.unref?.();
}
