const $ = (id) => document.getElementById(id);
const el = (sel, root = document) => root.querySelector(sel);

// ------------------------------------------------------------------- api ---

async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
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

/**
 * Shows a one-line outcome next to the control that produced it.
 *
 * Called from six places and defined in none of them until now -- every one of
 * those paths threw ReferenceError instead of reporting, so saving a password,
 * moving the panel's port and a failed update all went visibly nowhere. The
 * targets are a mix of <p class="hint"> and <div class="verdict">, so the
 * classes are set here rather than assumed.
 */
function kResult(id, message, bad = false) {
    const el = $(id);
    if (!el) return;
    el.hidden = false;
    el.className = bad ? 'verdict bad' : 'verdict';
    el.textContent = message;
}

/**
 * The panel's own "are you sure", in place of the browser's.
 *
 * confirm() puts the host and port in its title bar, so a question the panel
 * asked arrives looking like it came from a site rather than from the thing in
 * front of you. It also cannot hold the typed-phrase case, which is why
 * uninstalling used prompt() and compared strings by hand.
 *
 * Resolves true only on the confirm button. Escape, the backdrop, the close
 * cross and Cancel all mean no, which is the behaviour confirm() had and the
 * safer reading of someone dismissing a question they were asked.
 */
function askConfirm({ title, body = '', confirmLabel = 'OK', danger = false, requireText = null }) {
    const dialog = $('confirm-dialog');
    const ok = $('confirm-ok');
    const typedWrap = $('confirm-typed-wrap');
    const typed = $('confirm-typed');

    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    ok.textContent = confirmLabel;
    ok.className = danger ? 'primary danger' : 'primary';

    if (requireText) {
        typedWrap.hidden = false;
        $('confirm-typed-label').innerHTML = `Type <code></code> to confirm`;
        $('confirm-typed-label').querySelector('code').textContent = requireText;
        typed.value = '';
        // Armed only once the phrase matches, so the button cannot be hit by
        // someone clicking through on muscle memory.
        ok.disabled = true;
        typed.oninput = () => { ok.disabled = typed.value.trim() !== requireText; };
    } else {
        typedWrap.hidden = true;
        typed.oninput = null;
        ok.disabled = false;
    }

    const cancel = $('confirm-cancel');
    const closeX = dialog.querySelector('.dialog-close');

    return new Promise((resolve) => {
        // Answered from the buttons rather than only from the dialog's close
        // event. Both are wired because they fail in opposite directions: the
        // buttons cannot catch Escape or a click on the backdrop, and `close`
        // is dispatched as a queued task, so anything that is not running those
        // leaves the promise pending for ever -- which for a confirmation means
        // every destructive action quietly hangs instead of asking. Whichever
        // arrives first wins and the rest are torn down.
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            dialog.removeEventListener('close', onClose);
            dialog.removeEventListener('keydown', onKey);
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onNo);
            closeX?.removeEventListener('click', onNo);
            typed.oninput = null;
            if (dialog.open) dialog.close();
            resolve(value);
        };

        const matched = () => !requireText || typed.value.trim() === requireText;
        const onOk = () => finish(matched());
        const onNo = () => finish(false);
        const onKey = (e) => { if (e.key === 'Escape') finish(false); };
        // returnValue is '' when Escape or the backdrop closed it, so anything
        // other than the confirm button reads as no.
        const onClose = () => finish(dialog.returnValue === 'ok' && matched());

        ok.addEventListener('click', onOk);
        cancel.addEventListener('click', onNo);
        closeX?.addEventListener('click', onNo);
        dialog.addEventListener('close', onClose);
        dialog.addEventListener('keydown', onKey);

        dialog.returnValue = '';
        dialog.showModal();
        (requireText ? typed : ok).focus();
    });
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
    $('page-title').textContent =
        document.querySelector('.nav-item.active .label')?.textContent ??
        document.querySelector('.sys-item.active .sys-label')?.textContent ??
        'Overview';
    startPolling();
    loadApps();
    loadTunnel();
    // Drive discovery runs a container, so this is the one load that costs
    // something. Once on sign-in is enough -- Rescan is there for the moment a
    // drive is plugged in afterwards.
    loadBackup().catch(() => {});
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
    // The System screens live in the top banner rather than the sidebar, so
    // they carry their own highlight and their own name for the heading.
    for (const item of document.querySelectorAll('.sys-item')) {
        const active = item.dataset.tab === name;
        item.classList.toggle('active', active);
        if (active) title = el('.sys-label', item).textContent;
    }
    for (const tab of document.querySelectorAll('.tab')) {
        tab.classList.toggle('active', tab.id === `tab-${name}`);
    }
    $('page-title').textContent = title;
    // Read on arrival rather than polled: nothing on it changes by itself.
    if (name === 'global') loadGlobal().catch(() => {});
    // This one does change by itself, but the stream pushes those changes --
    // this is the first paint.
    if (name === 'queue') loadQueue();
    // Asked on arrival: the tunnel's health is Cloudflare's to report, live.
    if (name === 'tunnel') loadTunnel();
    // On the drawer layout, picking a destination should get out of the way.
    if (MOBILE()) closeDrawer();
}

