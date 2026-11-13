import fs from 'node:fs';
import path from 'node:path';
import { docker } from './dockerctl.js';
import { STACK_LOCAL } from './paths.js';
import * as apps from './apps.js';
import * as lifecycle from './lifecycle.js';
import * as selfservice from './selfservice.js';

/**
 * Looks for updates by itself, so nobody has to remember to go and ask.
 *
 * Hourly costs little. Docker Hub does not count a HEAD of a tag as a pull, and
 * the counted requests only happen once per new image (see registry.js). GitHub
 * allows 60 requests an hour per address and a scan makes about three.
 *
 * This only ever notices. Updating restarts things, so that stays a person's
 * decision: the banner says what is waiting and goes to the page that does it.
 */
const SCAN_EVERY_MS = 60 * 60_000;
const FIRST_SCAN_MS = 15_000;

/** What the banner shows, by service. Something with nothing to say has no entry. */
const found = new Map();

let log = () => {};

/** Which source the panel follows: wherever it was last installed from. */
function panelSource() {
    const last = selfservice.lastUpdate();
    return { repo: last?.repo || selfservice.STACK_REPO, ref: last?.ref || 'main' };
}

/**
 * Whether Family Hub's files are missing from the stack directory.
 *
 * It moved into this repository, and the update that brought that news was run
 * by the panel before it, whose list of folders to copy had no familyhub/ in
 * it. One more update, run by this panel, brings it -- so until then the panel
 * is not up to date, whatever the commit says.
 */
const familyHubMissing = () => !fs.existsSync(path.join(STACK_LOCAL, 'familyhub'));
const FAMILY_HUB_NOTE = 'Family Hub moved into the control panel. Update the panel once more to bring its files in and rebuild it.';

function notePanel(r) {
    const last = selfservice.lastUpdate();
    if (r.upToDate === true) return found.delete('panel');

    const behind = r.compare?.behind ? ` · ${r.compare.behind} commit${r.compare.behind === 1 ? '' : 's'} behind` : '';
    let head = 'Control panel update available';
    let detail = r.unfinished || `${r.latest.shortSha}${behind}\n${r.latest.message}`;
    if (last && !last.ok) {
        head = 'The last control panel update failed';
        detail = last.error || 'No reason was recorded.';
    } else if (r.upToDate === null) {
        // Not a claim that it is behind, which nothing here can know. Installs
        // made before the installer recorded a commit stay here until one update.
        head = 'Control panel version unknown';
        detail = 'This install has no recorded version, so the panel cannot tell whether it is behind. Updating once fixes that.';
    }
    found.set('panel', {
        key: 'panel',
        id: r.latest.sha,
        head,
        detail,
        tab: 'global',
        subtab: 'global-updates',
        ...panelSource(),
    });
}

function noteApp(name, r) {
    if (!r.updateAvailable) return found.delete(name);

    const { label } = apps.APPS[name];
    const major = r.majorChanges?.length > 0;
    let detail;
    if (r.kind === 'image') {
        const changed = (r.versions ?? []).filter((v) => v.running && v.latest && v.running !== v.latest);
        detail = changed.length
            ? changed.map((v) => `${v.label} ${v.running} → ${v.latest}`).join(' · ')
            : 'A rebuilt image with the same version numbers, usually for security fixes underneath.';
        if (major) detail += '\nA new major version cannot be rolled back, so read the release notes first.';
    } else {
        detail = `${r.shortSha}\n${r.message}`;
    }
    found.set(name, {
        key: name,
        id: r.digest ?? r.latestSha,
        head: `${major ? 'Major ' : ''}${label} update available`,
        detail,
        major,
        tab: name,
        subtab: `${name}-updates`,
    });
}

/**
 * The answer about one app. The Check button and the scan both come through
 * here, so the banner and the Updates tab cannot disagree.
 */
export async function checkApp(name) {
    // Every app is made from a Docker Hub image: pulled as it is, or the base
    // of the one built here. "Up to date" means built on what that tag points
    // at now. Family Hub's own code comes with the panel, so it is the panel's
    // update that brings a new version of that.
    const result = { kind: 'image', ...(await apps.checkBaseImage(name, docker)) };
    noteApp(name, result);
    return result;
}

/** The answer about the panel, from any source; only the one it follows reaches the banner. */
export async function checkPanel({ repo, ref }) {
    const latest = await selfservice.latestCommit({ repo, ref });
    const installed = selfservice.lastUpdate();
    // Only meaningful once something has recorded which commit is installed. A
    // failed update records the commit it was trying for, which is not installed.
    const known = installed?.ok && installed.repo === repo ? installed.sha : null;
    const unfinished = familyHubMissing() ? FAMILY_HUB_NOTE : null;
    const result = {
        latest,
        installedSha: known || null,
        upToDate: unfinished ? false : known ? known === latest.sha : null,
        compare: known ? await selfservice.compareToInstalled({ repo, base: known, head: latest.sha }) : null,
        unfinished,
    };
    const source = panelSource();
    if (source.repo === repo && source.ref === ref) notePanel(result);
    return result;
}

/**
 * What is installed and can be updated. An app switched off in its settings is
 * left out because its Update button refuses, and a banner leading there would
 * be a dead end.
 */
async function scannableApps() {
    const services = await lifecycle.statusAll();
    const cfg = apps.loadAppsConfig();
    return Object.keys(services).filter((name) => services[name].installed && cfg[name]?.enabled);
}

/**
 * One failed check keeps its last answer. Being offline for an hour says nothing
 * about whether an update is still waiting, and is not worth a banner of its own:
 * the Check button still reports the error to anyone who asks.
 */
export async function scan() {
    const results = await Promise.allSettled([
        checkPanel(panelSource()),
        ...(await scannableApps()).map((name) => checkApp(name)),
    ]);
    for (const r of results) {
        if (r.status === 'rejected') log(`update scan: ${r.reason?.message ?? r.reason}`);
    }
}

/** Drops what is known about an app, for when it has just been removed. */
export function forget(name) {
    found.delete(name);
}

/** Looks again straight after something changed what an app is running. */
export async function rescan(name) {
    found.delete(name);
    await checkApp(name).catch((err) => log(`update scan: ${err.message}`));
}

/** What the banner should show now. Read often, so it only ever reads memory and docker. */
export async function pending() {
    const installed = await scannableApps();
    return [...found.values()].filter((item) => item.key === 'panel' || installed.includes(item.key));
}

export function start(logger) {
    log = logger;
    const run = () => scan().catch((err) => log(`update scan: ${err.message}`));
    setTimeout(run, FIRST_SCAN_MS).unref();
    setInterval(run, SCAN_EVERY_MS).unref();
}
