const $ = (id) => document.getElementById(id);
const el = (sel, root = document) => root.querySelector(sel);

// ------------------------------------------------------------------- api ---

async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
        data = await res.json();
    } catch {
        /* empty body */
    }
    if (res.status === 401) {
        showLogin();
        throw new Error('Not signed in.');
    }
    if (!res.ok) {
        const detail = Array.isArray(data.details) ? `\n• ${data.details.join('\n• ')}` : '';
        throw new Error(`${data.error || res.statusText}${detail}`);
    }
    return data;
}

let toastTimer;
function toast(message, kind = '') {
    const node = $('toast');
    node.textContent = message;
    node.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.add('hidden'), kind === 'bad' ? 8000 : 3500);
}

function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

const fmtNum = (n) => (n === null || n === undefined || n === '' ? '–' : Number(n).toLocaleString());

// Container names, domains and log lines come from outside this file, so they
// are untrusted input on their way into innerHTML.
const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtBytes(text) {
    if (!text) return '–';
    return text; // docker already reports a human-readable size
}

function fmtDuration(iso) {
    if (!iso || iso.startsWith('0001')) return '–';
    const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
}

// ------------------------------------------------------------------ auth ---

function showLogin() {
    $('login').classList.remove('hidden');
    $('app').classList.add('hidden');
    stopPolling();
}

function showApp() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    // The heading is static markup until something navigates; seed it from
    // whichever entry starts active so it is not stale on first paint.
    $('page-title').textContent = document.querySelector('.nav-item.active .label').textContent;
    startPolling();
    loadProxies();
    loadApps();
    loadDuckDns();
    connectJobs();
    connectLogs();
}

$('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const err = $('login-error');
    err.hidden = true;
    try {
        await api('/api/login', { method: 'POST', body: { password: $('login-password').value } });
        $('login-password').value = '';
        showApp();
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
});

$('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    showLogin();
});

// --------------------------------------------------------- navigation ---

const SIDEBAR_KEY = 'quickstart-home-sidebar';
const MOBILE = () => window.matchMedia('(max-width: 860px)').matches;

function selectTab(name) {
    let title = name;
    for (const item of document.querySelectorAll('.nav-item')) {
        const active = item.dataset.tab === name;
        item.classList.toggle('active', active);
        // The row carries the highlight so it wraps the switch too.
        item.closest('.nav-row')?.classList.toggle('active', active);
        if (active) title = el('.label', item).textContent;
    }
    for (const tab of document.querySelectorAll('.tab')) {
        tab.classList.toggle('active', tab.id === `tab-${name}`);
    }
    $('page-title').textContent = title;
    // Read on arrival rather than polled: nothing on it changes by itself.
    if (name === 'global') loadGlobal().catch(() => {});
    // On the drawer layout, picking a destination should get out of the way.
    if (MOBILE()) closeDrawer();
}

for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => selectTab(item.dataset.tab));
}

// --- sub-tabs (panels inside one destination) ---

function selectSubtab(section, name) {
    for (const button of section.querySelectorAll('.subtab-btn')) {
        button.classList.toggle('active', button.dataset.subtab === name);
    }
    for (const panel of section.querySelectorAll(':scope > .subtab')) {
        panel.classList.toggle('active', panel.id === `sub-${name}`);
    }
}

for (const button of document.querySelectorAll('.subtab-btn')) {
    button.addEventListener('click', () => selectSubtab(button.closest('section'), button.dataset.subtab));
}

/** The sub-tab currently showing in a section, or null if it has none. */
const activeSubtab = (tab) =>
    document.querySelector(`#tab-${tab} .subtab-btn.active`)?.dataset.subtab ?? null;

// --- service switches in the sidebar ---

const navSwitch = (service) => document.querySelector(`[data-service="${service}"]`);

/**
 * Reflects a service's real state onto its sidebar switch. Never called from a
 * click: the switches show what the containers are doing, so a failed start
 * cannot leave one sitting in the wrong position.
 */
/**
 * The health dot beside a destination.
 *
 * Three states carry meaning and a fourth deliberately does not: a service you
 * switched off is not broken, so it gets a hollow dot rather than a red one.
 * Red is reserved for "you asked for this and it is not there", which is the
 * only case worth walking over to look at.
 */
/**
 * Where a tab's name and its lifecycle key are different words. Empty today --
 * every tab happens to be named after its service -- but the indirection is
 * what stops the next app that isn't from being a special case here.
 */
const HEALTH_KEYS = {};

/**
 * The dot beside a service.
 *
 * Red means installed and not running, which is a thing to look into. Something
 * that was never installed is not unhealthy, and saying so in red sends people
 * looking for a fault in a service they have not asked for yet.
 *
 * Every caller works this out from its own tab's data, and each of them would
 * have to remember to ask whether the thing exists first. Asking here instead
 * means none of them can forget, including the ones written later.
 */
function setNavHealth(tab, state) {
    const dot = document.querySelector(`.nav-dot[data-health="${tab}"]`);
    if (!dot) return;

    const known = serviceState[HEALTH_KEYS[tab] ?? tab];
    if (known && known.installed === false && state !== 'none') state = 'absent';

    dot.className = `nav-dot ${state === 'absent' ? '' : (state ?? '')}`.trim();
    dot.title = {
        ok: 'Running normally',
        warn: 'Running, but not fully ready',
        bad: 'Installed, but not running',
        off: 'Switched off',
        absent: 'Not installed',
        none: '',
    }[state] ?? '';
}

/**
 * Only for switches nothing else owns.
 *
 * The switch means one thing: this container is running. Several screens used
 * to write it from their own saved 'enabled' flag instead -- a tab
 * every five seconds, the apps tab on its own poll -- while loadServices wrote
 * what docker actually reported. A service that is installed and stopped has
 * enabled=true and running=false, so the two pollers took turns and the switch
 * flipped itself back and forth without anybody touching it. It looked exactly
 * like a service starting and stopping on its own.
 *
 * loadServices is the only writer for anything with a container now.
 */
function setNavSwitch(service, on, { disabled = false, reason = '' } = {}) {
    const input = navSwitch(service);
    if (!input || input.dataset.busy === '1') return;
    input.checked = Boolean(on);
    input.disabled = disabled;
    const label = input.closest('.switch');
    if (label) label.title = disabled && reason ? reason : label.getAttribute('aria-title') || label.title;
}

// ------------------------------------------------------- blocking actions ---

/**
 * Installing, starting, stopping and uninstalling take over the screen.
 *
 * They used to run in the background: a toast, and a log in the corner. That
 * reads as though the panel can do several of these at once, and it cannot --
 * there is one docker daemon, and the jobs queue. Clicking a switch while
 * Nextcloud was building put a five-second stop behind a twenty-minute build,
 * which from the outside is indistinguishable from a switch that does nothing.
 *
 * So: one at a time, everything else covered and blurred while it runs, the log
 * in front of you, and no way out until it is finished. Slower to look at, and
 * it never lies about what is happening.
 */
let pendingAction = null;

/**
 * Lines that arrived before we knew which job was ours.
 *
 * The server queues the job and starts streaming it before it answers the
 * request that asked for it, so the first lines of a fast job can beat their
 * own job id back to the browser. Held by id until an action claims them.
 */
const earlyLines = new Map();
const earlyEnds = new Map();

/**
 * How far along the thing in the overlay is.
 *
 * There is no honest single number for "install Nextcloud": it is a docker
 * build, and docker does not know how long it has left any more than we do. What there is, is a log that says what has happened, so the
 * bar is driven entirely by that -- every position it takes is something the
 * job has actually reported, and it only ever moves forwards.
 *
 * Between two reports it stops, because inventing movement is how a progress
 * bar starts lying. The stripes are what say it is still working; the elapsed
 * clock beside it is the other real number on offer.
 */
const ACTION_MARKS = [
    // Our own phase lines, from lifecycle.js and the routes.
    [/^Building /i, 0.04],
    [/^Removing the .* containers/i, 0.2],
    [/^Deleting volume /i, 0.55],
    [/^Keeping \d+ volume/i, 0.55],
    [/^Starting /i, 0.35],
    [/^Stopping /i, 0.35],
    [/^Creating the .* container/i, 0.86],
    [/^Recreating /i, 0.5],
    [/removed: \d+ container/i, 0.95],
    [/is installed and switched off/i, 0.97],

    // Compose's own progress, which is the tail of nearly every job here.
    [/\bPulling fs layer\b|\bPulling\b.*\.\.\.$/i, 0.1],
    [/\bDownload complete\b|\bPull complete\b/i, 0.3],
    [/Container .* (?:Creating|Created)\b/i, 0.9],
    [/Container .* (?:Starting|Started|Running|Stopping|Stopped|Removing|Removed)\b/i, 0.94],
    [/Volume .* (?:Creating|Created|Removing|Removed)\b/i, 0.9],
    [/Network .* (?:Creating|Created)\b/i, 0.88],

    // cargo, at the end of the long one.
    [/Finished `release` profile/i, 0.82],
];

/**
 * BuildKit's own step counter: "#21 [ourbuild 9/9] RUN cargo build --release",
 * and the line that ends a stage: "#22 DONE 1889.6s".
 *
 * Kept per stage. Two of these build in parallel and report interleaved, so
 * reading whichever line arrived last as "the" progress makes the bar jump to
 * whatever the furthest-along stage has reached while the other is barely
 * started. The average across the stages seen is the honest reading.
 */
