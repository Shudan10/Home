/*
 * What an image tag points at on Docker Hub right now, without pulling it.
 *
 * Nextcloud and Jellyfin both come from Docker Hub images that move under a
 * fixed tag -- `nextcloud:stable`, `jellyfin/jellyfin:latest` -- and nothing
 * else in the panel notices when they do. That is how Nextcloud sat on a PHP
 * with a published remote-code-execution fix for a week: the fix was out, the
 * tag had moved, and the Update button looked exactly as it always does.
 *
 * Docker Hub counts every manifest GET against an anonymous pull allowance
 * that the real pulls need too, so a check is careful with them. A HEAD of the
 * tag is free and returns its digest; the two GETs that turn that digest into
 * layers happen only when the digest is one not seen before, and the answer is
 * kept. Pressing Check repeatedly costs nothing until the tag actually moves.
 */

const REGISTRY = 'https://registry-1.docker.io';

const INDEX_TYPES = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const ARCH = { x64: 'amd64', arm64: 'arm64', arm: 'arm' }[process.arch] ?? process.arch;

/** "nextcloud:stable" -> { repo: "library/nextcloud", tag: "stable" }. Docker Hub only. */
export function parseImageRef(ref) {
    let rest = String(ref || '').trim();
    if (!rest) throw new Error('No image to check.');
    // A registry host is the first path part only when it looks like one.
    const first = rest.split('/')[0];
    if (rest.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
        if (first !== 'docker.io' && first !== 'registry-1.docker.io') {
            throw new Error(`${ref} is not on Docker Hub, which is the only registry this can check.`);
        }
        rest = rest.slice(first.length + 1);
    }
    let tag = 'latest';
    const colon = rest.lastIndexOf(':');
    if (colon > rest.lastIndexOf('/')) {
        tag = rest.slice(colon + 1);
        rest = rest.slice(0, colon);
    }
    const repo = rest.includes('/') ? rest : `library/${rest}`;
    return { repo, tag };
}

async function token(repo) {
    const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Docker Hub would not issue a token for ${repo} (${res.status}).`);
    return (await res.json()).token;
}

async function get(path, auth, accept, method = 'GET') {
    const res = await fetch(`${REGISTRY}${path}`, {
        method,
        headers: { Authorization: `Bearer ${auth}`, Accept: accept },
        signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) {
        throw new Error('Docker Hub is rate limiting this address. Try again in an hour or so.');
    }
    if (!res.ok) throw new Error(`Docker Hub returned ${res.status} for ${path}.`);
    return res;
}

/** Keyed by the tag's digest: one per image version, so it cannot go stale. */
const resolved = new Map();

/**
 * The current version of a tag: its digest, the uncompressed layer ids of the
 * build for this machine's architecture, and its environment and labels.
 *
 * `diffIds` are the ids Docker itself lists for a local image under
 * RootFS.Layers, which is what makes them comparable with what is running.
 */
export async function resolveTag(ref) {
    const { repo, tag } = parseImageRef(ref);
    const auth = await token(repo);

    // Free: a HEAD is not counted as a pull.
    const head = await get(`/v2/${repo}/manifests/${encodeURIComponent(tag)}`, auth, INDEX_TYPES, 'HEAD');
    const digest = head.headers.get('docker-content-digest');
    if (digest && resolved.has(digest)) return resolved.get(digest);

    // Counted: the index, then this architecture's manifest. Once per version.
    let manifest = await (await get(`/v2/${repo}/manifests/${encodeURIComponent(tag)}`, auth, INDEX_TYPES)).json();
    if (Array.isArray(manifest.manifests)) {
        const pick = manifest.manifests.find(
            (m) => m.platform?.os === 'linux' && m.platform?.architecture === ARCH && !m.platform?.variant?.startsWith?.('unknown'),
        );
        if (!pick) throw new Error(`${ref} has no build for ${ARCH}.`);
        manifest = await (await get(`/v2/${repo}/manifests/${pick.digest}`, auth, INDEX_TYPES)).json();
    }
    const configDigest = manifest.config?.digest;
    if (!configDigest) throw new Error(`Docker Hub's answer for ${ref} had no image config.`);

    // Blobs are not counted as pulls.
    const config = await (await get(`/v2/${repo}/blobs/${configDigest}`, auth, '*/*')).json();
    const value = {
        ref,
        digest,
        diffIds: config.rootfs?.diff_ids ?? [],
        env: envMap(config.config?.Env),
        labels: config.config?.Labels ?? {},
        created: config.created ?? null,
    };
    if (digest) resolved.set(digest, value);
    return value;
}

export function envMap(list = []) {
    const out = {};
    for (const line of list ?? []) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
}

/**
 * Whether `local` (an image's RootFS.Layers) is built on `base` (a tag's
 * diff ids). A pulled image matches exactly; one built FROM it starts with
 * exactly its layers and adds its own after. Anything else means the tag has
 * moved since the image was made.
 */
export function builtOn(local = [], base = []) {
    if (!base.length || local.length < base.length) return false;
    return base.every((id, i) => local[i] === id);
}