for (const item of document.querySelectorAll('.nav-item, .sys-item')) {
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
    // Connecting to Cloudflare and publishing a name: the lines tunnel.js
    // reports, mostly spent waiting on Cloudflare.
    [/^Checking the token with Cloudflare/i, 0.08],
    [/^Finding or creating the tunnel/i, 0.25],
    [/^Starting the connector/i, 0.55],
    [/^The tunnel is up/i, 0.97],
    [/^Pointing .* at the tunnel/i, 0.3],
    [/^DNS record added|record was already in place/i, 0.6],
    [/ is at https:\/\//i, 0.9],

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

    /*
     * rsync's own percentage, which is the only job here that can report a real
     * one -- everything else is a sequence of named steps the bar guesses at.
     *
     * Scoped to the backup action. The shape is generic enough ("123,456  45%")
     * that letting it run against every job would let some other tool's output
     * drive the bar backwards.
     */
    if (pendingAction.key === 'backup') {
        const pct = /^\s*[\d,]+\s+(\d{1,3})%/.exec(line);
        if (pct) {
            const done = Math.min(100, Number(pct[1])) / 100;
            // Folders are copied one after another, so each one's percentage is
            // a slice of the whole rather than the whole thing.
            const total = pendingAction.backupTotal || 1;
            const index = pendingAction.backupIndex || 0;
            return setProgress((index + done) / total);
        }
        const start = /^> (\/.*)$/.exec(line);
        if (start) {
            pendingAction.backupIndex = (pendingAction.backupIndex ?? -1) + 1;
            return;
        }
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
    const action = { key, title, jobId: null, finished: false, resolve: null, progress: 0, startedAt: Date.now(), lineCount: 0 };
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

/*
 * A line of the job's own output, as opposed to the overlay's furniture -- the
 * title it opens with and the verdict it closes with. Only these are counted,
 * because the count is an index into the server's copy of the job's lines, and
 * the furniture is not in that list.
 */
function appendJobLine(line) {
    if (pendingAction) pendingAction.lineCount += 1;
    actionAppend(line);
}

/** Ours, somebody else's, or too early to tell. */
function actionLine(jobId, line) {
    if (!pendingAction || pendingAction.finished) return;
    if (pendingAction.jobId === jobId) return appendJobLine(line);
    if (pendingAction.jobId === null) {
        const held = earlyLines.get(jobId) ?? [];
        held.push(line);
        earlyLines.set(jobId, held);
    }
}

/*
 * The overlay's second opinion.
 *
 * Everything on screen while an action runs comes from one event on the job
 * stream, and an event is delivered once. If that connection drops and comes
 * back across the moment the job finishes -- which the browser does on its own,
 * on a sleeping laptop or a flaky link -- the `end` event is simply gone, and
 * `snapshot` on reconnect only replays a job that is still running. Nothing
 * else ever tells the overlay, so it sat there spinning over a container that
 * had already stopped, with Cancel as the only way out.
 *
 * So it asks as well as listens. The stream stays the fast path; this is the
 * floor under it, and it also collects any log lines that arrived while the
 * stream was away, so the overlay ends up showing the whole run either way.
 */
let actionWatchdog = null;

function stopActionWatchdog() {
    clearInterval(actionWatchdog);
    actionWatchdog = null;
}

function startActionWatchdog() {
    stopActionWatchdog();
    actionWatchdog = setInterval(checkActionJob, 4000);
}

async function checkActionJob() {
    const action = pendingAction;
    if (!action?.jobId || action.finished) return stopActionWatchdog();

    let payload;
    try {
        payload = await api(`/api/jobs/${action.jobId}`);
    } catch {
        // The panel is unreachable this instant. That is what the update
        // overlay expects to happen to it, so it is never a reason to give up
        // on the job -- the next tick asks again.
        return;
    }
    // Re-checked because the await above is a gap: the stream may have finished
    // this overlay, or the user may have closed it and started another.
    if (pendingAction !== action || action.finished) return stopActionWatchdog();

    const job = payload?.job;
    if (!job) {
        // Fell out of the server's history, so it ended a while ago and we
        // missed it. There is no status left to report beyond that it is over.
        if (payload?.gone) finishAction({ id: action.jobId, status: 'succeeded' });
        return;
    }
    if (job.status === 'queued' || job.status === 'running') {
        // Still going, but catch up on anything the stream did not deliver.
        appendMissedLines(action, job.lines);
        return;
    }
    appendMissedLines(action, job.lines);
    finishAction(job);
}

/**
 * Lines the overlay never received. Counted rather than compared, because the
 * same line repeats often here -- three containers all saying "Started" is
 * normal -- so matching on content would drop the duplicates.
 */
function appendMissedLines(action, lines) {
    if (!Array.isArray(lines)) return;
    for (const line of lines.slice(action.lineCount)) actionAppend(line);
    action.lineCount = Math.max(action.lineCount, lines.length);
}

/** Takes ownership of a job id, and of anything it printed before we had it. */
function adoptActionJob(jobId) {
    if (!pendingAction) return;
    pendingAction.jobId = jobId;
    startActionWatchdog();
    // Nothing can be cancelled until there is something to name, and some
    // things are not cancellable at all.
    $('action-cancel').hidden = pendingAction.cancellable === false;
    for (const line of earlyLines.get(jobId) ?? []) appendJobLine(line);
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
    stopActionWatchdog();
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
    for (const reload of [loadServices, refreshStatus, loadApps, loadTunnel, loadBackup]) {
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
    const stop = await askConfirm({
        title: `Cancel "${action.title}"?`,
        body:
            'Whatever it has already done stays done -- this stops it where it is rather than undoing it. ' +
            'A build keeps the parts it finished, so starting again does not start from the beginning.',
        confirmLabel: 'Cancel it',
        danger: true,
    });
    if (!stop) return;

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
/*
 * Every switch does the same thing to a different key, so the key drives the
 * request directly. There used to be a SERVICE_ACTIONS map here holding one
 * `start(key)` per service, which meant a switch in the markup and an entry in
 * a map had to be kept in step by hand -- and Jellyfin's switch shipped without
 * its entry, so toggling it off died on "SERVICE_ACTIONS[service] is not a
 * function" instead of stopping the container.
 *
 * The server route is already generic (it validates the key against the
 * lifecycle units and 404s on anything it does not know), so the map was
 * duplicating a list that is authoritative elsewhere. Now a new switch works
 * the moment its markup exists.
 */
const setRunning = (key, on, headers) =>
    api(`/api/services/${key}/${on ? 'start' : 'stop'}`, { method: 'POST', headers });

/* Display names only. A missing entry falls back to the key, which reads badly
   but still works -- unlike the map above, this one cannot break anything. */
const SERVICE_NAMES = {
    nextcloud: 'Nextcloud',
    jellyfin: 'Jellyfin',
    mealplan: 'Meal Plan',
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

        // Queued rather than taking the screen. The switch still waits for the
        // real answer -- queueAction resolves when the job finishes, not when
        // it is accepted -- so it can go back if the container refused to
        // start, while the rest of the panel stays usable meanwhile.
        const job = await queueAction({
            title: `${wanted ? 'Starting' : 'Stopping'} ${name}`,
            request: (headers) => setRunning(service, wanted, headers),
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

// --- Overview: the Services card, folded behind its counts ---

/**
 * Collapsed, the card is one line: "N running, N stopped, N not installed", each
 * count a filter. Clicking one shows that status's tiles; clicking it again
 * folds the card. The choice holds while the page lives -- the status poll
 * redraws this every few seconds and must not snap it shut -- and starts
 * folded on a fresh load.
 *
 * Taken from Kaspa Quick Start, where the same table had grown long enough that
 * the one fact worth knowing at a glance -- is anything down -- was a scroll
 * away. A count answers that without reading anything.
 */
let svcFilter = null;
let ovContainers = [];

// running, degraded (restarting, dead, or running but failing its healthcheck),
// stopped, not installed -- the order the chips and the tiles both go in.
const svcDegraded = (c) => c.exists && (c.health === 'unhealthy' || c.status === 'restarting' || c.status === 'dead');
const svcGroup = (c) => (!c.exists ? 3 : svcDegraded(c) ? 1 : c.running ? 0 : 2);

function renderContainers(list) {
    if (list) ovContainers = [...list].sort((a, b) => svcGroup(a) - svcGroup(b));
    const box = $('svc-filters');
    const grid = $('ov-services');
    const hint = $('ov-services-hint');
    if (!box || !grid) return;

    if (!ovContainers.length) {
        box.innerHTML = '<span class="muted">Nothing on this machine yet.</span>';
        grid.hidden = true;
        hint.hidden = true;
        return;
    }

    // Each chip carries the same dot its tiles do: green running, red degraded,
    // amber stopped, grey absent. Degraded only appears while something is --
    // a permanent "0 degraded" would teach the eye to skip the red one.
    const groups = [
        [0, 'running', 'ok'],
        [1, 'degraded', 'bad'],
        [2, 'stopped', 'warn'],
        [3, 'not installed', ''],
    ];
    box.innerHTML = groups
        .map(([n, word, dot]) => {
            const count = ovContainers.filter((c) => svcGroup(c) === n).length;
            // A filter whose group has emptied since it was picked folds the
            // card rather than leaving it open on nothing. Checked before the
            // degraded chip is dropped, not after: degraded is the group most
            // likely to empty while open -- something recovers -- and returning
            // first left the card open on an empty grid with no chip lit.
            if (!count && svcFilter === n) svcFilter = null;
            if (!count && n === 1) return '';
            return `<button type="button" class="svc-filter${svcFilter === n ? ' active' : ''}" data-svc-filter="${n}" ${
                count ? '' : 'disabled'
            }><span class="svc-dot ${dot}"></span>${count} ${word}</button>`;
        })
        .join('');

    grid.hidden = svcFilter === null;
    hint.hidden = svcFilter !== 3;
    grid.innerHTML = ovContainers
        .filter((c) => svcFilter !== null && svcGroup(c) === svcFilter)
        .map((c) => {
            const [dot, word] = !c.exists
                ? ['', 'not installed']
                : svcDegraded(c)
                  ? ['bad', c.health === 'unhealthy' ? 'running, failing its health check' : c.status]
                  : c.running
                    ? ['ok', 'running']
                    : ['warn', c.status || 'stopped'];
            const uptime = c.running && c.startedAt ? `, up ${fmtDuration(c.startedAt)}` : '';
            // The whole line as a tooltip: a tile is narrow, and the status that
            // gets cut short is the long one -- which is the one worth reading.
            return `<div class="svc-card${c.exists ? '' : ' absent'}" title="${escapeHtml(`${c.label}: ${word}${uptime}`)}"><span class="svc-dot ${dot}"></span><div class="svc-meta"><strong>${escapeHtml(
                c.label,
            )}</strong><small>${escapeHtml(word + uptime)}</small></div></div>`;
        })
        .join('');
}

$('svc-filters')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-svc-filter]');
    if (!chip) return;
    const n = Number(chip.dataset.svcFilter);
    svcFilter = svcFilter === n ? null : n;
    renderContainers();
});

/* The last host payload, kept so the app links can use the LAN address the
   server discovered. Null until the first status poll lands. */
let hostSnapshot = null;

async function refreshStatus() {
    let s;
    try {
        s = await api('/api/status');
    } catch {
        return;
    }
    if (reloadIfManagerRestarted(s.bootId)) return;

    const h = s.host ?? {};
    hostSnapshot = h;
    $('ov-hostname').textContent = h.hostname ?? '–';
    $('ov-platform').textContent = `${h.platform ?? '–'} (${h.arch ?? '?'})`;
    $('ov-cpus').textContent = h.cpus ? `${h.cpus} cores` : '–';
    $('ov-uptime').textContent = fmtUptime(h.uptime);
    // One minute, five, fifteen -- the three the kernel reports, in that order.
    $('ov-load').textContent = h.loadAverage?.length ? h.loadAverage.join('  ') : '–';

    renderMeter('ov-disk', h.disk, 'Disk usage');
    renderMeter('ov-mem', h.memory, 'Memory');
    renderContainers(h.containers);

    // The dot that is not an app: off until an account is connected, then
    // green while the connector runs. The panel itself is always up if this
    // line is running at all.
    const t = s.tunnel ?? {};
    setNavHealth('tunnel', !t.connected ? 'off' : t.running ? 'ok' : 'bad');
}

// ------------------------------------------------------------------- apps ---

let appsState = null;

/* Loaded once per page load rather than on every poll: see loadApps. */
let mealPlanRefsLoaded = false;

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
    sharedPaths = [...(c.nextcloud?.sharedPaths ?? [])];
    renderSharedPaths();
    renderAppState('jellyfin', r.apps.jellyfin);

    // --- Meal Plan ---
    $('mealplan-pub-web').checked = c.mealplan?.publish?.web !== false;
    $('mealplan-port').value = c.mealplan?.hostPort ?? 8083;
    // Only set when the field is not being typed in, so a reload landing
    // mid-edit does not overwrite what somebody is halfway through.
    if (document.activeElement !== $('mealplan-ref')) $('mealplan-ref').value = c.mealplan?.ref ?? 'main';
    renderAppState('mealplan', r.apps.mealplan);
    loadMealPlanPassword();
    // Once per page load. loadApps runs on a timer, and the refs call reaches
    // GitHub -- cached server side, but there is no reason to ask repeatedly
    // for a list of branches that changes about never.
    if (!mealPlanRefsLoaded) {
        mealPlanRefsLoaded = true;
        loadMealPlanRefs();
    }

    for (const app of APP_KEYS) {
        const running = Boolean(r.apps[app]?.container?.running);
        setNavHealth(app, !c[app]?.enabled ? 'off' : running ? 'ok' : 'bad');
    }
}

/** Every app with a tab of its own. The loops below are driven by this. */
const APP_KEYS = ['nextcloud', 'jellyfin', 'mealplan'];

/**
 * The ways in to an app: the one on this network, and the one from outside.
 *
 * Both are shown when both exist, because they are not interchangeable. The
 * public address goes through Cloudflare and the tunnel; the local one is a
 * straight line to the container and keeps working when either is down --
 * which is exactly when somebody needs it. Showing only the public one turns
 * a tunnel problem into a Nextcloud that appears to be gone.
 *
 * The local host comes from whatever address the panel itself was opened on,
 * so a phone reading this gets a link that works from the phone rather than a
 * localhost that only means anything on the server.
 */

/**
 * The address to paste into a file manager.
 *
 * Nextcloud speaks WebDAV, which every desktop file manager can mount, and that
 * is the way to work with these files from this machine now that Nextcloud owns
 * them -- they are its to read and write, and the account is the way in.
 *
 * /remote.php/webdav/ rather than /remote.php/dav/files/<user>/ on purpose: the
 * short form serves whoever logs in, so the link is the same for everybody and
 * does not have to be rewritten per account. The scheme follows the protocol --
 * dav:// for http, davs:// for https -- because file managers pick their
 * transport from it and a davs:// against a plain http port simply fails.
 */
function webdavLinks(hostPort, publicUrl) {
    const rows = [];
    const row = (url, label) =>
        `<div class="media-row"><code>${escapeHtml(url)}</code>` +
        `<span class="muted">${escapeHtml(label)}</span></div>`;

    if (publicUrl) {
        const u = new URL(publicUrl);
        rows.push(row(`${u.protocol === 'https:' ? 'davs' : 'dav'}://${u.host}/remote.php/webdav/`, 'from anywhere'));
    }
    const local = localHost();
    if (hostPort && local) rows.push(row(`dav://${local}:${hostPort}/remote.php/webdav/`, 'on this network'));
    return rows.join('');
}

function appLinks(hostPort, publicUrl) {
    const a = (url, label) =>
        `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(url)} ↗</a>` +
        `<span class="muted"> ${escapeHtml(label)}</span>`;

    const rows = [];
    if (publicUrl) rows.push(a(publicUrl, 'from anywhere'));
    const local = localHost();
    if (hostPort && local) rows.push(a(`http://${local}:${hostPort}`, 'on this network'));
    return rows.map((r) => `<div class="app-link">${r}</div>`).join('');
}

/**
 * Which name the "on this network" link should use.
 *
 * The address in the address bar is right whenever it is already a local one,
 * and it is the better answer then: it is demonstrably reachable from wherever
 * this page is being read, whereas a discovered address is only inferred.
 *
 * It is wrong in one case, and it is a case that happens daily -- sitting at
 * home and opening the panel by its public name, which hairpin NAT allows and
 * habit encourages. The hostname is then the public name, and building a
 * "local" link out of it produced a link to the public name labelled as if it
 * were the LAN, which is what this is fixing.
 */
function localHost() {
    const here = location.hostname;
    const lan = hostSnapshot?.lanAddress ?? null;

    // Already a real address on the network, and demonstrably reachable from
    // wherever this page is being read, so it beats anything inferred.
    if (here.endsWith('.local') || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(here)) {
        return here;
    }

    // localhost is this *machine*, not this network. Echoing it back produced a
    // link labelled "on this network" that works only on the one computer the
    // panel happens to be open on -- paste it into a phone and nothing answers.
    // The discovered address is the one worth showing, so it wins here.
    if (here === 'localhost' || /^127\./.test(here) || /^\[?::1\]?$/.test(here)) {
        return lan ?? here;
    }

    // A public name: nothing about it is local, so only the discovered address
    // will do. Null when there is none, and then the row is left out rather
    // than guessed at.
    return lan;
}

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
        // Hidden by default each pass, so the branches below only have to say
        // when it should appear rather than every branch remembering to hide it.
        $('nextcloud-webdav-card').hidden = true;
        if (running && (cfg.publish.web || state.publicUrl)) {
            link.className = 'verdict ok';
            link.innerHTML = appLinks(cfg.publish.web ? cfg.hostPort : null, state.publicUrl);

            // Only offered when it is actually reachable, which is the same
            // condition as the links above -- an address nobody can connect to
            // is worse than no address.
            const dav = webdavLinks(cfg.publish.web ? cfg.hostPort : null, state.publicUrl);
            $('nextcloud-webdav-card').hidden = !dav;
            $('nextcloud-webdav').innerHTML = dav;
        } else if (running) {
            link.className = 'verdict';
            link.textContent =
                'Running, but not published on the host and not on a domain. Tick "Publish on the host" under Settings, or give it an address under Tunnel & domains.';
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
        if (running && (cfg.publish?.web || state.publicUrl)) {
            link.className = 'verdict ok';
            link.innerHTML = appLinks(cfg.publish?.web ? cfg.hostPort : null, state.publicUrl);
        } else if (running) {
            link.className = 'verdict';
            link.textContent =
                'Running, but not published on the host and not on a domain. Tick "Publish on the host" under Settings, or give it an address under Tunnel & domains.';
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

    if (name === 'mealplan') {
        const link = $('mealplan-link');
        const cfg = appsState.config.mealplan ?? {};
        link.hidden = false;
        if (running && (cfg.publish?.web || state.publicUrl)) {
            link.className = 'verdict ok';
            link.innerHTML = appLinks(cfg.publish?.web ? cfg.hostPort : null, state.publicUrl);
        } else if (running) {
            link.className = 'verdict';
            link.textContent =
                'Running, but not published on the host and not on a domain. Tick "Publish on the host" under Settings, or give it an address under Tunnel & domains.';
        } else {
            const note = appStatusNote(state, {
                absent: 'Not installed yet. Installing builds it and leaves it switched off.',
                stopped: 'Not running. Its switch in the sidebar starts it.',
            });
            link.className = note.bad ? 'verdict bad' : 'verdict';
            link.textContent = note.text;
        }

        const build = $('mealplan-build');
        build.textContent = state.build?.builtAt
            ? `Built ${new Date(state.build.builtAt).toLocaleString()}${
                  state.build.ref ? ` from ${state.build.ref}` : ''
              }.`
            : 'Not built yet.';
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

/*
 * The same list again for Nextcloud's shared folders. Deliberately a copy
 * rather than a shared widget: the two differ in what they mean -- Jellyfin's
 * are read-only libraries, these are folders you can work in -- and one
 * parameterised renderer covering both would hide that behind a flag.
 */
let sharedPaths = [];

function renderSharedPaths() {
    const list = $('nextcloud-shared-list');
    if (!list) return;
    if (!sharedPaths.length) {
        list.innerHTML = '<p class="muted">No folders shared yet.</p>';
        return;
    }
    list.innerHTML = sharedPaths
        .map(
            (path, i) => `<div class="media-row">
                <code>${escapeHtml(path)}</code>
                <button type="button" class="ghost mini" data-shared-remove="${i}" title="Stop sharing this folder">Remove</button>
            </div>`,
        )
        .join('');
}

function addSharedPath() {
    const box = $('nextcloud-shared-new');
    const path = box.value.trim().replace(/\/+$/, '');
    if (!path) return;
    if (!path.startsWith('/')) return toast('Give the full path, starting with a /.', 'bad');
    if (sharedPaths.includes(path)) return toast('That folder is already shared.', 'bad');

    sharedPaths.push(path);
    box.value = '';
    renderSharedPaths();
    toast('Added. Press Apply settings to share it.');
}

$('nextcloud-shared-add').addEventListener('click', addSharedPath);
$('nextcloud-shared-new').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        addSharedPath();
    }
});
$('nextcloud-shared-list').addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-shared-remove]');
    if (!button) return;
    sharedPaths.splice(Number(button.dataset.sharedRemove), 1);
    renderSharedPaths();
});

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
    if (name === 'mealplan') {
        return {
            enabled: Boolean(appsState?.config?.mealplan?.enabled),
            ref: $('mealplan-ref')?.value.trim() || appsState?.config?.mealplan?.ref || 'main',
            publish: { web: $('mealplan-pub-web').checked },
            hostPort: Number($('mealplan-port').value),
        };
    }
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
        sharedPaths: [...sharedPaths],
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
        const label = appsState?.apps?.[name]?.label ?? name;
        /*
         * No confirmation here.
         *
         * A rebuild is not destructive -- the data is in a volume, and a build
         * that fails leaves the running container alone -- so a dialog in front
         * of it only asks the question the button already asked. For the app
         * updates it also came after a Check, which is where the decision was
         * actually made. The peek in the corner is the acknowledgement instead,
         * and the queue page is where it can be watched or cancelled.
         */
        const result = await queueAction({
            title: `Rebuilding ${label}`,
            request: (headers) => api(`/api/apps/${name}/update`, { method: 'POST', headers }),
        });

        // Built, so the answer the check gave is spent: the button goes back to
        // needing a fresh one rather than staying lit over a commit that is now
        // the installed one.
        if (result?.ok) {
            $(`${name}-update`).disabled = true;
            setAppStatus(name, 'current',
                name === 'mealplan' ? 'Built from the newest commit' : 'Updated to the newest image',
                'Check again whenever you want to know if it has moved on.');
        }
    });
}