const BUILDKIT_STEP = /^(#\d+) \[[^\]]*?(\d+)\/(\d+)\]/;
const BUILDKIT_DONE = /^(#\d+) DONE\b/;

let progressTimer = null;

function resetProgress() {
    const bar = $('action-bar');
    const fill = $('action-bar-fill');
    bar.hidden = false;
    bar.className = 'action-bar working';
    bar.setAttribute('aria-valuenow', '0');
    fill.style.width = '0%';

    clearInterval(progressTimer);
    progressTimer = setInterval(tickElapsed, 1000);
    tickElapsed();
}

function setProgress(fraction) {
    if (!pendingAction || pendingAction.finished) return;
    // Forwards only. Two builds run in parallel and report their steps
    // interleaved, so the raw numbers go up and down; a bar that does the same
    // is worse than no bar.
    const next = Math.max(pendingAction.progress ?? 0, Math.min(fraction, 0.99));
    if (next === pendingAction.progress) return;
    pendingAction.progress = next;
    $('action-bar-fill').style.width = `${(next * 100).toFixed(1)}%`;
    $('action-bar').setAttribute('aria-valuenow', String(Math.round(next * 100)));
}

/** Reads one log line for anything that says where the job has got to. */
function progressFromLine(line) {
    if (!pendingAction) return;
    const stages = (pendingAction.stages ??= new Map());

    const step = BUILDKIT_STEP.exec(line);
    const done = BUILDKIT_DONE.exec(line);
    if (step && Number(step[3]) > 0) stages.set(step[1], Number(step[2]) / Number(step[3]));
    else if (done) stages.set(done[1], 1);

    if (step || done) {
        const mean = [...stages.values()].reduce((a, b) => a + b, 0) / stages.size;
        // The build occupies the middle of the bar: something has already
        // happened before the first step, and creating the container still has
        // to happen after the last one.
        return setProgress(0.06 + 0.74 * mean);
    }

    for (const [re, fraction] of ACTION_MARKS) {
        if (re.test(line)) return setProgress(fraction);
    }
}

function tickElapsed() {
    if (!pendingAction) return;
    const seconds = Math.round((Date.now() - pendingAction.startedAt) / 1000);
    const label = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
    $('action-elapsed').textContent = label;
}

function openAction({ key, title, note }) {
    const action = { key, title, jobId: null, finished: false, resolve: null, progress: 0, startedAt: Date.now() };
    action.done = new Promise((resolve) => {
        action.resolve = resolve;
    });
    pendingAction = action;

    $('action-title').textContent = title;
    $('action-note').textContent = note ?? '';
    $('action-log').textContent = '';
    $('action-spinner').hidden = false;
    // Docker can take a few seconds to say anything at all, and an empty black
    // box for those seconds reads as nothing having happened.
    actionAppend(`> ${title}…`);
    // Hidden rather than disabled-and-labelled: the bar says how far along this
    // is, and Cancel is the only thing to press until it finishes.
    const close = $('action-close');
    close.disabled = true;
    close.hidden = true;
    const cancel = $('action-cancel');
    cancel.hidden = true;
    cancel.disabled = false;
    cancel.textContent = 'Cancel';
    resetProgress();
    $('action-overlay').hidden = false;
    return action;
}

function actionAppend(line) {
    const log = $('action-log');
    if (!log) return;
    progressFromLine(line);
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent += `${line}\n`;
    if (atBottom) log.scrollTop = log.scrollHeight;
}

/** Ours, somebody else's, or too early to tell. */
function actionLine(jobId, line) {
    if (!pendingAction || pendingAction.finished) return;
    if (pendingAction.jobId === jobId) return actionAppend(line);
    if (pendingAction.jobId === null) {
        const held = earlyLines.get(jobId) ?? [];
        held.push(line);
        earlyLines.set(jobId, held);
    }
}

/** Takes ownership of a job id, and of anything it printed before we had it. */
function adoptActionJob(jobId) {
    if (!pendingAction) return;
    pendingAction.jobId = jobId;
    // Nothing can be cancelled until there is something to name, and some
    // things are not cancellable at all.
    $('action-cancel').hidden = pendingAction.cancellable === false;
    for (const line of earlyLines.get(jobId) ?? []) actionAppend(line);
    earlyLines.clear();
    const ended = earlyEnds.get(jobId);
    earlyEnds.clear();
    if (ended) finishAction(ended);
}

/** The job is over. Only now is there a way out of this. */
function finishAction(job) {
    if (!pendingAction || pendingAction.finished) return;
    const cancelled = job.status === 'cancelled';
    const ok = job.status === 'succeeded';
    actionAppend(
        cancelled
            ? '\n■ Cancelled. Anything it had already done is still done.'
            : ok
              ? '\n✓ Done.'
              : `\n✗ Failed: ${job.error ?? 'it did not finish'}`,
    );

    pendingAction.finished = true;
    $('action-spinner').hidden = true;
    $('action-cancel').hidden = true;
    $('action-title').textContent = `${pendingAction.title} — ${cancelled ? 'cancelled' : ok ? 'done' : 'failed'}`;

    // Full either way: the bar tracks the job reaching its end, not the job
    // succeeding. Which of those happened is the colour, the title and the last
    // line of the log.
    clearInterval(progressTimer);
    progressTimer = null;
    tickElapsed();
    $('action-bar').className = `action-bar${ok || cancelled ? '' : ' failed'}`;
    $('action-bar-fill').style.width = '100%';
    $('action-bar').setAttribute('aria-valuenow', '100');

    const close = $('action-close');
    close.disabled = false;
    close.hidden = false;
    close.focus();
    // Resolved rather than rejected even when the job failed: every caller
    // wants to know how it went, and none of them want an exception for a
    // container that would not start.
    pendingAction.resolve({ ...job, ok });
}

/** Called by the job stream when any job ends, ours or not. */
function actionJobEnded(job) {
    if (!pendingAction || pendingAction.finished) return;
    if (pendingAction.jobId === job.id) return finishAction(job);
    // A job that failed before its request came back -- 'no such service' is
    // instant. Held, or the overlay waits forever for a job that is over.
    if (pendingAction.jobId === null) earlyEnds.set(job.id, job);
}

/** Jobs the overlay has been closed on, so a reconnect does not reopen them. */
const dismissedJobs = new Set();

function closeAction() {
    if (!pendingAction?.finished) return;
    if (pendingAction.jobId) dismissedJobs.add(pendingAction.jobId);
    clearInterval(progressTimer);
    progressTimer = null;
    $('action-overlay').hidden = true;
    pendingAction = null;
    earlyLines.clear();
    earlyEnds.clear();

    // What exists, what is running and what every tab shows can all have
    // changed while this was on screen. Failures here are the panel not
    // knowing something yet, which the next poll fixes.
    for (const reload of [loadServices, refreshStatus, loadApps, loadProxies, loadPublish]) {
        Promise.resolve(reload()).catch(() => {});
    }
}

$('action-close').addEventListener('click', closeAction);

// Escape is the usual way out of a dialog, and here it must not be one until
// the job has finished. Capturing, so nothing else sees the key first.
document.addEventListener(
    'keydown',
    (event) => {
        if (!pendingAction) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (pendingAction.finished) closeAction();
            return;
        }
        // The overlay stops the mouse reaching the page behind it; tab does not
        // care about overlays, so focus is put back by hand.
        if (event.key === 'Tab') {
            const card = el('.action-card');
            if (card && !card.contains(document.activeElement)) {
                event.preventDefault();
                $('action-close').focus();
            }
        }
    },
    true,
);



/**
 * For the one action that ends by removing the panel.
 *
 * Nothing will ever report that it finished, because the thing that would do
 * the reporting is what gets removed. So the panel going quiet is the signal,
 * and it is confirmed rather than assumed: two failed health checks in a row,
 * three seconds apart, so a single dropped request does not declare the stack
 * gone while it is still working.
 */
function watchForPanelGone() {
    let misses = 0;
    const timer = setInterval(async () => {
        if (!pendingAction?.terminal || pendingAction.finished) return clearInterval(timer);
        try {
            const res = await fetch('/healthz', { cache: 'no-store' });
            if (res.ok) {
                misses = 0;
                return;
            }
            misses += 1;
        } catch {
            misses += 1;
        }
        if (misses < 2) return;

        clearInterval(timer);
        actionAppend('');
        actionAppend('The panel has been removed, so there is nothing left here to report from.');
        actionAppend('The last steps -- its own image, the network and the install directory -- finish in the container doing the removing.');
        finishAction({ status: 'succeeded' });
    }, 3000);
}

/**
 * Stop the job the overlay is watching.
 *
 * Confirmed, and the confirmation is the honest part: cancelling does not
 * rewind. A build keeps the layers it finished, an uninstall does not put back
 * what it removed, and a container that was half-way up is left wherever the
 * kill found it. What it buys is not spending the next half hour on something
 * you no longer want.
 */
$('action-cancel').addEventListener('click', async () => {
    const action = pendingAction;
    if (!action?.jobId || action.finished) return;
    if (
        !confirm(
            `Cancel "${action.title}"?\n\n` +
                'Whatever it has already done stays done -- this stops it where it is rather than undoing it. ' +
                'A build keeps the parts it finished, so starting again does not start from the beginning.',
        )
    ) {
        return;
    }

    const button = $('action-cancel');
    button.disabled = true;
    button.textContent = 'Cancelling…';
    try {
        await api(`/api/jobs/${action.jobId}/cancel`, { method: 'POST' });
    } catch (e) {
        // It finished on its own between the click and the request, most
        // likely. The end event says which, so this only reports and waits.
        actionAppend(`Could not cancel: ${e.message}`);
        button.disabled = false;
        button.textContent = 'Cancel';
    }
});

/**
 * Runs one of them: opens the overlay, starts the job, and resolves when the
 * job has finished -- not when the overlay is dismissed, which is the user's
 * own time and nothing should wait for it.
 */
async function runAction({ key, title, note, request, cancellable = true, terminal = false }) {
    if (pendingAction) {
        toast('Something else is running. Wait for it to finish.', 'bad');
        return null;
    }
    const action = openAction({ key, title, note });
    // Some things must not be stopped half way. Removing everything is the one:
    // it deletes the panel itself, so a cancel would land on a stack that is
    // partly gone with nothing left to finish taking it apart.
    action.cancellable = cancellable;
    // And this one ends by taking the panel away, so the log stopping is the
    // result rather than a fault.
    action.terminal = terminal;
    if (terminal) watchForPanelGone();

    let response;
    try {
        response = await request();
    } catch (e) {
        finishAction({ status: 'failed', error: e.message });
        return action.done;
    }

    // Something that finished inside the request itself, with no job to watch.
    // "Already on the newest version" is a real answer, and an overlay that
    // only ever says Done would hide it.
    if (!response?.jobId) {
        if (response?.message) actionAppend(response.message);
        finishAction({ status: 'succeeded' });
        return action.done;
    }
    adoptActionJob(response.jobId);
    return action.done;
}

const ACTION_VERBS = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' };

// Each service is switched on in whatever way its own API expects.
/**
 * What a switch does now: start or stop, and nothing else.
 *
 * It used to enable and disable, which for every container service meant
 * building on the way up and removing the container on the way down -- so
 * "off" and "never installed" were the same state, and an hour of building was
 * one careless click from gone. Installing and removing are their own actions
 * now, with their own buttons.
 */
const start = (key) => (on) => api(`/api/services/${key}/${on ? 'start' : 'stop'}`, { method: 'POST' });

const SERVICE_ACTIONS = {
    nextcloud: start('nextcloud'),
    proxy: start('proxy'),
};

const SERVICE_NAMES = {
    nextcloud: 'Nextcloud',
    proxy: 'the reverse proxy',
};

for (const input of document.querySelectorAll('[data-service]')) {
    input.addEventListener('change', async () => {
        const service = input.dataset.service;
        const wanted = input.checked;
        const name = SERVICE_NAMES[service] ?? service;

        // Held across the whole action so the status poll cannot flip the
        // switch back and forth underneath what is happening.
        input.dataset.busy = '1';
        input.disabled = true;

        const job = await runAction({
            key: service,
            title: `${wanted ? 'Starting' : 'Stopping'} ${name}`,
            note: wanted
                ? 'Starting a container that already exists is quick. Nothing is rebuilt.'
                : 'The container stops and keeps everything: its data, its image, and the container itself.',
            request: () => SERVICE_ACTIONS[service](wanted),
        });

        // Setting .checked does not fire change, so putting the switch back is
        // not another request.
        if (!job?.ok) input.checked = !wanted;
        input.dataset.busy = '0';
        input.disabled = false;
    });
}

// --- collapse (wide screens) ---

function setCollapsed(collapsed) {
    const sidebar = $('sidebar');
    sidebar.classList.toggle('collapsed', collapsed);
    const toggle = $('sidebar-toggle');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
    } catch {
        /* private browsing; the preference just will not persist */
    }
}

$('sidebar-toggle').addEventListener('click', () => setCollapsed(!$('sidebar').classList.contains('collapsed')));

try {
    if (localStorage.getItem(SIDEBAR_KEY) === 'collapsed') setCollapsed(true);
} catch {
    /* no stored preference */
}

// --- drawer (narrow screens) ---

function openDrawer() {
    $('sidebar').classList.add('open');
    $('sidebar-scrim').hidden = false;
}
function closeDrawer() {
    $('sidebar').classList.remove('open');
    $('sidebar-scrim').hidden = true;
}

$('sidebar-open').addEventListener('click', openDrawer);
$('sidebar-scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
});
// Leaving the drawer width with the drawer "open" would strand the scrim.
window.addEventListener('resize', () => {
    if (!MOBILE()) closeDrawer();
});

// --------------------------------------------------------------- overview ---

/**
 * The landing page is about the machine, not about any one app.
 *
 * A home server has no single number worth putting in the middle of a screen,
 * so this is the short honest list: how much disk and memory are left, how long
 * it has been up, and which of the stack's containers are actually running.
 * Disk first, because filling it up is the thing that actually goes wrong.
 */
let pollTimer = null;
const startPolling = () => {
    refreshStatus();
    if (!pollTimer) pollTimer = setInterval(refreshStatus, 4000);
};
const stopPolling = () => {
    clearInterval(pollTimer);
    pollTimer = null;
};

// The manager's process id for this run. A change means it restarted with
// different code underneath this tab.
let bootId = null;

/**
 * Reloads the page when the manager comes back as a different process, which is
 * what makes an edit under `dev.sh watch` appear without touching the browser,
 * and what stops a tab surviving a panel update from talking to an API it no
 * longer matches.
 *
 * It waits for a quiet moment first. Reloading out from under a half-typed form
 * or an open dialog would cost more than the staleness does, and the next poll
 * is four seconds away.
 */
function reloadIfManagerRestarted(id) {
    if (!id) return false;
    if (bootId === null) {
        bootId = id;
        return false;
    }
    if (id === bootId) return false;

    const typing = document.activeElement;
    const busy =
        document.querySelector('dialog[open]') ||
        (typing && ['INPUT', 'TEXTAREA', 'SELECT'].includes(typing.tagName));
    if (busy) return false;

    location.reload();
    return true;
}

