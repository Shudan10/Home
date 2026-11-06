import os from 'node:os';
import { containerState, run, STACK_CONTAINERS } from './dockerctl.js';
import { STACK_LOCAL } from './paths.js';

/**
 * What the machine itself looks like right now.
 *
 * A home server panel needs a landing page, and the honest one is about the
 * host rather than any single app: is anything running, is the disk about to
 * fill up, how long has it been up. Everything here is cheap enough to poll.
 */

/**
 * Free and total bytes on the filesystem the stack's data lands on.
 *
 * Not `/`. This process is inside a container, so the container's own root
 * filesystem is a number nobody cares about. The stack directory is a bind
 * mount of a real host path, so measuring that measures the host disk -- which
 * is the one that fills up when Nextcloud fills up.
 *
 * `df` rather than a statfs binding: it is in the image already and its POSIX
 * output is stable, whereas Node's filesystem-stats API has moved between
 * versions.
 */
export async function diskSpace() {
    try {
        // -P for POSIX output (one line per filesystem, fixed columns), -k for
        // 1024-byte blocks so the arithmetic is exact rather than rounded.
        const { stdout } = await run('df', ['-P', '-k', STACK_LOCAL], { timeoutMs: 10_000 });
        const line = stdout.trim().split('\n').slice(1).pop();
        if (!line) return null;

        // Filesystem  1024-blocks  Used  Available  Capacity  Mounted-on
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) return null;
        const total = Number(cols[1]) * 1024;
        const used = Number(cols[2]) * 1024;
        const free = Number(cols[3]) * 1024;
        if (!Number.isFinite(total) || !Number.isFinite(free) || !total) return null;

        return { total, used, free, percentUsed: Math.round((used / total) * 100) };
    } catch {
        return null;
    }
}

/**
 * The machine's name, which `os.hostname()` cannot give us.
 *
 * Inside a container that call returns the container's own hostname -- "manager"
 * -- which is a true answer to a question nobody asked. The Docker daemon runs
 * on the host and knows the host's name, so it is the one to ask.
 *
 * Cached for the process: a machine does not get renamed while the panel is up,
 * and this is on the status poll.
 */
let cachedHostname = null;

export async function hostname() {
    if (cachedHostname) return cachedHostname;
    try {
        const { stdout } = await run('docker', ['info', '--format', '{{.Name}}'], { timeoutMs: 10_000 });
        const name = stdout.trim();
        if (name) cachedHostname = name;
    } catch {
        /* fall back to whatever this container calls itself */
    }
    return cachedHostname ?? os.hostname();
}

/** Every container the stack can run, and whether it is up. */
export async function containers() {
    return Promise.all(
        STACK_CONTAINERS.map(async (entry) => ({
            ...entry,
            ...(await containerState(entry.name)),
        })),
    );
}

/*
 * This machine's address on the home network.
 *
 * Not readable from in here. Every interface this process can see belongs to
 * the docker network -- 172.18.0.5 and a loopback -- and offering either as
 * "on this network" sends somebody to an address that exists only inside a
 * container.
 *
 * The panel used to sidestep this by building the local link out of whatever
 * hostname the browser had used, on the reasoning that it is the one address
 * certain to work from wherever the page is being read. That holds right up
 * until you are sitting at home and reach the panel by its public name, which
 * a router with hairpin NAT lets you do and habit makes likely -- and then the
 * "on this network" link confidently points at the public name.
 *
 * So it is asked properly: a throwaway container sharing the host's network
 * stack opens a socket towards a public address and reports which local
 * address the kernel chose for it. Nothing is sent -- a connected UDP socket
 * only picks a route. The panel's own image is used because it is certainly
 * present; pulling something would make a landing page depend on the network.
 */
let lanCache = { at: 0, value: undefined };
/*
 * A probe that found nothing is kept too, for a while. It starts a container,
 * and it is on the status poll: answering "no address" by asking again every
 * few seconds meant a machine with no private address -- or a daemon that was
 * busy the once -- started a container per poll, for every open tab, forever.
 * Ten minutes is long enough to stop that and short enough that a network
 * which comes up later is noticed without a restart.
 */
const LAN_RETRY_MS = 10 * 60_000;

let lanProbe = null;

