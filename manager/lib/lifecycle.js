import { compose, docker, containerState } from './dockerctl.js';

/**
 * Install, start, stop, uninstall -- for everything in the stack that is a
 * container somebody switches on.
 *
 * The switch used to mean two different things at once. Turning an app off
 * removed its containers, so "off" and "never installed" were the same state
 * and the difference between pausing something and throwing it away came down
 * to which toggle you happened to flip. An hour of building was one careless
 * click from gone.
 *
 * Three states now, and they are separate on purpose:
 *
 *   not installed   nothing built, nothing to run. Install builds it.
 *   installed       the container exists. The switch starts and stops it, and
 *                   stopping keeps everything: the container, its data, the
 *                   image it took a while to build.
 *   uninstalled     asked for explicitly, on its own tab, and it takes the data
 *                   with it. Nothing else in here removes a volume.
 */

/**
 * What each service is made of. Volumes are listed by their real docker names
 * rather than their compose keys, because that is what has to be removed and
 * getting it wrong deletes somebody else's data.
 */
export const UNITS = {
    nextcloud: {
        label: 'Nextcloud',
        profile: 'nextcloud',
        services: ['nextcloud-db', 'nextcloud-redis', 'nextcloud-imaginary', 'nextcloud'],
        containers: [
            'quickstart-home-nextcloud',
            'quickstart-home-nextcloud-db',
            'quickstart-home-nextcloud-redis',
            'quickstart-home-nextcloud-imaginary',
        ],
        // The container that decides whether this is installed. A dependency
        // being absent is a broken install; this one being absent is no install.
        primary: 'quickstart-home-nextcloud',
        volumes: ['quickstart-home-nextcloud-data', 'quickstart-home-nextcloud-db-data'],
        images: ['quickstart-home/nextcloud'],
        buildable: ['nextcloud'],
        data: 'every file, photo and calendar stored in it',
    },
    jellyfin: {
        label: 'Jellyfin',
        profile: 'jellyfin',
        services: ['jellyfin'],
        containers: ['quickstart-home-jellyfin'],
        primary: 'quickstart-home-jellyfin',
        // Its own state only. The media is a read-only bind mount of a host
        // directory, so it is not a volume and nothing here can remove it --
        // which is the point: uninstalling a media server must not be a way to
        // delete somebody's films.
        volumes: ['quickstart-home-jellyfin-config', 'quickstart-home-jellyfin-cache'],
        // Pulled, not built here, and the tag is shared with anyone else
        // running Jellyfin on this machine. Never removed.
        images: [],
        buildable: [],
        pullable: ['jellyfin'],
        data: 'its library database, artwork and settings. Your media files are untouched: they live on your disk and are only ever mounted read-only',
    },
    proxy: {
        label: 'Reverse proxy',
        profile: 'proxy',
        services: ['proxy'],
        containers: ['quickstart-home-proxy'],
        primary: 'quickstart-home-proxy',
        volumes: [],
        // nginx is pulled, not built here, and is very likely in use by
        // something else on this machine. Never removed.
        images: [],
        buildable: [],
        data: 'nothing. Your domains and certificates live in the stack directory and are kept',
    },
};

export const unitFor = (key) => UNITS[key] ?? null;

/**
 * Every `up` here names every container the service owns, so compose has
 * nothing left to work out -- and is told not to.
 *
 * A service in this panel is started by somebody clicking its switch, and by
 * nothing else. `--no-deps` is what keeps a `depends_on` added later from
 * quietly turning one start into several.
 */
const NO_DEPS = ['--no-deps'];

/** Installed means the container exists, whether or not it is running. */
export async function status(key) {
    const unit = unitFor(key);
    if (!unit) return null;

    const state = await containerState(unit.primary);
    return {
        key,
        label: unit.label,
        tab: unit.tab ?? key,
        runnable: true,
        installed: state.exists,
        running: state.running,
        status: state.status,
        health: state.health,
    };
}

export async function statusAll() {
    return Object.fromEntries(await Promise.all(Object.keys(UNITS).map(async (key) => [key, await status(key)])));
}

/**
 * Builds the images and creates the containers, and leaves them stopped.
 *
 * Installing is not starting. It used to end in `up -d`, so choosing to have
 * something on the machine also chose to run it. The switch is what starts
 * things, and it is now the only thing that does.
 */