/** Bytes as something a person reads, which docker's own strings are not. */
function humanBytes(bytes) {
    if (!Number.isFinite(bytes)) return '–';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function fmtUptime(seconds) {
    if (!Number.isFinite(seconds)) return '–';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
}

/**
 * A usage meter. Amber at 75 and red at 90 rather than a single colour, because
 * the whole point of showing a disk bar on a file server is the warning.
 */
function renderMeter(prefix, stats, label) {
    const pct = stats?.percentUsed;
    const bar = $(`${prefix}-bar`);
    const text = $(`${prefix}-pct`);
    const detail = $(`${prefix}-detail`);
    if (!bar || !text || !detail) return;

    if (!stats || !Number.isFinite(pct)) {
        text.textContent = '–';
        bar.style.width = '0%';
        bar.className = 'meter-fill';
        detail.textContent = `${label} could not be read.`;
        return;
    }

    text.textContent = `${pct}%`;
    bar.style.width = `${pct}%`;
    bar.className = `meter-fill${pct >= 90 ? ' bad' : pct >= 75 ? ' warn' : ''}`;
    detail.textContent = `${humanBytes(stats.free)} free of ${humanBytes(stats.total)}`;
}

function renderContainers(list) {
    const body = $('ov-containers');
    if (!body) return;

    if (!list?.length) {
        body.innerHTML = '<tr><td colspan="3" class="muted">Nothing installed yet.</td></tr>';
        return;
    }

    body.innerHTML = list
        .map((c) => {
            const word = !c.exists ? 'not installed' : c.running ? 'running' : c.status === 'restarting' ? 'restarting' : 'stopped';
            const tone = !c.exists ? 'off' : c.running ? 'ok' : 'bad';
            // A container with no HEALTHCHECK reports null, which is not a
            // problem and should not read as one.
            const health = c.running && c.health && c.health !== 'healthy' ? ` (${escapeHtml(c.health)})` : '';
            return `<tr>
                <td>${escapeHtml(c.label)}</td>
                <td><span class="tag ${tone}">${word}${health}</span></td>
                <td class="muted">${c.running && c.startedAt ? `up ${fmtDuration(c.startedAt)}` : '–'}</td>
            </tr>`;
        })
        .join('');
}

async function refreshStatus() {
    let s;
    try {
        s = await api('/api/status');
    } catch {
        return;
    }
    if (reloadIfManagerRestarted(s.bootId)) return;

    const h = s.host ?? {};
    $('ov-hostname').textContent = h.hostname ?? '–';
    $('ov-platform').textContent = `${h.platform ?? '–'} (${h.arch ?? '?'})`;
    $('ov-cpus').textContent = h.cpus ? `${h.cpus} cores` : '–';
    $('ov-uptime').textContent = fmtUptime(h.uptime);
    // One minute, five, fifteen -- the three the kernel reports, in that order.
    $('ov-load').textContent = h.loadAverage?.length ? h.loadAverage.join('  ') : '–';

    renderMeter('ov-disk', h.disk, 'Disk usage');
    renderMeter('ov-mem', h.memory, 'Memory');
    renderContainers(h.containers);

    // The two dots that are not an app: the proxy has its own switch, and the
    // panel itself is always up if this line is running at all.
    const proxy = s.services?.proxy;
    setNavHealth('proxy', !proxy?.installed ? 'absent' : proxy.running ? 'ok' : 'bad');
}

// ------------------------------------------------------------------- apps ---

let appsState = null;

async function loadApps() {
    const r = await api('/api/apps');
    appsState = r;
    const c = r.config;

    // Defaults here as well as on the server. This whole function is one long
    // sequence of assignments, so a single missing key used to throw and leave
    // every field below it unpopulated, which the next save then posted back as
    // empty values. Nothing in here should be able to do that again.
    $('nextcloud-pub-web').checked = c.nextcloud?.publish?.web !== false;
    $('nextcloud-port').value = c.nextcloud?.hostPort ?? 8080;
    $('nextcloud-user').value = c.nextcloud?.adminUser ?? 'admin';
    $('nextcloud-domains').value = c.nextcloud?.trustedDomains ?? 'localhost';
    renderAppState('nextcloud', r.apps.nextcloud);
    loadNextcloudAdmin();

    // --- Jellyfin ---
    $('jellyfin-pub-web').checked = c.jellyfin?.publish?.web !== false;
    $('jellyfin-port').value = c.jellyfin?.hostPort ?? 8096;
    $('jellyfin-hwaccel').checked = Boolean(c.jellyfin?.hardwareAcceleration);
    // Held in a variable rather than read back off the DOM: the list is rows of
    // text with a remove button each, and rebuilding it from the config on
    // every render is what keeps the two from drifting.
    mediaPaths = [...(c.jellyfin?.mediaPaths ?? [])];
    renderMediaPaths();
    renderAppState('jellyfin', r.apps.jellyfin);

    for (const app of APP_KEYS) {
        const running = Boolean(r.apps[app]?.container?.running);
        setNavHealth(app, !c[app]?.enabled ? 'off' : running ? 'ok' : 'bad');
    }
}

/** Every app with a tab of its own. The loops below are driven by this. */
const APP_KEYS = ['nextcloud', 'jellyfin'];

/**
 * The message for an app that is switched on but has no container. Saying
 * "starting up" is right while it is still working and wrong once it has given
 * up, and a build that fails leaves exactly that second state behind, so the
 * outcome of the last attempt is what decides which one you get.
 */
function startFailure(state) {
    if (state.lastRun?.ok !== false) return null;
    const reason = (state.lastRun.error || '').trim();
    return `Could not start. ${reason ? `${reason} ` : ''}The full output is under All logs; switching it off and on again retries.`;
}

/**
 * The one word a status badge shows, and it comes from the container.
 *
 * Three states somebody can act on -- nothing there, there but stopped, up --
 * said in the panel's own words. Docker's own vocabulary leaks otherwise: a
 * container somebody switched off reports "exited", which is true, is not what
 * they did, and sits oddly next to a switch labelled off.
 */
function containerWord(container) {
    if (!container?.exists) return 'not installed';
    if (container.running) return 'running';
    if (container.status === 'restarting') return 'restarting';
    return 'stopped';
}

/**
 * What to say about an app that has no link to offer.
 *
 * Driven by the container and never by the saved `enabled` flag. That flag is
 * what separates stopped from uninstalled, so it stays true across a stop --
 * and reading it as "this is meant to be up" is how a service somebody had
 * switched off spent the whole time claiming to be starting up.
 */
function appStatusNote(state, { absent, stopped }) {
    const container = state.container ?? {};
    if (!container.exists) return { text: absent, bad: false };
    // A container that exists, is not running, and failed the last time it was
    // asked to. Not the same as one that was switched off.
    const failure = startFailure(state);
    if (failure) return { text: failure, bad: true };
    if (container.status === 'restarting') {
        return { text: 'Restarting. If it keeps doing this, All logs says why.', bad: true };
    }
    // Every caller shows a link instead of reaching this, but a helper whose
    // answer depends on that is one refactor away from saying "not running"
    // about something that is.
    if (container.running) return { text: 'Running.', bad: false };
    return { text: stopped, bad: false };
}

function renderAppState(name, state) {
    const badge = $(`${name}-state`);
    const container = state.container ?? {};
    const running = container.running;
    badge.textContent = containerWord(container);
    badge.className = `tag ${!container.exists ? 'off' : running ? 'ok' : ''}`;

    const notice = $(`${name}-notice`);
    if (state.blockers?.length) {
        notice.hidden = false;
        notice.className = 'verdict bad';
        notice.textContent = state.blockers.join(' ');
    } else {
        notice.hidden = true;
    }

    if (name === 'nextcloud') {
        const link = $('nextcloud-link');
        const cfg = appsState.config.nextcloud;
        link.hidden = false;
        if (running && cfg.publish.web) {
            const url = `http://${location.hostname}:${cfg.hostPort}`;
            link.className = 'verdict ok';
            link.innerHTML = `<a href="${url}" target="_blank" rel="noreferrer noopener">${escapeHtml(url)} ↗</a>`;
        } else if (running) {
            link.className = 'verdict';
            link.textContent =
                'Running, but not published on the host. Reach it through a proxy host, or tick "Publish on the host" under Settings.';
        } else {
            const note = appStatusNote(state, {
                absent: 'Not installed yet. Installing builds it and leaves it switched off.',
                stopped: 'Not running. Its switch in the sidebar starts it.',
            });
            link.className = note.bad ? 'verdict bad' : 'verdict';
            link.textContent = note.text;
        }

        // What is running, and when the image behind it was built. The version
        // is only knowable while it is up, and the build date is only useful
        // once there is one, so this says whichever parts are actually true.
        const build = $('nextcloud-build');
        const parts = [];
        if (state.version) parts.push(`Running Nextcloud ${state.version}`);
        if (state.build?.builtAt) {
            parts.push(`${parts.length ? 'i' : 'I'}mage built ${new Date(state.build.builtAt).toLocaleString()}`);
        }
        build.textContent = parts.length ? `${parts.join(', ')}.` : 'Not built yet.';
    }

    if (name === 'jellyfin') {
        const link = $('jellyfin-link');
        const cfg = appsState.config.jellyfin ?? {};
        link.hidden = false;
        if (running && cfg.publish?.web) {
            // location.hostname rather than localhost: the panel is often open
            // from another machine on the network, and localhost would send
            // that browser to itself.
            const url = `http://${location.hostname}:${cfg.hostPort}`;
            link.className = 'verdict ok';
            link.innerHTML = `<a href="${url}" target="_blank" rel="noreferrer noopener">${escapeHtml(url)} ↗</a>`;
        } else if (running) {
            link.className = 'verdict';
            link.textContent =
                'Running, but not published on the host. Reach it through a domain on the proxy, or tick "Publish on the host" under Settings.';
        } else {
            const note = appStatusNote(state, {
                absent: 'Not installed yet. Installing downloads the image and leaves it switched off.',
                stopped: 'Not running. Its switch in the sidebar starts it.',
            });
            link.className = note.bad ? 'verdict bad' : 'verdict';
            link.textContent = note.text;
        }

        // No media folders is not an error, but it is the reason an otherwise
        // working Jellyfin shows an empty library, so it is said out loud.
        const notice = $('jellyfin-notice');
        if (!state.blockers?.length && !(cfg.mediaPaths ?? []).length) {
            notice.hidden = false;
            notice.className = 'verdict';
            notice.textContent =
                'No media folders yet, so Jellyfin has nothing to show. Add them under Settings and it will find them.';
        }

        const build = $('jellyfin-build');
        build.textContent = state.build?.builtAt
            ? `Image downloaded ${new Date(state.build.builtAt).toLocaleString()}.`
            : 'Not installed yet.';

        // Said before the checkbox is ticked rather than after: a machine with
        // no render device cannot do this, and finding that out from a
        // container that will not start is a bad way to learn it.
        const gpu = $('jellyfin-hwaccel-note');
        const box = $('jellyfin-hwaccel');
        if (state.gpuAvailable === false) {
            gpu.hidden = false;
            gpu.className = 'verdict';
            gpu.textContent =
                'No /dev/dri on this machine, so there is no GPU to hand over. Jellyfin will transcode on the processor, which works and is only slower.';
            box.disabled = true;
            box.checked = false;
        } else if (state.gpuAvailable === true) {
            gpu.hidden = false;
            gpu.className = 'verdict ok';
            gpu.textContent = 'This machine has a render device, so hardware transcoding is available.';
            box.disabled = false;
        } else {
            gpu.hidden = true;
            box.disabled = false;
        }
    }
}

// --- jellyfin media folders ---

/**
 * The media folder list, held here rather than read back out of the DOM.
 *
 * Each row is a path and a button that removes it, so the list is the state and
 * the rows are a picture of it. Rebuilding the rows from this on every change
 * is what stops the two from disagreeing.
 */
let mediaPaths = [];

function renderMediaPaths() {
    const list = $('jellyfin-media-list');
    if (!list) return;

    if (!mediaPaths.length) {
        list.innerHTML = '<p class="muted">No folders yet.</p>';
        return;
    }
    list.innerHTML = mediaPaths
        .map(
            (path, i) => `<div class="media-row">
                <code>${escapeHtml(path)}</code>
                <button type="button" class="ghost mini" data-media-remove="${i}" title="Remove this folder">Remove</button>
            </div>`,
        )
        .join('');
}

function addMediaPath() {
    const box = $('jellyfin-media-new');
    // Trailing slashes are stripped so /srv/Films and /srv/Films/ cannot both
    // be added as though they were two different folders.
    const path = box.value.trim().replace(/\/+$/, '');
    if (!path) return;
    if (!path.startsWith('/')) return toast('Give the full path, starting with a /.', 'bad');
    if (mediaPaths.includes(path)) return toast('That folder is already on the list.', 'bad');

    mediaPaths.push(path);
    box.value = '';
    renderMediaPaths();
    // Nothing is saved until Apply, so say so rather than let the row imply it.
    toast('Added. Press Apply settings to mount it.');
}

$('jellyfin-media-add').addEventListener('click', addMediaPath);
$('jellyfin-media-new').addEventListener('keydown', (event) => {
    // Enter in a lone text box would submit nothing and look like it did.
    if (event.key === 'Enter') {
        event.preventDefault();
        addMediaPath();
    }
});

$('jellyfin-media-list').addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-media-remove]');
    if (!button) return;
    mediaPaths.splice(Number(button.dataset.mediaRemove), 1);
    renderMediaPaths();
});

function collectAppConfig(name) {
    if (name === 'jellyfin') {
        return {
            enabled: Boolean(appsState?.config?.jellyfin?.enabled),
            publish: { web: $('jellyfin-pub-web').checked },
            hostPort: Number($('jellyfin-port').value),
            mediaPaths: [...mediaPaths],
            hardwareAcceleration: $('jellyfin-hwaccel').checked,
        };
    }
    if (name !== 'nextcloud') return {};
    return {
        enabled: Boolean(appsState?.config?.nextcloud?.enabled),
        // The image is built from the local Dockerfile, so there is no branch to
        // pick. Sent unchanged so a save cannot drop it.
        ref: appsState?.config?.nextcloud?.ref ?? 'main',
        publish: { web: $('nextcloud-pub-web').checked },
        hostPort: Number($('nextcloud-port').value),
        adminUser: $('nextcloud-user').value.trim(),
        trustedDomains: $('nextcloud-domains').value.trim(),
    };
}

// --- nextcloud admin password ---

/**
 * The install-time password, shown because there is nowhere else to find it
 * short of reading the stack's .env by hand. Masked until asked for, so it is
 * not left sitting on screen.
 */
async function loadNextcloudAdmin() {
    try {
        const r = await api('/api/apps/nextcloud/admin');
        $('nextcloud-pass').value = r.password || '';
        $('nextcloud-pass').placeholder = r.password ? '' : 'not set yet';
    } catch {
        /* the card is only useful once the stack has been installed */
    }
}

$('nextcloud-pass-show').addEventListener('click', () => {
    const box = $('nextcloud-pass');
    const hidden = box.type === 'password';
    box.type = hidden ? 'text' : 'password';
    $('nextcloud-pass-show').textContent = hidden ? 'Hide' : 'Show';
});