// --- meal plan: family password and branch list ---

/** Whether a password is set, which is the thing worth knowing here -- the hash
 *  itself is never sent back out. */
async function loadMealPlanPassword() {
    const note = $('mealplan-pass-state');
    try {
        const { set } = await api('/api/apps/mealplan/password');
        note.hidden = false;
        note.className = set ? 'verdict ok' : 'verdict bad';
        note.textContent = set
            ? 'A family password is set.'
            : 'No password is set, so anyone who can reach Meal Plan can change the week. Set one.';
    } catch {
        note.hidden = true;
    }
}

$('mealplan-password-save').addEventListener('click', async () => {
    const field = $('mealplan-password');
    const err = $('mealplan-password-error');
    const button = $('mealplan-password-save');
    err.hidden = true;
    button.disabled = true;
    try {
        const r = await api('/api/apps/mealplan/password', {
            method: 'POST',
            body: { password: field.value },
        });
        field.value = '';
        toast(r.restarting ? 'Password set. Meal Plan is restarting.' : 'Password set.');
        loadMealPlanPassword();
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    } finally {
        button.disabled = false;
    }
});

/*
 * Check first, then update -- the same two steps as the panel's own, for every
 * app.
 *
 * The Update button starts disabled and only opens once a check has found
 * something, so pressing it is always a decision about a known change rather
 * than a rebuild on the off chance. Meal Plan is checked against its
 * repository; Nextcloud and Jellyfin against the Docker Hub tag they are made
 * from, which is the part that used to go unwatched -- Nextcloud's button
 * looked the same with a PHP security fix waiting upstream as without one.
 */
