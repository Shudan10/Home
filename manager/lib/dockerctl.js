import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COMPOSE_FILE, CONF_DIR, STACK_LOCAL } from './paths.js';
import { jobContext } from './jobcontext.js';

/**
 * Processes spawned by a job that is still running, so cancelling has something
 * to kill. Only `run` registers here -- `streamLogs` follows a container's
 * output and stopping a job has no business stopping that.
 */
const LIVE = new Set();

/**
 * Ends the processes a job started. SIGTERM, because docker and certbot both
 * clean up on it; a build that is killed leaves its finished layers in the
 * cache, so starting again picks up where this left off rather than at the
 * beginning.
 */
export function killJob(jobId) {
    let killed = 0;
    for (const entry of LIVE) {
        if (entry.jobId !== jobId) continue;
        try {
            entry.child.kill('SIGTERM');
            killed += 1;
        } catch {
            /* already gone */
        }
    }
    return killed;
}

const MANAGER_CONTAINER = process.env.MANAGER_CONTAINER || 'quickstart-home-manager';
const PROXY_CONTAINER = process.env.PROXY_CONTAINER || 'quickstart-home-proxy';
const NEXTCLOUD_CONTAINER = process.env.NEXTCLOUD_CONTAINER || 'quickstart-home-nextcloud';
const JELLYFIN_CONTAINER = process.env.JELLYFIN_CONTAINER || 'quickstart-home-jellyfin';

export { MANAGER_CONTAINER, PROXY_CONTAINER, NEXTCLOUD_CONTAINER, JELLYFIN_CONTAINER };

/**
 * Every container this stack can run, in the order worth reading them.
 *
 * This one list is both the Overview roll-call and the set of tiles on the Logs
 * page, so a container missing from here is a container with nowhere to read
 * its output -- which is exactly what happened to Jellyfin: it was added to the
 * compose file and the lifecycle units but not to this list, so it ran without
 * ever appearing on either page.
 */
export const STACK_CONTAINERS = [
    { key: 'nextcloud', label: 'nextcloud', name: NEXTCLOUD_CONTAINER },
    { key: 'nextcloud-db', label: 'nextcloud mariadb', name: 'quickstart-home-nextcloud-db' },
    { key: 'nextcloud-redis', label: 'nextcloud redis', name: 'quickstart-home-nextcloud-redis' },
    { key: 'nextcloud-imaginary', label: 'nextcloud previews', name: 'quickstart-home-nextcloud-imaginary' },
    { key: 'jellyfin', label: 'jellyfin', name: JELLYFIN_CONTAINER },
    { key: 'proxy', label: 'nginx proxy', name: PROXY_CONTAINER },
    { key: 'manager', label: 'control panel', name: MANAGER_CONTAINER },
];

export class CommandError extends Error {
    constructor(message, { code, stdout, stderr }) {
        super(message);
        this.name = 'CommandError';
        this.code = code;
        this.stdout = stdout;
        this.stderr = stderr;
    }
}

/**
 * Runs a command, optionally streaming output line by line to `onLine`.
 * Never uses a shell, so arguments carrying user input cannot be re-parsed.
 */
export function run(cmd, args, { onLine, timeoutMs = 15 * 60_000, cwd = STACK_LOCAL, env } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
        // Whichever job's function this was called from, however far down.
        const entry = { child, jobId: jobContext.getStore()?.id ?? null };
        if (entry.jobId) LIVE.add(entry);
        let stdout = '';
        let stderr = '';
        let pending = '';

        const emit = (chunk) => {
            if (!onLine) return;
            pending += chunk;
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) onLine(line);
        };

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new CommandError(`${cmd} timed out after ${timeoutMs}ms`, { code: -1, stdout, stderr }));
        }, timeoutMs);

        child.stdout.on('data', (d) => {
            stdout += d;
            emit(d.toString());
        });
        child.stderr.on('data', (d) => {
            stderr += d;
            emit(d.toString());
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            LIVE.delete(entry);
            reject(new CommandError(`failed to run ${cmd}: ${err.message}`, { code: -1, stdout, stderr }));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            LIVE.delete(entry);
            if (pending && onLine) onLine(pending);
            if (code === 0) resolve({ stdout, stderr, code });
            else reject(new CommandError(`${cmd} exited with code ${code}: ${stderr.trim() || stdout.trim()}`, { code, stdout, stderr }));
        });
    });
}

export const docker = (args, opts) => run('docker', args, opts);