$('nextcloud-pass-copy').addEventListener('click', async () => {
    const value = $('nextcloud-pass').value;
    if (!value) return toast('There is no password to copy yet.', 'bad');
    try {
        await navigator.clipboard.writeText(value);
        toast('Password copied.');
    } catch {
        // Clipboard access needs a secure context, which plain http on another
        // machine is not. Selecting it is then the only way to get at it.
        $('nextcloud-pass').type = 'text';
        $('nextcloud-pass').select();
        toast('Could not reach the clipboard, so it is selected instead.', 'bad');
    }
});

$('nextcloud-pass-save').addEventListener('click', async () => {
    const box = $('nextcloud-pass-new');
    const password = box.value;
    if (password.length < 10) return toast('Nextcloud needs at least 10 characters.', 'bad');

    const button = $('nextcloud-pass-save');
    button.disabled = true;
    try {
        await api('/api/apps/nextcloud/admin/password', { method: 'POST', body: { password } });
        box.value = '';
        toast('Password changed.');
        loadNextcloudAdmin();
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        button.disabled = false;
    }
});

for (const name of APP_KEYS) {
    // The switch is a power control: it takes effect on the spot. Everything
    // that needs an explicit Apply stays a checkbox.
    $(`${name}-save`).addEventListener('click', async () => {
        const err = $(`${name}-error`);
        err.hidden = true;
        try {
            await api(`/api/apps/${name}`, { method: 'PUT', body: { config: collectAppConfig(name) } });
            setTimeout(loadApps, 2000);
        } catch (e) {
            err.textContent = e.message;
            err.hidden = false;
        }
    });

    $(`${name}-update`).addEventListener('click', async () => {
        if (!confirm('Rebuild Nextcloud on the newest base image?\n\nIt will be unavailable while it rebuilds. Your files are not touched.')) return;
        await runAction({
            key: name,
            title: `Rebuilding ${appsState?.apps?.[name]?.label ?? name}`,
            note: 'Pulls the newest Nextcloud image and rebuilds on top of it. It is unavailable until this finishes, and a build that fails leaves the running one alone.',
            request: () => api(`/api/apps/${name}/update`, { method: 'POST' }),
        });
    });
}

// Restart, and whatever else gets one of these later. The same container
// actions as the sidebar switches, so they get the same overlay.
for (const button of document.querySelectorAll('[data-app-action]')) {
    button.addEventListener('click', async () => {
        const [name, action] = button.dataset.appAction.split('/');
        const verb = ACTION_VERBS[action] ?? action;
        await runAction({
            key: name,
            title: `${verb} ${appsState?.apps?.[name]?.label ?? name}`,
            note: 'Nothing is rebuilt and nothing is removed.',
            request: () => api(`/api/apps/${button.dataset.appAction}`, { method: 'POST' }),
        });
    });
}

// ---------------------------------------------------------------- proxies ---

let proxies = [];
// The kinds a proxy host can forward to, as the server defines them. The dialog
// used to carry its own copy in markup, which went stale the moment the apps
// became targets: editing a Nextcloud host showed an empty "Forwards to".
let targetKinds = {};

async function loadProxies() {
    const r = await api('/api/proxies');
    proxies = r.proxies;
    targetKinds = r.targets ?? {};

    // Reflect whether the proxy is running before anything else: with it off,
    // adding a host would write config nothing is serving.
    const on = Boolean(r.enabled);
    const badge = $('proxy-state');
    badge.textContent = containerWord(r.container);
    badge.className = `tag ${!r.container?.exists ? 'off' : r.container.running ? 'ok' : ''}`;
    // The dot follows the container, not the saved setting: with the proxy
    // installed and stopped this used to stay green, and disagree with the
    // services poll writing the same dot from what docker says.
    setNavHealth('proxy', r.container?.running ? 'ok' : on ? 'bad' : 'off');

    // With the proxy off, the settings are not just unusable, they are
    // misleading: a saved host writes nginx config nothing is serving. So the
    // page says what to do rather than showing controls that cannot work.
    $('proxy-config').hidden = !on;

    // With nothing else on the page, a full-width card of two sentences is
    // mostly empty space; narrowed and centred it reads as the one thing there
    // is to do. It goes back to full width once the settings are under it.
    $('tab-proxy').classList.toggle('alone', !on);

    for (const id of ['proxy-reload', 'proxy-renew', 'dd-now']) {
        const button = $(id);
        button.disabled = !on;
        button.title = on ? '' : 'Turn the reverse proxy on first.';
    }

    // The one table on this page is the service view, which reads the same
    // proxy list back from its own endpoint.
    await loadPublish();
}

// ------------------------------------------------- services and domains ---

/**
 * The whole of this page. It asks "what do you want reachable" rather than
 * "what is an upstream", and the wizard behind the Set up button answers every
 * other question -- the name, the DNS record, the certificate, whatever the
 * service needs switched on -- so that nobody has to learn nginx to publish a
 * node. The proxy-host dialog is still here for the details, reached from a
 * published row rather than from a screen of its own.
 */
let publishState = { services: [], domains: [] };

async function loadPublish() {
    try {
        publishState = await api('/api/publish');
        if (publishState.publicPorts) {
            const p = publishState.publicPorts;
            $('ports-http').value = p.http;
            $('ports-https').value = p.https;
            $('ports-bind-http').value = p.bindHttp;
            $('ports-bind-https').value = p.bindHttps;
            $('panel-port').value = p.panel;
            $('panel-port-state').textContent = `This panel answers on port ${p.panel}. The reverse proxy holds ${p.bindHttp} and ${p.bindHttps} on this machine.`;
        }
    } catch {
        // The proxy card above already reports anything that is actually wrong.
        return;
    }
    renderPublishServices();
}

/** What a target kind reads as, for "in use by" and for taken-domain options. */
const serviceLabel = (kind) => publishState.services.find((s) => s.kind === kind)?.label ?? 'another proxy host';