function setAppStatus(name, state, head, detail) {
    setUpdateStatus(state, head, detail, `${name}-check-status`);
}
const setMealPlanStatus = (state, head, detail) => setAppStatus('mealplan', state, head, detail);

function renderImageCheck(name, r) {
    const label = appsState?.apps?.[name]?.label ?? name;
    const update = $(`${name}-update`);
    const now = (r.versions ?? []).filter((v) => v.latest).map((v) => `${v.label} ${v.latest}`).join(' · ');

    if (r.neverBuilt) {
        setAppStatus(name, null, `${r.image} is ${now || r.shortSha}.`,
            `${label} is not installed yet, so there is nothing to compare it against. Installing it fetches this.`);
        update.disabled = true;
        return;
    }
    if (!r.updateAvailable) {
        setAppStatus(name, 'current', 'Up to date', `${now ? `${now} · ` : ''}${r.image}`);
        update.disabled = true;
        return;
    }

    const changed = (r.versions ?? []).filter((v) => v.running && v.latest && v.running !== v.latest);
    // Same version numbers, new image: the tag was rebuilt -- usually security
    // fixes to the operating system underneath, which never change the
    // headline version and are exactly the ones worth not sitting on.
    const what = changed.length
        ? changed.map((v) => `${v.label} ${v.running} → ${v.latest}`).join(' · ')
        : `${r.image} has been rebuilt upstream with the same version numbers, usually for security fixes underneath.`;
    const major = r.majorChanges?.length
        ? `\n${r.majorChanges.join(' and ')} would move to a new major version. It upgrades its database on the first start and cannot be rolled back, so read the release notes first.`
        : '';
    setAppStatus(name, 'update', major ? 'Major update available' : 'Update available', what + major);
    update.disabled = false;
}

function renderRepoCheck(name, r) {
    const label = appsState?.apps?.[name]?.label ?? name;
    const update = $(`${name}-update`);
    const when = r.date ? new Date(r.date).toLocaleString() : 'unknown date';
    if (r.neverBuilt) {
        // Nothing recorded to compare against, which is every install that has
        // not built it yet. "Up to date" here would be a guess.
        setAppStatus(name, null, `${r.ref} is at ${r.shortSha} (${when}).`,
            `This install has not built ${label} yet, so there is nothing to compare it against.`);
        update.disabled = false;
    } else if (r.updateAvailable) {
        setAppStatus(name, 'update', 'Update available', `${r.shortSha}\n${r.message}`);
        update.disabled = false;
    } else {
        setAppStatus(name, 'current', 'Up to date', `${r.ref} · ${r.shortSha} · ${when}`);
        update.disabled = true;
    }
}

for (const name of APP_KEYS) {
    $(`${name}-check`)?.addEventListener('click', async () => {
        const button = $(`${name}-check`);
        button.disabled = true;
        setAppStatus(name, 'checking', 'Checking…');
        try {
            const r = await api(`/api/apps/${name}/check`);
            if (r.kind === 'image') renderImageCheck(name, r);
            else renderRepoCheck(name, r);
        } catch (e) {
            setAppStatus(name, 'error', 'Could not check', e.message);
        } finally {
            button.disabled = false;
        }
    });
}

// A different branch is a different question, so the last answer no longer
// applies and the button goes back to needing a check -- unless the branch is
// being moved to, which is itself a reason to rebuild.
$('mealplan-ref').addEventListener('input', () => {
    const changed = $('mealplan-ref').value.trim() !== (appsState?.config?.mealplan?.ref ?? 'main');
    $('mealplan-update').disabled = !changed;
    setMealPlanStatus(null, changed
        ? 'Branch changed. Updating will build from it.'
        : 'Checked against GitHub when you ask, never on its own.');
});

