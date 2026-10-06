import { docker, JELLYFIN_CONTAINER } from './dockerctl.js';

const IMAGE = 'quickstart-home/manager:1';

/*
 * How often to look, and how long to wait before looking again after a repair.
 *
 * Half a minute is short enough that a drive plugged back in is working again
 * before anybody has finished walking to the sofa, and the check itself is two
 * stat calls -- nothing that warrants being frugal about.
 *
 * The cooldown is the part that matters. If a restart does not fix the mount
 * then restarting again will not fix it either, and a container being recreated
 * every thirty seconds is worse than the fault it is trying to repair.
 */
const INTERVAL_MS = 30_000;
const COOLDOWN_MS = 5 * 60_000;

/*
 * Reads an identity for each path: which filesystem it is on, and which inode.
 *
 * Paths arrive as arguments rather than interpolated into the script, because
 * they contain spaces -- "/media/shudan/1TB Storage" being the specific one
 * this exists for -- and a quoted path inside a generated shell string is a
 * quoting bug waiting to happen.
 */
const IDENT = 'for p in "$@"; do stat -c "%d:%i" "$p" 2>/dev/null || echo -; done';

async function containerIdents(dests) {
    const { stdout } = await docker(
        ['exec', JELLYFIN_CONTAINER, 'sh', '-c', IDENT, 'sh', ...dests],
        { timeoutMs: 20_000 },
    );
    return stdout.split('\n').filter(Boolean);
}

/*
 * The same identity, but as the host knows it, plus whether anything is there.
 *
 * The emptiness check is not decoration. Docker creates a missing bind source
 * as an empty directory instead of refusing to start, so after the drive is
 * unplugged the mount point still exists -- as an empty folder on the internal
 * disk. Restarting against that would hand Jellyfin an empty library and leave
 * a directory sitting where the drive needs to mount. So a restart is only
 * allowed when the source has something in it.
 */
async function hostIdents(sources) {
    const script =
        'for p in "$@"; do\n' +
        '  id=$(stat -c "%d:%i" "$p" 2>/dev/null) || { printf -- "-\\t-\\n"; continue; }\n' +
        '  if [ -n "$(ls -A "$p" 2>/dev/null | head -1)" ]; then printf "%s\\tfull\\n" "$id"\n' +
        '  else printf "%s\\tempty\\n" "$id"; fi\n' +
        'done';
    const { stdout } = await docker(
        ['run', '--rm', '-v', '/:/host:ro', IMAGE, 'sh', '-c', script, 'sh', ...sources.map((s) => `/host${s}`)],
        { timeoutMs: 30_000 },
    );
    return stdout.split('\n').filter(Boolean).map((l) => {
        const [ident, state] = l.split('\t');
        return { ident, full: state === 'full' };
    });
}

/** The media folders Jellyfin was started with, as source/destination pairs. */
async function mediaMounts() {
    const fmt = '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}\t{{.Destination}}\n{{end}}{{end}}';
    const { stdout } = await docker(['inspect', '-f', fmt, JELLYFIN_CONTAINER], { timeoutMs: 15_000 });
    return stdout
        .split('\n')
        .map((l) => l.split('\t'))
        .filter(([source, dest]) => source && dest && dest.startsWith('/media'))
        .map(([source, dest]) => ({ source, dest }));
}

/**
 * Has a mount gone stale underneath Jellyfin?
 *
 * A bind mount is resolved to an inode when the container starts, not kept as a
 * live path. Unplugging the drive destroys that inode and plugging it back in
 * makes a new one, so the host is looking at the drive while the container is
 * still holding the dead one -- and reports an empty library without erroring,
 * which is the part that makes this worth detecting rather than waiting to be
 * told about.
 *
 * Comparing the filesystem id is what catches it. The inode number alone does
 * not: a remounted drive hands the same directory the same inode number, and
 * only the device it sits on differs.
 */
export async function findStaleMounts() {
    const mounts = await mediaMounts();
    if (!mounts.length) return [];

    const [inside, outside] = await Promise.all([
        containerIdents(mounts.map((m) => m.dest)),
        hostIdents(mounts.map((m) => m.source)),
    ]);
    if (inside.length !== mounts.length || outside.length !== mounts.length) return [];

    return mounts.filter((m, i) => {
        const host = outside[i];
        if (!host || host.ident === '-' || !host.full) return false;
        return inside[i] !== '-' && inside[i] !== host.ident;
    });
}

let timer = null;
let lastRepairAt = 0;

/**
 * Watches for a drive that came back and restarts Jellyfin when one has.
 *
 * Deliberately not tied to the backup schedule: that one is off by default and
 * is about copying files, while this is about a library that silently reads as
 * empty whether or not anything is being backed up.
 */
export function watch(log = () => {}, isBusy = () => false) {
    if (timer) clearInterval(timer);

    const tick = async () => {
        // Another job recreating containers would be doing so underneath this
        // check, and its own restart makes the repair redundant anyway.
        if (isBusy()) return;
        if (Date.now() - lastRepairAt < COOLDOWN_MS) return;

        try {
            const stale = await findStaleMounts();
            if (!stale.length) return;

            lastRepairAt = Date.now();
            log(`jellyfin: ${stale.map((m) => m.source).join(', ')} came back on a new mount, restarting`);
            await docker(['restart', JELLYFIN_CONTAINER], { timeoutMs: 2 * 60_000 });

            const left = await findStaleMounts().catch(() => []);
            log(left.length ? 'jellyfin: still not reading the drive after a restart' : 'jellyfin: reading the drive again');
        } catch (err) {
            // A drive that is not plugged in, or a container that is not
            // running, is the normal state of affairs rather than a fault.
            log(`jellyfin: mount check skipped (${err.message})`);
        }
    };

    timer = setInterval(tick, INTERVAL_MS);
    timer.unref?.();
    return tick;
}