function renderPublishServices() {
    const { services, domains } = publishState;

    $('publish-body').innerHTML = services
        .map((s) => {
            // The proxy host behind this row, and the domain record behind
            // that. Both are read all over the cells below, so they are worked
            // out once, first: a `const` further down would be in the temporal
            // dead zone for everything above it, and the row would throw.
            const proxy = proxies.find((p) => p.id === s.proxyId);
            const record = domains.find((d) => d.domain === s.domain);

            // "not running" is a state, not a problem: a domain can be assigned
            // now and answer when the service is started. "unavailable" is the
            // one that means the panel will refuse.
            const status = s.blocked
                ? `<span class="tag off" title="${escapeHtml(s.reason)}">unavailable</span>`
                : s.ready
                  ? '<span class="tag ok">ready</span>'
                  : `<span class="tag" title="${escapeHtml(s.reason ?? '')}">not running</span>`;

            // Certificate life is on screen rather than in an e-mail nobody
            // asked for. Renewal is automatic, so this is a check, not a chore.
            const days = record?.expiry?.daysLeft;
            const https = Number.isFinite(days)
                ? `<span class="tag ${days <= 14 ? 'warn' : 'ok'}" title="The certificate renews automatically about a month before this.">https, ${days}d left</span>`
                : record?.ssl?.mode === 'letsencrypt'
                  ? '<span class="tag" title="Not issued yet. Retry HTTPS asks again.">no certificate</span>'
                  : '';

            const address = s.url
                ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(s.domain)}${
                      s.path && s.path !== '/' ? escapeHtml(s.path) : ''
                  }</a> ${https}${proxy?.auth?.enabled ? ' <span class="tag">password</span>' : ''}${
                      (proxy?.allowlist || []).length ? ' <span class="tag">ip filter</span>' : ''
                  }`
                // The button beside this already says "Set up", so repeating
                // "not published" here would be two answers to one question.
                : '<span class="muted">–</span>';

            // Setting up and moving to another name are the same walk from a
            // different starting point, so one button covers both. Everything
            // the advanced screen used to offer for a host is on the row that
            // host belongs to: retry the certificate, open the details, take it
            // down.
            const needsCert = proxy?.ssl?.mode === 'letsencrypt' && !proxy.certificate;
            const actions = s.blocked
                ? `<button class="ghost" disabled title="${escapeHtml(s.reason)}">Set up</button>`
                : [
                      `<button class="primary" data-setup="${s.key}">${s.domain ? 'Change' : 'Set up'}</button>`,
                      needsCert ? `<button class="ghost" data-cert="${s.proxyId}" title="The name has no certificate yet. This asks Let's Encrypt again.">Retry HTTPS</button>` : '',
                      s.proxyId ? `<button class="ghost" data-options="${s.proxyId}" title="Basic auth, IP allowlist, rate limit, custom nginx.">Options</button>` : '',
                      s.domain ? `<button class="ghost danger" data-unpublish="${s.key}">Unpublish</button>` : '',
                  ]
                      .filter(Boolean)
                      .join(' ');

            return `<tr title="${escapeHtml(`Forwards to ${s.upstreamLabel}`)}">
      <td><span class="service-name">${escapeHtml(s.label)}</span><small class="service-detail">${escapeHtml(s.detail)}</small></td>
      <td>${status}</td>
      <td>${address}</td>
      <td class="row-actions">${actions}</td>
    </tr>`;
        })
        .join('');

}

// Everything a published address needs is on its own row: set it up, retry the
// certificate, open the details, take it down.
$('publish-body').addEventListener('click', async (event) => {
    const { setup, unpublish, cert, options } = event.target.dataset ?? {};
    if (setup) return openSetup(setup);
    if (options) return openProxyDialog(proxies.find((p) => p.id === options));

    if (cert) {
        const proxy = proxies.find((p) => p.id === cert);
        try {
            await api(`/api/proxies/${cert}/certificate`, { method: 'POST', body: { email: proxy?.ssl?.email } });
        } catch (e) {
            toast(e.message, 'bad');
        }
        return;
    }

    if (!unpublish) return;

    const service = publishState.services.find((s) => s.key === unpublish);
    if (!confirm(`Stop publishing ${service?.label ?? unpublish} on ${service?.domain}?\n\nThe name stays on your list and the certificate is left alone.`)) {
        return;
    }
    event.target.disabled = true;
    try {
        await api(`/api/publish/${unpublish}`, { method: 'POST', body: { domain: null } });
        toast(`${service?.label ?? unpublish} is no longer published`);
        await loadProxies();
    } catch (e) {
        toast(e.message, 'bad');
        event.target.disabled = false;
    }
});

$('ports-save').addEventListener('click', async () => {
    $('ports-save').disabled = true;
    try {
        const r = await api('/api/proxy/ports', {
            method: 'POST',
            body: {
                http: Number($('ports-http').value),
                https: Number($('ports-https').value),
                bindHttp: Number($('ports-bind-http').value),
                bindHttps: Number($('ports-bind-https').value),
            },
        });
        toast(
            r.jobId
                ? `Moving the proxy to ports ${r.bindHttp} and ${r.bindHttps}.`
                : `Addresses will use ${r.http === 80 ? 'the default http port' : `http port ${r.http}`} and ${r.https === 443 ? 'the default https port' : `https port ${r.https}`}.`,
        );
        await loadProxies();
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        $('ports-save').disabled = false;
    }
});

/**
 * The reachability check. It reports what this machine does and what the
 * internet can see separately, because those need opposite fixes and look
 * identical from outside: a closed port and a stopped proxy both just fail.
 */
$('ports-check').addEventListener('click', async () => {
    const button = $('ports-check');
    const out = $('ports-check-result');
    button.disabled = true;
    button.textContent = 'Checking…';
    out.hidden = false;
    out.innerHTML = '<p class="muted">Asking a few places on the internet to connect. This takes a few seconds.</p>';

    try {
        const r = await api('/api/proxy/portcheck');
        const line = (ok, text) => `<li class="${ok === null ? '' : ok ? 'ok' : 'bad'}">${escapeHtml(text)}</li>`;
        const rows = [];
        const bound = `${r.local.bindHttp} and ${r.local.bindHttps}`;

        rows.push(line(r.local.proxyRunning, r.local.proxyRunning ? 'The reverse proxy is running here.' : 'The reverse proxy is not running, so nothing would answer even on an open port.'));
        rows.push(line(r.local.publishesHttp && r.local.publishesHttps,
            r.local.publishesHttp && r.local.publishesHttps
                ? `It holds ports ${bound} on this machine.`
                : `It is missing ${[!r.local.publishesHttp && r.local.bindHttp, !r.local.publishesHttps && r.local.bindHttps].filter(Boolean).join(' and ')} on this machine.`));

        // Holding the port and answering on it are different things, and only
        // the second one is what anybody means. An SSL listener needs a
        // certificate to present, so until one exists nginx is not on 443 at
        // all and the published port leads nowhere. Neutral rather than red:
        // this is a stage of setting up, not a fault.
        rows.push(line(r.local.servesHttps ? true : null, r.local.servesHttps
            ? `nginx is listening for https on ${r.local.bindHttps}.`
            : `nginx is not serving https yet, because no certificate exists to present. Port ${r.local.bindHttps} is published but nothing answers on it until Set up issues one.`));
        rows.push(line(r.local.servesChallenge, r.local.servesChallenge
            ? "It serves the file Let's Encrypt asks for."
            : "It did not serve the file Let's Encrypt asks for, which is the thing to fix first."));

        if (r.outside) {
            for (const key of ['http', 'https']) {
                const p = r.outside[key];
                const port = p.port;

                // Not asked, because there is nothing listening to answer. A
                // red cross here would be describing the certificate that does
                // not exist yet, not the forwarding rule.
                if (key === 'https' && p.serving === false) {
                    rows.push(line(null, `Port ${port}: not checked, because nothing is serving https yet. It cannot pass until there is a certificate.`));
                    continue;
                }

                // Port 80 is always identified -- the check fetches a file
                // from this machine. Port 443 only once a certificate exists,
                // and saying which is which is the difference between "it
                // works" and "something out there answered".
                const identified = key === 'http' || p.identified;
                rows.push(
                    line(
                        p.open,
                        `Port ${port}: ${
                            p.open
                                ? identified
                                    ? 'reaches this machine'
                                    : 'something accepts connections, which may be your router rather than this machine'
                                : p.open === null
                                  ? 'no answer in time'
                                  : 'does not reach this machine'
                        } (${p.detail}).`,
                    ),
                );
            }
        } else {
            rows.push(line(null, `Could not check from outside: ${r.error ?? 'unknown reason'}.`));
        }

        const httpsPending = r.outside?.https?.serving === false;
        const bothOpen = r.outside && r.outside.http?.open && r.outside.https?.open;

        /*
         * What this check does and does not say about certificates.
         *
         * Three different situations, and the wrong sentence in any of them
         * sends somebody into their router for no reason. With no domain yet
         * there is nothing to certify and nothing to conclude. With a DuckDNS
         * name the challenge is a TXT record, so no port is involved at all --
         * which is the case the old wording got flatly backwards, telling
         * people port 80 had to be open when it did not. Only a name that is
         * not DuckDNS actually needs port 80 inbound.
         */
        const certNote = !r.local.hasDomain
            ? ' No domain is set up yet, so there is nothing to certify. Set up creates the name, the configuration and the certificate together.'
            : r.dnsChallenge
              ? ' Certificates do not depend on any of this: your DuckDNS name is proved with a DNS record, not an inbound request.'
              : " This name is not a DuckDNS one, so Let's Encrypt proves it by fetching a file over port 80. That port has to reach this machine before a certificate can be issued.";

        // The forwarding advice is only worth giving about a port that is
        // supposed to be answering. Naming the https port while nothing is
        // listening on it describes a rule that is not the problem.
        const forwardAdvice = httpsPending
            ? `On your router, external <strong>${escapeHtml(String(r.outside.http.port))}</strong> should point to this machine on port <strong>${escapeHtml(String(r.local.bindHttp))}</strong>. Leave the https rule until there is a certificate; it cannot be tested before then.`
            : `Two numbers per rule, and they are not the same one: the outside port is what the internet dials, the forward port is what this machine listens on. On your router, external <strong>${escapeHtml(String(r.outside?.http?.port))}</strong> to this machine on port <strong>${escapeHtml(String(r.local.bindHttp))}</strong>, and external <strong>${escapeHtml(String(r.outside?.https?.port))}</strong> to port <strong>${escapeHtml(String(r.local.bindHttps))}</strong>.`;

        let verdict = '';
        if (bothOpen) {
            verdict = `<p class="muted">Both ports reach this machine.${certNote}</p>`;
        } else if (httpsPending && r.outside?.http?.open) {
            // The good outcome at this stage, and it used to read as a failure.
            verdict = `<p class="muted">Everything that can work yet does. Port ${escapeHtml(String(r.outside.http.port))} reaches this machine, and https is waiting on a certificate rather than on your router.${certNote}</p>`;
        } else if (r.outside && r.local.servesChallenge) {
            verdict = `<p class="muted">This machine is set up correctly, so what is missing is the forwarding. ${forwardAdvice}${certNote}</p>`;
        }

        out.innerHTML = `<ul class="port-result">${rows.join('')}</ul>${verdict}`;
    } catch (e) {
        out.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    } finally {
        button.disabled = false;
        button.textContent = 'Check from outside';
    }
});

// -------------------------------------------------------------- lifecycle ---

/**
 * Install, run, uninstall.
 *
 * The sidebar switch used to mean "exists or does not", so turning something
 * off threw away an hour of building. Now a service that has never been
 * installed offers a button that says so, and the switch only appears once
 * there is something to switch: from then on it starts and stops, and nothing
 * it does removes anything.
 *
 * Removing is its own tab, per service, and says what it will delete.
 */
let serviceState = {};

const UNINSTALL_COPY = {
    nextcloud: 'every file, photo and calendar stored in it',
    proxy: 'nothing. Your domains and certificates live in the stack directory and are kept',
};

async function loadServices() {
    try {
        serviceState = (await api('/api/services')).services ?? {};
    } catch {
        return;
    }
    for (const [key, state] of Object.entries(serviceState)) {
        renderServiceRow(key, state);
        renderInstallGate(key, state);
    }
    renderUninstallCards();
}

/** The sidebar row: a button before it exists, a switch after. */
function renderServiceRow(key, state) {
    const input = navSwitch(key);
    if (!input) return;
    const label = input.closest('.switch');
    const row = label?.closest('.nav-row');
    if (!row) return;

    let button = row.querySelector('[data-install]');
    if (!button) {
        button = document.createElement('button');
        button.className = 'nav-install';
        button.dataset.install = key;
        button.textContent = 'Install';
        row.appendChild(button);
    }

    const installed = Boolean(state?.installed);
    // Something with nothing to run would get the Install button like everything
    // else, and then no control at all -- rather than a toggle claiming to start
    // something that does not run.
    const runnable = state?.runnable !== false;

    button.hidden = installed;
    if (label) label.hidden = !installed || !runnable;

    // Set before any tab has been opened, so a service nobody has looked at
    // still shows the right colour.
    setNavHealth(state?.tab ?? key, !installed ? 'absent' : state.running ? 'ok' : 'bad');

    // A switch that is showing should say what is actually true, without
    // waiting for the next status poll to correct it.
    if (installed && runnable && input.dataset.busy !== '1') input.checked = Boolean(state.running);
}

/**
 * A service that is not installed has nothing to show, so it does not show it.
 *
 * The page underneath is real markup with empty numbers and dead switches, and
 * reading it as though it meant something is the obvious mistake. Blurred and
 * covered, it reads as what it is: a preview of what installing gets you.
 */
function renderInstallGate(key, state) {
    // A service's switch key and its tab name are allowed to differ, so the
    // unit's own `tab` wins where it has one.
    const section = document.getElementById(`tab-${state?.tab ?? key}`);
    if (!section) return;

    const installed = Boolean(state?.installed);
    section.classList.toggle('not-installed', !installed);

    let gate = section.querySelector(':scope > .install-gate');
    if (installed) return gate?.remove();

    // Left alone while its install runs: the overlay in front of it has the
    // log, and rebuilding this would put a live Install button back underneath.
    if (pendingAction?.key === key && gate) return;

    if (!gate) {
        gate = document.createElement('div');
        gate.className = 'install-gate';
        section.appendChild(gate);
    }
    // Already built and still saying the same thing. The poll comes round every
    // ten seconds and there is nothing here that changes in between.
    if (gate.dataset.builtFor === key) return;
    gate.dataset.builtFor = key;

    const label = escapeHtml(state?.label ?? key);
    gate.innerHTML = `
      <div class="install-gate-card">
        <h3>${label} is not installed</h3>
        <p class="muted">${
            state?.runnable === false
                ? 'Installing downloads the firmware and checks it against the hashes the release publishes.'
                : 'Installing builds its image and creates its container. It stays switched off afterwards -- the switch in the sidebar is what starts it. Everything behind this is what it will look like.'
        }</p>
        <button class="primary big" data-install="${escapeHtml(key)}">Install ${label}</button>
      </div>`;
}

/**
 * Rebuilt only when something actually changed. These cards carry a checkbox
 * somebody may have just ticked, and the services poll comes round every ten
 * seconds; rewriting the markup underneath them would untick it.
 */
let uninstallSignature = null;

function renderUninstallCards() {
    const signature = Object.entries(serviceState)
        .map(([key, state]) => `${key}:${state?.installed ? 1 : 0}`)
        .join(',');
    if (signature === uninstallSignature) return;
    uninstallSignature = signature;

    for (const card of document.querySelectorAll('.uninstall-card')) {
        const key = card.dataset.uninstall;
        const state = serviceState[key];
        const installed = Boolean(state?.installed);

        card.innerHTML = `
      <h3>Uninstall ${escapeHtml(state?.label ?? key)}</h3>
      <p class="muted">
        Removes the containers, the images built for it, and by default its data.
        Everything else in the panel leaves all of that alone: stopping a service
        keeps it, and this is the only place that does not.
      </p>
      <div class="notice">
        <p><strong>What goes:</strong> ${escapeHtml(UNINSTALL_COPY[key] ?? 'its data')}.</p>
        <p class="muted">Installing it again afterwards starts from nothing, and rebuilds.</p>
      </div>
      <label class="check">
        <input type="checkbox" data-keepdata="${key}"> Keep the data, remove only the containers and images
      </label>
      <div class="row">
        <button class="ghost danger" data-douninstall="${key}" ${installed ? '' : 'disabled'}>
          ${installed ? 'Uninstall' : 'Not installed'}
        </button>
        <span class="muted">${installed ? '' : 'There is nothing here to remove.'}</span>
      </div>`;
    }
}

document.addEventListener('click', async (event) => {
    const key = event.target?.dataset?.install;
    if (!key) return;

    const label = serviceState[key]?.label ?? key;
    await runAction({
        key,
        title: `Installing ${label}`,
        note:
            serviceState[key]?.runnable === false
                ? 'Downloading the firmware and checking it against the published hashes.'
                : 'The first install builds an image from source, which can take a long time. It does not start the service -- that is the switch. Leave this open.',
        request: () => api(`/api/services/${key}/install`, { method: 'POST' }),
    });
});

document.addEventListener('click', async (event) => {
    const key = event.target?.dataset?.douninstall;
    if (!key) return;

    const state = serviceState[key];
    const keepData = document.querySelector(`[data-keepdata="${key}"]`)?.checked === true;
    const what = keepData ? 'its containers and images' : `its containers, images and ${UNINSTALL_COPY[key]}`;

    // Typed rather than clicked. This is the one action in the panel that
    // deletes something a person cannot get back.
    const typed = prompt(
        `This removes ${what}.\n\nThis cannot be undone. Type the name to confirm:\n\n  ${key}`,
    );
    if (typed !== key) return toast(typed === null ? 'Nothing was removed.' : 'That did not match, so nothing was removed.');

    await runAction({
        key,
        title: `Uninstalling ${state?.label ?? key}`,
        note: `Removing ${what}. Stopping partway through would leave half of it behind, so this runs to the end.`,
        request: () => api(`/api/services/${key}/uninstall`, { method: 'POST', body: { confirm: key, keepData } }),
    });
});

// ------------------------------------------------------------ setup wizard ---

/**
 * The guided path to a public address, which is the only path most people
 * should need. It asks for a DuckDNS name and a token, shows exactly what it is
 * about to change, and then does all of it: the DNS record, whatever the
 * service needs switched on, the vhost, and the certificate.
 *
 * The alternative -- add a domain, pick an upstream, remember to click "get
 * certificate" -- is still there under Domains and Advanced. This is for the
 * person who wants their node reachable and does not want to learn nginx to get
 * there.
 */
let setupState = { key: null, step: 1, plan: null, mode: 'new', domain: null };

async function openSetup(key) {
    const service = publishState.services.find((s) => s.key === key);
    setupState = { key, step: 1, plan: null, mode: 'new', domain: null };

    $('setup-title').textContent = `Publish ${service?.label ?? key}`;
    $('setup-error').hidden = true;
    $('setup-subdomain').value = '';
    $('setup-token').value = '';

    let info;
    try {
        info = await api(`/api/setup/${key}`);
    } catch (e) {
        return toast(e.message, 'bad');
    }
    setupState.plan = info;

    // A name and token already saved means this is someone's second service, so
    // the first two steps are a confirmation rather than a chore.
    if (info.duckdns?.subdomain) $('setup-subdomain').value = info.duckdns.subdomain;
    $('setup-token-note').hidden = !info.duckdns?.hasToken;
    $('setup-token').placeholder = info.duckdns?.hasToken ? 'unchanged' : 'from duckdns.org';
    $('setup-ip').textContent = info.publicIp
        ? `This connection looks like ${info.publicIp} from the outside. DuckDNS will point the name here.`
        : 'Could not work out this connection\'s public address, which is not fatal: DuckDNS uses the address it sees.';

    $('setup-after').textContent = (service?.afterNote ?? '').replace('{domain}', 'that name');
    $('setup-auth').checked = false;
    $('setup-auth-fields').hidden = true;
    $('setup-allowlist').value = '';

    // A second service starts from a list of names rather than from duckdns.org.
    renderDomainChoices();
    setupState.step = publishState.domains.length ? 0 : 1;
    renderSetupStep();
    $('setup-dialog').showModal();
}

/**
 * The domain list, which used to be a screen of its own. It only ever answered
 * two questions -- which names do I have, and can I get rid of this one -- and
 * both belong at the point where a name is being chosen.
 */
function renderDomainChoices() {
    const list = $('setup-domain-list');
    const service = publishState.services.find((s) => s.key === setupState.key);

    list.innerHTML = publishState.domains
        .map((d) => {
            const others = (d.hosts ?? []).filter((h) => h.kind !== service?.kind);
            const mine = (d.hosts ?? []).find((h) => h.kind === service?.kind);

            // A name can carry several services, so "in use" is information
            // rather than a refusal. The one arrangement that cannot work is a
            // service that must own the root joining a name whose root is taken.
            const blocked = service?.rootOnly && !d.rootFree && !mine;
            const sharing = others
                .map((h) => `${serviceLabel(h.kind)}${h.path === '/' ? '' : ` at ${h.path}`}`)
                .join(', ');

            const note = blocked
                ? `${serviceLabel(d.usedBy)} is at the root, and this has to be`
                : mine
                  ? `already serving this${mine.path === '/' ? '' : ` at ${mine.path}`}`
                  : others.length
                    ? `shared with ${sharing}, so this joins at ${escapeHtml(service?.sharedPath ?? '/' + setupState.key)}`
                    : d.certificate
                      ? 'free, and has an HTTPS certificate'
                      : 'free, no certificate yet';

            return `<label class="domain-choice${blocked ? ' taken' : ''}">
        <input type="radio" name="setup-domain" value="${escapeHtml(d.domain)}"${blocked ? ' disabled' : ''}>
        <span>
          <strong>${escapeHtml(d.domain)}</strong>
          <small>${note}</small>
        </span>
        ${(d.hosts ?? []).length ? '' : `<button type="button" class="ghost danger" data-domain-del="${d.id}">Remove</button>`}
      </label>`;
        })
        .join('')
        .concat(
            `<label class="domain-choice">
        <input type="radio" name="setup-domain" value="" checked>
        <span><strong>Create another DuckDNS name</strong><small>free, and kept pointed here for you</small></span>
      </label>`,
        );
}

$('setup-domain-list').addEventListener('click', async (event) => {
    const id = event.target.dataset?.domainDel;
    if (!id) return;
    const record = publishState.domains.find((d) => d.id === id);
    if (!confirm(`Remove ${record?.domain}?\n\nNothing is published on it, so this only takes the name off the list.`)) return;
    try {
        await api(`/api/domains/${id}`, { method: 'DELETE' });
        await loadPublish();
        renderDomainChoices();
    } catch (e) {
        toast(e.message, 'bad');
    }
});

/** The name this run will publish on, whichever way it was chosen. */
const setupDomain = () =>
    setupState.mode === 'existing'
        ? setupState.domain
        : `${$('setup-subdomain').value.trim().toLowerCase()}.duckdns.org`;

function renderSetupStep() {
    const { step, plan } = setupState;
    for (const section of document.querySelectorAll('#setup-form .setup-step')) {
        section.hidden = Number(section.dataset.step) !== step;
    }
    $('setup-back').hidden = step === (publishState.domains.length ? 0 : 1);
    $('setup-next').hidden = step === 3;
    $('setup-run').hidden = step !== 3;

    if (step !== 3) return;

    const domain = setupDomain();
    const record = publishState.domains.find((d) => d.domain === domain);
    const joining = (record?.hosts ?? []).filter((h) => h.kind !== plan.service.kind);
    // The address is the name plus wherever this service lands on it, which is
    // not always the root once a name is shared.
    const path = joining.some((h) => h.path === '/') ? (plan.service.sharedPath ?? `/${setupState.key}`) : '';
    setupState.address = `https://${domain}${path}`;

    $('setup-summary').textContent = joining.length
        ? `${plan.service.label} will answer on ${setupState.address}, alongside ${joining
              .map((h) => serviceLabel(h.kind))
              .join(', ')} already on that name. Everything below happens in one go:`
        : `${plan.service.label} will answer on ${setupState.address}. Everything below happens in one go:`;
    $('setup-plan').innerHTML = (plan.steps ?? [])
        // The DNS step belongs to creating a name. Choosing one that is already
        // here skips it, and listing it anyway would promise work that will not
        // happen.
        .filter((st) => !(st.key === 'dns' && setupState.mode === 'existing'))
        .map(
            (st) => `<li class="${st.done ? 'done' : ''}">
        <strong>${escapeHtml(st.label)}</strong>${st.done ? ' <span class="tag ok">already done</span>' : ''}
        <small>${escapeHtml(st.detail ?? '')}</small>
      </li>`,
        )
        .join('');

    const svc = publishState.services.find((s) => s.key === setupState.key);
    $('setup-after').textContent = (svc?.afterNote ?? '').replace('{domain}', setupState.address.replace(/^https:\/\//, ''));
}

$('setup-next').addEventListener('click', () => {
    const { step } = setupState;
    $('setup-error').hidden = true;

    if (step === 0) {
        const chosen = document.querySelector('input[name="setup-domain"]:checked')?.value ?? '';
        setupState.mode = chosen ? 'existing' : 'new';
        setupState.domain = chosen || null;
        // A name already here needs nothing else: no token to save, and the
        // certificate is issued without a contact address.
        setupState.step = chosen ? 3 : 1;
        renderSetupStep();
        return;
    }

    if (step === 1) {
        const name = $('setup-subdomain').value.trim().toLowerCase().replace(/\.duckdns\.org\.?$/, '');
        if (!/^[a-z0-9-]{1,63}$/.test(name)) return toast('Enter the name you created at duckdns.org.', 'bad');
        $('setup-subdomain').value = name;
    }

    if (step === 2) {
        // A name already on this panel needs no token: either it is already
        // being refreshed, or it is not a DuckDNS name in the first place.
        if (!$('setup-token').value.trim() && !setupState.plan?.duckdns?.hasToken) {
            return toast('Paste the token from duckdns.org.', 'bad');
        }
    }

    setupState.step = Math.min(3, step + 1);
    renderSetupStep();
});

$('setup-back').addEventListener('click', () => {
    const { step, mode } = setupState;
    // Coming back from the plan on an existing name lands on the list it was
    // chosen from, not on the DuckDNS steps it never saw.
    setupState.step = step === 3 && mode === 'existing' ? 0 : Math.max(publishState.domains.length ? 0 : 1, step - 1);
    renderSetupStep();
});

$('setup-auth').addEventListener('change', (event) => {
    $('setup-auth-fields').hidden = !event.target.checked;
});

$('setup-run').addEventListener('click', async () => {
    const { key, mode, domain } = setupState;
    const body = {
        domain: mode === 'existing' ? domain : undefined,
        subdomain: mode === 'existing' ? undefined : $('setup-subdomain').value.trim(),
        token: $('setup-token').value.trim(),
        auth: $('setup-auth').checked
            ? { enabled: true, user: $('setup-auth-user').value.trim(), password: $('setup-auth-pass').value }
            : { enabled: false },
        allowlist: $('setup-allowlist').value,
    };

    $('setup-run').disabled = true;
    try {
        const r = await api(`/api/setup/${key}`, { method: 'POST', body });
        $('setup-dialog').close();
        // The job console is where every long job in this panel reports, and
        // this one has more to say than a toast can hold.
    } catch (e) {
        const box = $('setup-error');
        box.textContent = e.message;
        box.hidden = false;
    } finally {
        $('setup-run').disabled = false;
    }
});




$('proxy-reload').addEventListener('click', async () => {
    try {
        await api('/api/proxy/reload', { method: 'POST' });
        toast('nginx configuration reloaded.', 'good');
    } catch (e) {
        toast(e.message, 'bad');
    }
});

$('proxy-renew').addEventListener('click', async () => {
    try {
        await api('/api/proxy/renew', { method: 'POST' });
    } catch (e) {
        toast(e.message, 'bad');
    }
});

let editingId = null;

function openProxyDialog(proxy) {
    editingId = proxy?.id ?? null;
    $('proxy-dialog-title').textContent = proxy ? `Edit ${proxy.domain}` : 'Add proxy host';
    $('px-error').hidden = true;

    const kind = proxy?.target?.kind ?? 'nextcloud';
    $('px-target').innerHTML = Object.entries(targetKinds)
        .map(([key, meta]) => `<option value="${key}">${escapeHtml(meta.label ?? key)}</option>`)
        .join('');
    // A host pointing at something this panel no longer offers keeps its own
    // option, so opening it cannot silently repoint it at the first in the list.
    if (kind && !targetKinds[kind]) {
        $('px-target').insertAdjacentHTML('beforeend', `<option value="${escapeHtml(kind)}">${escapeHtml(kind)}</option>`);
    }

    $('px-domain').value = proxy?.domain ?? '';
    $('px-target').value = kind;
    $('px-scheme').value = proxy?.target?.scheme ?? 'http';
    $('px-host').value = proxy?.target?.host ?? '';
    $('px-port').value = proxy?.target?.port ?? '';
    $('px-websocket').checked = proxy?.websocket ?? true;
    $('px-tls').checked = proxy?.ssl?.mode === 'letsencrypt';
    $('px-email').value = proxy?.ssl?.email ?? '';
    $('px-forcehttps').checked = proxy?.ssl?.forceHttps !== false;
    $('px-staging').checked = false;
    $('px-auth').checked = Boolean(proxy?.auth?.enabled);
    $('px-user').value = proxy?.auth?.user ?? '';
    $('px-pass').value = '';
    $('px-allow').value = (proxy?.allowlist ?? []).join('\n');
    $('px-rate').value = proxy?.rateLimit ?? '';
    $('px-enabled').checked = proxy?.enabled !== false;

    toggleCustomTarget();
    $('proxy-dialog').showModal();
}

const toggleCustomTarget = () => {
    $('px-custom').hidden = $('px-target').value !== 'custom';
};
$('px-target').addEventListener('change', toggleCustomTarget);

$('proxy-form').addEventListener('submit', async (event) => {
    if (event.submitter?.value !== 'save') return; // cancel
    event.preventDefault();

    const err = $('px-error');
    err.hidden = true;

    const payload = {
        domain: $('px-domain').value.trim().toLowerCase(),
        enabled: $('px-enabled').checked,
        websocket: $('px-websocket').checked,
        target: {
            kind: $('px-target').value,
            scheme: $('px-scheme').value,
            host: $('px-host').value.trim(),
            port: Number($('px-port').value) || undefined,
        },
        ssl: {
            mode: $('px-tls').checked ? 'letsencrypt' : 'none',
            email: $('px-email').value.trim(),
            forceHttps: $('px-forcehttps').checked,
        },
        auth: {
            enabled: $('px-auth').checked,
            user: $('px-user').value.trim(),
            password: $('px-pass').value || undefined,
        },
        allowlist: lines('px-allow'),
        rateLimit: Number($('px-rate').value) || null,
    };

    try {
        if (editingId) await api(`/api/proxies/${editingId}`, { method: 'PUT', body: { proxy: payload } });
        else await api('/api/proxies', { method: 'POST', body: { proxy: payload } });

        $('proxy-dialog').close();
        await loadProxies();
        toast('Proxy host saved.', 'good');

        // A brand new https host has no certificate yet; offer to fetch it now.
        const saved = proxies.find((p) => p.domain === payload.domain);
        if (saved && payload.ssl.mode === 'letsencrypt' && !saved.certificate) {
            if (confirm(`Request a Let's Encrypt certificate for ${payload.domain} now?\n\nPort 80 must already reach this machine.`)) {
                await api(`/api/proxies/${saved.id}/certificate`, {
                    method: 'POST',
                    body: { email: payload.ssl.email, staging: $('px-staging').checked },
                });
            }
        }
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
});

// ---------------------------------------------------------------- duckdns ---

/**
 * DuckDNS has no screen of its own: the wizard sets the name and the token,
 * and this is the one line that says whether the refresh is alive. The public
 * address it also reports is what the port check compares against.
 */
async function loadDuckDns() {
    const r = await api('/api/duckdns');
    $('public-ip').textContent = r.publicIp || 'unknown';

    const names = r.duckdns.domains
        ? r.duckdns.domains
              .split(',')
              .filter(Boolean)
              .map((d) => `${d}.duckdns.org`)
              .join(', ')
        : '';
    const last = r.duckdns.lastRunAt
        ? `checked ${new Date(r.duckdns.lastRunAt).toLocaleTimeString()}, ${r.duckdns.lastResult}`
        : 'not checked yet';

    $('duck-status').textContent = r.duckdns.enabled
        ? `DuckDNS: ${names} (${last}, every ${r.duckdns.intervalMinutes} min)`
        : 'DuckDNS: nothing set up yet. Set up a service and it is arranged for you.';
}

$('dd-now').addEventListener('click', async () => {
    try {
        const r = await api('/api/duckdns/update', { method: 'POST' });
        toast(`Updated ${r.domains.join(', ')}`, 'good');
        loadDuckDns();
    } catch (e) {
        toast(e.message, 'bad');
    }
});

// ------------------------------------------------------------------- logs ---

// Log text size, kept per view. Each log is read for its own reasons -- one
// gets skimmed for a single line, another gets stared at -- so a size that
// suits one is rarely the size that suits the next.
const LOG_ZOOM_KEY = 'quickstart-home-log-size';
const LOG_SIZE_MIN = 9;
const LOG_SIZE_MAX = 22;
const LOG_SIZE_DEFAULT = 11.5;
const LOG_SIZE_STEP = 1.5;

const logSizeKey = (view) => `${LOG_ZOOM_KEY}:${view}`;

function logSize(view) {
    const stored = Number(localStorage.getItem(logSizeKey(view)));
    return Number.isFinite(stored) && stored >= LOG_SIZE_MIN && stored <= LOG_SIZE_MAX ? stored : LOG_SIZE_DEFAULT;
}

/**
 * Sets the size on the view's own element, so the variable resolves for that
 * subtree only. The buttons that drive it disable at the ends of the range.
 */
function applyLogSize(view, size) {
    const clamped = Math.min(LOG_SIZE_MAX, Math.max(LOG_SIZE_MIN, size));
    const nodes = document.querySelectorAll(`[data-logview="${view}"]`);
    // One id, one view. Styling every match keeps this correct even if a view
    // id is ever reused, instead of silently resizing whichever came first.
    for (const node of nodes) node.style.setProperty('--log-size', `${clamped}px`);
    try {
        localStorage.setItem(logSizeKey(view), String(clamped));
    } catch {
        /* private browsing: the size just will not persist */
    }
    for (const button of document.querySelectorAll(`[data-zoom][data-zoom-view="${view}"]`)) {
        const step = Number(button.dataset.zoom);
        button.disabled = step < 0 ? clamped <= LOG_SIZE_MIN : clamped >= LOG_SIZE_MAX;
    }
    return clamped;
}

/** Re-applies a stored size to a view, for tiles that are created later. */
function restoreLogSize(view) {
    applyLogSize(view, logSize(view));
}

document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-zoom][data-zoom-view]');
    if (!button) return;
    const view = button.dataset.zoomView;
    const node = document.querySelector(`[data-logview="${view}"]`);
    // Keep a view that is pinned to the bottom pinned after the text resizes.
    const atBottom = node ? node.scrollHeight - node.scrollTop - node.clientHeight < 4 : false;
    applyLogSize(view, logSize(view) + Number(button.dataset.zoom) * LOG_SIZE_STEP);
    if (node && atBottom) node.scrollTop = node.scrollHeight;
});

// Log tiles are built as containers appear and each restores its own text size
// then (see connectLogs), so there is nothing static to restore here.

// None of these is a service, so their dots stay hollow rather than implying a
// state they cannot have.
setNavHealth('logs', 'none');
setNavHealth('global', 'none');
setNavHealth('support', 'none');

// One tile per container, all fed by a single multiplexed EventSource. Per-tile
// streams would need one connection each, and browsers cap concurrent
// HTTP/1.1 connections per origin at about six -- which the status poll and the
// job console also need.
let logStream = null;
const logBuffers = new Map();
const LOG_TILE_LINES = 400;

function logTile(key, label) {
    return `<article class="log-tile" data-tile="${key}">
      <div class="log-tile-head">
        <span class="dot" data-tiledot="${key}"></span>
        <span class="name">${escapeHtml(label)}</span>
        <span class="count" data-tilecount="${key}">0</span>
        <span class="zoom" role="group" aria-label="Text size"><button type="button" class="zoom-btn" data-zoom="-1" data-zoom-view="tile:${key}" title="Smaller text">−</button><button type="button" class="zoom-btn" data-zoom="1" data-zoom-view="tile:${key}" title="Larger text">+</button></span>
        <button type="button" data-expand="${key}" title="Expand this one to full width">⤢</button>
        <button type="button" data-clear="${key}" title="Clear">✕</button>
      </div>
      <pre data-tilelog="${key}" data-logview="tile:${key}"></pre>
    </article>`;
}

function renderLogTile(key) {
    const pre = document.querySelector(`[data-tilelog="${key}"]`);
    if (!pre) return;
    const buf = logBuffers.get(key) ?? [];
    const filter = $('log-filter').value.trim().toLowerCase();
    const shown = filter ? buf.filter((l) => l.toLowerCase().includes(filter)) : buf;

    // While filtering, a container with no match is dropped rather than left as
    // an empty box: the point of a filter is to be shown only what matched.
    const tile = document.querySelector(`[data-tile="${key}"]`);
    if (tile) tile.hidden = Boolean(filter) && shown.length === 0;

    pre.textContent = shown.join('\n');
    const count = document.querySelector(`[data-tilecount="${key}"]`);
    if (count) count.textContent = filter ? `${shown.length}/${buf.length}` : String(buf.length);
    if ($('log-follow').checked) pre.scrollTop = pre.scrollHeight;
}

/** Keeps the toolbar honest about what the filter is hiding. */
function updateLogSummary() {
    const tiles = [...document.querySelectorAll('.log-tile')];
    if (!tiles.length) return;
    const visible = tiles.filter((t) => !t.hidden);
    const filter = $('log-filter').value.trim();
    const note = $('logs-note');

    if (!filter) {
        note.textContent = `${tiles.length} container${tiles.length === 1 ? '' : 's'} running`;
    } else if (visible.length) {
        note.textContent = `${visible.length} of ${tiles.length} container${tiles.length === 1 ? '' : 's'} match “${filter}”`;
    } else {
        note.textContent = `Nothing matches “${filter}”`;
    }

    let empty = document.getElementById('log-no-match');
    if (!visible.length && filter) {
        if (!empty) {
            empty = document.createElement('p');
            empty.id = 'log-no-match';
            empty.className = 'empty-tile';
            $('log-grid').appendChild(empty);
        }
        empty.textContent = `No lines in any container match “${filter}”.`;
        empty.hidden = false;
    } else if (empty) {
        empty.hidden = true;
    }
}

function connectLogs() {
    logStream?.close();
    logBuffers.clear();
    const grid = $('log-grid');
    grid.innerHTML = '<p class="empty-tile">Connecting…</p>';

    logStream = new EventSource('/api/logs/stream-all');

    logStream.addEventListener('containers', (event) => {
        const { containers } = JSON.parse(event.data);
        const up = containers.filter((c) => c.running !== false).length;
        // A stopped container still has a log worth reading -- usually the one
        // that says why it stopped -- so it keeps its tile and the count says
        // how many of them are actually running.
        $('logs-note').textContent = containers.length
            ? `${containers.length} container${containers.length === 1 ? '' : 's'}, ${up} running`
            : '';
        // The tiles are about to be replaced, so anything lifted over them is
        // gone too; leaving the scrim would dim the page with nothing on top.
        closeLogOverlay();
        // The panel's own jobs first: installs, certificates, restarts. It is
        // the log somebody is looking for after something went wrong, and it
        // exists whether or not any container does.
        grid.innerHTML =
            logTile(JOB_LOG_KEY, 'Panel jobs') +
            (containers.length
                ? containers.map((c) => logTile(c.key, c.label)).join('')
                : '<p class="empty-tile">Nothing is installed yet, so there are no container logs. The panel\'s own log is above.</p>');
        logBuffers.set(JOB_LOG_KEY, [...jobLog]);
        renderLogTile(JOB_LOG_KEY);
        for (const c of containers) {
            logBuffers.set(c.key, []);
            // The tile was just recreated, so its stored size needs reapplying.
            restoreLogSize(`tile:${c.key}`);
            const dot = document.querySelector(`[data-tiledot="${c.key}"]`);
            if (dot) dot.className = `dot ${c.running === false ? 'off' : 'ok'}`;
        }
        updateLogSummary();
    });

    logStream.addEventListener('line', (event) => {
        const { key, line } = JSON.parse(event.data);
        const buf = logBuffers.get(key);
        if (!buf) return;
        buf.push(line);
        if (buf.length > LOG_TILE_LINES) buf.splice(0, buf.length - LOG_TILE_LINES);
        const wasHidden = document.querySelector(`[data-tile="${key}"]`)?.hidden;
        renderLogTile(key);
        // A newly arrived line can pull a hidden container back into the match.
        if (wasHidden !== document.querySelector(`[data-tile="${key}"]`)?.hidden) updateLogSummary();
    });

    logStream.addEventListener('error', () => {
        for (const dot of document.querySelectorAll('[data-tiledot]')) dot.className = 'dot bad';
    });
}

/**
 * Lifts one log out of the grid and centres it over the rest.
 *
 * The tile is not moved in the DOM, only positioned over everything else, so it
 * keeps receiving the same stream it was already getting. Re-parenting it would
 * have meant rebuilding the element and losing whatever had scrolled past.
 */
let logOverlay = null;

function toggleLogOverlay(key) {
    const tile = document.querySelector(`[data-tile="${key}"]`);
    if (!tile) return;
    if (logOverlay === key) return closeLogOverlay();

    closeLogOverlay();
    tile.classList.add('expanded');
    logOverlay = key;

    const scrim = document.createElement('div');
    scrim.className = 'log-scrim';
    scrim.addEventListener('click', closeLogOverlay);
    document.body.appendChild(scrim);

    // A log pinned to the bottom should still be pinned after it changes size.
    const pre = tile.querySelector('pre');
    if (pre) pre.scrollTop = pre.scrollHeight;
}

function closeLogOverlay() {
    if (!logOverlay) return;
    document.querySelector(`[data-tile="${logOverlay}"]`)?.classList.remove('expanded');
    document.querySelector('.log-scrim')?.remove();
    logOverlay = null;
}

// Escape closes it, which is what every other overlay on the web does.
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeLogOverlay();
});