/* The branches and tags the repository actually has, offered as a datalist
   rather than a select: the field still accepts a commit-ish the list does not
   know about, which is what makes testing a fork possible. */
async function loadMealPlanRefs() {
    try {
        const { branches = [], tags = [] } = await api('/api/apps/mealplan/refs');
        $('mealplan-refs').innerHTML = [...branches, ...tags]
            .map((r) => `<option value="${escapeHtml(r)}"></option>`)
            .join('');
    } catch {
        /* GitHub being unreachable or rate limited is not worth a message: the
           field works perfectly well without suggestions. */
    }
}

// Restart, and whatever else gets one of these later. The same container
// actions as the sidebar switches, so they get the same overlay.
for (const button of document.querySelectorAll('[data-app-action]')) {
    button.addEventListener('click', async () => {
        const [name, action] = button.dataset.appAction.split('/');
        const verb = ACTION_VERBS[action] ?? action;
        await queueAction({
            title: `${verb} ${appsState?.apps?.[name]?.label ?? name}`,
            request: (headers) => api(`/api/apps/${button.dataset.appAction}`, { method: 'POST', headers }),
        });
    });
}

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

/* What "and its data" actually means for each service, in plain words, for the
   confirmation dialog. Jellyfin's media folders are bind-mounted read-only from
   elsewhere on the disk, so uninstalling it cannot touch the films themselves --
   only what Jellyfin built from them. Worth saying, since that is the thing
   somebody would be afraid of losing here. */
const UNINSTALL_COPY = {
    nextcloud: 'every file, photo and calendar stored in it',
    jellyfin: 'its library, artwork and watch history. Your media folders are mounted read-only and are left alone',
    mealplan: 'the meal library and every week that has been planned',
};
const uninstallCopy = (key) => UNINSTALL_COPY[key] ?? 'its data';

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
        <p><strong>What goes:</strong> ${escapeHtml(uninstallCopy(key))}.</p>
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
    const what = keepData ? 'its containers and images' : `its containers, images and ${uninstallCopy(key)}`;

    // Typed rather than clicked. This is the one action in the panel that
    // deletes something a person cannot get back.
    const sure = await askConfirm({
        title: `Uninstall ${state?.label ?? key}?`,
        body: `This removes ${what}.\n\nThis cannot be undone.`,
        confirmLabel: 'Uninstall',
        danger: true,
        requireText: key,
    });
    if (!sure) return toast('Nothing was removed.');

    await runAction({
        key,
        title: `Uninstalling ${state?.label ?? key}`,
        note: `Removing ${what}. Stopping partway through would leave half of it behind, so this runs to the end.`,
        request: () => api(`/api/services/${key}/uninstall`, { method: 'POST', body: { confirm: key, keepData } }),
    });
});

// ----------------------------------------------------------------- tunnel ---

/*
 * Tunnel & domains: connect a Cloudflare account once, then give any app a
 * name on your domain. Everything that talks to Cloudflare is a queued job --
 * it waits on Cloudflare and on a container -- so it shows in the corner and
 * the page stays usable.
 */
let tunnelState = null;

// What the name box suggests for each service, so the obvious choice is one
// keystroke away rather than a decision.
const SUGGESTED_NAME = { nextcloud: 'cloud', jellyfin: 'media', mealplan: 'meals', panel: 'panel', custom: 'home' };

async function loadTunnel() {
    try {
        tunnelState = await api('/api/tunnel');
    } catch {
        return;
    }
    renderTunnel();
}

