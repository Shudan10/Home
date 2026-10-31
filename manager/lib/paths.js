import fs from 'node:fs';
import path from 'node:path';

// STACK_LOCAL is where the stack directory is mounted *inside* this container.
// STACK_HOST is the same directory as the Docker daemon sees it. They differ,
// and mixing them up is the easiest way to break this stack: compose file
// arguments and `docker run -v` sources must always use the host path, while
// plain file reads/writes must always use the local path.
export const STACK_LOCAL = process.env.STACK_LOCAL || '/stack';
export const STACK_HOST = process.env.STACK_DIR || STACK_LOCAL;

export const CONF_DIR = path.join(STACK_LOCAL, 'conf');

export const COMPOSE_FILE = path.join(STACK_LOCAL, 'docker-compose.yml');
export const ENV_FILE = path.join(STACK_LOCAL, '.env');

export const MANAGER_CONFIG_FILE = path.join(CONF_DIR, 'manager.json');

// The host-side equivalents, for `docker run -v` and compose `-f`.
export const hostPath = (...parts) => path.posix.join(STACK_HOST.replace(/\\/g, '/'), ...parts);

export function ensureDirs() {
    fs.mkdirSync(CONF_DIR, { recursive: true });
}