$('log-filter').addEventListener('input', () => {
    for (const key of logBuffers.keys()) renderLogTile(key);
    updateLogSummary();
});

$('log-grid').addEventListener('click', (event) => {
    const expand = event.target.dataset?.expand;
    const clear = event.target.dataset?.clear;
    if (expand) {
        toggleLogOverlay(expand);
    } else if (clear) {
        logBuffers.set(clear, []);
        renderLogTile(clear);
    }
});

// ---------------------------------------------------------------- console ---

let jobStream = null;

/**
 * What is waiting behind the job on screen. The console shows one job at a
 * time, so without this a queue of three looks like one.
 */
/** What is waiting, now that there is no console head to put it in. */
let lastQueueNote = '';
function renderQueue(pending) {
    const list = pending ?? [];
    const note = list.length ? `then: ${list.map((j) => j.name).join(', ')}` : '';
    // Only when it changes: this runs on every job event, and a toast repeating
    // itself is worse than no toast at all.
    if (note && note !== lastQueueNote) toast(note);
    lastQueueNote = note;
}

const refreshQueueSoon = debounce(async () => {
    try {
        const { job } = await api('/api/jobs/current');
        renderQueue(job?.pending);
    } catch {
        /* the console is cosmetic */
    }
}, 250);

/**
 * A job that renders on its own page rather than in the console overlay.
 *
 * Flashing is watched from the screen you started it on: you have a board in
 * your hand and the port you picked is on that screen, so throwing a modal over
 * it hides the context you need if something goes wrong.
 */
