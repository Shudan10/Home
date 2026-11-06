import fs from 'node:fs';
import path from 'node:path';

import { docker, MANAGER_CONTAINER } from './dockerctl.js';
import { STACK_HOST, STACK_LOCAL } from './paths.js';
import { readEnvFile } from './store.js';

/*
 * Two jobs that cannot run where every other job runs.
 *
 * Updating the panel replaces the container executing the update. Removing the
 * stack deletes it outright. Either way this process is gone half way through
 * and the remaining steps never happen.
 *
 * So both hand off to a detached container that outlives this one. It is the
 * usual shape for this: the thing being replaced starts its replacement and
 * then stops mattering.
 *
 * Both mount the stack at its *host* path rather than at /stack. The docker CLI
 * resolves build contexts and volume sources itself, so a path that only exists
 * inside this container yields a build quietly made from the wrong files.
 * Mounting host-path onto the same host-path makes the CLI and the daemon agree.
 */

const PANEL_IMAGE = 'quickstart-home/manager:1';
export const STACK_REPO = process.env.STACK_REPO || 'Shudan10/Home';

/*
 * A value made safe to paste into the generated shell scripts below.
 *
 * Those scripts are built as text, and the stack's host path went into them
 * bare or in double quotes -- so an install folder with a space in it (any
 * "Home Server" folder) split into two words, and one with a $ or a backtick
 * in it would have been run. Single quotes are the one shell quoting with no
 * exceptions inside; a single quote itself is closed, escaped and reopened.
 */
const sq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const HOST_Q = sq(STACK_HOST);

// Status is written as key=value lines rather than JSON. Emitting valid JSON
// from shell means escaping quotes and backslashes in error text, which is
// exactly the kind of thing that works until the day an error message contains
// a quote. One key per line cannot be malformed.
const STATUS_LOCAL = path.join(STACK_LOCAL, 'conf', 'last-update.txt');
const STATUS_HOST_Q = sq(`${STACK_HOST}/conf/last-update.txt`);

/** The status file as it stands, finished or not. */
function readStatus() {
    let raw;
    try {
        raw = fs.readFileSync(STATUS_LOCAL, 'utf8');
    } catch {
        return null;
    }
    const out = { steps: [] };
    for (const line of raw.split('\n')) {
        const at = line.indexOf('=');
        if (at < 1) continue;
        const key = line.slice(0, at);
        const value = line.slice(at + 1);
        if (key === 'step') out.steps.push(value);
        else out[key] = value;
    }
    return out;
}

/** Reads back what the detached updater recorded, once the panel is up again. */
export function lastUpdate() {
    const out = readStatus();
    if (!out?.result) return null;
    return { ...out, ok: out.result === 'ok' };
}

/**
 * The same file while the update is still running, for the overlay to follow.
 *
 * The updater cannot report through the job queue: it replaces the very panel
 * that would be serving the events, so it runs detached in its own container and
 * writes each step to this file instead. Watching it is the only way to see the
 * run as it happens -- and without that, a failure here was completely silent.
 * The panel said "Rebuilding. This page will drop out and come back on its own",
 * the update died at the first step, and the page waited for a restart that was
 * never coming.
 */
export function updateProgress() {
    const out = readStatus();
    if (!out) return { running: false, steps: [] };
    const done = Boolean(out.result);
    return {
        ...out,
        steps: out.steps,
        running: !done,
        ok: out.result === 'ok',
    };
}

/**
 * Launches a detached container that survives this one being replaced.
 * `--rm` so a finished run leaves nothing behind to clean up.
 */
async function detach({ name, image, script, mounts = [] }) {
    // A run that died mid-way would still hold the name.
    await docker(['rm', '-f', name], { timeoutMs: 30_000 }).catch(() => {});

    const { stdout } = await docker(
        [
            'run',
            '--detach',
            '--rm',
            '--name',
            name,
            '-v',
            '/var/run/docker.sock:/var/run/docker.sock',
            ...mounts.flatMap((m) => ['-v', m]),
            image,
            'sh',
            '-c',
            script,
        ],
        { timeoutMs: 60_000 },
    );
    return stdout.trim().slice(0, 12);
}