export async function lanAddress() {
    if (lanCache.value) return lanCache.value;
    if (lanCache.value === null && Date.now() - lanCache.at < LAN_RETRY_MS) return null;
    // Several tabs polling at once share the one probe rather than each
    // starting a container of its own.
    lanProbe ??= probeLanAddress().finally(() => {
        lanProbe = null;
    });
    return lanProbe;
}

async function probeLanAddress() {
    const probe = "const s=require('node:dgram').createSocket('udp4');" +
        "s.connect(53,'1.1.1.1',()=>{console.log(s.address().address);s.close()});" +
        "setTimeout(()=>process.exit(0),2000);";
    let value = null;
    try {
        const { stdout } = await run(
            'docker',
            ['run', '--rm', '--network', 'host', 'quickstart-home/manager:1', 'node', '-e', probe],
            { timeoutMs: 20_000 },
        );
        const ip = String(stdout).trim().split('\n').pop().trim();
        // Only a private address is an answer. A public one means this machine
        // is not behind a router at all, and there is no "on this network" to
        // offer -- better to say nothing than to print its public address.
        value = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? ip : null;
    } catch {
        value = null;
    }
    // A found address is kept for the process, as before: it is what the
    // machine is, not something that changes while the panel runs.
    lanCache = { at: Date.now(), value };
    return value;
}

/*
 * This machine on Tailscale, if it is on a tailnet.
 *
 * Asked of Tailscale itself, through the local status socket its daemon keeps
 * on the host, rather than inferred from network interfaces: only Tailscale
 * knows the machine's MagicDNS name, and the name is the address worth
 * showing -- it stays the same if the 100.x address ever changes. Read from a
 * throwaway container with the host's root mounted read-only, the same way
 * the drive list is read; the socket is under /run, because on the host
 * /var/run is a symlink to /run and inside the container that link points at
 * the container's own /run instead.
 *
 * Kept for five minutes rather than forever like the LAN address: Tailscale is
 * something people sign in to and out of while the panel runs.
 */
let tsCache = { at: 0, value: undefined };
const TS_TTL_MS = 5 * 60_000;

export async function tailscale({ force = false } = {}) {
    if (!force && tsCache.value !== undefined && Date.now() - tsCache.at < TS_TTL_MS) return tsCache.value;
    const script =
        'S=/host/run/tailscale/tailscaled.sock; [ -S "$S" ] || exit 0; ' +
        'curl -s --max-time 5 --unix-socket "$S" http://local-tailscaled.sock/localapi/v0/status';
    let value = null;
    try {
        const { stdout } = await run('docker', ['run', '--rm', '-v', '/:/host:ro', 'quickstart-home/manager:1', 'sh', '-c', script], {
            timeoutMs: 20_000,
        });
        const status = stdout.trim() ? JSON.parse(stdout) : null;
        // Installed but signed out, or stopped, is the same as not there: no
        // address that anyone could reach this machine on.
        if (status?.BackendState === 'Running' && status.Self) {
            const ip = (status.Self.TailscaleIPs ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? null;
            const name = String(status.Self.DNSName ?? '').replace(/\.$/, '') || null;
            const magicDNS = Boolean(status.CurrentTailnet?.MagicDNSEnabled);
            if (ip || name) {
                value = {
                    ip,
                    name,
                    magicDNS,
                    // What to type: the name when MagicDNS resolves it for every
                    // device on the tailnet, otherwise the address.
                    host: magicDNS && name ? name : ip,
                };
            }
        }
    } catch {
        value = null;
    }
    tsCache = { at: Date.now(), value };
    return value;
}

/**
 * The whole Overview payload.
 *
 * Memory, load and uptime come from `os`, which inside a container still
 * reports the host's figures -- the namespace does not virtualise them -- so
 * they are the machine's, which is what is wanted here.
 */
export async function snapshot() {
    const [disk, list, name] = await Promise.all([diskSpace(), containers(), hostname()]);
    const total = os.totalmem();
    const free = os.freemem();

    return {
        hostname: name,
        // Cached after the first look, so polling this page costs nothing.
        lanAddress: await lanAddress(),
        tailscale: await tailscale(),
        platform: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        cpus: os.cpus().length,
        // Seconds since the host booted.
        uptime: Math.round(os.uptime()),
        loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
        memory: { total, free, used: total - free, percentUsed: Math.round(((total - free) / total) * 100) },
        disk,
        containers: list,
    };
}