export async function install(key, onLine = () => {}) {
    const unit = unitFor(key);
    if (!unit) throw new Error(`No such service: ${key}`);

    if (unit.buildable.length) {
        onLine(`Building ${unit.label}. The first time can take a while.`);
        await compose(['build', ...unit.buildable], { onLine, profile: unit.profile, timeoutMs: 120 * 60_000 });
    }
    // An image that is pulled rather than built. `create` would fetch it anyway,
    // but silently and with no progress -- and a several-hundred-megabyte
    // download with nothing on screen reads as a panel that has stopped.
    if (unit.pullable?.length) {
        onLine(`Downloading ${unit.label}. This is a few hundred megabytes the first time.`);
        await compose(['pull', ...unit.pullable], { onLine, profile: unit.profile, timeoutMs: 60 * 60_000 });
    }
    onLine(`Creating the ${unit.label} container.`);
    await compose(['create', ...unit.services], { onLine, profile: unit.profile, timeoutMs: 20 * 60_000 });
    onLine(`${unit.label} is installed and switched off. Its switch in the sidebar starts it.`);
}

/**
 * Starts or stops. Never removes anything: a stopped service keeps its
 * container, its volumes and its image, and starting it again is immediate.
 */
export async function setRunning(key, running, onLine = () => {}) {
    const unit = unitFor(key);
    if (!unit) throw new Error(`No such service: ${key}`);

    if (running) {
        onLine(`Starting ${unit.label}.`);
        // `up -d` rather than `start`, so a container whose configuration
        // changed while it was stopped comes back with the new one.
        await compose(['up', '-d', ...NO_DEPS, ...unit.services], {
            onLine,
            profile: unit.profile,
            timeoutMs: 10 * 60_000,
        });
    } else {
        onLine(`Stopping ${unit.label}. Nothing is removed.`);
        await compose(['stop', ...unit.services], { onLine, profile: unit.profile, timeoutMs: 5 * 60_000 });
    }
}

/**
 * Removes everything this service owns, and says what it removed.
 *
 * `keepData` exists because "uninstall" means two things to two people: get rid
 * of the software, or get rid of all of it. The panel asks which, and the
 * volumes are the difference.
 */
export async function uninstall(key, { keepData = false, onLine = () => {} } = {}) {
    const unit = unitFor(key);
    if (!unit) throw new Error(`No such service: ${key}`);

    const removed = { containers: [], volumes: [], images: [] };

    onLine(`Removing the ${unit.label} containers.`);
    await compose(['rm', '-sf', ...unit.services], { onLine, profile: unit.profile, timeoutMs: 10 * 60_000 }).catch(
        (err) => onLine(`compose could not remove them cleanly: ${err.message}`),
    );
    // Anything compose missed, by name. A container created by an older version
    // of this stack is not in today's compose file but is still on the machine.
    for (const name of unit.containers) {
        const state = await containerState(name);
        if (!state.exists) continue;
        await docker(['rm', '-f', name], { timeoutMs: 60_000 }).catch(() => {});
        removed.containers.push(name);
    }

    if (keepData) {
        onLine(`Keeping ${unit.volumes.length} volume${unit.volumes.length === 1 ? '' : 's'}: ${unit.data}.`);
    } else {
        for (const volume of unit.volumes) {
            onLine(`Deleting volume ${volume}. This is not recoverable.`);
            await docker(['volume', 'rm', volume], { timeoutMs: 60_000 })
                .then(() => removed.volumes.push(volume))
                .catch((err) => onLine(`  ${volume} was not removed: ${err.message}`));
        }
    }

    for (const image of unit.images) {
        // Tagged by ref or version, so every tag of ours goes, and nothing that
        // is not ours is touched.
        const { stdout } = await docker(['images', '--format', '{{.Repository}}:{{.Tag}}', image], {
            timeoutMs: 30_000,
        }).catch(() => ({ stdout: '' }));
        for (const tag of stdout.split('\n').map((t) => t.trim()).filter(Boolean)) {
            await docker(['image', 'rm', '-f', tag], { timeoutMs: 60_000 })
                .then(() => removed.images.push(tag))
                .catch(() => {});
        }
    }

    onLine(
        `${unit.label} removed: ${removed.containers.length} container(s), ${removed.volumes.length} volume(s), ` +
            `${removed.images.length} image(s). It can be installed again from its tab.`,
    );
    return removed;
}