let inlineJob = null;

function claimJob(namePrefix, { el, state, onEnd }) {
    inlineJob = { namePrefix, el, state, onEnd };
    el.textContent = '';
}

function inlineJobHandles(name) {
    return inlineJob && String(name || '').startsWith(inlineJob.namePrefix);
}

function appendInline(line) {
    const el = inlineJob.el;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.textContent += `${line}\n`;
    if (atBottom) el.scrollTop = el.scrollHeight;
}

/**
 * Everything the panel's own jobs have printed this session.
 *
 * Kept whether or not the logs tab is open, because the interesting moment for
 * a job log is usually after it has finished: something did not work and the
 * question is what it said. This is the panel's own log, sitting beside the
 * containers' logs, which is where somebody looks for it.
 */
const JOB_LOG_KEY = 'panel-jobs';
const jobLog = [];

function pushJobLine(line) {
    jobLog.push(line);
    if (jobLog.length > LOG_TILE_LINES) jobLog.splice(0, jobLog.length - LOG_TILE_LINES);

    const buf = logBuffers.get(JOB_LOG_KEY);
    if (!buf) return;
    buf.push(line);
    if (buf.length > LOG_TILE_LINES) buf.splice(0, buf.length - LOG_TILE_LINES);
    renderLogTile(JOB_LOG_KEY);
}

/**
 * A job that this page is not already watching -- because it was started before
 * the page loaded, or queued behind the one that just finished.
 *
 * Refreshing the browser during a half-hour rebuild used to lose it entirely:
 * the job carried on in the manager, the page came back with no overlay and an
 * Update button that looked ready, and pressing it queued a second rebuild
 * behind the first. The work is on the server and always was; only the window
 * onto it was tied to the page.
 */
function adoptRunningJob(job, note) {
    // Watching something of our own that has not finished. That one wins.
    if (pendingAction && !pendingAction.finished) return;
    // Closed by hand once already. The job stream re-sends its snapshot every
    // time it reconnects, and a dropped connection is not a reason to put an
    // overlay back over somebody who has read it and moved on.
    if (dismissedJobs.has(job.id)) return;
    if (pendingAction) closeAction();

    const action = openAction({ key: null, title: job.name, note });
    // Elapsed from when the job really started, not from when this page noticed.
    const began = Date.parse(job.startedAt ?? '');
    if (!Number.isNaN(began)) action.startedAt = began;

    // Replaying what it has printed also puts the progress bar where it belongs.
    for (const line of job.lines ?? []) actionAppend(line);
    adoptActionJob(job.id);
    tickElapsed();
}