function renderTunnel() {
    const t = tunnelState;
    if (!t) return;
    $('tunnel-setup').hidden = t.connected;
    $('tunnel-live').hidden = !t.connected;
    if (!t.connected) return;

    // Health, as Cloudflare sees it -- the connector running here is necessary
    // but not sufficient, and a token that has been revoked shows up here first.
    const cfStatus = t.cloudflare?.status ?? 'unknown';
    const tag = $('tunnel-state');
    const words = { healthy: 'connected', degraded: 'degraded', down: 'down', inactive: 'not connected' };
    tag.textContent = words[cfStatus] ?? cfStatus;
    tag.className = `tag ${cfStatus === 'healthy' ? 'ok' : cfStatus === 'degraded' ? 'warn' : 'bad'}`;

    const note = $('tunnel-note');
    let msg = null;
    if (!t.container?.running) {
        msg = 'The connector is not running on this machine, so nothing published here can be reached. Restarting the panel, or connecting again, starts it.';
    } else if (t.cloudflare?.error) {
        msg = `Could not ask Cloudflare how the tunnel is doing: ${t.cloudflare.error}`;
    } else if (cfStatus !== 'healthy') {
        msg = 'The connector is running, but Cloudflare does not see it yet. Right after connecting that is normal for a minute; if it stays like this, the connector\'s log under All logs will say why.';
    }
    note.hidden = !msg;
    note.className = 'verdict bad';
    note.textContent = msg ?? '';

    $('tunnel-account').textContent = t.accountName ?? '–';
    $('tunnel-name').textContent = t.tunnelName ?? '–';
    $('tunnel-zones').textContent = t.zones.map((z) => z.name).join(', ') || '–';

    // Published names.
    const list = $('tunnel-routes');
    if (!t.routes.length) {
        list.innerHTML = '<p class="muted">Nothing yet. Pick something below and give it a name.</p>';
    } else {
        list.innerHTML = t.routes
            .map(
                (r) => `<div class="route-row">
                    <div class="route-main">
                        <a href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(r.hostname)} ↗</a>
                        <span class="muted">${escapeHtml(r.label)}${r.service === 'custom' ? ` · ${escapeHtml(r.origin)}` : ''}</span>
                        ${r.appOff ? '<span class="muted route-warn">switched off, so this shows an error until it is started</span>' : ''}
                    </div>
                    <button type="button" class="ghost danger" data-unpublish="${escapeHtml(r.hostname)}">Take offline</button>
                </div>`,
            )
            .join('');
    }

    // The publish form. Options are rebuilt but the choices kept, because this
    // re-renders after every job and must not throw away half-typed input.
    const svc = $('pub-service');
    const keepSvc = svc.value;
    svc.innerHTML = t.services.map((x) => `<option value="${x.key}">${escapeHtml(x.label)}</option>`).join('');
    if (keepSvc && t.services.some((x) => x.key === keepSvc)) svc.value = keepSvc;

    const zone = $('pub-zone');
    const keepZone = zone.value;
    zone.innerHTML = t.zones.map((z) => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join('');
    if (keepZone && t.zones.some((z) => z.id === keepZone)) zone.value = keepZone;

    renderPublishForm();
}

function renderPublishForm() {
    const t = tunnelState;
    if (!t?.connected) return;
    const service = t.services.find((x) => x.key === $('pub-service').value) ?? t.services[0];
    $('pub-detail').textContent = [service.detail, service.note].filter(Boolean).join(' ');
    $('pub-origin-row').hidden = service.key !== 'custom';
    $('pub-sub').placeholder = SUGGESTED_NAME[service.key] ?? 'name';

    const warn = $('pub-warning');
    warn.hidden = !service.warning;
    warn.textContent = service.warning ?? '';

    const zoneName = t.zones.find((z) => z.id === $('pub-zone').value)?.name ?? '';
    const sub = $('pub-sub').value.trim().toLowerCase();
    $('pub-preview').textContent = zoneName
        ? `It will be at https://${sub ? `${sub}.` : ''}${zoneName}${sub ? '' : ' (the domain itself, since the name is empty)'}`
        : '';
}

for (const id of ['pub-service', 'pub-zone']) $(id).addEventListener('change', renderPublishForm);
$('pub-sub').addEventListener('input', renderPublishForm);

$('tunnel-connect').addEventListener('click', async () => {
    const button = $('tunnel-connect');
    const err = $('tunnel-connect-error');
    const token = $('tunnel-token').value.trim();
    err.hidden = true;
    if (!token) {
        err.textContent = 'Paste the API token from Cloudflare first.';
        err.hidden = false;
        return;
    }
    button.disabled = true;
    const result = await queueAction({
        title: 'Connecting to Cloudflare',
        request: (headers) => api('/api/tunnel/connect', { method: 'POST', body: { token }, headers }),
    });
    button.disabled = false;
    if (result.ok) {
        // Not left sitting in the field once it has been stored.
        $('tunnel-token').value = '';
    } else {
        err.textContent = result.error || 'Connecting did not finish. The Update Queue has its log.';
        err.hidden = false;
    }
    loadTunnel();
});

$('pub-go').addEventListener('click', async () => {
    const button = $('pub-go');
    const err = $('pub-error');
    err.hidden = true;
    const body = {
        service: $('pub-service').value,
        subdomain: $('pub-sub').value.trim(),
        zoneId: $('pub-zone').value,
        origin: $('pub-origin').value.trim(),
    };
    const label = tunnelState?.services.find((x) => x.key === body.service)?.label ?? body.service;
    button.disabled = true;
    const result = await queueAction({
        title: `Publishing ${label}`,
        request: (headers) => api('/api/tunnel/routes', { method: 'POST', body, headers }),
    });
    button.disabled = false;
    if (result.ok) {
        $('pub-sub').value = '';
        $('pub-origin').value = '';
    } else {
        // Shown beside the form as well as in the corner: a name that is taken
        // or mistyped is fixed here, not in the queue.
        err.textContent = result.error || 'Publishing did not finish. The Update Queue has its log.';
        err.hidden = false;
    }
    loadTunnel();
    loadApps();
});

$('tunnel-routes').addEventListener('click', async (event) => {
    const hostname = event.target.closest('[data-unpublish]')?.dataset.unpublish;
    if (!hostname) return;
    const route = tunnelState?.routes.find((r) => r.hostname === hostname);
    const sure = await askConfirm({
        title: `Take ${hostname} offline?`,
        body: `${route?.label ?? 'It'} stops answering on that name and its DNS record is removed. Nothing in the app itself changes, and you can publish it again any time.`,
        confirmLabel: 'Take offline',
        danger: true,
    });
    if (!sure) return;
    await queueAction({
        title: `Taking ${hostname} offline`,
        request: (headers) => api(`/api/tunnel/routes/${encodeURIComponent(hostname)}`, { method: 'DELETE', headers }),
    });
    loadTunnel();
    loadApps();
});

$('tunnel-disconnect').addEventListener('click', async () => {
    const n = tunnelState?.routes.length ?? 0;
    const sure = await askConfirm({
        title: 'Disconnect from Cloudflare?',
        body: `${n ? `${n} published name${n === 1 ? '' : 's'} go${n === 1 ? 'es' : ''} offline and ${n === 1 ? 'its DNS record is' : 'their DNS records are'} removed. ` : ''}The connector stops and the token is forgotten. Your apps keep running and are still reachable on your home network.`,
        confirmLabel: 'Disconnect',
        danger: true,
    });
    if (!sure) return;
    await queueAction({
        title: 'Disconnecting from Cloudflare',
        request: (headers) => api('/api/tunnel/disconnect', { method: 'POST', headers }),
    });
    loadTunnel();
    loadApps();
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
/*
 * How much work is outstanding, as a count on the Update Queue button.
 *
 * This used to raise a toast listing what was waiting, on every job event. The
 * queued event already says a job was accepted, so that was the same news
 * twice -- and a toast is gone a moment later, which is the wrong shape for a
 * number that stays true until the work is done.
 */
let queueBusy = false;
function renderQueue(pending) {
    setQueueBadge((pending ?? []).length + (queueBusy ? 1 : 0));
}

const refreshQueueSoon = debounce(async () => {
    try {
        const { job } = await api('/api/jobs/current');
        renderQueue(job?.pending);
    } catch {
        /* the console is cosmetic */
    }
}, 250);

// ------------------------------------------------------- the update queue --

/*
 * Work that does not take the screen away.
 *
 * Updating and rebuilding used to open the blocking overlay, which refused a
 * second request outright -- so lining up "update the panel" and "rebuild
 * Nextcloud" meant sitting through the first with nothing else usable. These
 * now go to the queue instead: the server runs them one at a time as it always
 * did, the panel stays usable, and the Update Queue page shows what is running
 * and what is behind it.
 */

/** id -> resolve, for callers waiting on a job they sent to the queue. */
const queueEnds = new Map();
/*
 * Jobs that ended before anyone was waiting on them.
 *
 * A short job can finish -- and its `end` arrive on the stream -- before its
 * own HTTP response gets back to the caller that would have registered a
 * waiter. Without somewhere to put that ending, the caller waits for an event
 * that has already been and gone. Capped, because this is a safety net and not
 * a record of anything.
 */
const queueEnded = new Map();

function settleQueueJob(job) {
    const waiter = queueEnds.get(job.id);
    if (waiter) {
        queueEnds.delete(job.id);
        waiter(job);
        return;
    }
    queueEnded.set(job.id, job);
    if (queueEnded.size > 50) queueEnded.delete(queueEnded.keys().next().value);
}

/**
 * Sends one piece of work to the queue and resolves once it has finished.
 *
 * Resolving with the finished job rather than on acceptance is what lets a
 * caller hold a button disabled until it is really done, and put it back on
 * failure. `noCancel` marks the few that must run to the end once started.
 */
async function queueAction({ title, request, onEnd, noCancel = false }) {
    const headers = { 'X-QSH-Queue': '1', 'X-QSH-Queue-Title': encodeURIComponent(title) };
    if (noCancel) headers['X-QSH-No-Cancel'] = '1';

    let response;
    try {
        response = await request(headers);
    } catch (e) {
        toast(`${title}: ${e.message}`, 'bad');
        return { ok: false, status: 'failed', error: e.message };
    }

    // Finished inside the request, with no job to watch. "Already on the newest
    // version" is a real answer, and treating it as a failure would be wrong.
    if (!response?.jobId) {
        toast(response?.message ?? `${title}: nothing to do.`);
        return { ok: true, status: 'succeeded' };
    }

    showPeek({ id: response.jobId, name: title, state: 'Queued' });
    refreshQueueSoon();

    return new Promise((resolve) => {
        const finish = (job) => {
            const result = { ...job, ok: job.status === 'succeeded' };
            Promise.resolve()
                .then(() => onEnd?.(result))
                .catch(() => {});
            resolve(result);
        };
        const early = queueEnded.get(response.jobId);
        if (early) {
            queueEnded.delete(response.jobId);
            finish(early);
        } else {
            queueEnds.set(response.jobId, finish);
        }
    });
}

// --- the peek: a glance at queued work, not a modal ---

let peekJobId = null;
let peekHideTimer = null;

function showPeek({ id, name, state }) {
    peekJobId = id;
    clearTimeout(peekHideTimer);
    $('queue-peek-title').textContent = name;
    $('queue-peek-state').textContent = state;
    $('queue-peek-log').textContent = '';
    $('queue-peek').hidden = false;
}

function peekLine(jobId, line) {
    if (!peekJobId || jobId !== peekJobId) return;
    const log = $('queue-peek-log');
    log.textContent += `${line}\n`;
    // Only the tail is worth keeping here; the whole log is on the queue page.
    const lines = log.textContent.split('\n');
    if (lines.length > 60) log.textContent = lines.slice(-60).join('\n');
    log.scrollTop = log.scrollHeight;
}

function peekEnded(job) {
    if (!peekJobId || job.id !== peekJobId) return;
    $('queue-peek-state').textContent =
        { succeeded: 'Done', cancelled: 'Cancelled' }[job.status] ?? `Failed: ${job.error ?? 'unknown'}`;
    // A failure is worth leaving on screen longer than a success.
    clearTimeout(peekHideTimer);
    peekHideTimer = setTimeout(hidePeek, job.status === 'succeeded' ? 4000 : 12000);
}

function hidePeek() {
    clearTimeout(peekHideTimer);
    peekJobId = null;
    $('queue-peek').hidden = true;
}

$('queue-peek').addEventListener('click', () => {
    hidePeek();
    selectTab('queue');
});

// --- the badge ---

function setQueueBadge(count) {
    const badge = $('queue-count');
    if (!badge) return;
    badge.textContent = String(count);
    badge.hidden = count <= 0;
}

// --- the page ---

let queueElapsedTimer = null;

const fmtClock = (ms) => {
    const secs = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(secs / 60);
    return m ? `${m}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;
};

function queueRow(job, { clickable = false } = {}) {
    const li = document.createElement('li');
    li.className = `queue-item${clickable ? ' is-clickable' : ''}`;

    const name = document.createElement('span');
    name.className = 'queue-name';
    name.textContent = job.name;
    li.append(name);

    if (job.status && job.status !== 'queued') {
        const status = document.createElement('span');
        status.className = `queue-status ${job.status}`;
        status.textContent = job.status;
        li.append(status);
    }

    const when = document.createElement('span');
    when.className = 'queue-when';
    const stamp = job.finishedAt ?? job.startedAt ?? job.queuedAt;
    when.textContent = stamp ? new Date(stamp).toLocaleTimeString() : '';
    li.append(when);

    if (clickable && job.lines?.length) {
        li.addEventListener('click', () => {
            const open = li.querySelector('.queue-item-log');
            if (open) return open.remove();
            const log = document.createElement('pre');
            log.className = 'logview queue-item-log';
            log.textContent = job.lines.join('\n');
            li.append(log);
        });
    }
    return li;
}

function renderQueuePage(view) {
    const current = view.current;
    $('queue-current').hidden = !current;
    $('queue-current-empty').hidden = Boolean(current);

    if (current) {
        $('queue-current-name').textContent = current.name;
        $('queue-current-log').textContent = (current.lines ?? []).join('\n');
        $('queue-current-log').scrollTop = $('queue-current-log').scrollHeight;
        const cancel = $('queue-current-cancel');
        // The few that cannot be stopped say so rather than offering a button
        // that answers no.
        cancel.disabled = Boolean(current.noCancel);
        cancel.title = current.noCancel
            ? 'This one cannot be stopped partway: it would leave half of it behind.'
            : '';
        cancel.dataset.jobId = current.id;
    }

    const pending = view.pending ?? [];
    $('queue-pending-empty').hidden = pending.length > 0;
    const pendingList = $('queue-pending');
    pendingList.innerHTML = '';
    for (const job of pending) pendingList.append(queueRow(job));

    const history = view.history ?? [];
    $('queue-history-empty').hidden = history.length > 0;
    const historyList = $('queue-history');
    historyList.innerHTML = '';
    for (const job of history) historyList.append(queueRow(job, { clickable: true }));

    setQueueBadge(pending.length + (current ? 1 : 0));
    tickQueueElapsed(current);
}

function tickQueueElapsed(current) {
    clearInterval(queueElapsedTimer);
    if (!current?.startedAt) return;
    const started = new Date(current.startedAt).getTime();
    const paint = () => {
        $('queue-current-elapsed').textContent = fmtClock(Date.now() - started);
    };
    paint();
    queueElapsedTimer = setInterval(paint, 1000);
}

async function loadQueue() {
    try {
        renderQueuePage(await api('/api/jobs/queue'));
    } catch {
        /* the page is a view of something the server owns; a failed read is
           not worth an error on screen */
    }
}

/** Re-read, but only when somebody is looking at it. */
const refreshQueueIfOpen = debounce(() => {
    if ($('tab-queue')?.classList.contains('active')) loadQueue();
}, 200);

/*
 * The running job's log, line by line, while the page is open.
 *
 * Appended rather than re-fetched: the lines arrive on the stream anyway, and
 * asking the server again for a log that just grew by one line is a round trip
 * to learn what was already in hand.
 */
function appendQueuePageLine(jobId, line) {
    const pane = $('queue-current-log');
    if (!pane || $('queue-current').hidden) return;
    if ($('queue-current-cancel').dataset.jobId !== jobId) return;
    const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    pane.textContent += `${line}\n`;
    // Only follow along if they had not scrolled up to read something.
    if (atBottom) pane.scrollTop = pane.scrollHeight;
}

$('queue-current-cancel').addEventListener('click', async () => {
    const id = $('queue-current-cancel').dataset.jobId;
    if (!id) return;
    try {
        const r = await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
        if (r?.reason) toast(r.reason, 'bad');
    } catch (e) {
        toast(e.message, 'bad');
    }
    loadQueue();
});

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
        queueBusy = true;
        for (const line of job.lines ?? []) pushJobLine(line);
        renderQueue(job.pending);
        // Queued work was never the overlay's to adopt: it is watched on its
        // own page, which the badge points at.
        if (job.queued) {
            refreshQueueIfOpen();
            return;
        }
        adoptRunningJob(
            job,
            'This was already running when the page loaded. It runs in the manager, not in the browser, so refreshing or closing the tab never interrupted it.',
        );
    });
    jobStream.addEventListener('start', (event) => {
        const job = JSON.parse(event.data);
        queueBusy = true;
        renderQueue(job.pending);
        pushJobLine(`\n> ${job.name}`);

        // Queued work belongs to the peek and the queue page, never the overlay.
        if (job.queued) {
            showPeek({ id: job.id, name: job.name, state: 'Running' });
            refreshQueueIfOpen();
            return;
        }

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
        refreshQueueIfOpen();
        if (job.queued) {
            // Its own page says where it is in the line; a toast behind the
            // peek would be the same thing said twice.
            if (job.id === peekJobId) {
                $('queue-peek-state').textContent = job.running ? `Waiting for ${job.running}` : 'Queued';
            }
            return;
        }
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
        peekLine(jobId, line);
        appendQueuePageLine(jobId, line);
        // The overlay shows the action it started; a tab watching its own job
        // shows that one. Everything is in All logs either way.
        actionLine(jobId, line);
        if (inlineJob) appendInline(line);
    });
    jobStream.addEventListener('end', (event) => {
        const job = JSON.parse(event.data);
        queueBusy = false;
        renderQueue(job.pending);
        refreshQueueIfOpen();

        // Anyone holding a button until this finished hears about it first --
        // before the early returns below, which are about the overlay.
        settleQueueJob(job);
        if (job.queued) {
            peekEnded(job);
            loadServices().catch(() => {});
            refreshStatus();
            loadApps();
            return;
        }

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
        loadApps();
        loadTunnel().catch(() => {});
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
    const move = await askConfirm({
        title: `Move this panel to port ${port}?`,
        body: 'It restarts, and this page will follow it to the new address. Anything you have bookmarked stops working.',
        confirmLabel: 'Move it',
    });
    if (!move) return;

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
    const clear = await askConfirm({
        title: 'Remove the password?',
        body: 'Anyone who can reach this port will then have full control of your services and of Docker. Only sensible while the panel is on 127.0.0.1.',
        confirmLabel: 'Remove it',
        danger: true,
    });
    if (!clear) {
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
/**
 * The result of the update check, as a state rather than a sentence.
 *
 * All four answers used to be the same muted grey line, so "there is a new
 * version waiting" looked exactly like "nothing to report" and got skimmed
 * past. The state drives the colour and the glow; see .status-line in the
 * stylesheet.
 *
 * Built out of nodes and textContent rather than a template string: `head` and
 * `detail` carry a commit subject straight from GitHub, and that is somebody
 * else's text going into our page.
 */
function setUpdateStatus(state, head, detail, id = 'global-check-status') {
    const el = $(id);
    if (!el) return;
    el.className = state ? `status-line is-${state}` : 'status-line';
    el.replaceChildren();

    const dot = document.createElement('span');
    dot.className = 'status-dot';

    const body = document.createElement('span');
    body.className = 'status-body';

    const h = document.createElement('span');
    h.className = 'status-head';
    h.textContent = head;
    body.append(h);

    if (detail) {
        const d = document.createElement('span');
        d.className = 'status-detail';
        d.textContent = detail;
        body.append(d);
    }
    el.append(dot, body);
}

$('global-check-btn').addEventListener('click', async () => {
    const button = $('global-check-btn');
    const repo = $('global-repo').value.trim();
    const ref = $('global-ref').value.trim();
    button.disabled = true;
    setUpdateStatus('checking', 'Checking…');
    try {
        const q = new URLSearchParams({ repo, ref });
        const r = await api(`/api/system/panel-latest?${q}`);
        const when = r.latest.date ? new Date(r.latest.date).toLocaleString() : 'unknown date';
        if (r.upToDate === true) {
            setUpdateStatus('current', 'Up to date', `${ref} · ${r.latest.shortSha} · ${when}`);
        } else if (r.upToDate === false) {
            const n = r.compare?.behind;
            const ahead = n ? ` · ${n} commit${n === 1 ? '' : 's'} ahead of yours` : '';
            // The headline is the same three words every time, so it is
            // recognisable at a glance; the sha and subject go underneath.
            setUpdateStatus('update', 'Update available',
                `${r.latest.shortSha}${ahead}\n${r.latest.message}`);
        } else {
            // No recorded sha, which is every install that has not used this
            // button yet. Saying "up to date" here would be a guess.
            setUpdateStatus(null, `${ref} is at ${r.latest.shortSha} (${when}).`,
                'This install has no recorded commit, so there is nothing to compare it against yet.');
        }
    } catch (e) {
        setUpdateStatus('error', 'Could not check', e.message);
    } finally {
        button.disabled = false;
    }
});

$('global-update-btn').addEventListener('click', async () => {
    const button = $('global-update-btn');
    const repo = $('global-repo').value.trim();
    const ref = $('global-ref').value.trim();
    const update = await askConfirm({
        title: `Update the panel from ${repo}@${ref}?`,
        body: 'It will go offline for a minute or two while it rebuilds. Your services keep running.',
        confirmLabel: 'Update',
    });
    if (!update) return;

    button.disabled = true;
    try {
        await api('/api/system/panel-update', { method: 'POST', body: { repo, ref } });
    } catch (e) {
        kResult('global-update-result', e.message, true);
        button.disabled = false;
        return;
    }

    // Same overlay as every other action, driven by polling rather than by the
    // job stream. The updater cannot use the queue -- it replaces the process
    // that would be reporting -- so before this, an update that failed at its
    // first step said "Rebuilding, this page will come back on its own" and
    // then waited forever for a restart that was never coming.
    openAction({
        key: 'panel-update',
        title: `Updating the panel from ${repo}@${ref}`,
        note: 'It rebuilds in its own container, so this keeps running even if this page reloads. The panel drops out near the end and comes back on its own.',
    });
    pendingAction.cancellable = false;
    followPanelUpdate();
});

/**
 * Follows the detached updater by reading the file it writes a step at a time.
 *
 * Every failure mode here ends in a visible verdict: a step that reports an
 * error, or the panel never coming back. The one thing it must not do is treat
 * the panel going away as a fault -- that is the update working.
 */
function followPanelUpdate() {
    const deadline = Date.now() + 15 * 60_000;
    let shown = 0;
    let wasDown = false;
    let rebuilt = false;

    const tick = async () => {
        if (!pendingAction || pendingAction.finished) return;

        let status = null;
        try {
            status = await api('/api/system/panel-update/status');
            if (wasDown) return location.reload();
        } catch {
            // Expected: this is the panel being replaced under us.
            wasDown = true;
        }

        if (status) {
            for (const step of status.steps.slice(shown)) actionAppend(step);
            shown = Math.max(shown, status.steps.length);

            if (status.result === 'fail') {
                return finishAction({ status: 'failed', error: status.error ?? 'the update did not finish' });
            }
            // result=ok is written just before the restart, so from here the
            // panel disappearing is the expected next thing.
            if (status.result === 'ok' && !rebuilt) {
                rebuilt = true;
                actionAppend('Rebuilt. Waiting for the panel to come back…');
            }
        }

        if (Date.now() > deadline) {
            return finishAction({
                status: 'failed',
                error: 'the panel did not come back within fifteen minutes. Run: docker logs quickstart-home-panel-update',
            });
        }
        setTimeout(tick, 2000);
    };
    setTimeout(tick, 1000);
}

// Nothing else in the panel is guarded like this, because nothing else deletes
// the node, its chain data and the panel in one go.
const TEARDOWN_PHRASE = 'DELETE EVERYTHING';

$('global-teardown-confirm').addEventListener('input', (event) => {
    $('global-teardown-btn').disabled = event.target.value.trim() !== TEARDOWN_PHRASE;
});

$('global-teardown-btn').addEventListener('click', async () => {
    const teardown = await askConfirm({
        title: 'Remove every service, all its data and this panel?',
        body: 'This cannot be undone. Docker itself stays installed.',
        confirmLabel: 'Remove everything',
        danger: true,
    });
    if (!teardown) return;

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

/*
 * Registers the no-cache service worker, which exists only so the panel can be
 * installed to a home screen. Failure is ignored on purpose: this is not served
 * over https on a LAN address, and browsers refuse to register a worker on an
 * insecure origin. That refusal is expected and must not surface as an error --
 * the panel works identically without it, and iOS installs from the manifest
 * and the apple-touch-icon regardless.
 */
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
}

// ------------------------------------------------------------------ backup --

/**
 * The Backup tab.
 *
 * Destinations are chosen from a discovered list rather than typed, because a
 * mistyped path here does not fail: Docker creates a bind mount source that is
 * missing, so the copy would run onto the internal disk and report success.
 */
let backupSources = [];
let backupDrives = [];

function renderBackupSources() {
    const note = $('backup-sources-note');
    if (!note) return;
    if (!backupSources.length) {
        note.className = 'verdict bad';
        note.textContent =
            'Nextcloud has no shared folders yet, so there is nothing to back up. Add one under Settings.';
        return;
    }
    note.className = 'verdict';
    note.textContent = `Backs up what Nextcloud is serving: ${backupSources.join(', ')}.`;
}

function renderBackupDrives(selected) {
    const sel = $('backup-destination');
    if (!sel) return;
    if (!backupDrives.length) {
        sel.innerHTML = '<option value="">No drives found</option>';
        return;
    }
    const gb = (n) => `${(n / 1e9).toFixed(0)} GB`;
    sel.innerHTML =
        '<option value="">Choose a drive…</option>' +
        backupDrives
            .map(
                (d) =>
                    `<option value="${escapeHtml(d.path)}"${d.path === selected ? ' selected' : ''}>` +
                    `${escapeHtml(d.path)} — ${gb(d.free)} free of ${gb(d.total)}</option>`,
            )
            .join('');
    // A destination saved earlier for a drive that is not plugged in now would
    // otherwise silently become "Choose a drive", and saving would clear it.
    if (selected && !backupDrives.some((d) => d.path === selected)) {
        sel.insertAdjacentHTML(
            'beforeend',
            `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} — not plugged in</option>`,
        );
    }
}

async function loadBackup() {
    let r;
    try {
        r = await api('/api/backup');
    } catch {
        return;
    }
    const c = r.config ?? {};
    backupDrives = r.drives ?? [];
    backupSources = r.sources ?? [];
    renderBackupSources();
    renderBackupDrives(c.destination);
    $('backup-enabled').checked = Boolean(c.enabled);
    $('backup-mirror').checked = Boolean(c.mirrorDeletes);
    $('backup-interval').value = c.intervalMinutes ?? 15;

    const last = $('backup-last');
    if (c.lastRunAt) {
        last.hidden = false;
        last.className = c.lastOk === false ? 'verdict bad' : 'verdict ok';
        last.textContent = `${c.lastOk === false ? 'Last attempt failed' : 'Last backup'}: ${c.lastResult ?? ''} (${new Date(c.lastRunAt).toLocaleString()})`;
    } else {
        last.hidden = false;
        last.className = 'verdict';
        last.textContent = 'No backup has run yet.';
    }
}

$('backup-rescan').addEventListener('click', async () => {
    const button = $('backup-rescan');
    button.disabled = true;
    try {
        await loadBackup();
        toast(backupDrives.length ? `Found ${backupDrives.length} drive(s).` : 'No drives found.');
    } finally {
        button.disabled = false;
    }
});

$('backup-save').addEventListener('click', async () => {
    const err = $('backup-error');
    err.hidden = true;
    const body = {
        enabled: $('backup-enabled').checked,
        destination: $('backup-destination').value,
        intervalMinutes: Number($('backup-interval').value),
        mirrorDeletes: $('backup-mirror').checked,
    };
    try {
        await api('/api/backup', { method: 'PUT', body });
        kResult('backup-result', 'Saved.', false);
        await loadBackup();
    } catch (e) {
        err.hidden = false;
        err.textContent = e.message;
    }
});

$('backup-run').addEventListener('click', async () => {
    const pending = runAction({
        key: 'backup',
        title: 'Backing up',
        note: 'Copying to the drive. This runs in the manager, so closing this page does not stop it.',
        request: () => api('/api/backup/run', { method: 'POST' }),
    });
    // runAction opens the overlay synchronously before it awaits anything, so
    // pendingAction exists by the time this line runs. The bar needs to know
    // how many folders there are to turn one folder's percentage into a share
    // of the whole; the index starts below zero because the first "> /path"
    // line advances it to zero.
    if (pendingAction) {
        pendingAction.backupTotal = backupSources.length || 1;
        pendingAction.backupIndex = -1;
    }
    const job = await pending;
    if (job) loadBackup().catch(() => {});
});