// --------------------------------------------------------- panel restart ---

/**
 * Recreates the panel's own container.
 *
 * The admin password reaches the panel as an environment variable, read once at
 * startup, so setting one from inside the panel means replacing the container
 * that is serving the request. It cannot do that itself -- the command would die
 * with the process running it -- so a detached sidecar does it a moment later,
 * from this same image, which already has compose in it.
 */
export async function restartManager() {
    const compose = `docker compose ${await composeFileArgs()} --project-directory ${HOST_Q}`;
    const script = `
set -u
# Long enough for the response to this request to have been written.
sleep 2
${compose} up -d --force-recreate manager
`;
    const container = await detach({
        name: 'quickstart-home-panel-restart',
        image: PANEL_IMAGE,
        script,
        mounts: [`${STACK_HOST}:${STACK_HOST}`],
    });
    return { started: true, container };
}

// ------------------------------------------------------------- panel update ---

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// No "..", so a ref cannot climb out of the URL path it is pasted into.
const REF_RE = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,120}$/;

// Exactly the set install.sh replaces on a re-install. conf/ holds generated
// state, so it is not listed: wiping it would cost real work to get back. An
// old proxy/ directory from before the tunnel is left where it is, for the
// same reason -- it may hold certificates somebody wants to keep.
const CODE_ITEMS = ['docker-compose.yml', 'manager', 'nextcloud', 'uninstall.sh', 'dev.sh', 'README.md'];

const ghHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'quickstart-home-panel',
};

/** The commit a branch or tag currently points at. */
export async function latestCommit({ repo = STACK_REPO, ref = 'main' } = {}) {
    if (!REPO_RE.test(repo)) throw new Error(`"${repo}" is not a valid owner/repo.`);
    if (!REF_RE.test(ref)) throw new Error(`"${ref}" is not a valid branch, tag or commit.`);

    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
        headers: ghHeaders,
        signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) throw new Error(`${repo}@${ref} does not exist.`);
    // Unauthenticated GitHub allows 60 requests an hour per address, which a
    // manual check will never reach, but the message should say so if it does.
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is rate limiting this address. Try again in a few minutes.');
    if (!res.ok) throw new Error(`GitHub returned ${res.status}.`);

    const c = await res.json();
    return {
        sha: c.sha,
        shortSha: String(c.sha || '').slice(0, 7),
        date: c.commit?.committer?.date ?? c.commit?.author?.date ?? null,
        message: String(c.commit?.message || '').split('\n')[0].slice(0, 140),
        url: c.html_url ?? null,
    };
}

/**
 * How far behind the installed commit is. Skipped when nothing recorded an
 * installed sha, which is every install that has never used this button.
 */
