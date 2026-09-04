import fs from 'node:fs';
import path from 'node:path';

import { docker, MANAGER_CONTAINER } from './dockerctl.js';
import { STACK_HOST, STACK_LOCAL } from './paths.js';

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

// Status is written as key=value lines rather than JSON. Emitting valid JSON
// from shell means escaping quotes and backslashes in error text, which is
// exactly the kind of thing that works until the day an error message contains
// a quote. One key per line cannot be malformed.
const STATUS_LOCAL = path.join(STACK_LOCAL, 'conf', 'last-update.txt');
const STATUS_HOST = `${STACK_HOST}/conf/last-update.txt`;

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
    const compose = `docker compose ${await composeFileArgs()} --project-directory "${STACK_HOST}"`;
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
// state and proxy/ holds issued certificates, so neither is listed: wiping
// either would cost real work to get back.
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
        if (files.length) return files.map((f) => `-f "${f}"`).join(' ');
    } catch {
        /* fall through to the base file */
    }
    return `-f "${STACK_HOST}/docker-compose.yml"`;
}

export async function updatePanel({ repo = STACK_REPO, ref = 'main' } = {}) {
    if (!REPO_RE.test(repo)) throw new Error(`"${repo}" is not a valid owner/repo.`);
    if (!REF_RE.test(ref)) throw new Error(`"${ref}" is not a valid branch, tag or commit.`);

    // Pinned to a resolved commit rather than the branch name, so what gets
    // recorded as installed is exactly what was downloaded. A branch moves.
    const head = await latestCommit({ repo, ref }).catch(() => null);
    const download = head?.sha || ref;

    const compose = `docker compose ${await composeFileArgs()} --project-directory "${STACK_HOST}"`;

    const script = `
set -u
S=${STATUS_HOST}
: > "$S"
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
for item in ${CODE_ITEMS.join(' ')}; do
  [ -e "$tmp/$item" ] || continue
  rm -rf "${STACK_HOST}/$item"
  cp -a "$tmp/$item" "${STACK_HOST}/" || fail "Could not write $item."
done
rm -rf "$tmp"

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

const CONTAINERS = [
    'quickstart-home-proxy',
    'quickstart-home-nextcloud',
    'quickstart-home-nextcloud-db',
    'quickstart-home-nextcloud-redis',
    'quickstart-home-nextcloud-imaginary',
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

const VOLUMES = ['quickstart-home-nextcloud-db-data', 'quickstart-home-nextcloud-data'];

// Pulled by the stack but not built by it, so they may well be shared with
// something else on the machine. Docker refuses when they are, which is the
// behaviour we want: nothing unrelated gets broken.
const BASE_IMAGES = [
    'nginx:1.27-alpine',
    'certbot/certbot:latest',
    'node:22-alpine',
    'alpine:3.21',
    'mariadb:10.11',
    'redis:7-alpine',
    'nextcloud/aio-imaginary:latest',
    'nextcloud:stable',
];

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

    // Ordered so the panel can report on it. Everything up to the last block
    // leaves the manager running, so the overlay showing this is fed by the
    // same docker logs the sidecar is writing; the last block takes the panel
    // away and the log ends there because there is nothing left to carry it.
    const script = `
set -u
echo "Removing containers"
for c in ${CONTAINERS.join(' ')}; do
  docker rm -f "$c" >/dev/null 2>&1 && echo "  removed $c" || true
done

echo "Removing images the stack built"
docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \\
  | grep '^quickstart-home/' \\
  | grep -v '^quickstart-home/manager' \\
  | while read -r i; do docker rmi -f "$i" >/dev/null 2>&1 && echo "  removed $i" || true; done

echo "Removing base images (skipped where something else still uses them)"
for i in ${BASE_IMAGES.join(' ')}; do
  docker rmi "$i" >/dev/null 2>&1 && echo "  removed $i" || echo "  kept $i, something else uses it"
done

echo "Removing volumes. This is every file stored in your apps."
for v in ${VOLUMES.join(' ')}; do
  docker volume rm -f "$v" >/dev/null 2>&1 && echo "  removed $v" || true
done

echo "Removing the control panel itself. This is where the log stops."
sleep 2
docker rm -f ${PANEL_CONTAINER} >/dev/null 2>&1 || true
docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \\
  | grep '^quickstart-home/manager' \\
  | while read -r i; do docker rmi -f "$i" >/dev/null 2>&1 || true; done

# Only once every container is off it.
docker network rm quickstart-home-net >/dev/null 2>&1 || true
# Our images are gone by now, so their build cache is dangling and this reclaims
# it. Without -a, cache that other projects still reference is left alone.
docker builder prune -f >/dev/null 2>&1 || true

# The parent is mounted rather than the stack directory itself, because a bind
# mount cannot delete its own mount point: mounted at itself, rm -rf empties the
# directory but leaves it behind. Guarded exactly as uninstall.sh guards it, so
# a directory that is not recognisably this install is never touched.
if [ -f "/host/${base}/docker-compose.yml" ] || [ -f "/host/${base}/.env" ]; then
  rm -rf "/host/${base}" && echo "Removed ${STACK_HOST}"
else
  echo "${STACK_HOST} does not look like a Quick Start Home install, so leaving it alone."
fi
echo "Done. Docker itself was left installed."
`;

    // Deliberately not the panel's image: this has to delete every
    // quickstart-home image including the one the panel runs from, and Docker
    // will not remove an image that a running container is using.
    const container = await detach({
        name: 'quickstart-home-teardown',
        image: 'docker:cli',
        script,
        mounts: [`${parent}:/host`],
    });
    return { started: true, container, removes: STACK_HOST };
}