function connectJobs() {
    jobStream?.close();
    jobStream = new EventSource('/api/jobs/stream');
    // A job already running when this page loaded: what it has printed so far
    // goes into the panel's log, so opening All logs shows it rather than
    // starting from the next line.
    jobStream.addEventListener('snapshot', (event) => {
        const job = JSON.parse(event.data);
        if (job.status !== 'running') return;
        for (const line of job.lines ?? []) pushJobLine(line);
        renderQueue(job.pending);
        adoptRunningJob(
            job,
            'This was already running when the page loaded. It runs in the manager, not in the browser, so refreshing or closing the tab never interrupted it.',
        );
    });
    jobStream.addEventListener('start', (event) => {
        const job = JSON.parse(event.data);
        renderQueue(job.pending);
        pushJobLine(`\n> ${job.name}`);

        // The overlay is open on a job that has finished, and another was
        // waiting behind it. Follow that one rather than leaving it to run with
        // nothing on screen -- which is the same hole a refresh used to open.
        if (pendingAction?.finished) {
            return adoptRunningJob({ ...job, lines: [], startedAt: null }, 'This was queued behind the one that just finished.');
        }
        // Nothing pops up any more, so a job with no log of its own on screen
        // says once that it has started.
        if (!inlineJobHandles(job.name) && !pendingAction) toast(`${job.name}…`);
    });
    // Something was accepted but has not started. Saying so is the difference
    // between a queue and a click that appeared to do nothing.
    jobStream.addEventListener('queued', (event) => {
        const job = JSON.parse(event.data);
        if (job.ahead === 0 && !job.running) return;
        const waiting = `Waiting for ${job.running ?? 'the job running now'} to finish first.`;
        // If this is the overlay's own job, it belongs in its log rather than
        // in a toast behind it. It has no id yet, so it goes in the same place
        // as any other line that arrived early.
        if (pendingAction) actionLine(job.id, waiting);
        else toast(`${job.name}: queued behind ${job.running ?? 'the job running now'}`);
        refreshQueueSoon();
    });
    jobStream.addEventListener('line', (event) => {
        const { line, jobId } = JSON.parse(event.data);
        pushJobLine(line);
        // The overlay shows the action it started; a tab watching its own job
        // shows that one. Everything is in All logs either way.
        actionLine(jobId, line);
        if (inlineJob) appendInline(line);
    });
    jobStream.addEventListener('end', (event) => {
        const job = JSON.parse(event.data);
        renderQueue(job.pending);
        const wasOurs = pendingAction?.jobId === job.id;
        actionJobEnded(job);
        // Whether a service exists changes when a job finishes, and nothing
        // else tells the page that. Without this the Install overlay sat there
        // for up to ten seconds after the log had already said Done.
        loadServices().catch(() => {});

        // The overlay has already said how it went, in front of everything.
        if (wasOurs) {
            refreshStatus();
            return;
        }

        if (inlineJob) {
            appendInline(job.status === 'succeeded' ? '\n✓ Done.' : `\n✗ Failed: ${job.error}`);
            inlineJob.onEnd?.(job);
            inlineJob = null;
            refreshStatus();
            return;
        }
        toast(
            { succeeded: `${job.name}: done`, cancelled: `${job.name}: cancelled` }[job.status] ?? `${job.name}: failed`,
            { succeeded: 'good', cancelled: '' }[job.status] ?? 'bad',
        );
        refreshStatus();
        loadProxies();
        loadApps();
        loadPublish().catch(() => {});
    });
}

// -------------------------------------------------------- admin password ---

/**
 * Setting a password is the one change that replaces the container serving this
 * page, so it cannot report success the way everything else does: the answer
 * arrives as the panel coming back with a sign-in screen.
 */
function renderPasswordCard(isSet) {
    $('password-state').textContent = isSet
        ? 'A password is required to open this panel. Change it below, or remove it if you first bind the panel back to this machine only.'
        : 'No password is set, and this panel listens on your whole network. Anyone who can reach the port has full control of Docker, which is root on this machine. Set one now.';
    $('password-current-row').hidden = !isSet;
    $('password-clear').hidden = !isSet;
    $('password-save').textContent = isSet ? 'Change it' : 'Set a password';
}

/**
 * Waits for the panel to go away and come back, then reloads. The restart is
 * done by a detached container a second or two after the request returns, so
 * "still answering" does not yet mean "finished".
 */
async function waitForPanelRestart(note) {
    const deadline = Date.now() + 120_000;
    let wentDown = false;
    kResult('password-result', note, false);

    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
            const res = await fetch('/healthz', { cache: 'no-store' });
            if (res.ok && wentDown) return location.reload();
        } catch {
            wentDown = true;
        }
    }
    kResult('password-result', 'The panel has not come back. Check `docker logs quickstart-home-manager`.', true);
}

$('password-save').addEventListener('click', async () => {
    const password = $('password-new').value;
    const repeat = $('password-repeat').value;

    if (password.length < 8) return toast('Use at least 8 characters.', 'bad');
    if (password !== repeat) return toast('The two passwords are not the same.', 'bad');

    $('password-save').disabled = true;
    try {
        await api('/api/auth/password', {
            method: 'POST',
            body: { password, current: $('password-current').value },
        });
        $('password-new').value = '';
        $('password-repeat').value = '';
        $('password-current').value = '';
        await waitForPanelRestart('Password saved. The panel is restarting, and will ask you to sign in.');
    } catch (e) {
        toast(e.message, 'bad');
        $('password-save').disabled = false;
    }
});

$('panel-port-save').addEventListener('click', async () => {
    const port = Number($('panel-port').value);
    if (!confirm(`Move this panel to port ${port}?\n\nIt restarts, and this page will follow it to the new address. Anything you have bookmarked stops working.`)) return;

    $('panel-port-save').disabled = true;
    try {
        const r = await api('/api/panel/port', { method: 'POST', body: { port } });
        if (r.unchanged) return toast('It is already on that port.');
        // The address this page is on is about to stop answering, so it waits
        // for the new one rather than for this one to come back.
        kResult('panel-port-result', `Moving to port ${port}. This page will go there once it answers.`, false);
        const target = `${location.protocol}//${location.hostname}:${port}${location.pathname}`;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            await new Promise((res) => setTimeout(res, 2000));
            try {
                await fetch(`${location.protocol}//${location.hostname}:${port}/healthz`, { mode: 'no-cors', cache: 'no-store' });
                return location.assign(target);
            } catch {
                /* not up yet */
            }
        }
        kResult('panel-port-result', `It has not answered on ${port} yet. Try ${target} directly.`, true);
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        $('panel-port-save').disabled = false;
    }
});

$('password-clear').addEventListener('click', async () => {
    if (!confirm('Remove the password?\n\nAnyone who can reach this port will then have full control of the node and of Docker. Only sensible while the panel is on 127.0.0.1.')) {
        return;
    }
    $('password-clear').disabled = true;
    try {
        await api('/api/auth/password', { method: 'POST', body: { clear: true, current: $('password-current').value } });
        await waitForPanelRestart('Password removed. The panel is restarting.');
    } catch (e) {
        toast(e.message, 'bad');
        $('password-clear').disabled = false;
    }
});

// -------------------------------------------------------- global settings ---

/**
 * Both actions here replace or delete the container serving this page, so
 * neither reports back the way every other job does. The panel does not get to
 * see the end of its own update: the request returns as soon as a detached
 * container has picked the work up, and the result is read out of a status file
 * once the panel is running again.
 */
async function loadGlobal() {
    const r = await api('/api/system');
    $('global-panel-version').textContent = r.panelVersion || '–';
    $('global-stack-dir').textContent = r.stackDir || '–';

    const last = r.lastUpdate;
    if (!last) return;
    kResult(
        'global-update-result',
        last.ok
            ? `Updated from ${last.repo}@${last.ref} at ${new Date(last.at).toLocaleString()}.`
            : `Last update failed: ${last.error || 'no reason recorded'}`,
        !last.ok,
    );
}

/**
 * Nothing here polls GitHub in the background. A control panel that phones home
 * on a timer is a surprise, and the answer is only interesting at the moment
 * somebody is thinking about updating.
 */
$('global-check-btn').addEventListener('click', async () => {
    const button = $('global-check-btn');
    const repo = $('global-repo').value.trim();
    const ref = $('global-ref').value.trim();
    button.disabled = true;
    $('global-check-status').textContent = 'Checking…';
    try {
        const q = new URLSearchParams({ repo, ref });
        const r = await api(`/api/system/panel-latest?${q}`);
        const when = r.latest.date ? new Date(r.latest.date).toLocaleString() : 'unknown date';
        if (r.upToDate === true) {
            $('global-check-status').textContent = `Up to date. ${ref} is at ${r.latest.shortSha}, ${when}.`;
        } else if (r.upToDate === false) {
            const behind = r.compare?.behind ? `, ${r.compare.behind} commit${r.compare.behind === 1 ? '' : 's'} ahead of yours` : '';
            $('global-check-status').textContent = `Update available: ${r.latest.shortSha}${behind}. ${r.latest.message}`;
        } else {
            // No recorded sha, which is every install that has not used this
            // button yet. Saying "up to date" here would be a guess.
            $('global-check-status').textContent =
                `${ref} is at ${r.latest.shortSha} (${when}). This install has no recorded commit, so there is nothing to compare it against yet.`;
        }
    } catch (e) {
        $('global-check-status').textContent = e.message;
    } finally {
        button.disabled = false;
    }
});

$('global-update-btn').addEventListener('click', async () => {
    const button = $('global-update-btn');
    const repo = $('global-repo').value.trim();
    const ref = $('global-ref').value.trim();
    if (!confirm(`Update the panel from ${repo}@${ref}?\n\nIt will go offline for a minute or two while it rebuilds. The node keeps running.`)) return;

    button.disabled = true;
    try {
        await api('/api/system/panel-update', { method: 'POST', body: { repo, ref } });
        kResult('global-update-result', 'Rebuilding. This page will drop out and come back on its own.');
        waitForPanel();
    } catch (e) {
        kResult('global-update-result', e.message, true);
        button.disabled = false;
    }
});

/**
 * Polls until the panel answers again. The rebuild takes it away mid-request,
 * so failures here are expected and are not worth showing until it has been
 * gone long enough to mean something.
 */
function waitForPanel() {
    const deadline = Date.now() + 10 * 60_000;
    let wasDown = false;

    const tick = async () => {
        try {
            const res = await fetch('/healthz', { cache: 'no-store' });
            if (res.ok) {
                if (wasDown) return location.reload();
                // Still the old panel: it has not gone down yet.
            }
        } catch {
            wasDown = true;
        }
        if (Date.now() > deadline) {
            kResult('global-update-result', 'The panel has not come back after ten minutes. Check `docker logs quickstart-home-panel-update`.', true);
            $('global-update-btn').disabled = false;
            return;
        }
        setTimeout(tick, 3000);
    };
    setTimeout(tick, 4000);
}

// Nothing else in the panel is guarded like this, because nothing else deletes
// the node, its chain data and the panel in one go.
const TEARDOWN_PHRASE = 'DELETE EVERYTHING';

$('global-teardown-confirm').addEventListener('input', (event) => {
    $('global-teardown-btn').disabled = event.target.value.trim() !== TEARDOWN_PHRASE;
});

$('global-teardown-btn').addEventListener('click', async () => {
    if (!confirm('Remove the node, all its data and this panel?\n\nThis cannot be undone. Docker itself stays installed.')) return;

    $('global-teardown-btn').disabled = true;
    const job = await runAction({
        key: null,
        title: 'Removing everything',
        note:
            'Every container, image, volume and file this stack created, including this panel. ' +
            'It cannot be cancelled: half a teardown leaves a stack with nothing left to finish taking it apart.',
        cancellable: false,
        terminal: true,
        request: () => api('/api/system/teardown', { method: 'POST', body: { confirm: TEARDOWN_PHRASE } }),
    });
    // Only reached when it never started -- the phrase was wrong, or docker
    // refused to launch the container that does the removing.
    if (!job?.ok) $('global-teardown-btn').disabled = false;
});

// ------------------------------------------------------------------- boot ---

// Which services exist at all, which decides whether each row shows a button or
// a switch. Refreshed alongside the status poll so an install or an uninstall
// finishing is reflected without a reload.
// Ten seconds, not thirty: this is now the only thing that writes the switches,
// so how stale it is, is how stale they are.
setInterval(() => loadServices().catch(() => {}), 10_000);

api('/api/session')
    .then((s) => {
        if (s.panelVersion) $('version-badge').textContent = `v${s.panelVersion}`;
        renderPasswordCard(Boolean(s.required));
        // No password set is not a supported state here -- the installer always
        // sets one, and the panel listens on the whole network -- so the badge
        // in the sidebar is a warning rather than a note.
        $('logout').hidden = !s.required;
        $('auth-note').hidden = Boolean(s.required);
        if (s.passwordUnusable) {
            // No password will be accepted, so say that rather than let someone
            // retype a correct one until they give up.
            const note = $('login-error');
            note.hidden = false;
            note.textContent =
                'The stored password cannot be read, so none will be accepted. It was truncated by an old bug in how the hash was saved. Clear ADMIN_PASSWORD_HASH in the .env file in your install directory, recreate the panel container, and set a new password from Global settings.';
        }
        if (s.authenticated) {
            showApp();
            loadServices().catch(() => {});
        } else showLogin();
    })
    .catch(() => showLogin());