export async function compareToInstalled({ repo, base, head }) {
    if (!base || !head || base === head) return null;
    try {
        const res = await fetch(`https://api.github.com/repos/${repo}/compare/${base}...${head}`, {
            headers: ghHeaders,
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return null;
        const c = await res.json();
        return { behind: Number(c.ahead_by) || 0, status: c.status ?? null };
    } catch {
        return null;
    }
}

/**
 * The exact `-f` list the running project was created with, read off the
 * container's own compose labels.
 *
 * Rebuilding with only docker-compose.yml looks fine and is not: the published
 * port overrides live in conf/apps-ports.yml, so a manager recreated without
 * them comes back with no host port mapping, which means the panel that started
 * the update never reappears. Any local override in play (a dev.yml with bind
 * mounts, say) would be silently dropped the same way. The labels are what
 * compose itself used, and they are host paths already, which is what the
 * detached container needs.
 */
async function composeFileArgs() {
    try {
        const { stdout } = await docker([
            'inspect',
            '--format',
            '{{index .Config.Labels "com.docker.compose.project.config_files"}}',
            MANAGER_CONTAINER,
        ]);
        const files = stdout
            .trim()
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean);
        if (files.length) return files.map((f) => `-f ${sq(f)}`).join(' ');
    } catch {
        /* fall through to the base file */
    }
    return `-f ${sq(`${STACK_HOST}/docker-compose.yml`)}`;
}

export async function updatePanel({ repo = STACK_REPO, ref = 'main' } = {}) {
    if (!REPO_RE.test(repo)) throw new Error(`"${repo}" is not a valid owner/repo.`);
    if (!REF_RE.test(ref)) throw new Error(`"${ref}" is not a valid branch, tag or commit.`);

    // Pinned to a resolved commit rather than the branch name, so what gets
    // recorded as installed is exactly what was downloaded. A branch moves.
    const head = await latestCommit({ repo, ref }).catch(() => null);
    const download = head?.sha || ref;

    const compose = `docker compose ${await composeFileArgs()} --project-directory ${HOST_Q}`;

    const script = `
set -u
D=${HOST_Q}
S=${STATUS_HOST_Q}
# This runs as root, and whatever it writes is root's unless it says
# otherwise. The stack directory belongs to whoever installed it, and so
# should everything it puts there: root-owned files are what made the next
# install.sh, dev.sh or uninstall.sh die on "Permission denied".
owner=$(stat -c %u:%g "$D" 2>/dev/null) || owner=""
: > "$S"
[ -n "$owner" ] && chown "$owner" "$S" 2>/dev/null
echo "kind=panel-update" >> "$S"
echo "repo=${repo}" >> "$S"
echo "ref=${ref}" >> "$S"
echo "sha=${head?.sha || ''}" >> "$S"
echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$S"
step() { echo "step=$1" >> "$S"; echo "$1"; }
fail() { echo "error=$1" >> "$S"; echo "result=fail" >> "$S"; exit 1; }

step "Downloading ${repo}@${ref}"
tmp=$(mktemp -d) || fail "Could not create a temporary directory."
# Retried, because this is the one step that fails for reasons that pass on
# their own. The commit was resolved through the API a moment ago; codeload
# builds the tarball separately and can 404 for a few seconds on a commit that
# was only just pushed, which is exactly when somebody presses this button.
# The old single attempt turned that into "Check the branch or tag name" -- a
# message accusing the one thing that had already been proven right.
n=0
until curl -fsSL "https://codeload.github.com/${repo}/tar.gz/${download}" | tar -xz -C "$tmp" --strip-components=1; do
  n=$((n + 1))
  [ "$n" -ge 5 ] && fail "Could not download ${download} from ${repo} after 5 tries. GitHub may be unreachable from this machine."
  echo "  download attempt $n failed, retrying in 5s"
  sleep 5
  # A fresh directory rather than emptying this one. Shell braces are JS
  # template syntax in this file, so "\${tmp:?}" cannot be written here, and a
  # bare "rm -rf $tmp/*" with tmp somehow unset is not a risk worth carrying.
  rm -rf "$tmp"
  tmp=$(mktemp -d) || fail "Could not create a temporary directory."
done
[ -f "$tmp/docker-compose.yml" ] || fail "That archive does not look like the stack."

step "Replacing the panel files"
[ -n "$owner" ] || fail "Could not tell who owns the stack directory, so nothing was replaced."
# In two passes, so a failure part-way leaves the old files rather than a mix
# of old and new. The old way removed each item and then copied its
# replacement in, and a copy that failed after the removal left the panel with
# no manager/ to rebuild from at all.
#
# First every item is staged next to its old self as <item>.new, owned by the
# stack directory's owner. Nothing in use has been touched yet, so any failure
# here only has to clear the staging away.
#
# Then each is swapped in with two renames, old to <item>.old and new into its
# place, which on one filesystem cannot half-happen. A failed rename puts back
# everything already swapped. The .old copies go only once all are in.
#
# An <item>.old with no <item> beside it is a run that was killed between its
# two renames; it is put back before anything else, so that run is undone.
for item in ${CODE_ITEMS.join(' ')}; do
  if [ ! -e "$D/$item" ] && [ -e "$D/$item.old" ]; then mv "$D/$item.old" "$D/$item"; fi
  rm -rf "$D/$item.new" "$D/$item.old"
done
staged=""
for item in ${CODE_ITEMS.join(' ')}; do
  [ -e "$tmp/$item" ] || continue
  if ! { cp -a "$tmp/$item" "$D/$item.new" && chown -R "$owner" "$D/$item.new"; }; then
    for x in $staged $item; do rm -rf "$D/$x.new"; done
    fail "Could not write $item. Nothing was replaced, and the old panel is still running."
  fi
  staged="$staged $item"
done
rm -rf "$tmp"
undo() {
  for x in $swapped; do
    rm -rf "$D/$x"
    [ -e "$D/$x.old" ] && mv "$D/$x.old" "$D/$x"
  done
  for x in $staged; do rm -rf "$D/$x.new"; done
}
swapped=""
for item in $staged; do
  if [ -e "$D/$item" ] && ! mv "$D/$item" "$D/$item.old"; then
    undo
    fail "Could not move the old $item aside. Everything was put back, and the old panel is still running."
  fi
  if ! mv "$D/$item.new" "$D/$item"; then
    [ -e "$D/$item.old" ] && mv "$D/$item.old" "$D/$item"
    undo
    fail "Could not put the new $item in place. Everything was put back, and the old panel is still running."
  fi
  swapped="$swapped $item"
done
for item in $staged; do rm -rf "$D/$item.old"; done

step "Rebuilding the panel image"
${compose} build manager || fail "The panel image did not build. The old panel is still running."

step "Restarting the panel"
echo "result=ok" >> "$S"
${compose} up -d --force-recreate manager || {
  echo "error=The image built, but the panel container did not come back." >> "$S"
  echo "result=fail" >> "$S"
  exit 1
}
`;

    // Runs from the panel's own image, which already carries docker, compose,
    // buildx and curl, so nothing extra is pulled to do this.
    const container = await detach({
        name: 'quickstart-home-panel-update',
        image: PANEL_IMAGE,
        script,
        mounts: [`${STACK_HOST}:${STACK_HOST}`],
    });
    return { started: true, container, repo, ref };
}

// ----------------------------------------------------------------- teardown ---

// Every container the stack runs except the panel itself. Jellyfin and Meal
// Plan were missing from this list, so "remove everything" left both running.
// Keep in step with STACK_CONTAINERS in dockerctl.js and the list in
// uninstall.sh.
const CONTAINERS = [
    'quickstart-home-tunnel',
    'quickstart-home-mullvad',
    'quickstart-home-kachat-nextcloud',
    'quickstart-home-kachat-db',
    'quickstart-home-kachat-redis',
    'quickstart-home-nextcloud',
    'quickstart-home-nextcloud-db',
    'quickstart-home-nextcloud-redis',
    'quickstart-home-nextcloud-imaginary',
    'quickstart-home-jellyfin',
    'quickstart-home-mealplan',
    'quickstart-home-minecraft',
    // From before the tunnel; gone on most installs, harmless when it is.
    'quickstart-home-proxy',
    // The panel's other helpers. They remove themselves when they finish, so
    // these are only ever one that died part-way and still holds its name.
    'quickstart-home-panel-update',
    'quickstart-home-panel-restart',
];

/**
 * The panel, removed on its own at the very end.
 *
 * It used to go with the rest, in the first step, which meant the screen that
 * asked for this vanished before the removal had done anything and the person
 * who pressed the button never saw a word of it. Everything it can narrate
 * happens first; it is taken away last, and its disappearing is the finish.
 */
const PANEL_CONTAINER = 'quickstart-home-manager';

// Everything the stack keeps. The button promises "all its data", and it
// used to quietly keep Jellyfin's library database and Meal Plan's meals.
// Every named volume in docker-compose.yml; the script also removes whatever
// compose has labelled as this project's, so one added there later is not
// missed here. Redis has none: it runs on a tmpfs.
const VOLUMES = [
    'quickstart-home-nextcloud-db-data',
    'quickstart-home-nextcloud-data',
    'quickstart-home-jellyfin-config',
    'quickstart-home-jellyfin-cache',
    'quickstart-home-mealplan-data',
    'quickstart-home-minecraft-data',
    'quickstart-home-mullvad-tailscale',
    'quickstart-home-kachat-data',
    'quickstart-home-kachat-db-data',
];

const NETWORKS = ['quickstart-home-net', 'quickstart-home-vpn'];

/*
 * The image this teardown runs in. Pinned, like every other image the stack
 * pulls, so what runs here is a decision rather than whatever `docker:cli`
 * pointed at on the day; checked to exist on Docker Hub when it was set.
 *
 * It is the one thing the teardown cannot remove: Docker will not delete the
 * image of a container that is still running, and this container is running
 * until the very end. So it says so, with the command, instead of claiming
 * everything is gone. uninstall.sh removes it.
 */
const TEARDOWN_IMAGE = 'docker:29.9.3-cli';

// An image tag read from .env, refused unless it is plainly a tag, since it
// goes into a shell script.
const envTag = (env, key, fallback) => (/^[A-Za-z0-9._-]{1,128}$/.test(env[key] ?? '') ? env[key] : fallback);

/*
 * Pulled by the stack but not built by it, so they may well be shared with
 * something else on the machine. Docker refuses when they are, which is the
 * behaviour we want: nothing unrelated gets broken.
 *
 * At the exact tags in use: `docker rmi` without one means :latest, which
 * never matches a pinned image. Several come from .env, so they are read from
 * it now rather than assumed. Keep in step with docker-compose.yml, the
 * Dockerfiles, and the list in uninstall.sh.
 */
function baseImages() {
    let env = {};
    try {
        env = readEnvFile();
    } catch {
        /* the defaults below */
    }
    return [
        `cloudflare/cloudflared:${envTag(env, 'TUNNEL_VERSION', '2026.10.7')}`,
        // The Mullvad exit node is built on this; keep in step with its Dockerfile.
        'tailscale/tailscale:v1.104',
        // The panel's image is built on node; alpine is the helper image the
        // panel runs its small jobs in.
        'node:22-alpine',
        'alpine:3.21',
        'mariadb:10.11',
        'redis:7-alpine',
        'nextcloud/aio-imaginary:latest',
        // The base the Nextcloud image is built FROM (the NEXTCLOUD_TAG build arg).
        `nextcloud:${envTag(env, 'NEXTCLOUD_TAG', 'stable')}`,
        `jellyfin/jellyfin:${envTag(env, 'JELLYFIN_VERSION', 'latest')}`,
        `itzg/minecraft-server:${envTag(env, 'MINECRAFT_IMAGE_VERSION', 'latest')}`,
        // From older versions, so an upgraded install is cleaned up too: the
        // nginx proxy and its certbot from before the tunnel, and the unpinned
        // image this teardown used to run in.
        'nginx:1.27-alpine',
        'certbot/certbot:latest',
        'docker:cli',
    ];
}

/**
 * Removes everything this stack put on the machine and leaves Docker itself
 * installed, which is the whole point of doing it this way rather than telling
 * people to uninstall Docker.
 */
export async function teardown() {
    const parent = path.posix.dirname(STACK_HOST.replace(/\\/g, '/'));
    const base = path.posix.basename(STACK_HOST.replace(/\\/g, '/'));
    // Refuse the cases where deleting "the parent's child" would mean deleting
    // something enormous by accident.
    if (!base || base === '.' || base === '/' || parent === base) {
        throw new Error(`Refusing to remove ${STACK_HOST}: it has no parent directory to work from.`);
    }
    const target = sq(`/host/${base}`);

    // Ordered so the panel can report on it. Everything up to the last block
    // leaves the manager running, so the overlay showing this is fed by the
    // same docker logs the sidecar is writing; the last block takes the panel
    // away and the log ends there because there is nothing left to carry it.
    //
    // What could not be removed is collected as it goes and said before the
    // panel goes, while there is still someone to read it. "Done" used to be
    // printed whatever had happened.
    //
    // Loops read from $(...) rather than a pipe: a pipe's loop runs in a
    // subshell, and what it adds to $left would be lost with it.
    const script = `
set -u
left=""
keep() { left="$left
  - $1"; echo "  could not remove $1"; }

echo "Removing containers"
# -v takes each container's anonymous volumes with it; never a named one.
for c in ${CONTAINERS.join(' ')}; do
  docker container inspect "$c" >/dev/null 2>&1 || continue
  if docker rm -fv "$c" >/dev/null 2>&1; then echo "  removed $c"; else keep "container $c"; fi
done

echo "Removing images the stack built"
for i in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^quickstart-home/' | grep -v '^quickstart-home/manager'); do
  if docker rmi -f "$i" >/dev/null 2>&1; then echo "  removed $i"; else keep "image $i"; fi
done

echo "Removing base images (skipped where something else still uses them)"
for i in ${baseImages().join(' ')}; do
  docker image inspect "$i" >/dev/null 2>&1 || continue
  docker rmi "$i" >/dev/null 2>&1 && echo "  removed $i" || echo "  kept $i, something else uses it"
done

echo "Removing volumes. This is every file stored in your apps."
volumes=" ${VOLUMES.join(' ')} "
for v in $(docker volume ls -q --filter label=com.docker.compose.project=quickstart-home 2>/dev/null); do
  case "$volumes" in *" $v "*) ;; *) volumes="$volumes$v " ;; esac
done
for v in $volumes; do
  docker volume inspect "$v" >/dev/null 2>&1 || continue
  if docker volume rm -f "$v" >/dev/null 2>&1; then echo "  removed $v"; else keep "volume $v"; fi
done

if [ -z "$left" ]; then
  echo "Everything above is gone."
else
  echo "These could not be removed:$left"
fi
echo "Left for you to remove: ${TEARDOWN_IMAGE}, the image this removal is running in. Docker"
echo "will not delete it while it runs. Once this has finished: docker rmi ${TEARDOWN_IMAGE}"

echo "Removing the control panel itself. This is where the log stops."
sleep 2
docker rm -f ${PANEL_CONTAINER} >/dev/null 2>&1 || keep "container ${PANEL_CONTAINER}"
for i in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^quickstart-home/manager'); do
  docker rmi -f "$i" >/dev/null 2>&1 || keep "image $i"
done

# Only once every container is off it.
for n in ${NETWORKS.join(' ')}; do
  docker network inspect "$n" >/dev/null 2>&1 || continue
  docker network rm "$n" >/dev/null 2>&1 || keep "network $n"
done
# Our images are gone by now, so their build cache is dangling and this reclaims
# it. Without -a, cache that other projects still reference is left alone.
docker builder prune -f >/dev/null 2>&1 || true

# The parent is mounted rather than the stack directory itself, because a bind
# mount cannot delete its own mount point: mounted at itself, rm -rf empties the
# directory but leaves it behind. Guarded exactly as uninstall.sh guards it, so
# a directory that is not recognisably this install is never touched.
if [ -f ${target}/docker-compose.yml ] || [ -f ${target}/.env ]; then
  rm -rf ${target}
  if [ -e ${target} ]; then keep ${sq(STACK_HOST)}; else echo "Removed "${HOST_Q}; fi
else
  echo ${HOST_Q}" does not look like a Quick Start Home install, so leaving it alone."
fi
if [ -z "$left" ]; then
  echo "Done. Docker itself was left installed, and so is ${TEARDOWN_IMAGE} until you remove it."
else
  echo "Finished, but these are still here:$left"
  echo "Docker itself was left installed."
fi
`;

    // Deliberately not the panel's image: this has to delete every
    // quickstart-home image including the one the panel runs from, and Docker
    // will not remove an image that a running container is using.
    const container = await detach({
        name: 'quickstart-home-teardown',
        image: TEARDOWN_IMAGE,
        script,
        mounts: [`${parent}:/host`],
    });
    return { started: true, container, removes: STACK_HOST };
}