function composeFiles() {
    const files = ['-f', COMPOSE_FILE];
    const override = path.join(CONF_DIR, 'apps-ports.yml');
    if (fs.existsSync(override)) files.push('-f', override);
    return files;
}

/**
 * `profile: 'nextcloud'` is what makes an app's services visible to compose.
 * Everything optional sits behind a profile so that a bare `up -d` -- what the
 * installer runs -- starts the panel and nothing else.
 */
export const compose = (args, { profile, ...opts } = {}) =>
    run(
        'docker',
        [
            'compose',
            ...composeFiles(),
            ...(profile ? ['--profile', profile] : []),
            '--project-directory',
            STACK_LOCAL,
            ...args,
        ],
        opts,
    );

// ------------------------------------------------------------- inspection --

export async function containerState(name) {
    try {
        const { stdout } = await docker([
            'inspect',
            '--format',
            // `.State.Health` only exists when the image declares a HEALTHCHECK.
            // Referencing it unguarded makes `docker inspect` fail outright, so
            // every container without one looked like it did not exist at all.
            '{{.State.Status}}|{{.State.Running}}|{{.State.StartedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.Config.Image}}|{{.RestartCount}}',
            name,
        ]);
        const [status, running, startedAt, health, image, restarts] = stdout.trim().split('|');
        return {
            exists: true,
            status,
            running: running === 'true',
            startedAt,
            health: health === 'none' || health === '<no value>' ? null : health,
            image,
            restarts: Number(restarts) || 0,
        };
    } catch {
        return { exists: false, status: 'absent', running: false, startedAt: null, health: null, image: null, restarts: 0 };
    }
}

export async function publishedPorts(name) {
    try {
        const { stdout } = await docker(['port', name]);
        return stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [container, host] = line.split(' -> ');
                return { container: container?.trim(), host: host?.trim() };
            });
    } catch {
        return [];
    }
}

export async function logs(name, tail = 300) {
    try {
        const { stdout, stderr } = await docker(['logs', '--tail', String(tail), name]);
        return `${stdout}${stderr}`;
    } catch (err) {
        return err instanceof CommandError ? `${err.stdout || ''}${err.stderr || ''}` : String(err);
    }
}

export function streamLogs(name, onLine, { tail = 200, timestamps = false } = {}) {
    const args = ['logs', '--tail', String(tail), '--follow'];
    if (timestamps) args.push('--timestamps');
    const child = spawn('docker', [...args, name]);
    let pending = '';
    const emit = (chunk) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) onLine(line);
    };
    child.stdout.on('data', (d) => emit(d.toString()));
    child.stderr.on('data', (d) => emit(d.toString()));
    child.on('error', (err) => onLine(`[manager] log stream error: ${err.message}`));
    return () => child.kill('SIGKILL');
}

/**
 * What a volume takes up, as docker reports it.
 *
 * Coarse -- `docker system df` gives text like "19.58GB" -- but it costs one
 * command and no container, so it is what the Overview asks for. Use
 * `volumeBytes` when the exact figure matters.
 */
export async function diskUsage(volume) {
    try {
        const { stdout } = await docker(['system', 'df', '-v', '--format', '{{json .}}']);
        const parsed = JSON.parse(stdout.trim().split('\n').pop());
        const match = (parsed.Volumes || []).find((v) => v.Name === volume);
        return match ? { name: volume, size: match.Size } : null;
    } catch {
        return null;
    }
}

/**
 * Exact bytes held in a volume, by walking it.
 *
 * `docker system df` reports four significant figures, which is far too coarse
 * to watch something grow. This starts a throwaway container to `du` the mount,
 * so the answer is real bytes -- and because it starts a container, it is held
 * for a minute per volume.
 */
const byteCache = new Map();
const BYTE_CACHE_MS = 60_000;

export async function volumeBytes(volume, { force = false } = {}) {
    const hit = byteCache.get(volume);
    if (!force && hit && Date.now() - hit.at < BYTE_CACHE_MS) return hit.value;
    try {
        const { stdout } = await docker(
            ['run', '--rm', '-v', `${volume}:/d:ro`, 'alpine:3.21', 'du', '-sb', '/d'],
            { timeoutMs: 120_000 },
        );
        const m = /^(\d+)\s/.exec(stdout.trim());
        if (!m) return null;
        const value = Number(m[1]);
        byteCache.set(volume, { at: Date.now(), value });
        return value;
    } catch {
        return null;
    }
}
