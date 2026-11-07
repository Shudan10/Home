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
    /*
     * The sign-in form's own request is the one 401 that is an answer rather
     * than a session running out. Treating it like the others put "Not signed
     * in." under a password box somebody had just typed into, which says the
     * opposite of what happened -- the server's "Incorrect password." is the
     * sentence they need. Everything else that 401s really has lost its
     * session, and goes back to the sign-in screen as before.
     */
    const signingIn = path === '/api/login';
    if (res.status === 401 && signingIn) throw new Error(data.error || 'Incorrect password.');
    if (res.status === 401) {
        showLogin();
        throw new Error('Not signed in.');
    }
    // Too many wrong passwords in a row. The server's own words say how long
    // to wait, and a bare "Too Many Requests" would not.
    if (res.status === 429) {
        throw new Error(data.error || 'Too many attempts. Wait a minute, then try again.');
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
    // A pill is right for one line and wrong for three: the round ends eat into
    // the first and last lines of a long one. Measured after the text is in,
    // because only the browser knows where it wrapped.
    const line = parseFloat(getComputedStyle(node).lineHeight) || 20;
    const padding = parseFloat(getComputedStyle(node).paddingTop) * 2 || 20;
    node.classList.toggle('multiline', node.offsetHeight - padding > line * 1.5);
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

/*
 * Controls waiting on a request of their own.
 *
 * A button is disabled while its request is out, and then the next poll
 * re-renders the card it sits on and switches it straight back on -- the
 * Tailscale HTTPS switches, the allow-list switch -- so a second click goes in
 * behind the first while the first is still running. Every render that sets
 * `disabled` asks here first, and a control is let go of on every way its
 * request can end, failures included, so nothing is left greyed out either.
 *
 * Keyed by name rather than by element, because the renders replace the
 * element and the name is what survives.
 */
const pendingControls = new Set();
const isHeld = (name) => pendingControls.has(name);

function holdControl(name, node = $(name)) {
    pendingControls.add(name);
    if (node) node.disabled = true;
}

function releaseControl(name, { node = $(name), enabled = true } = {}) {
    pendingControls.delete(name);
    if (node) node.disabled = !enabled;
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
    // For the sidebar dot, and the HTTPS addresses on each app's page.
    loadTailscale();
    loadKachat();
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
    if (name === 'backups') {
        loadBackup().catch(() => {});
        if (activeSubtab('backups') === 'backups-restore') loadRestore().catch(() => {});
    }
    // This one does change by itself, but the stream pushes those changes --
    // this is the first paint.
    if (name === 'queue') loadQueue();
    // Asked on arrival: the tunnel's health is Cloudflare's to report, live.
    if (name === 'tunnel') loadTunnel();
    // Devices come and go, so this is read fresh on arrival too.
    if (name === 'kachat') loadKachat();
    if (name === 'tailscale') {
        loadTailscale();
        if (activeSubtab('tailscale') === 'ts-mullvad') loadMullvad();
    }
    // The player lists change by themselves -- people join and leave -- so
    // they are fetched on arrival and then kept fresh while the tab is open.
    if (name === 'minecraft') {
        loadMinecraftPlayers();
        if (activeSubtab('minecraft') === 'minecraft-worlds') loadMinecraftWorlds();
    }
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

// A button elsewhere on a page that opens one of its sub-tabs, like the link
// from the Tunnel tab's connect form to the Setup API token guide.
for (const button of document.querySelectorAll('[data-goto-subtab]')) {
    button.addEventListener('click', () => selectSubtab(button.closest('section'), button.dataset.gotoSubtab));
}

/** The sub-tab currently showing in a section, or null if it has none. */
const activeSubtab = (tab) =>
    document.querySelector(`#tab-${tab} .subtab-btn.active`)?.dataset.subtab ?? null;

// --- service switches in the sidebar ---

const navSwitch = (service) => document.querySelector(`[data-service="${service}"]`);

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

    // App backups are one app after another, each a "> Name" line; the bar
    // moves an app's share at a time.
    if (pendingAction.key === 'snapshots' && /^> /.test(line)) {
        pendingAction.snapIndex = (pendingAction.snapIndex ?? -1) + 1;
        return setProgress(Math.min(0.95, pendingAction.snapIndex / (pendingAction.snapTotal || 1)));
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
    // Focus goes into the card, onto the card itself while it has no button to
    // offer -- Cancel appears once there is a job id, Close once it is over --
    // so a keyboard is inside the overlay from the start rather than on
    // whatever was clicked behind it.
    el('.action-card').focus();
    return action;
}

/** The buttons in the overlay that can take focus right now. */
const actionFocusables = () =>
    [...document.querySelectorAll('.action-card button')].filter((b) => !b.hidden && !b.disabled);

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

/** The states a job does not leave. */
const FINAL_JOB_STATES = new Set(['succeeded', 'failed', 'cancelled']);

/** What the panel says about a job it has no record of at all. */
const LOST_JOB = 'the panel restarted and lost track of this job — check the result';

/**
 * Asks the server how one job is doing.
 *
 * Resolves with the job as the server has it, with { status: 'queued' } for one
 * still waiting its turn, or with { status: 'gone' } when nothing anywhere
 * knows it. Throws when the panel cannot be reached, which is never an answer.
 *
 * `gone` is checked a second way before it is believed. /api/jobs/<id> only
 * looks at the running job and the finished ones, not at the line waiting --
 * so a job queued behind a half-hour rebuild came back `gone` within seconds of
 * being asked for, and an overlay asking about it declared it done before it
 * had started. The queue view does list the waiting ones, and it carries the
 * history as well, for a job that finished in the gap between the two reads.
 */
async function askJob(id) {
    const payload = await api(`/api/jobs/${id}`);
    if (payload?.job) return payload.job;

    const view = await api('/api/jobs/queue');
    if (view?.current?.id === id) return view.current;
    if ((view?.pending ?? []).some((job) => job.id === id)) return { id, status: 'queued' };
    const finished = (view?.history ?? []).find((job) => job.id === id);
    return finished ?? { id, status: 'gone' };
}

async function checkActionJob() {
    const action = pendingAction;
    if (!action?.jobId || action.finished) return stopActionWatchdog();

    let job;
    try {
        job = await askJob(action.jobId);
    } catch {
        // The panel is unreachable this instant. That is what the update
        // overlay expects to happen to it, so it is never a reason to give up
        // on the job -- the next tick asks again.
        return;
    }
    // Re-checked because the await above is a gap: the stream may have finished
    // this overlay, or the user may have closed it and started another.
    if (pendingAction !== action || action.finished) return stopActionWatchdog();

    if (job.status === 'gone') {
        // No record of it anywhere: the history is held in memory, so this is
        // the panel having restarted underneath the job, or the job being old
        // enough to have fallen out. Either way there is nobody left who knows
        // how it went, and saying "Done" would be a guess dressed as a fact.
        finishAction({ id: action.jobId, status: 'unknown', error: LOST_JOB });
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
    // The one thing to press now exists, so focus moves onto it -- unless it
    // has already gone somewhere else inside the card.
    if (!$('action-cancel').hidden && document.activeElement === el('.action-card')) $('action-cancel').focus();
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
    // Neither a success nor a failure: see checkActionJob.
    const unknown = job.status === 'unknown';
    actionAppend(
        cancelled
            ? '\n■ Cancelled. Anything it had already done is still done.'
            : ok
              ? '\n✓ Done.'
              : unknown
                ? `\n? Not known: ${job.error ?? LOST_JOB}.`
                : `\n✗ Failed: ${job.error ?? 'it did not finish'}`,
    );

    pendingAction.finished = true;
    stopActionWatchdog();
    $('action-spinner').hidden = true;
    $('action-cancel').hidden = true;
    $('action-title').textContent = `${pendingAction.title} — ${
        cancelled ? 'cancelled' : ok ? 'done' : unknown ? 'result unknown' : 'failed'
    }`;

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
    //
    // The backup card only when it is on screen. Reading it means discovering
    // drives, which starts a container, and doing that after every install,
    // start and stop was the panel's most expensive habit for a card nobody
    // was looking at. Rescan is there for a drive plugged in meanwhile.
    const reloads = [loadServices, refreshStatus, loadApps, loadTunnel];
    if (backupOnScreen()) reloads.push(loadBackup);
    for (const reload of reloads) {
        Promise.resolve(reload()).catch(() => {});
    }
}

/** Whether the Backup card is the one showing. */
const backupOnScreen = () => $('tab-backups')?.classList.contains('active');

$('action-close').addEventListener('click', closeAction);

// Escape is the usual way out of a dialog, and here it must not be one until
// the job has finished. Capturing, so nothing else sees the key first.
document.addEventListener(
    'keydown',
    (event) => {
        if (!pendingAction) return;
        // The confirm dialog asked from in here ("Cancel this job?") is on top
        // and owns the keyboard. Taking Escape from it left the question with
        // no keyboard way to say no; taking Tab left its buttons unreachable.
        // A modal <dialog> already keeps its own focus.
        if ($('confirm-dialog').open) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (pendingAction.finished) closeAction();
            return;
        }
        // The overlay stops the mouse reaching the page behind it; tab does not
        // care about overlays, so focus is kept inside by hand: round the
        // buttons that are showing, or on the card when there are none.
        if (event.key === 'Tab') {
            const card = el('.action-card');
            if (!card) return;
            const buttons = actionFocusables();
            const inside = card.contains(document.activeElement);
            if (!buttons.length) {
                event.preventDefault();
                card.focus();
                return;
            }
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            const at = document.activeElement;
            if (!inside || at === card || (event.shiftKey ? at === first : at === last)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
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
    minecraft: 'Minecraft',
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

/*
 * Whether there is anybody to poll for.
 *
 * A tab left open in the background used to ask for the whole machine's status
 * every four seconds and the services every ten, for as long as the browser
 * kept it -- days, on a desktop -- and kept doing it after signing out, each
 * request a 401 that bounced the sign-in screen again. Nothing reads the
 * answers while the page is hidden or signed out, so nothing is asked.
 */
const panelOpen = () => !$('app').classList.contains('hidden');
const pollable = () => panelOpen() && !document.hidden;

const startPolling = () => {
    refreshStatus();
    // Here rather than only on boot, so signing in from the form gets the
    // sidebar switches straight away instead of on the next ten-second tick.
    loadServices().catch(() => {});
    if (!pollTimer) pollTimer = setInterval(() => pollable() && refreshStatus(), 4000);
};
const stopPolling = () => {
    clearInterval(pollTimer);
    pollTimer = null;
};

// Coming back to the tab gets a fresh picture at once rather than one up to
// ten seconds old, which is what pausing would otherwise cost.
document.addEventListener('visibilitychange', () => {
    if (!pollable()) return;
    refreshStatus();
    loadServices().catch(() => {});
});

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
    const ts = h.tailscale;
    $('ov-tailscale').textContent = ts
        ? [ts.name, ts.ip].filter(Boolean).join(' · ')
        : 'Not on a tailnet. Install Tailscale on this machine and sign in, and every app gets an address that works from your other Tailscale devices.';
    $('ov-tailscale').classList.toggle('muted', !ts);
    $('ov-hostname').textContent = h.hostname ?? '–';
    $('ov-platform').textContent = `${h.platform ?? '–'} (${h.arch ?? '?'})`;
    $('ov-cpus').textContent = h.cpus ? `${h.cpus} cores` : '–';
    $('ov-uptime').textContent = fmtUptime(h.uptime);
    // One minute, five, fifteen -- the three the kernel reports, in that order.
    $('ov-load').textContent = h.loadAverage?.length ? h.loadAverage.join('  ') : '–';

    // The LAN and Tailscale addresses the app pages build their links from.
    refreshAppLinks();

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

/*
 * Settings somebody has changed and not yet applied.
 *
 * loadApps runs after every job, every tunnel and Tailscale change and every
 * time the overlay closes, and it used to write the saved settings back over
 * every field each time. So: tick two boxes, change a port, publish a name on
 * the Tunnel tab, come back -- and the form said what was saved an hour ago,
 * and Apply would have sent that. Whatever was being edited was quietly gone.
 *
 * A form is dirty from its first input or change until it is applied, or until
 * Discard changes throws the edits away. While it is dirty its fields are left
 * alone; the badges, links and notices around it still update, because those
 * are about the app rather than about what is being typed.
 */
const dirtyForms = new Set();

/** The fields each form owns. Built on demand: MC_* are defined further down. */
const formFields = (name) =>
    ({
        nextcloud: ['nextcloud-pub-web', 'nextcloud-port', 'nextcloud-user', 'nextcloud-domains'],
        jellyfin: ['jellyfin-pub-web', 'jellyfin-port', 'jellyfin-hwaccel'],
        mealplan: ['mealplan-pub-web', 'mealplan-port', 'mealplan-ref'],
        minecraft: [...Object.values(MC_CHECKS), ...Object.values(MC_FIELDS)],
        backup: [
            'backup-enabled', 'backup-mirror', 'backup-interval', 'backup-destination', 'snap-enabled', 'snap-keep',
            ...['nextcloud', 'kachat', 'jellyfin', 'mealplan', 'minecraft', 'panel'].map((k) => `snap-svc-${k}`),
        ],
    })[name] ?? [];

// Spelled out rather than built from APP_KEYS, which is declared further down
// and would not exist yet when this line runs.
const FORM_NAMES = ['nextcloud', 'jellyfin', 'mealplan', 'minecraft', 'backup'];

function setFormDirty(name, dirty) {
    if (dirty) dirtyForms.add(name);
    else dirtyForms.delete(name);
    // The way back out, shown only while there is something to go back from.
    const revert = $(`${name}-revert`);
    if (revert) revert.hidden = !dirty;
}
const isDirty = (name) => dirtyForms.has(name);

/** Which form a field belongs to, or null for one that is not a setting. */
function formOf(id) {
    if (!id) return null;
    return FORM_NAMES.find((name) => formFields(name).includes(id)) ?? null;
}

// One listener for every form: a field's own id says which form it is in.
for (const type of ['input', 'change']) {
    document.addEventListener(type, (event) => {
        const name = formOf(event.target?.id);
        if (name) setFormDirty(name, true);
    });
}

for (const name of FORM_NAMES) {
    $(`${name}-revert`)?.addEventListener('click', () => {
        setFormDirty(name, false);
        // Read back fresh rather than restored from a copy, so it is what the
        // server has now, not what it had when the editing started.
        Promise.resolve(name === 'backup' ? loadBackup() : loadApps()).catch(() => {});
    });
}

async function loadApps() {
    const r = await api('/api/apps');
    appsState = r;
    const c = r.config;

    // Defaults here as well as on the server. This whole function is one long
    // sequence of assignments, so a single missing key used to throw and leave
    // every field below it unpopulated, which the next save then posted back as
    // empty values. Nothing in here should be able to do that again.
    if (!isDirty('nextcloud')) {
        $('nextcloud-pub-web').checked = c.nextcloud?.publish?.web !== false;
        $('nextcloud-port').value = c.nextcloud?.hostPort ?? 8080;
        $('nextcloud-user').value = c.nextcloud?.adminUser ?? 'admin';
        $('nextcloud-domains').value = c.nextcloud?.trustedDomains ?? 'localhost';
        // Held in a variable rather than read back off the DOM: the list is
        // rows of text with a remove button each, and rebuilding it from the
        // config on every render is what keeps the two from drifting.
        sharedPaths = [...(c.nextcloud?.sharedPaths ?? [])];
        renderSharedPaths();
    }
    renderAppState('nextcloud', r.apps.nextcloud);
    loadNextcloudAdmin();

    // --- Jellyfin ---
    if (!isDirty('jellyfin')) {
        $('jellyfin-pub-web').checked = c.jellyfin?.publish?.web !== false;
        $('jellyfin-port').value = c.jellyfin?.hostPort ?? 8096;
        $('jellyfin-hwaccel').checked = Boolean(c.jellyfin?.hardwareAcceleration);
        mediaPaths = [...(c.jellyfin?.mediaPaths ?? [])];
        renderMediaPaths();
    }
    renderAppState('jellyfin', r.apps.jellyfin);

    // --- Meal Plan ---
    if (!isDirty('mealplan')) {
        $('mealplan-pub-web').checked = c.mealplan?.publish?.web !== false;
        $('mealplan-port').value = c.mealplan?.hostPort ?? 8083;
        // Only set when the field is not being typed in, so a reload landing
        // mid-edit does not overwrite what somebody is halfway through.
        if (document.activeElement !== $('mealplan-ref')) $('mealplan-ref').value = c.mealplan?.ref ?? 'main';
    }
    renderAppState('mealplan', r.apps.mealplan);
    loadMealPlanPassword();
    // Once per page load. loadApps runs on a timer, and the refs call reaches
    // GitHub -- cached server side, but there is no reason to ask repeatedly
    // for a list of branches that changes about never.
    if (!mealPlanRefsLoaded) {
        mealPlanRefsLoaded = true;
        loadMealPlanRefs();
    }

    // --- Minecraft ---
    if (!isDirty('minecraft')) fillMinecraftSettings(c.minecraft ?? {});
    renderAppState('minecraft', r.apps.minecraft);

    // Everything above was drawn from the addresses known right now.
    appLinkInputs = appLinkSignature();

    for (const app of APP_KEYS) {
        const running = Boolean(r.apps[app]?.container?.running);
        setNavHealth(app, !c[app]?.enabled ? 'off' : running ? 'ok' : 'bad');
    }
}

/** Every app with a tab of its own. The loops below are driven by this. */
const APP_KEYS = ['nextcloud', 'jellyfin', 'mealplan', 'minecraft'];

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
/**
 * This machine's address on Tailscale, or null when it is not on a tailnet.
 * The MagicDNS name when that is on, since it is the same for every device on
 * the tailnet and survives the 100.x address changing; the address otherwise.
 */
const tailscaleHost = () => hostSnapshot?.tailscale?.host ?? null;

/**
 * Puts exactly `text` on the clipboard.
 *
 * The panel is mostly opened over plain http -- on the home network, or over
 * Tailscale -- and there the browser does not offer navigator.clipboard at
 * all, because it is not a secure context. The old copy command still works
 * there, through a text box that exists only for the moment of copying.
 *
 * Copying by selecting the text was how links went wrong: a selection can end
 * on the line break after it, and `.../webdav/%0A` is a folder no file
 * manager can open. So what gets copied is the string, never the page text.
 */
async function copyText(text) {
    const value = String(text ?? '').trim();
    if (!value) return false;
    if (window.isSecureContext && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return true;
        } catch {
            /* fall through to the old way */
        }
    }
    const box = document.createElement('textarea');
    box.value = value;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.append(box);
    box.select();
    box.setSelectionRange(0, value.length);
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch {
        ok = false;
    }
    box.remove();
    return ok;
}

/** A Copy button for one value. The value rides in the attribute, not the text. */
const copyButton = (value) =>
    `<button type="button" class="ghost copy-btn" data-copy="${escapeHtml(String(value).trim())}" title="Copy">Copy</button>`;

document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    event.preventDefault();
    const value = button.dataset.copy;
    if (await copyText(value)) toast('Copied.');
    else toast(`Could not copy. Here it is to copy by hand: ${value}`, 'bad');
});

/** An app's HTTPS address on Tailscale, once it has been turned on for it. */
const tailscaleHttps = (key) => tsState?.serve?.find((a) => a.key === key && a.on && !a.broken)?.url ?? null;

function webdavLinks(hostPort, publicUrl, key = 'nextcloud') {
    const rows = [];
    const row = (url, label) =>
        `<div class="media-row"><code>${escapeHtml(url)}</code>` +
        `<span class="muted">${escapeHtml(label)}</span>${copyButton(url)}</div>`;

    if (publicUrl) {
        const u = new URL(publicUrl);
        rows.push(row(`${u.protocol === 'https:' ? 'davs' : 'dav'}://${u.host}/remote.php/webdav/`, 'from anywhere'));
    }
    const local = localHost();
    if (hostPort && local) rows.push(row(`dav://${local}:${hostPort}/remote.php/webdav/`, 'on this network'));
    // Plain dav, not davs: there is no certificate on that port, and the
    // tailnet already encrypts everything between its devices.
    // HTTPS once it is on for Nextcloud, and then davs: the certificate is a
    // real one, and some file managers will not save a password over dav.
    const tsHttps = tailscaleHttps(key);
    const ts = tailscaleHost();
    if (tsHttps) rows.push(row(`davs://${new URL(tsHttps).host}/remote.php/webdav/`, 'over Tailscale'));
    else if (hostPort && ts) rows.push(row(`dav://${ts}:${hostPort}/remote.php/webdav/`, 'over Tailscale'));
    return rows.join('');
}

function appLinks(hostPort, publicUrl, key = null) {
    const a = (url, label) =>
        `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(url)} ↗</a>` +
        `<span class="muted"> ${escapeHtml(label)}</span>${copyButton(url)}`;

    const rows = [];
    if (publicUrl) rows.push(a(publicUrl, 'from anywhere'));
    const local = localHost();
    if (hostPort && local) rows.push(a(`http://${local}:${hostPort}`, 'on this network'));
    // Any device signed in to the same tailnet, from anywhere, with no tunnel
    // or domain involved. http is right here: Tailscale encrypts the traffic.
    const tsHttps = key ? tailscaleHttps(key) : null;
    const ts = tailscaleHost();
    if (tsHttps) rows.push(a(tsHttps, 'over Tailscale'));
    else if (hostPort && ts) rows.push(a(`http://${ts}:${hostPort}`, 'over Tailscale'));
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

/*
 * The "Open it" block of an app's page: its addresses when it is up and
 * reachable, and otherwise a sentence saying why not.
 *
 * Its own function because it depends on two things that arrive on their own
 * schedule. The "on this network" address comes from the status poll
 * (hostSnapshot) and the Tailscale ones from loadTailscale (tsState); both
 * used to be read only when loadApps happened to run, and on a fresh page
 * loadApps usually wins that race -- so a running Nextcloud showed no local
 * link and plain-http Tailscale ones until something else reloaded the apps,
 * which on a quiet afternoon could be never. refreshAppLinks redraws just these
 * blocks when either of them changes.
 */
const APP_LINK_COPY = {
    nextcloud: 'Not installed yet. Installing builds it and leaves it switched off.',
    jellyfin: 'Not installed yet. Installing downloads the image and leaves it switched off.',
    mealplan: 'Not installed yet. Installing builds it and leaves it switched off.',
};

function renderAppLink(name, state) {
    const link = $(`${name}-link`);
    if (!link || !(name in APP_LINK_COPY) || !state) return;
    const cfg = appsState?.config?.[name] ?? {};
    const running = state.container?.running;
    const web = Boolean(cfg.publish?.web);
    link.hidden = false;
    // Hidden by default each pass, so the branches below only have to say
    // when it should appear rather than every branch remembering to hide it.
    if (name === 'nextcloud') $('nextcloud-webdav-card').hidden = true;

    if (running && (web || state.publicUrl)) {
        link.className = 'verdict ok';
        link.innerHTML = appLinks(web ? cfg.hostPort : null, state.publicUrl, name);

        if (name === 'nextcloud') {
            // Only offered when it is actually reachable, which is the same
            // condition as the links above -- an address nobody can connect
            // to is worse than no address.
            const dav = webdavLinks(web ? cfg.hostPort : null, state.publicUrl);
            $('nextcloud-webdav-card').hidden = !dav;
            $('nextcloud-webdav').innerHTML = dav;
        }
    } else if (running) {
        link.className = 'verdict';
        link.textContent =
            'Running, but not published on the host and not on a domain. Tick "Publish on the host" under Settings, or give it an address under Tunnel & domains.';
    } else {
        const note = appStatusNote(state, {
            absent: APP_LINK_COPY[name],
            stopped: 'Not running. Its switch in the sidebar starts it.',
        });
        link.className = note.bad ? 'verdict bad' : 'verdict';
        link.textContent = note.text;
    }
}

/** What the app links were last drawn from, so they are redrawn only on a change. */
let appLinkInputs = null;

const appLinkSignature = () =>
    JSON.stringify([
        hostSnapshot?.lanAddress ?? null,
        hostSnapshot?.tailscale?.host ?? null,
        (tsState?.serve ?? []).map((a) => [a.key, a.on, a.broken, a.url]),
    ]);

/**
 * Redraws the address blocks -- and nothing else -- when the addresses they
 * are built from have changed since they were last drawn. Cheap enough to call
 * on every status poll: almost always the signature matches and it returns.
 */
function refreshAppLinks() {
    if (!appsState) return;
    const signature = appLinkSignature();
    if (signature === appLinkInputs) return;
    appLinkInputs = signature;
    for (const name of Object.keys(APP_LINK_COPY)) renderAppLink(name, appsState.apps?.[name]);
    renderMinecraftJoin();
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
        renderAppLink(name, state);

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
        renderAppLink(name, state);

        // No media folders is not an error, but it is the reason an otherwise
        // working Jellyfin shows an empty library, so it is said out loud.
        const notice = $('jellyfin-notice');
        const cfg = appsState.config.jellyfin ?? {};
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
        renderAppLink(name, state);

        const build = $('mealplan-build');
        build.textContent = state.build?.builtAt
            ? `Built ${new Date(state.build.builtAt).toLocaleString()}${
                  state.build.ref ? ` from ${state.build.ref}` : ''
              }.`
            : 'Not built yet.';
    }

    if (name === 'minecraft') {
        const link = $('minecraft-link');
        link.hidden = false;
        if (running) {
            // The image's own health check is what knows when the world is
            // loaded. Until then a Java client gets "connection refused",
            // which reads as broken when it is only busy.
            const health = container.health;
            link.className = health === 'unhealthy' ? 'verdict bad' : health === 'starting' ? 'verdict' : 'verdict ok';
            link.textContent =
                health === 'starting'
                    ? 'Starting. The first time, it downloads the game and builds the world, which takes a few minutes. Players can join once this says ready.'
                    : health === 'unhealthy'
                      ? 'Running, but not answering players. The Log tab shows what it last said.'
                      : 'Running and ready. Players can join with these addresses.';
        } else {
            const note = appStatusNote(state, {
                absent: 'Not installed yet. Installing downloads the server and leaves it switched off.',
                stopped: 'Not running. Its switch in the sidebar starts it.',
            });
            link.className = note.bad ? 'verdict bad' : 'verdict';
            link.textContent = note.text;
        }
        renderMinecraftJoin();

        $('minecraft-build').textContent = state.build?.builtAt
            ? `Image downloaded ${new Date(state.build.builtAt).toLocaleString()}.`
            : 'Not installed yet.';
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
    setFormDirty('jellyfin', true);
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
    setFormDirty('nextcloud', true);
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
    setFormDirty('nextcloud', true);
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
    setFormDirty('jellyfin', true);
});

function collectAppConfig(name) {
    if (name === 'minecraft') return collectMinecraftSettings();
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
    if (await copyText(value)) {
        toast('Password copied.');
    } else {
        // Neither way of copying worked. Selecting it is then the only way
        // to get at it.
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
    /*
     * Held from the click until the job the save started has finished, not
     * just until the PUT answers. The PUT only saves and queues the restart;
     * a second Apply pressed while that restart runs queued a second one
     * behind it, which for Nextcloud is minutes of the same work twice.
     */
    $(`${name}-save`).addEventListener('click', async () => {
        const id = `${name}-save`;
        if (isHeld(id)) return;
        const err = $(`${name}-error`);
        err.hidden = true;
        holdControl(id);
        try {
            const r = await api(`/api/apps/${name}`, { method: 'PUT', body: { config: collectAppConfig(name) } });
            // Saved, so what is in the form is now what the server has, and
            // the next reload is free to write it back.
            setFormDirty(name, false);
            setTimeout(loadApps, 2000);
            if (r?.jobId) await waitForJob(r.jobId);
        } catch (e) {
            err.textContent = e.message;
            err.hidden = false;
        } finally {
            releaseControl(id);
        }
    });

    $(`${name}-update`).addEventListener('click', async () => {
        const id = `${name}-update`;
        if (isHeld(id)) return;
        const label = appsState?.apps?.[name]?.label ?? name;
        // Off for as long as the rebuild is queued or running, whatever a Check
        // pressed meanwhile says: the button is already doing what it offers.
        holdControl(id);
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
        let result = null;
        try {
            result = await queueAction({
                title: `Rebuilding ${label}`,
                request: (headers) => api(`/api/apps/${name}/update`, { method: 'POST', headers }),
            });
        } finally {
            // Built, so the answer the check gave is spent: the button goes
            // back to needing a fresh one rather than staying lit over a commit
            // that is now the installed one. Anything else -- refused, failed,
            // cancelled -- leaves the update that was found still waiting, so
            // it comes back on.
            releaseControl(id, { enabled: !result?.ok });
        }
        if (result?.ok) {
            setAppStatus(name, 'current',
                name === 'mealplan' ? 'Built from the newest commit' : 'Updated to the newest image',
                'Check again whenever you want to know if it has moved on.');
            loadUpdateBanner();
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
        // Publishing it was waiting on this, so the tunnel form should know now
        // rather than on the next reload.
        loadTunnel().catch(() => {});
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

/*
 * Both of these leave the button off while its own rebuild is queued or
 * running (isHeld): a Check pressed meanwhile still says what it found, and
 * lighting the button under a rebuild already in hand is how the same rebuild
 * got queued twice.
 */
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
    update.disabled = isHeld(update.id);
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
        update.disabled = isHeld(update.id);
    } else if (r.updateAvailable) {
        setAppStatus(name, 'update', 'Update available', `${r.shortSha}\n${r.message}`);
        update.disabled = isHeld(update.id);
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
            loadUpdateBanner();
        }
    });
}

// A different branch is a different question, so the last answer no longer
// applies and the button goes back to needing a check -- unless the branch is
// being moved to, which is itself a reason to rebuild.
$('mealplan-ref').addEventListener('input', () => {
    const changed = $('mealplan-ref').value.trim() !== (appsState?.config?.mealplan?.ref ?? 'main');
    // Never switched on under a rebuild that is already queued or running.
    $('mealplan-update').disabled = isHeld('mealplan-update') || !changed;
    setMealPlanStatus(null, changed
        ? 'Branch changed. Updating will build from it.'
        : 'Checked against GitHub every hour. Check for update asks right now.');
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

// --------------------------------------------------------------- minecraft ---

/*
 * Settings go through the same Apply as every other app. Players do not: each
 * change to who can join is one small request answered on the spot, because
 * "let Sam in" is a thing done while Sam is standing there waiting.
 */

const MC_CHECKS = {
    pvp: 'mc-pvp',
    hardcore: 'mc-hardcore',
    forceGamemode: 'mc-force-gamemode',
    allowNether: 'mc-allow-nether',
    allowFlight: 'mc-allow-flight',
    commandBlocks: 'mc-command-blocks',
    onlineMode: 'mc-online-mode',
    consoles: 'mc-consoles',
    eula: 'mc-eula',
};
const MC_FIELDS = {
    gamemode: 'mc-gamemode',
    difficulty: 'mc-difficulty',
    maxPlayers: 'mc-max-players',
    motd: 'mc-motd',
    version: 'mc-version',
    memory: 'mc-memory',
    javaPort: 'mc-java-port',
    bedrockPort: 'mc-bedrock-port',
    viewDistance: 'mc-view-distance',
    simulationDistance: 'mc-sim-distance',
    spawnProtection: 'mc-spawn-protection',
    seed: 'mc-seed',
    levelType: 'mc-level-type',
};
const MC_NUMBERS = new Set(['maxPlayers', 'javaPort', 'bedrockPort', 'viewDistance', 'simulationDistance', 'spawnProtection']);

function fillMinecraftSettings(m) {
    for (const [key, id] of Object.entries(MC_CHECKS)) $(id).checked = Boolean(m[key]);
    // A field somebody is typing in is left alone, so a reload landing mid-edit
    // does not throw away what they were halfway through.
    for (const [key, id] of Object.entries(MC_FIELDS)) {
        if (document.activeElement !== $(id)) $(id).value = m[key] ?? '';
    }
}

function collectMinecraftSettings() {
    const out = { enabled: Boolean(appsState?.config?.minecraft?.enabled) };
    for (const [key, id] of Object.entries(MC_CHECKS)) out[key] = $(id).checked;
    for (const [key, id] of Object.entries(MC_FIELDS)) {
        const value = $(id).value.trim();
        out[key] = MC_NUMBERS.has(key) ? Number(value) : value;
    }
    if (!out.version) out.version = 'LATEST';
    return out;
}

// Ticking the licence is the one thing standing between an install and a
// server, so it saves itself rather than waiting for an Apply further down.
// While an apply is already running the button is held, and a click on it does
// nothing -- so that is said, rather than the tick looking saved when it is not.
$('mc-eula').addEventListener('change', () => {
    if (isHeld('minecraft-save')) {
        toast('Settings are still being applied. Press Apply settings once that has finished.', 'bad');
        return;
    }
    $('minecraft-save').click();
});

/** The addresses to type into each game, built from the address that works from here. */
function renderMinecraftJoin() {
    const cfg = appsState?.config?.minecraft;
    const installed = Boolean(appsState?.apps?.minecraft?.container?.exists);
    $('mc-join').hidden = !installed || !cfg;
    if (!cfg) return;

    const host = localHost() ?? 'this machine';
    // A port the game assumes is left off, because the box that asks for it
    // is then one fewer thing to get wrong.
    $('mc-join-java').textContent = Number(cfg.javaPort) === 25565 ? host : `${host}:${cfg.javaPort}`;
    $('mc-join-bedrock').textContent = `${host}   port ${cfg.bedrockPort}`;
    // Friends on your tailnet join with no port forwarding at all. Consoles
    // cannot run Tailscale, so for them this line is no use, and it says so.
    const ts = tailscaleHost();
    $('mc-join-ts').hidden = !ts;
    if (ts) {
        $('mc-join-ts-java').textContent = Number(cfg.javaPort) === 25565 ? ts : `${ts}:${cfg.javaPort}`;
        $('mc-join-ts-bedrock').textContent = `${ts}   port ${cfg.bedrockPort}`;
    }
    $('mc-fwd-java').textContent = cfg.javaPort;
    $('mc-fwd-bedrock').textContent = cfg.bedrockPort;
    $('mc-fwd-host').textContent = hostSnapshot?.lanAddress ?? 'this machine';
}

$('mc-public-ip').addEventListener('click', async () => {
    const button = $('mc-public-ip');
    const out = $('mc-public-ip-value');
    button.disabled = true;
    try {
        const { address } = await api('/api/apps/minecraft/public-address');
        const cfg = appsState?.config?.minecraft ?? {};
        out.hidden = false;
        out.textContent = address
            ? `Java ${Number(cfg.javaPort) === 25565 ? address : `${address}:${cfg.javaPort}`} · Bedrock ${address} port ${cfg.bedrockPort}`
            : 'Unknown';
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        button.disabled = false;
    }
});

// --- players ---

let mcPlayers = null;
let mcPlayersBusy = false;

async function loadMinecraftPlayers() {
    if (mcPlayersBusy) return;
    mcPlayersBusy = true;
    try {
        mcPlayers = await api('/api/apps/minecraft/players');
        renderMinecraftPlayers();
        renderMinecraftJoin();
        loadMinecraftConsoles();
    } catch {
        /* the next poll tries again */
    } finally {
        mcPlayersBusy = false;
    }
}

const mcKey = (p) => (p.uuid ? p.uuid : String(p.name).toLowerCase());
const mcEdition = (p) => (p.platform === 'bedrock' ? 'Bedrock' : 'Java');

function mcButton(player, action, label, extra = '') {
    return `<button type="button" class="ghost mini ${extra}" data-mc-act="${action}" data-mc-name="${escapeHtml(player.name)}" data-mc-uuid="${escapeHtml(player.uuid ?? '')}" data-mc-platform="${player.platform === 'bedrock' ? 'bedrock' : 'java'}">${label}</button>`;
}

function mcRow(player, note, buttons) {
    return `<div class="media-row">
        <div class="mc-player"><strong>${escapeHtml(player.name)}</strong><span class="tag">${mcEdition(player)}</span>${
            note ? `<span class="muted">${escapeHtml(note)}</span>` : ''
        }</div>
        <div class="mc-actions">${buttons.join('')}</div>
    </div>`;
}

function renderMinecraftPlayers() {
    const p = mcPlayers;
    if (!p) return;

    const note = $('mc-players-note');
    const msg = !p.installed
        ? 'Minecraft is not installed yet.'
        : p.error
          ? p.error
          : !p.running
            ? 'The server is stopped. The list, operators and bans can still be changed here, and take effect when it starts.'
            : !p.ready
              ? 'The server is starting. Changes to the list work now; kicking waits until it is up.'
              : null;
    note.hidden = !msg;
    note.className = p.error ? 'verdict bad' : 'verdict';
    note.textContent = msg ?? '';

    const allowed = new Set(p.whitelist.map(mcKey));
    const opped = new Set(p.ops.map(mcKey));

    // --- online ---
    $('mc-online-count').textContent = p.running && p.ready ? `${p.online.length} of ${p.max ?? '?'}` : '–';
    $('mc-online').innerHTML = !p.running
        ? '<p class="muted">The server is not running.</p>'
        : !p.ready
          ? '<p class="muted">Starting up…</p>'
          : !p.online.length
            ? '<p class="muted">Nobody is playing right now.</p>'
            : p.online
                  .map((player) =>
                      mcRow(player, opped.has(mcKey(player)) ? 'operator' : '', [
                          p.whitelistOn && !allowed.has(mcKey(player)) ? mcButton(player, 'allow', 'Add to list') : '',
                          opped.has(mcKey(player)) ? mcButton(player, 'deop', 'Remove operator') : mcButton(player, 'op', 'Make operator'),
                          mcButton(player, 'kick', 'Kick'),
                          mcButton(player, 'ban', 'Ban', 'danger'),
                      ]),
                  )
                  .join('');

    // --- allow list ---
    const toggle = $('mc-wl-on');
    // Left alone while its own request is out: minecraftAct reloads this list
    // before it returns, and that redraw used to switch it back on mid-request.
    if (!isHeld('mc-wl-on')) toggle.checked = Boolean(p.whitelistOn);
    toggle.disabled = !p.installed || isHeld('mc-wl-on');
    $('mc-wl-hint').textContent = p.whitelistOn
        ? 'On: only the players below can join. Everyone else is turned away at the door.'
        : 'Off: anyone who knows the address can join. The list below is kept, and applies the moment this is turned on.';
    $('mc-wl-list').innerHTML = p.whitelist.length
        ? p.whitelist.map((player) => mcRow(player, '', [mcButton(player, 'disallow', 'Remove')])).join('')
        : '<p class="muted">Nobody on the list yet.</p>';

    $('mc-ops-list').innerHTML = p.ops.length
        ? p.ops.map((player) => mcRow(player, '', [mcButton(player, 'deop', 'Remove')])).join('')
        : '<p class="muted">No operators. Without one, nobody can use commands in the game, only in the Log tab here.</p>';

    $('mc-bans-list').innerHTML =
        p.bans.length || p.ipBans.length
            ? [
                  ...p.bans.map((player) => mcRow(player, player.reason || '', [mcButton(player, 'pardon', 'Unban')])),
                  // Address bans are made in the game with /ban-ip. Shown so
                  // they are not invisible, lifted from the console.
                  ...p.ipBans.map(
                      (b) => `<div class="media-row"><div class="mc-player"><strong>${escapeHtml(b.ip)}</strong><span class="tag">address</span><span class="muted">${escapeHtml(b.reason || '')} · lift with pardon-ip in the Log tab</span></div></div>`,
                  ),
              ].join('')
            : '<p class="muted">Nobody is banned.</p>';
}

async function minecraftAct(body, { quiet = false } = {}) {
    try {
        const r = await api('/api/apps/minecraft/players', { method: 'POST', body });
        if (!quiet) toast(r.message || 'Done.');
        return true;
    } catch (e) {
        toast(e.message, 'bad');
        return false;
    } finally {
        loadMinecraftPlayers();
    }
}

$('mc-wl-on').addEventListener('change', async () => {
    const box = $('mc-wl-on');
    const wanted = box.checked;
    holdControl('mc-wl-on');
    let ok = false;
    try {
        ok = await minecraftAct({ action: 'whitelist', enabled: wanted });
    } finally {
        if (!ok) box.checked = !wanted;
        releaseControl('mc-wl-on', { enabled: mcPlayers?.installed !== false });
    }
});

/** An Add button and the name box beside it, Enter included. */
function mcAddForm(inputId, platformId, buttonId, action, { reasonId = null, after = null } = {}) {
    const submit = async () => {
        const name = $(inputId).value.trim();
        if (!name) return toast('Type a name first.', 'bad');
        const body = { action, name, platform: $(platformId).value };
        if (reasonId) body.reason = $(reasonId).value.trim();
        if (after && !(await after(body))) return;
        $(buttonId).disabled = true;
        const ok = await minecraftAct(body);
        $(buttonId).disabled = false;
        if (ok) {
            $(inputId).value = '';
            if (reasonId) $(reasonId).value = '';
        }
    };
    $(buttonId).addEventListener('click', submit);
    for (const id of [inputId, reasonId].filter(Boolean)) {
        $(id).addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                submit();
            }
        });
    }
}

mcAddForm('mc-wl-name', 'mc-wl-platform', 'mc-wl-add', 'allow');
mcAddForm('mc-ops-name', 'mc-ops-platform', 'mc-ops-add', 'op');
mcAddForm('mc-ban-name', 'mc-ban-platform', 'mc-ban-add', 'ban', { reasonId: 'mc-ban-reason' });

$('tab-minecraft').addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-mc-act]');
    if (!button) return;
    const { mcAct: action, mcName: name, mcUuid: uuid, mcPlatform: platform } = button.dataset;

    if (action === 'ban') {
        const sure = await askConfirm({
            title: `Ban ${name}?`,
            body: 'They are put out of the game and cannot come back until they are unbanned, whether or not they are on the list.',
            confirmLabel: 'Ban',
            danger: true,
        });
        if (!sure) return;
    }
    button.disabled = true;
    await minecraftAct({ action, name, uuid: uuid || undefined, platform });
});

// --- xbox, playstation, switch ---

/*
 * The bridge's progress, said as the next thing to do: sign it in, then tell
 * console players which gamertag to add. Everything here is read from the
 * server log by the panel, because that is the only place the bridge reports.
 */
async function loadMinecraftConsoles() {
    let c;
    try {
        c = await api('/api/apps/minecraft/consoles');
    } catch {
        $('mc-consoles-checked').textContent = 'Could not check just now.';
        return;
    }
    $('mc-consoles-checked').textContent = `Checked ${new Date().toLocaleTimeString()}`;
    // Failing to sign in stops the bridge until the server restarts, so these
    // states need a way forward as well as a way to look again.
    const retry = { 'sign-in': 'Get a new code', 'no-profile': 'Try again', age: 'Try again', error: 'Try again' }[c.state];
    $('mc-consoles-actions').hidden = c.state === 'off';
    $('mc-consoles-retry').hidden = !retry;
    $('mc-consoles-retry').textContent = retry ?? 'Try again';
    // Only once an account is known. Before that there is nothing to forget:
    // the next code can be used with whichever account they like.
    $('mc-consoles-reset').hidden = !c.gamertag;
    const tag = $('mc-consoles-tag');
    const body = $('mc-consoles-body');
    const words = {
        off: ['off', ''],
        stopped: ['waiting', ''],
        starting: ['starting', ''],
        'sign-in': ['needs sign-in', 'warn'],
        'no-profile': ['needs an Xbox profile', 'warn'],
        age: ['needs attention', 'warn'],
        error: ['not working', 'warn'],
        connecting: ['connecting', ''],
        ready: ['ready', 'ok'],
    };
    const [word, kind] = words[c.state] ?? [c.state, ''];
    tag.textContent = word;
    tag.className = `tag ${kind}`;

    // Rewritten only when something changed, so a half-read code does not
    // flicker away under somebody every few seconds.
    const signature = JSON.stringify(c);
    if (body.dataset.sig === signature) return;
    body.dataset.sig = signature;

    const joinSteps = (gamertag) => `
        <ol class="steps">
          <li>On the console, open Minecraft and go to <strong>Play → Friends</strong>.</li>
          <li>Choose <strong>Add Friend</strong> (or <em>Find Cross-Platform Friends</em>) and search for <code>${escapeHtml(gamertag)}</code>. Add it.</li>
          <li>Within a minute the server appears under <strong>Joinable Friends</strong>. Select it to play.</li>
        </ol>
        <p class="hint">
          The account accepts friend requests by itself. It forgets players who
          have not joined for 15 days, who just add it again. If
          <em>Only players on this list can join</em> is on, add each player's
          gamertag to the list too, as Bedrock. On PlayStation and Switch the
          player has to be signed in to their Microsoft account inside
          Minecraft, and the account must allow cross-network play.
        </p>`;

    if (c.state === 'off') {
        body.innerHTML = `<p class="muted">Off. Consoles have no Add Server button, so they cannot join yet. Turn on
            <strong>Let Xbox, PlayStation and Switch players join</strong> under Settings, and the server will join
            them through the Friends tab.</p>`;
    } else if (c.state === 'stopped') {
        body.innerHTML = '<p class="muted">On, and it starts with the server. Start Minecraft and this card shows what to do next.</p>';
    } else if (c.state === 'starting') {
        body.innerHTML = '<p class="muted">The server is starting. The console bridge signs in once the world has loaded, usually within a minute or two.</p>';
    } else if (c.state === 'sign-in') {
        const signIn = microsoftSignInUrl(c.url);
        const open = signIn
            ? `<a href="${escapeHtml(signIn)}" target="_blank" rel="noreferrer noopener">${escapeHtml(signIn)} ↗</a>`
            : `<code>${escapeHtml(c.url ?? '')}</code>`;
        body.innerHTML = `
          <p>Sign the server in to its own Microsoft account. Once is enough; it remembers it.
            A new account needs an Xbox profile first: sign in to
            <a href="https://www.xbox.com" target="_blank" rel="noreferrer noopener">xbox.com ↗</a> with it once and pick a gamertag.</p>
          ${signIn ? '' : `<p class="verdict bad">The address below came from the server's log and does not look like a Microsoft one, so it is not a link here.
            Microsoft's own page for these codes is <code>https://www.microsoft.com/link</code>. Do not sign in anywhere else.</p>`}
          <ol class="steps">
            <li>Open ${open} on any device.</li>
            <li>Enter the code <code class="mc-code">${escapeHtml(c.code)}</code></li>
            <li>Sign in with the <strong>spare</strong> account, using its password (not a passwordless sign-in).</li>
          </ol>
          <p class="hint">This card moves on by itself once it has worked. Codes expire after about fifteen minutes. Get a new code restarts the server, which takes about a minute.</p>`;
    } else if (c.state === 'no-profile') {
        body.innerHTML = `
          <p class="verdict bad">Microsoft accepted that sign-in, but the account has no Xbox profile yet, so it cannot host a game.</p>
          <ol class="steps">
            <li>Open <a href="https://www.xbox.com" target="_blank" rel="noreferrer noopener">xbox.com ↗</a>, sign in with the same account, and follow the prompts to pick a gamertag.</li>
            <li>Come back and press <strong>Try again</strong>. The server restarts, which takes about a minute.</li>
            <li>Enter the new code this card shows, and sign in again.</li>
          </ol>`;
    } else if (c.state === 'age') {
        body.innerHTML = `<p class="verdict bad">Microsoft wants that account's age confirmed before it can play online. Sign in to
            <a href="https://www.xbox.com" target="_blank" rel="noreferrer noopener">xbox.com ↗</a> with it, finish the age check, then press Try again.</p>`;
    } else if (c.state === 'error') {
        body.innerHTML = `<p class="verdict bad">The console bridge stopped with an error, so consoles cannot join right now. Java and Bedrock players are not affected. Try again restarts the server, and the Log tab has the full story.</p>
            <p class="hint">${escapeHtml(c.error ?? '')}</p>`;
    } else {
        body.innerHTML = `
          <p>${c.state === 'ready' ? 'Ready.' : 'Signed in, and opening the session…'} The server's account is
            <code class="mc-code">${escapeHtml(c.gamertag)}</code>
            <span class="muted">(${fmtNum(c.friends)} of ${fmtNum(c.maxFriends)} friends)</span></p>
          ${joinSteps(c.gamertag)}`;
    }
}

/**
 * The sign-in address, but only if it really is Microsoft's.
 *
 * It is read out of the Minecraft server's log, and anything that can get a
 * line into that log -- a player's chat message, a plugin, a crafted name --
 * could otherwise put a link of its choosing on this card, next to the words
 * "sign in with the spare account". So it is a link only when it is https on
 * one of the hosts Microsoft signs people in from, subdomains included, and
 * shown as plain text with a warning when it is anything else. The pattern
 * that pulls it out of the log is anchored on the server as well; this is the
 * second lock, at the point where it becomes clickable.
 */
const MICROSOFT_HOSTS = ['microsoft.com', 'live.com', 'microsoftonline.com', 'xbox.com'];

function microsoftSignInUrl(raw) {
    let url;
    try {
        url = new URL(String(raw ?? '').trim());
    } catch {
        return null;
    }
    // No credentials and no odd port: https://microsoft.com@evil.example/ is a
    // link to evil.example, and none of Microsoft's pages need either.
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    return MICROSOFT_HOSTS.some((d) => host === d || host.endsWith(`.${d}`)) ? url.href : null;
}

$('mc-consoles-reset').addEventListener('click', resetMinecraftConsoles);

$('mc-consoles-check').addEventListener('click', async () => {
    const button = $('mc-consoles-check');
    button.disabled = true;
    await loadMinecraftConsoles();
    button.disabled = false;
});

$('mc-consoles-retry').addEventListener('click', async () => {
    const online = mcPlayers?.online?.length ?? 0;
    if (online) {
        const sure = await askConfirm({
            title: 'Restart the server?',
            body: `${online === 1 ? '1 player is' : `${online} players are`} on the server and will be disconnected for about a minute.`,
            confirmLabel: 'Restart',
        });
        if (!sure) return;
    }
    const button = $('mc-consoles-retry');
    button.disabled = true;
    await queueAction({
        title: 'Restarting Minecraft to sign in again',
        request: (headers) => api('/api/apps/minecraft/restart', { method: 'POST', headers }),
    });
    button.disabled = false;
    loadMinecraftConsoles();
});

async function resetMinecraftConsoles() {
    const sure = await askConfirm({
        title: 'Use a different account?',
        body: 'The server forgets the account it signed in with, and its friend list. Console players will need to add the new account instead.\n\nThe server restarts to ask for the new sign-in, which disconnects everyone for about a minute.',
        confirmLabel: 'Sign out and restart',
    });
    if (!sure) return;
    try {
        const r = await api('/api/apps/minecraft/consoles/reset', { method: 'POST' });
        toast(r.restarting ? 'Signed out. Restarting to ask for a new account.' : 'Signed out. The next start asks for an account.');
    } catch (e) {
        toast(e.message, 'bad');
    }
    $('mc-consoles-body').dataset.sig = '';
    loadMinecraftConsoles();
}

// --- worlds ---

let mcWorlds = null;

async function loadMinecraftWorlds() {
    try {
        mcWorlds = await api('/api/apps/minecraft/worlds');
    } catch (e) {
        $('mc-worlds-list').innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
        return;
    }
    const list = mcWorlds.worlds;
    const note = $('mc-worlds-note');
    const hasCurrent = list.some((w) => w.current);
    const msg = !mcWorlds.installed
        ? 'Minecraft is not installed yet, so there are no worlds to show.'
        : !hasCurrent
          ? `The server is set to "${mcWorlds.current}", which does not exist yet. It makes a new world with that name the next time it starts.`
          : null;
    note.hidden = !msg;
    note.textContent = msg ?? '';

    $('mc-worlds-list').innerHTML = list.length
        ? list
              .map((w) => {
                  const facts = [
                      w.version ? `Minecraft ${w.version}` : null,
                      humanBytes(w.bytes),
                      w.lastPlayed ? `last played ${new Date(w.lastPlayed).toLocaleDateString()}` : null,
                  ].filter(Boolean);
                  // The name inside the world is what people recognise, but the
                  // folder is what the panel and the server call it.
                  const title = w.levelName || w.name;
                  return `<div class="media-row">
                      <div class="mc-player">
                        <strong>${escapeHtml(title)}</strong>
                        ${w.current ? '<span class="tag ok">in use</span>' : ''}
                        ${w.newer ? '<span class="tag warn">newer than this server</span>' : ''}
                        <span class="muted">${title === w.name ? '' : `${escapeHtml(w.name)} · `}${escapeHtml(facts.join(' · '))}</span>
                      </div>
                      ${w.current ? '' : `<div class="mc-actions"><button type="button" class="ghost mini" data-mc-world="${escapeHtml(w.name)}">Switch to this world</button></div>`}
                  </div>`;
              })
              .join('')
        : '<p class="muted">No worlds yet. The server makes its first one when it first starts, or add your own below.</p>';
}

document.querySelector('[data-subtab="minecraft-worlds"]').addEventListener('click', loadMinecraftWorlds);

$('mc-worlds-list').addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-mc-world]');
    if (!button) return;
    const name = button.dataset.mcWorld;
    const world = mcWorlds?.worlds?.find((w) => w.name === name);
    const label = world?.levelName || name;

    if (mcWorlds?.running || world?.newer) {
        const online = mcPlayers?.online?.length ?? 0;
        const sure = await askConfirm({
            title: `Switch to ${label}?`,
            body: [
                mcWorlds?.running
                    ? online
                        ? `The server restarts, which disconnects ${online === 1 ? 'the 1 player' : `all ${online} players`} for about a minute.`
                        : 'The server restarts, which takes about a minute.'
                    : null,
                'The current world is saved and kept.',
                world?.newer
                    ? `\n${label} was made with a newer Minecraft than the world in use. If the server has not moved to that version, it will refuse to start until you switch back or set a newer version.`
                    : null,
            ].filter(Boolean).join(' '),
            confirmLabel: 'Switch',
        });
        if (!sure) return;
    }
    button.disabled = true;
    const result = await queueAction({
        title: `Switching Minecraft to ${label}`,
        request: (headers) => api('/api/apps/minecraft/worlds/switch', { method: 'POST', headers, body: { name } }),
    });
    if (!result.ok && result.error) toast(result.error, 'bad');
    button.disabled = false;
    loadMinecraftWorlds();
    loadApps();
});

const worldAddResult = (result) => {
    if (result.ok) toast('World added. Press Switch to this world when you want to play it.');
    else if (result.error) toast(result.error, 'bad');
    loadMinecraftWorlds();
};

/** XHR rather than fetch, because only XHR reports how far an upload has got. */
function sendWorldFile(file, headers) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/apps/minecraft/worlds/upload?filename=${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
        xhr.upload.addEventListener('progress', (event) => {
            if (!event.lengthComputable) return;
            const pct = Math.round((event.loaded / event.total) * 100);
            $('mc-world-pct').textContent = `${pct}%`;
            $('mc-world-bar').style.width = `${pct}%`;
        });
        xhr.addEventListener('load', () => {
            let data = {};
            try {
                data = JSON.parse(xhr.responseText);
            } catch {
                /* a proxy's error page, for one */
            }
            if (xhr.status === 401) showLogin();
            if (xhr.status >= 200 && xhr.status < 300) resolve(data);
            else if (xhr.status === 413) reject(new Error(data.error || 'That file is too big to send this way. Open the panel by its home address, or add it from this machine.'));
            else reject(new Error(data.error || `The upload failed (${xhr.status}).`));
        });
        xhr.addEventListener('error', () => reject(new Error('The upload was cut off. Check the connection and try again.')));
        xhr.send(file);
    });
}

$('mc-world-upload').addEventListener('click', async () => {
    const box = $('mc-world-file');
    const file = box.files?.[0];
    if (!file) return toast('Choose a file first.', 'bad');
    // Said now rather than after sending all of it.
    if (/\.(?:mcworld|mctemplate)$/i.test(file.name)) {
        return toast('That is a Bedrock world, and this server runs Java worlds. Convert it with Chunker first (chunker.app).', 'bad');
    }
    const button = $('mc-world-upload');
    button.disabled = true;
    $('mc-world-progress').hidden = false;
    $('mc-world-pct').textContent = '0%';
    $('mc-world-bar').style.width = '0%';
    const result = await queueAction({
        title: `Adding ${file.name}`,
        request: (headers) => sendWorldFile(file, headers),
    });
    $('mc-world-progress').hidden = true;
    button.disabled = false;
    if (result.ok) box.value = '';
    worldAddResult(result);
});

$('mc-world-add').addEventListener('click', async () => {
    const box = $('mc-world-path');
    const path = box.value.trim();
    if (!path) return toast('Type the path first.', 'bad');
    const button = $('mc-world-add');
    button.disabled = true;
    const result = await queueAction({
        title: `Adding ${path.split('/').filter(Boolean).pop() ?? 'a world'}`,
        request: (headers) => api('/api/apps/minecraft/worlds/import', { method: 'POST', headers, body: { path } }),
    });
    button.disabled = false;
    if (result.ok) box.value = '';
    worldAddResult(result);
});

// --- log ---

let mcLogBusy = false;

async function loadMinecraftLog() {
    if (mcLogBusy) return;
    mcLogBusy = true;
    const view = $('mc-log');
    try {
        if (!appsState?.apps?.minecraft?.container?.exists) {
            view.textContent = 'Minecraft is not installed yet.';
            return;
        }
        const { text } = await api('/api/logs?container=minecraft&tail=800');
        // Kept at the bottom only if it already was, so scrolling back to read
        // something is not undone by the next refresh.
        const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
        // Paper colours its console, and the codes would show as junk.
        view.textContent =
            String(text ?? '')
                .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
                .split('\n')
                // The server logs two lines for every console connection, and
                // this page's own player list makes one every eight seconds.
                // Left in, they bury anything worth reading.
                .filter((line) => !/Thread RCON Client .* (?:started|shutting down)/.test(line))
                .join('\n') || 'Nothing logged yet.';
        if (atBottom) view.scrollTop = view.scrollHeight;
    } catch {
        /* the next poll tries again */
    } finally {
        mcLogBusy = false;
    }
}

async function sendMinecraftCommand(command) {
    const out = $('mc-command-out');
    try {
        const r = await api('/api/apps/minecraft/command', { method: 'POST', body: { command } });
        out.hidden = false;
        out.textContent = `> ${command}\n${r.output}`;
        return true;
    } catch (e) {
        toast(e.message, 'bad');
        return false;
    } finally {
        loadMinecraftLog();
    }
}

$('mc-command-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const box = $('mc-command');
    const command = box.value.trim();
    if (!command) return;
    if (await sendMinecraftCommand(command)) box.value = '';
});

for (const button of document.querySelectorAll('[data-mc-command]')) {
    button.addEventListener('click', () => sendMinecraftCommand(button.dataset.mcCommand));
}

/*
 * Kept fresh only while somebody is looking. The player list costs a console
 * command and the log a docker call, which is nothing once and wasteful every
 * few seconds from a tab sitting in the background.
 */
const mcVisible = () => !document.hidden && $('tab-minecraft').classList.contains('active');
setInterval(() => {
    if (mcVisible()) loadMinecraftPlayers();
}, 8000);
setInterval(() => {
    if (mcVisible() && activeSubtab('minecraft') === 'minecraft-log') loadMinecraftLog();
}, 3000);
document.querySelector('[data-subtab="minecraft-log"]').addEventListener('click', loadMinecraftLog);

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
    minecraft: 'the world and everything built in it, and the allow list, operators and bans',
    kachat: 'every photo, video and voice message sent from it, and the contacts backups in it. Every link sent from it stops working',
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
    // Its page reads more than this poll knows, so it is read again whenever
    // the switch or an install changes what this poll does know.
    const kc = serviceState.kachat;
    if (kc && kcState && (kc.installed !== kcState.installed || kc.running !== kcState.running)) loadKachat();
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
                ? 'Installing sets it up. There is nothing to keep running afterwards, so it gets no switch. Everything behind this is what it will look like.'
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
        <input type="checkbox" data-keepdata="${escapeHtml(key)}"> Keep the data, remove only the containers and images
      </label>
      <div class="row">
        <button class="ghost danger" data-douninstall="${escapeHtml(key)}" ${installed ? '' : 'disabled'}>
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
                ? 'Setting it up. Leave this open until it says it is done.'
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
        // The note says it runs to the end, and the overlay used to offer
        // Cancel anyway -- which the server then refused, or worse, honoured
        // half way through deleting the volumes. No button, and the no-cancel
        // header so the queue page's own Cancel is off for it too.
        cancellable: false,
        request: () =>
            api(`/api/services/${key}/uninstall`, {
                method: 'POST',
                body: { confirm: key, keepData },
                headers: { 'X-QSH-No-Cancel': '1' },
            }),
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
const SUGGESTED_NAME = { nextcloud: 'cloud', jellyfin: 'media', mealplan: 'meals', kachat: 'share', panel: 'panel', custom: 'home' };

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
    // A blocked service stays in the list rather than being disabled: a greyed
    // option gives no reason, and picking it is how the reason gets shown.
    svc.innerHTML = t.services
        .map((x) => `<option value="${escapeHtml(x.key)}">${escapeHtml(x.label)}${x.blocked ? ' (needs a password first)' : ''}</option>`)
        .join('');
    if (keepSvc && t.services.some((x) => x.key === keepSvc)) svc.value = keepSvc;

    const zone = $('pub-zone');
    const keepZone = zone.value;
    zone.innerHTML = t.zones.map((z) => `<option value="${escapeHtml(z.id)}">${escapeHtml(z.name)}</option>`).join('');
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
    // Something that cannot be published says why where the warning goes, and
    // the button stays off: the server refuses it anyway, and a button that
    // only ever produces an error is worse than one that is plainly not on.
    if (service.blocked) {
        warn.hidden = false;
        warn.className = 'verdict bad';
        warn.textContent = service.blocked;
    } else {
        warn.className = 'verdict warn';
        warn.hidden = !service.warning;
        warn.textContent = service.warning ?? '';
    }
    $('pub-go').disabled = Boolean(service.blocked);

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

// -------------------------------------------------------------- tailscale ---

/*
 * Tailscale: this machine's status, HTTPS addresses for the apps, the devices
 * on the tailnet, and how to put Tailscale on the next one. Read only from
 * the daemon on this machine; the admin console is linked for the rest.
 */
let tsState = null;

const TS_OS_NAMES = { linux: 'Linux', windows: 'Windows', macOS: 'macOS', iOS: 'iOS', android: 'Android', tvOS: 'tvOS' };

async function loadTailscale({ fresh = false } = {}) {
    try {
        tsState = await api(`/api/tailscale${fresh ? '?fresh=1' : ''}`);
    } catch {
        return;
    }
    renderTailscale();
}

function relativeTime(iso) {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 90) return 'just now';
    const m = Math.round(s / 60);
    if (m < 90) return `${m} minutes ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} hours ago`;
    const d = Math.round(h / 24);
    return d < 60 ? `${d} days ago` : new Date(iso).toLocaleDateString();
}

const tsCopy = copyButton;

function renderTailscale() {
    const t = tsState;
    if (!t) return;

    setNavHealth('tailscale', !t.installed ? 'absent' : !t.running ? 'warn' : t.health?.length ? 'warn' : 'ok');

    // This machine: one of three starting points.
    $('ts-setup').hidden = t.running;
    $('ts-live').hidden = !t.running;
    if (!t.running) {
        const tag = $('ts-setup-state');
        const body = $('ts-setup-body');
        if (t.error) {
            tag.textContent = 'unknown';
            tag.className = 'tag warn';
            body.innerHTML = `<p class="muted">${escapeHtml(t.error)}</p>`;
        } else if (!t.installed) {
            tag.textContent = 'not installed';
            tag.className = 'tag off';
            body.innerHTML = `<p class="muted">Tailscale is not on this machine. To put it on, run these in a terminal on it:</p>
                <pre class="cmd">curl -fsSL https://tailscale.com/install.sh | sh</pre>
                <pre class="cmd">sudo tailscale up</pre>
                <p class="muted">The second one prints a link: open it and sign in. Then select <strong>Check again</strong>.</p>`;
        } else {
            tag.textContent = t.state === 'NeedsLogin' ? 'signed out' : (t.state ?? 'stopped').toLowerCase();
            tag.className = 'tag warn';
            body.innerHTML = t.authURL
                ? `<p class="muted">Tailscale is waiting for somebody to sign in. Open this link and sign in:</p>
                   <p><a href="${escapeHtml(t.authURL)}" target="_blank" rel="noreferrer noopener">${escapeHtml(t.authURL)} ↗</a></p>`
                : `<p class="muted">Tailscale is installed but not connected. In a terminal on this machine, run:</p>
                   <pre class="cmd">sudo tailscale up</pre>
                   <p class="muted">If it prints a link, open it and sign in. Then select <strong>Check again</strong>.</p>`;
        }
    } else {
        const tag = $('ts-state');
        tag.textContent = t.health?.length ? 'connected, with warnings' : 'connected';
        tag.className = `tag ${t.health?.length ? 'warn' : 'ok'}`;
        $('ts-name').textContent = t.self.dnsName ?? t.self.name;
        $('ts-ip').textContent = t.self.ip ?? '–';
        $('ts-version').textContent = t.version ?? '–';
        $('ts-magicdns').textContent = t.magicDNS ? 'on' : 'off';
        $('ts-account').textContent = t.account ?? '–';
        $('ts-https').textContent = t.https?.enabled ? 'on' : 'off';
        $('ts-expiry').textContent = t.self.keyExpiry ? new Date(t.self.keyExpiry).toLocaleDateString() : 'never';

        // Things worth acting on, in the order they matter.
        const notes = [];
        for (const h of t.health ?? []) notes.push(['bad', h]);
        if (!t.magicDNS) {
            notes.push(['bad', 'MagicDNS is off, so other devices have to use the 100.x address rather than the name. Turn it on in the DNS page of the admin console.']);
        }
        if (t.exitNode) {
            notes.push([
                'bad',
                `This machine sends its internet traffic through ${t.exitNode.mullvad ? 'the Mullvad exit node' : 'the exit node'} ${t.exitNode.name}${t.exitNode.online ? '' : ', which is offline right now'}. So do the Cloudflare tunnel and every app on it. To stop, run: sudo tailscale set --exit-node=`,
            ]);
        }
        if (t.self.keyExpiry) {
            notes.push([
                'warn',
                `This machine has to be signed in again on ${new Date(t.self.keyExpiry).toLocaleDateString()}, and until then nothing can reach it over Tailscale. For a server, turn that off: in the admin console, open Machines, select the … beside ${t.self.name}, then Disable key expiry.`,
            ]);
        }
        $('ts-notes').innerHTML = notes
            .map(([kind, text]) => `<div class="verdict ${kind}">${escapeHtml(text)}</div>`)
            .join('');
    }

    // HTTPS for apps.
    const check = (done, text) => `<li><span class="svc-dot ${done ? 'ok' : 'bad'}"></span><span>${text}</span></li>`;
    const httpsOn = Boolean(t.https?.enabled);
    $('ts-checks').innerHTML = [
        check(t.running, t.running ? 'Tailscale is running on this machine.' : 'Tailscale is not running on this machine. See <strong>This machine</strong>.'),
        check(t.magicDNS, t.magicDNS ? 'MagicDNS is on.' : 'MagicDNS is off.'),
        check(httpsOn, httpsOn ? 'HTTPS certificates are on for your tailnet.' : 'HTTPS certificates are off for your tailnet.'),
    ].join('');
    $('ts-enable-https').hidden = !t.running || httpsOn;
    $('ts-cert-name').textContent = t.self?.dnsName ?? 'this machine’s name';

    const ready = t.running && httpsOn;
    $('ts-serve').innerHTML = (t.serve ?? [])
        .map((a) => {
            const note = a.funnel
                ? `<p class="ts-row-note warn">Tailscale Funnel is on for this port, so this address is open to the whole internet, not just your tailnet. Turn Funnel off with <code>tailscale funnel --https=${a.port} off</code> if that is not what you want.</p>`
                : a.broken
                  ? `<p class="ts-row-note warn">${escapeHtml(a.label)}'s network port is off, so this address has nothing to reach. Turn the port back on in its settings, or turn this off.</p>`
                  : a.blocked
                    ? `<p class="ts-row-note muted">${escapeHtml(a.blocked)}</p>`
                    : '';
            const dav =
                a.key === 'nextcloud' && a.on && a.url
                    ? `<span class="ts-addr"><span class="muted">In a file manager: <code>davs://${escapeHtml(new URL(a.url).host)}/remote.php/webdav/</code></span>${tsCopy(`davs://${new URL(a.url).host}/remote.php/webdav/`)}</span>`
                    : '';
            const address = a.url
                ? a.on
                    ? `<span class="ts-addr"><a href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(a.url)} ↗</a>${tsCopy(a.url)}</span>`
                    : `<span class="muted">Would be at ${escapeHtml(a.url)}</span>`
                : '';
            // Off while its own request is out, whatever the state says: this
            // whole list is redrawn on every Tailscale read, and that redraw
            // used to hand the switch back mid-request.
            const disabled = isHeld(`ts-serve:${a.key}`) || (!a.on && (!ready || a.blocked)) ? 'disabled' : '';
            return `<div class="ts-row">
                <div class="ts-row-main">
                    <span class="ts-row-title">${escapeHtml(a.label)}${a.localPort ? ` <span class="muted">→ port ${a.localPort}</span>` : ''}</span>
                    ${address}
                    ${dav}
                </div>
                <label class="switch" title="${a.on ? 'Turn HTTPS off' : 'Turn HTTPS on'}">
                    <input type="checkbox" data-ts-serve="${escapeHtml(a.key)}" ${a.on ? 'checked' : ''} ${disabled} aria-label="HTTPS for ${escapeHtml(a.label)}">
                    <span class="track"></span>
                </label>
                ${note}
            </div>`;
        })
        .join('') || '<p class="muted">Tailscale is not running on this machine.</p>';

    // Your devices.
    const devices = t.devices ?? [];
    $('ts-device-count').textContent = devices.length
        ? `${devices.filter((d) => d.online).length} of ${devices.length} online`
        : '–';
    const owners = new Set(devices.map((d) => d.owner).filter(Boolean));
    $('ts-devices').innerHTML = devices.length
        ? devices
              .map((d) => {
                  const status = d.self
                      ? 'this machine'
                      : d.online
                        ? `online${d.connection ? ` · ${d.connection}` : ''}`
                        : d.lastSeen
                          ? `last seen ${relativeTime(d.lastSeen)}`
                          : 'offline';
                  const meta = [TS_OS_NAMES[d.os] ?? d.os, owners.size > 1 ? d.owner : null, d.exitNode ? 'your exit node' : null]
                      .filter(Boolean)
                      .map(escapeHtml)
                      .join(' · ');
                  return `<div class="ts-row">
                    <div class="ts-row-main">
                        <span class="ts-row-title"><span class="svc-dot ${d.online ? 'ok' : ''}"></span>${escapeHtml(d.name)}
                            <span class="muted">${escapeHtml(status)}</span></span>
                        ${meta ? `<span class="muted">${meta}</span>` : ''}
                        ${d.dnsName ? `<span class="ts-addr"><span>${escapeHtml(d.dnsName)}</span>${tsCopy(d.dnsName)}</span>` : ''}
                        ${d.ip ? `<span class="ts-addr"><span>${escapeHtml(d.ip)}</span>${tsCopy(d.ip)}</span>` : ''}
                    </div>
                </div>`;
              })
              .join('')
        : '<p class="muted">Tailscale is not running on this machine, so there is no tailnet to list.</p>';

    // The apps' own pages offer the HTTPS addresses switched on above.
    refreshAppLinks();

    // Install: which account to sign in with.
    const acct = $('ts-install-account');
    acct.hidden = !t.account;
    if (t.account) {
        const apple = /@privaterelay\.appleid\.com$/i.test(t.account);
        acct.innerHTML = `This machine is signed in as <strong>${escapeHtml(t.account)}</strong>.` +
            (apple
                ? ' That is a private address from Sign in with Apple, so on your other devices choose <strong>Sign in with Apple</strong> and use the same Apple Account.'
                : ' Use the same account on your other devices.');
    }
}

for (const button of document.querySelectorAll('[data-ts-refresh]')) {
    button.addEventListener('click', async () => {
        button.disabled = true;
        await loadTailscale({ fresh: true });
        button.disabled = false;
    });
}

$('tab-tailscale').addEventListener('click', async (event) => {
    const os = event.target.closest('[data-ts-os]');
    if (os) {
        for (const chip of document.querySelectorAll('[data-ts-os]')) chip.classList.toggle('active', chip === os);
        for (const page of document.querySelectorAll('[data-ts-os-page]')) page.hidden = page.dataset.tsOsPage !== os.dataset.tsOs;
    }
});

$('ts-serve').addEventListener('change', async (event) => {
    const box = event.target.closest('[data-ts-serve]');
    if (!box) return;
    const key = box.dataset.tsServe;
    const on = box.checked;
    const app = tsState?.serve?.find((a) => a.key === key);
    const held = `ts-serve:${key}`;
    if (isHeld(held)) return;
    // Back to what it really is until the job says otherwise.
    box.checked = !on;
    holdControl(held, box);
    try {
        // A refusal is toasted by queueAction, and a failed job shows in the peek.
        await queueAction({
            title: `${on ? 'Turning on' : 'Turning off'} Tailscale HTTPS for ${app?.label ?? key}`,
            request: (headers) =>
                api(`/api/tailscale/serve/${encodeURIComponent(key)}`, { method: 'POST', body: { on }, headers }),
        });
        await loadTailscale({ fresh: true });
    } finally {
        // Let go, then drawn again from whatever is known -- the fresh read if
        // it worked, the last one if it did not. loadTailscale draws nothing
        // when it fails, which used to leave this switch off until a reload.
        pendingControls.delete(held);
        renderTailscale();
    }
    loadApps().catch(() => {});
});

// --- the Mullvad exit node ---

let mvState = null;
let mvLocations = null;
let mvPoll = null;

async function loadMullvad() {
    try {
        mvState = await api('/api/mullvad');
    } catch {
        return;
    }
    renderMullvad();
    if (!mvLocations) {
        api('/api/mullvad/locations')
            .then((r) => {
                mvLocations = r.locations;
                renderMullvadLocations();
            })
            .catch((e) => {
                $('mv-location-new').innerHTML = `<option value="">Could not load Mullvad's cities: ${escapeHtml(e.message)}</option>`;
            });
    }
}

function renderMullvadLocations() {
    const options = (selected) =>
        (mvLocations ?? [])
            .map(
                (l) =>
                    `<option value="${escapeHtml(l.id)}" ${l.id === selected ? 'selected' : ''}>${escapeHtml(l.label)}${l.km !== null ? ` · ${l.km.toLocaleString()} km` : ''}</option>`,
            )
            .join('');
    const fresh = $('mv-location-new');
    fresh.innerHTML = options(fresh.value || mvLocations?.[0]?.id);
    $('mv-location').innerHTML = options(mvState?.location);
}

function renderMullvad() {
    const m = mvState;
    if (!m) return;
    $('mv-setup').hidden = m.connected;
    for (const id of ['mv-live', 'mv-move', 'mv-remove-card']) $(id).hidden = !m.connected;
    $('mv-use').hidden = true;
    clearTimeout(mvPoll);
    if (!m.connected) return;
    if (mvLocations) renderMullvadLocations();

    const ts = m.tailscale;
    const running = Boolean(m.container?.running);
    const signedIn = ts?.state === 'Running';
    const ready = running && m.tunnelUp && signedIn && ts.approved;

    const tag = $('mv-state');
    tag.textContent = ready ? 'ready' : !running ? 'stopped' : !m.tunnelUp ? 'not connected to Mullvad' : 'needs finishing';
    tag.className = `tag ${ready ? 'ok' : 'warn'}`;

    $('mv-server').textContent = m.relay ? `${m.relay} · ${m.locationLabel ?? ''}` : '–';
    $('mv-exit').textContent = m.exit
        ? `${m.exit.ip} · ${[m.exit.city, m.exit.country].filter(Boolean).join(', ')}${m.exit.mullvad ? '' : ' (not Mullvad!)'}`
        : '–';
    $('mv-expiry').textContent = m.expiry ? `paid until ${new Date(m.expiry).toLocaleDateString()}` : '–';
    $('mv-device').textContent = m.deviceName ?? '–';

    $('mv-checks-title').textContent = ready ? 'Status' : 'Finish setting it up';
    const check = (done, text) => `<li><span class="svc-dot ${done ? 'ok' : 'bad'}"></span><span>${text}</span></li>`;
    $('mv-checks').innerHTML = [
        check(running, running ? 'The exit node is running.' : 'The exit node is not running. Its log is under All logs.'),
        check(m.tunnelUp, m.tunnelUp ? 'Connected to Mullvad.' : 'Not connected to Mullvad yet. Give it a minute after starting; if it stays like this, try another city.'),
        check(signedIn, signedIn ? `Signed in to your tailnet as <strong>${escapeHtml(ts.name ?? 'home-mullvad')}</strong>.` : 'Not signed in to your tailnet yet.'),
        check(ts?.approved, ts?.approved ? 'Approved as an exit node.' : 'Not approved as an exit node yet.'),
    ].join('');

    // The one thing to do next, spelled out.
    let next = '';
    if (running && !signedIn && ts?.authURL) {
        next = `<div class="verdict">
            <p><strong>Sign it in to your tailnet.</strong> Open this link and sign in with the same account as this machine${
                /@privaterelay\.appleid\.com$/i.test(tsState?.account ?? '') ? ' (Sign in with Apple)' : ''
            }:</p>
            <p><a href="${escapeHtml(ts.authURL)}" target="_blank" rel="noreferrer noopener">${escapeHtml(ts.authURL)} ↗</a></p>
        </div>`;
    } else if (signedIn && !ts.approved) {
        next = `<div class="verdict">
            <p><strong>Approve it as an exit node.</strong> Tailscale asks for this once, so nobody can turn a device into an exit node without you knowing.</p>
            <ol class="steps">
                <li>Open <a href="https://login.tailscale.com/admin/machines" target="_blank" rel="noreferrer noopener">Machines in the admin console ↗</a>.</li>
                <li>Find <strong>${escapeHtml(ts.name ?? 'home-mullvad')}</strong>, select <strong>…</strong>, then <strong>Edit route settings</strong>.</li>
                <li>Tick <strong>Use as exit node</strong> and save.</li>
                <li>While you are there, select <strong>…</strong> again and choose <strong>Disable key expiry</strong>, so it does not stop working in six months.</li>
            </ol>
        </div>`;
    }
    $('mv-next').innerHTML = next;

    $('mv-use').hidden = !ready;
    const name = ts?.name ?? 'home-mullvad';
    for (const el of document.querySelectorAll('.mv-name')) el.textContent = name;
    $('mv-linux-on').textContent = `sudo tailscale set --exit-node=${name}`;

    // While it waits on something done elsewhere -- a sign-in, an approval --
    // the page notices by itself rather than needing Check again.
    if (!ready && activeSubtab('tailscale') === 'ts-mullvad' && $('tab-tailscale').classList.contains('active')) {
        mvPoll = setTimeout(loadMullvad, 8000);
    }
}

document.querySelector('[data-subtab="ts-mullvad"]').addEventListener('click', loadMullvad);

$('mv-refresh').addEventListener('click', async () => {
    $('mv-refresh').disabled = true;
    await loadMullvad();
    $('mv-refresh').disabled = false;
});

$('mv-connect').addEventListener('click', async () => {
    const err = $('mv-connect-error');
    err.hidden = true;
    const account = $('mv-account').value.replace(/\D/g, '');
    const location = $('mv-location-new').value;
    if (!account) {
        err.textContent = 'Type your Mullvad account number first.';
        err.hidden = false;
        return;
    }
    $('mv-connect').disabled = true;
    const result = await queueAction({
        title: 'Setting up the Mullvad exit node',
        request: (headers) => api('/api/mullvad/connect', { method: 'POST', body: { account, location }, headers }),
    });
    $('mv-connect').disabled = false;
    if (result.ok) {
        $('mv-account').value = '';
    } else {
        err.textContent = result.error || 'Setting it up did not finish. The Update Queue has its log.';
        err.hidden = false;
    }
    loadMullvad();
});

$('mv-move-go').addEventListener('click', async () => {
    const location = $('mv-location').value;
    if (!location || location === mvState?.location) return toast('That is the city it is already in.');
    $('mv-move-go').disabled = true;
    await queueAction({
        title: 'Moving the Mullvad exit node',
        request: (headers) => api('/api/mullvad/location', { method: 'POST', body: { location }, headers }),
    });
    $('mv-move-go').disabled = false;
    loadMullvad();
});

$('mv-remove').addEventListener('click', async () => {
    const sure = await askConfirm({
        title: 'Remove the Mullvad exit node?',
        body: 'Devices using it go back to their normal connection. Its device is removed from your Mullvad account and its Tailscale sign-in is signed out. You can set it up again any time.',
        confirmLabel: 'Remove',
        danger: true,
    });
    if (!sure) return;
    await queueAction({
        title: 'Removing the Mullvad exit node',
        request: (headers) => api('/api/mullvad/remove', { method: 'POST', headers }),
    });
    loadMullvad();
});

// ------------------------------------------------------- kachat nextcloud ---

/*
 * KaChat Nextcloud: a separate Nextcloud for the KaChat and KaPay apps, run
 * entirely from here -- install, accounts, app passwords, the links that
 * have been shared, and calls.
 */
let kcState = null;
let kcAccount = null;

async function loadKachat() {
    try {
        kcState = await api('/api/kachat');
    } catch {
        return;
    }
    renderKachat();
}

const kcAccounts = () => kcState?.accounts ?? [];
const kcCurrent = () => kcAccounts().find((a) => a.username === kcAccount) ?? kcAccounts()[0] ?? null;

function renderKachat() {
    const k = kcState;
    if (!k) return;
    // Installing, the switch and the sidebar dot are the panel's usual ones;
    // this page is what comes after. Before the first start there is nothing
    // set up to show, so it says what the switch will do.
    // Not installed, the cards stay as a preview under the install screen,
    // the way every other app's page does.
    if (!k.installed) {
        for (const id of ['kc-live', 'kc-connect-card', 'kc-calls-card']) $(id).hidden = false;
        $('kc-setup').hidden = true;
        return;
    }
    $('kc-setup').hidden = k.setUp;
    $('kc-live').hidden = !k.setUp;
    // Accounts and calls are read from Nextcloud itself, which a switched-off
    // one cannot answer; the status card says it is off instead.
    for (const id of ['kc-connect-card', 'kc-calls-card']) $(id).hidden = !k.setUp || !k.running;
    if (!k.setUp) return;

    const accounts = kcAccounts();
    if (!kcCurrent() && accounts.length) kcAccount = accounts[0].username;
    else if (kcCurrent()) kcAccount = kcCurrent().username;
    const acct = kcCurrent();
    const hasPw = Boolean(acct?.appPasswords?.length);

    const tag = $('kc-state');
    const ready = k.running && k.server && hasPw;
    tag.textContent = !k.running ? 'stopped' : ready ? 'ready' : 'needs finishing';
    tag.className = `tag ${ready ? 'ok' : k.running ? 'warn' : 'off'}`;

    const check = (done, text) => `<li><span class="svc-dot ${done ? 'ok' : 'bad'}"></span><span>${text}</span></li>`;
    // Switched off, the one thing worth saying is that; the rest is read
    // from a Nextcloud that is not answering.
    $('kc-checks').innerHTML = !k.running
        ? check(false, 'Switched off. Links sent from it do not open until its switch in the sidebar starts it again.')
        : [
              check(true, 'Running.'),
              check(Boolean(k.server), k.server ? `On your domain at <strong>${escapeHtml(k.server)}</strong>.` : 'Not on your domain yet.'),
              check(Boolean(acct), acct ? `Account <strong>${escapeHtml(acct.username)}</strong> is ready.` : 'No account yet. Add one under Accounts.'),
              check(hasPw, hasPw ? 'It has an app password.' : 'No app password yet. Make one below.'),
          ].join('');

    $('kc-next').innerHTML =
        k.running && !k.server
            ? `<div class="verdict"><p><strong>Put it on your domain.</strong> Open <a href="#" data-goto-tab="tunnel">Tunnel &amp; domains</a>, choose <strong>KaChat Nextcloud</strong> under <strong>Publish something</strong>, and give it a name such as <code>share</code>. Only what KaChat and KaPay use is reachable on that name.</p></div>`
            : '';

    // Connect apps.
    const pick = (sel) => {
        $(sel).innerHTML = accounts.map((a) => `<option value="${escapeHtml(a.username)}" ${a.username === kcAccount ? 'selected' : ''}>${escapeHtml(a.username)}</option>`).join('');
    };
    pick('kc-account-pick');
    pick('kc-media-pick');
    pick('kc-files-pick');
    $('kc-account-pick-row').hidden = accounts.length < 2;
    $('kc-media-pick-row').hidden = accounts.length < 2;
    $('kc-files-pick-row').hidden = accounts.length < 2;

    $('kc-server').textContent = k.server ?? 'publish it on your domain first';
    $('kc-server-copy').innerHTML = k.server ? copyButton(k.server) : '';
    $('kc-username').textContent = acct?.username ?? '–';
    $('kc-username-copy').innerHTML = acct ? copyButton(acct.username) : '';
    $('kc-pw-go').disabled = !acct || !k.running;
    $('kc-pw-list').innerHTML = (acct?.appPasswords ?? [])
        .map(
            (t) => `<div class="ts-row">
                <div class="ts-row-main">
                    <span class="ts-row-title">${escapeHtml(t.name)}</span>
                    <span class="muted">${t.lastActivity ? `last activity ${relativeTime(t.lastActivity)}` : 'not used yet'}</span>
                </div>
                <button type="button" class="ghost danger" data-kc-revoke="${escapeHtml(String(t.id))}">Revoke</button>
            </div>`,
        )
        .join('');

    // Calls.
    const t = k.talk;
    $('kc-calls').innerHTML = !k.running
        ? '<p class="muted">Start it to see the call settings.</p>'
        : !t?.enabled
          ? '<p class="verdict bad">Nextcloud Talk is not installed here, so KaChat calls are off. Restarting it tries again.</p>'
          : `<ul class="ts-checks">
                <li><span class="svc-dot ok"></span><span>Nextcloud Talk ${escapeHtml(t.version ?? '')} is on, so KaChat can make voice and video calls.</span></li>
                <li><span class="svc-dot ${t.stun?.length ? 'ok' : 'bad'}"></span><span>${
                    t.stun?.length ? `Phones find each other with ${escapeHtml(t.stun.join(', '))}.` : 'No STUN server, so most calls between different networks fail.'
                }</span></li>
            </ul>
            <p class="hint">
                The sound and picture go straight between the two phones, not through this machine,
                and nothing needs a port opened. A call can still fail to connect when both phones
                are on strict networks, such as two phones on mobile data with some carriers: that
                needs a relay (TURN), which is not set up.
            </p>`;

    // Accounts.
    $('kc-accounts').innerHTML = accounts.length
        ? accounts
              .map((a) => {
                  const quota = a.quota && a.quota !== 'none' ? a.quota : 'no limit';
                  return `<div class="ts-row">
                    <div class="ts-row-main">
                        <span class="ts-row-title">${escapeHtml(a.username)}</span>
                        <span class="muted">${a.used !== null ? humanBytes(a.used) : '–'} used of ${escapeHtml(quota)} · ${a.appPasswords.length} app password${a.appPasswords.length === 1 ? '' : 's'}</span>
                    </div>
                    <div class="row kc-quota">
                        <input value="${escapeHtml(a.quota && a.quota !== 'none' ? a.quota : '')}" placeholder="20 GB" data-kc-quota-input="${escapeHtml(a.username)}" size="8">
                        <button type="button" class="ghost" data-kc-quota="${escapeHtml(a.username)}">Set space</button>
                        <button type="button" class="ghost danger" data-kc-remove-user="${escapeHtml(a.username)}">Remove</button>
                    </div>
                </div>`;
              })
              .join('')
        : '<p class="muted">No accounts yet.</p>';
}

async function loadKachatMedia() {
    const user = $('kc-media-pick').value || kcAccount;
    const box = $('kc-media');
    if (!user || !kcState?.running) {
        box.innerHTML = '<p class="muted">Nothing to show while it is stopped or has no account.</p>';
        $('kc-media-count').textContent = '–';
        return;
    }
    box.innerHTML = '<p class="muted">Reading the links…</p>';
    let list;
    try {
        ({ shares: list } = await api(`/api/kachat/accounts/${encodeURIComponent(user)}/shares`));
    } catch (e) {
        box.innerHTML = `<p class="verdict bad">${escapeHtml(e.message)}</p>`;
        return;
    }
    $('kc-media-count').textContent = `${list.length} shared`;
    const kind = (m) => (String(m).startsWith('video/') ? 'video' : String(m).startsWith('audio/') ? 'voice' : String(m).startsWith('image/') ? 'photo' : 'file');
    box.innerHTML = list.length
        ? list
              .map(
                  (s) => `<div class="kc-media-item">
                    ${
                        kind(s.mime) === 'voice'
                            ? '<div class="kc-thumb kc-thumb-voice" aria-hidden="true">♪</div>'
                            : `<img class="kc-thumb" loading="lazy" alt="" src="/api/kachat/accounts/${encodeURIComponent(user)}/preview/${encodeURIComponent(s.fileId)}">`
                    }
                    <div class="ts-row-main">
                        <span class="ts-row-title">${escapeHtml(s.name)}</span>
                        <span class="muted">${kind(s.mime)}${s.created ? ` · shared ${relativeTime(s.created)}` : ''}${s.expires ? ` · until ${escapeHtml(new Date(s.expires).toLocaleDateString())}` : ''}</span>
                        <span class="ts-addr"><a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(s.url)} ↗</a>${copyButton(s.url)}</span>
                    </div>
                    <button type="button" class="ghost danger" data-kc-unshare="${escapeHtml(String(s.id))}" data-kc-unshare-name="${escapeHtml(s.name)}">Stop sharing</button>
                </div>`,
              )
              .join('')
        : '<p class="muted">Nothing has been shared from this account yet.</p>';
}

// A file with no preview (a video Nextcloud has not made one for yet) gets a
// plain play mark instead of a broken image.
$('kc-media').addEventListener(
    'error',
    (event) => {
        if (!event.target.matches?.('img.kc-thumb')) return;
        event.target.replaceWith(Object.assign(document.createElement('div'), { className: 'kc-thumb kc-thumb-voice', textContent: '▶' }));
    },
    true,
);

// What a file is, in the words of the apps that wrote it. Anything else is
// shown by its name alone.
function kcFileNote(f) {
    if (/(^|\/)kachat-contacts\.json$/i.test(f.path)) return 'Contacts backup, shared by KaChat and KaPay. Encrypted with your wallet seed.';
    if (/(^|\/)kachat-backup\.json$/i.test(f.path)) return 'KaChat backup.';
    if (/portfolio/i.test(f.path) && /\.json$/i.test(f.path)) return 'KaPay portfolio. Not encrypted: readable on this server.';
    if (/^KaChat\/Media\//.test(f.path)) return f.shared ? 'Sent media, its link is open.' : 'Sent media, no open link.';
    return '';
}

async function loadKachatFiles() {
    const user = $('kc-files-pick').value || kcAccount;
    const box = $('kc-files');
    if (!user || !kcState?.running) {
        box.innerHTML = '<p class="muted">Nothing to show while it is stopped or has no account.</p>';
        $('kc-files-count').textContent = '–';
        return;
    }
    box.innerHTML = '<p class="muted">Reading the folder…</p>';
    let out;
    try {
        out = await api(`/api/kachat/accounts/${encodeURIComponent(user)}/files`);
    } catch (e) {
        box.innerHTML = `<p class="verdict bad">${escapeHtml(e.message)}</p>`;
        return;
    }
    const files = out.files.filter((f) => !f.folder);
    const total = files.reduce((n, f) => n + f.size, 0);
    $('kc-files-count').textContent = `${files.length} file${files.length === 1 ? '' : 's'} · ${humanBytes(total)}`;
    if (!files.length) {
        box.innerHTML = '<p class="muted">Nothing backed up yet. Once KaChat or KaPay is signed in to this account, its backups and sent media show up here.</p>';
        return;
    }
    // Grouped by the folder each file sits in, the KaChat folder first and
    // its media last, newest first inside each.
    const groups = new Map();
    for (const f of files) {
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push(f);
    }
    const rank = (d) => (d === 'KaChat' ? 0 : d.startsWith('KaChat/Media') ? 2 : 1);
    const dirs = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const href = (f) => `/api/kachat/accounts/${encodeURIComponent(user)}/file?path=${encodeURIComponent(f.path)}`;
    box.innerHTML =
        dirs
            .map((dir) => {
                const list = groups.get(dir).sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
                const size = list.reduce((n, f) => n + f.size, 0);
                const rows = list
                    .map((f) => {
                        const note = kcFileNote(f);
                        return `<div class="kc-file">
                            <div class="ts-row-main">
                                <span class="ts-row-title">${escapeHtml(f.name)}</span>
                                <span class="muted">${humanBytes(f.size)}${f.modified ? ` · ${relativeTime(f.modified)}` : ''}${note ? ` · ${escapeHtml(note)}` : ''}</span>
                            </div>
                            <button type="button" class="ghost" data-kc-download="${escapeHtml(href(f))}">Download</button>
                        </div>`;
                    })
                    .join('');
                return `<details class="kc-dir" ${list.length <= 30 ? 'open' : ''}>
                    <summary><strong>${escapeHtml(dir ? `${dir}/` : 'Top level')}</strong> <span class="muted">${list.length} file${list.length === 1 ? '' : 's'} · ${humanBytes(size)}</span></summary>
                    ${rows}
                </details>`;
            })
            .join('') + (out.truncated ? '<p class="hint">Only the first 5,000 entries are shown.</p>' : '');
}

document.querySelector('[data-subtab="kc-files"]').addEventListener('click', loadKachatFiles);
$('kc-files-refresh').addEventListener('click', loadKachatFiles);
$('kc-files-pick').addEventListener('change', loadKachatFiles);

document.querySelector('[data-subtab="kc-media"]').addEventListener('click', loadKachatMedia);
$('kc-media-refresh').addEventListener('click', loadKachatMedia);
$('kc-media-pick').addEventListener('change', loadKachatMedia);
$('kc-account-pick').addEventListener('change', () => {
    kcAccount = $('kc-account-pick').value;
    $('kc-pw-new').hidden = true;
    renderKachat();
});
$('kc-refresh').addEventListener('click', loadKachat);

$('tab-kachat').addEventListener('click', async (event) => {
    const goto = event.target.closest('[data-goto-tab]');
    if (goto) {
        event.preventDefault();
        selectTab(goto.dataset.gotoTab);
        return;
    }
    const revoke = event.target.closest('[data-kc-revoke]');
    if (revoke) {
        const sure = await askConfirm({
            title: 'Revoke this app password?',
            body: 'The app using it is signed out at once and has to be given a new one.',
            confirmLabel: 'Revoke',
            danger: true,
        });
        if (!sure) return;
        try {
            await api(`/api/kachat/accounts/${encodeURIComponent(kcAccount)}/app-passwords/${revoke.dataset.kcRevoke}`, { method: 'DELETE' });
            toast('Revoked.');
        } catch (e) {
            toast(e.message, 'bad');
        }
        return loadKachat();
    }
    const download = event.target.closest('[data-kc-download]');
    if (download) {
        // The panel answers it as an attachment, so this saves and stays put.
        Object.assign(document.createElement('a'), { href: download.dataset.kcDownload, download: '' }).click();
        return;
    }
    const unshare = event.target.closest('[data-kc-unshare]');
    if (unshare) {
        const user = $('kc-media-pick').value || kcAccount;
        const sure = await askConfirm({
            title: `Stop sharing ${unshare.dataset.kcUnshareName}?`,
            body: 'The link stops working for everyone who has it, including in chats already sent. The file itself stays in the account.',
            confirmLabel: 'Stop sharing',
            danger: true,
        });
        if (!sure) return;
        try {
            await api(`/api/kachat/accounts/${encodeURIComponent(user)}/shares/${unshare.dataset.kcUnshare}`, { method: 'DELETE' });
            toast('No longer shared.');
        } catch (e) {
            toast(e.message, 'bad');
        }
        return loadKachatMedia();
    }
    const quota = event.target.closest('[data-kc-quota]');
    if (quota) {
        const user = quota.dataset.kcQuota;
        const value = document.querySelector(`[data-kc-quota-input="${CSS.escape(user)}"]`).value.trim() || 'none';
        try {
            await api(`/api/kachat/accounts/${encodeURIComponent(user)}/quota`, { method: 'PUT', body: { quota: value } });
            toast('Saved.');
        } catch (e) {
            toast(e.message, 'bad');
        }
        return loadKachat();
    }
    const removeUser = event.target.closest('[data-kc-remove-user]');
    if (removeUser) {
        const user = removeUser.dataset.kcRemoveUser;
        const sure = await askConfirm({
            title: `Remove the account ${user}?`,
            body: 'Everything in it goes: its photos, videos, voice messages and contacts backup. Every link it shared stops working, and KaChat and KaPay signed in with it are signed out.',
            confirmLabel: 'Remove',
            danger: true,
            requireText: user,
        });
        if (!sure) return;
        try {
            await api(`/api/kachat/accounts/${encodeURIComponent(user)}`, { method: 'DELETE' });
            toast(`Removed ${user}.`);
        } catch (e) {
            toast(e.message, 'bad');
        }
        return loadKachat();
    }
});

$('kc-pw-go').addEventListener('click', async () => {
    const name = $('kc-pw-name').value.trim() || 'KaChat';
    const box = $('kc-pw-new');
    $('kc-pw-go').disabled = true;
    try {
        const r = await api(`/api/kachat/accounts/${encodeURIComponent(kcAccount)}/app-passwords`, { method: 'POST', body: { name } });
        box.hidden = false;
        box.innerHTML = `<p><strong>App password for ${escapeHtml(r.name)}</strong>. Copy it into the app now: it is shown only this once.</p>
            <div class="media-row"><span class="kc-field">Password</span><code>${escapeHtml(r.password)}</code>${copyButton(r.password)}</div>`;
        $('kc-pw-name').value = '';
    } catch (e) {
        toast(e.message, 'bad');
    }
    $('kc-pw-go').disabled = false;
    loadKachat();
});

$('kc-new-user-go').addEventListener('click', async () => {
    const username = $('kc-new-user').value.trim();
    if (!username) return toast('Type a username first.', 'bad');
    $('kc-new-user-go').disabled = true;
    try {
        await api('/api/kachat/accounts', { method: 'POST', body: { username } });
        toast(`Made ${username}.`);
        $('kc-new-user').value = '';
        kcAccount = username.toLowerCase();
    } catch (e) {
        toast(e.message, 'bad');
    }
    $('kc-new-user-go').disabled = false;
    loadKachat();
});

// Opening on the system this page is being read on saves a click.
(() => {
    const ua = navigator.userAgent;
    const os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
        ? 'ios'
        : /Android/.test(ua)
          ? 'android'
          : /Windows/.test(ua)
            ? 'windows'
            : /Macintosh/.test(ua)
              ? 'mac'
              : /Linux/.test(ua)
                ? 'linux'
                : null;
    document.querySelector(`[data-ts-os="${os}"]`)?.click();
})();

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

function logTile(rawKey, label) {
    // The keys come from the server's container list; escaped once here for
    // the half-dozen attributes they go into.
    const key = escapeHtml(rawKey);
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

/**
 * Keeps a server stream connected.
 *
 * EventSource retries by itself only after some failures. A 502 while the
 * panel restarts after an Update, a session that expired, or a phone putting
 * the page to sleep each leave it closed or silently dead, and the page then
 * shows the last lines it got, forever, looking like nothing is happening.
 *
 * The server sends a ping every 20 seconds, so a stream with nothing for 50
 * is dead whatever its readyState says. A closed or dead one is opened again,
 * waiting a little longer each time it fails, and checked the moment the
 * page is looked at again.
 */
function guardStream(connect) {
    let stream = null;
    let lastSeen = 0;
    let delay = 2000;
    let retry = null;

    const signedIn = () => !$('app').classList.contains('hidden');
    const again = () => {
        clearTimeout(retry);
        retry = setTimeout(() => signedIn() && open(), delay);
        delay = Math.min(delay * 2, 30_000);
    };
    const open = () => {
        stream?.close();
        lastSeen = Date.now();
        stream = connect();
        const seen = () => {
            lastSeen = Date.now();
            delay = 2000;
        };
        stream.addEventListener('open', seen);
        stream.addEventListener('ping', seen);
        stream.addEventListener('error', () => stream.readyState === EventSource.CLOSED && again());
        return stream;
    };
    const check = () => {
        if (!stream || !signedIn() || document.hidden) return;
        if (stream.readyState === EventSource.CLOSED || Date.now() - lastSeen > 50_000) open();
    };
    setInterval(check, 15_000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    return { open, touch: () => (lastSeen = Date.now()) };
}

const logGuard = guardStream(() => openLogStream());
const jobGuard = guardStream(() => openJobStream());

function connectLogs() {
    logGuard.open();
}

function connectJobs() {
    jobGuard.open();
}

function openLogStream() {
    logStream?.close();
    logBuffers.clear();
    const grid = $('log-grid');
    grid.innerHTML = '<p class="empty-tile">Connecting…</p>';

    logStream = new EventSource('/api/logs/stream-all');
    // Lines count as signs of life as much as pings do.
    logStream.addEventListener('line', () => logGuard.touch());

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
    return logStream;
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
        const { job, busy } = await api('/api/jobs/current');
        // Taken from the server rather than kept only from start/end events,
        // so a missed `end` does not leave the badge counting a job for ever.
        queueBusy = Boolean(busy);
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

/**
 * id -> the callers waiting on that job, each with its own settle and check.
 *
 * A set per id rather than one waiter: the server folds a second identical
 * request into the job that is already waiting last in line and hands back the
 * same id, and a map of one waiter per id let the second caller overwrite the
 * first, which then waited for ever.
 */
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

/** Ids the stream has said started, for the peek; see queueAction. Capped. */
const startedJobs = new Set();

function settleQueueJob(job) {
    const waiters = queueEnds.get(job.id);
    if (waiters?.size) {
        for (const waiter of [...waiters]) waiter.settle(job);
        return;
    }
    queueEnded.set(job.id, job);
    if (queueEnded.size > 50) queueEnded.delete(queueEnded.keys().next().value);
}

/*
 * Asks again about every job somebody is waiting on, now rather than at the
 * next tick. Called when the job stream comes back after a drop: whatever ended
 * while it was away sent its `end` into nothing, and the snapshot a reconnect
 * brings only describes a job that is still running.
 */
function recheckJobWaiters({ except = new Set() } = {}) {
    for (const [id, waiters] of queueEnds) {
        if (except.has(id)) continue;
        for (const waiter of waiters) waiter.check();
    }
}

/**
 * Resolves with a job once it has finished, however that news arrives.
 *
 * The stream's `end` event is the fast way and nearly always the one that
 * lands. It is also delivered exactly once, so a connection that drops across
 * the moment a job ends -- a laptop lid, a phone locking, the panel restarting
 * -- used to leave the caller waiting for ever, with its button greyed out
 * until the page was reloaded. So it asks as well: every five seconds while it
 * waits, and straight away when the stream reconnects.
 *
 * A job nobody has any record of resolves as `unknown`, not as a success. Its
 * record lived in the panel's memory and the panel has lost it; the honest
 * answer is that it is over and nobody can say how it went.
 */
function waitForJob(id) {
    return new Promise((resolve) => {
        const early = queueEnded.get(id);
        if (early) {
            queueEnded.delete(id);
            resolve(early);
            return;
        }

        let timer = null;
        let asking = false;
        const waiters = queueEnds.get(id) ?? new Set();
        queueEnds.set(id, waiters);

        const waiter = {
            settle(job) {
                if (!waiters.has(waiter)) return;
                waiters.delete(waiter);
                if (!waiters.size) queueEnds.delete(id);
                clearInterval(timer);
                resolve(job);
            },
            async check() {
                if (asking || !waiters.has(waiter)) return;
                asking = true;
                try {
                    const job = await askJob(id);
                    if (FINAL_JOB_STATES.has(job.status)) waiter.settle(job);
                    else if (job.status === 'gone') waiter.settle({ id, status: 'unknown', error: LOST_JOB });
                } catch {
                    /* the panel is unreachable this instant; the next tick asks again */
                } finally {
                    asking = false;
                }
            },
        };
        waiters.add(waiter);
        timer = setInterval(() => waiter.check(), 5000);
    });
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

    // With nothing ahead of it the job has usually started -- and its `start`
    // event been and gone -- before this response arrives, so "Queued" here
    // would sit over a job that is running for as long as it runs.
    showPeek({ id: response.jobId, name: title, state: startedJobs.has(response.jobId) ? 'Running' : 'Queued' });
    refreshQueueSoon();

    const job = await waitForJob(response.jobId);
    // Learnt by asking rather than from the stream, the peek and the badge
    // never heard either; this is the one place that knows to tell them.
    // Repeating it after an `end` that did arrive changes nothing.
    peekEnded(job);
    refreshQueueSoon();

    const result = { ...job, ok: job.status === 'succeeded' };
    Promise.resolve()
        .then(() => onEnd?.(result))
        .catch(() => {});
    return result;
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
    // Toasts stack above the peek rather than under it: on a phone the two
    // share the bottom of the screen, and a toast was landing on the peek's
    // log, unreadable and in front of the thing it was about. The stylesheet
    // lifts .toast by this much.
    document.documentElement.style.setProperty('--peek-h', `${$('queue-peek').offsetHeight + 12}px`);
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
        { succeeded: 'Done', cancelled: 'Cancelled', unknown: 'Lost track of it — check the result' }[job.status] ??
        `Failed: ${job.error ?? 'unknown'}`;
    // A failure is worth leaving on screen longer than a success.
    clearTimeout(peekHideTimer);
    peekHideTimer = setTimeout(hidePeek, job.status === 'succeeded' ? 4000 : 12000);
}

function hidePeek() {
    clearTimeout(peekHideTimer);
    peekJobId = null;
    $('queue-peek').hidden = true;
    document.documentElement.style.setProperty('--peek-h', '0px');
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

function openJobStream() {
    jobStream?.close();
    jobStream = new EventSource('/api/jobs/stream');
    /*
     * Connected, or connected again. Anything that ended while the stream was
     * away has had its one `end` event already, into nothing, so everybody
     * waiting on a job asks about it now rather than at their next tick -- the
     * overlay's watchdog included. On the first connection there is nothing
     * waiting and this does nothing.
     */
    jobStream.addEventListener('open', () => {
        recheckJobWaiters();
        if (pendingAction?.jobId && !pendingAction.finished) checkActionJob();
    });
    // A job already running when this page loaded: what it has printed so far
    // goes into the panel's log, so opening All logs shows it rather than
    // starting from the next line.
    jobStream.addEventListener('snapshot', (event) => {
        const job = JSON.parse(event.data);
        // The server's picture of what is still to do. A job somebody is
        // waiting on that is in neither half of it has ended, so it is asked
        // about -- which settles it with its real outcome, or as unknown.
        const live = new Set([...(job.status === 'running' ? [job.id] : []), ...(job.pending ?? []).map((p) => p.id)]);
        recheckJobWaiters({ except: live });
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
        startedJobs.add(job.id);
        if (startedJobs.size > 50) startedJobs.delete(startedJobs.values().next().value);
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
        if (!pendingAction) toast(`${job.name}…`);
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
        // The overlay shows the action it started, the peek and the queue page
        // the queued one. Everything is in All logs either way.
        actionLine(jobId, line);
    });
    jobStream.addEventListener('end', (event) => {
        const job = JSON.parse(event.data);
        queueBusy = false;
        renderQueue(job.pending);
        refreshQueueIfOpen();

        // Anyone holding a button until this finished hears about it first --
        // before the early returns below, which are about the overlay.
        settleQueueJob(job);
        // Before the early returns: a switch's job is a queued one, and the
        // KaChat page shows what that job's first start set up.
        loadKachat();
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

        toast(
            { succeeded: `${job.name}: done`, cancelled: `${job.name}: cancelled` }[job.status] ?? `${job.name}: failed`,
            { succeeded: 'good', cancelled: '' }[job.status] ?? 'bad',
        );
        refreshStatus();
        loadApps();
        loadTunnel().catch(() => {});
    });
    return jobStream;
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
    } finally {
        // Only reached with the page still here: a restart that worked has
        // reloaded it. One that never came back says so in the result line,
        // and the button has to be usable again for whatever comes next --
        // it used to stay greyed out until a reload.
        $('password-save').disabled = false;
    }
});

$('panel-port-save').addEventListener('click', async () => {
    const raw = $('panel-port').value.trim();
    const port = Number(raw);
    // Said before the question rather than after it: a confirmation dialog
    // offering to move the panel to port 0, or to where it already is, is a
    // question with no good answer.
    if (!raw) return toast('Type the port to move the panel to first.', 'bad');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return toast('A port is a whole number from 1 to 65535.', 'bad');
    }
    if (panelPort && port === panelPort) return toast(`The panel is already on port ${port}.`);
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
    } finally {
        // As for password-save: only reached if the page did not reload.
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
/** The port the panel says it is on, from /api/system. Null until it has said. */
let panelPort = null;

async function loadGlobal() {
    const r = await api('/api/system');
    $('global-panel-version').textContent = r.panelVersion || '–';
    $('global-stack-dir').textContent = r.stackDir || '–';

    // The port box started empty and stayed that way, so "Move the panel"
    // pressed as found asked to move it to port 0. It starts on the port the
    // panel is actually on now -- unless somebody is typing a new one in.
    panelPort = Number(r.panelPort) || null;
    if (panelPort && document.activeElement !== $('panel-port')) $('panel-port').value = panelPort;
    $('panel-port-state').textContent = panelPort
        ? `This panel is on port ${panelPort}${r.panelBind ? `, listening on ${r.panelBind}` : ''}.`
        : 'The panel could not say which port it is on.';

    const last = r.lastUpdate;
    if (!last) return;
    kResult(
        'global-update-result',
        last.ok
            ? `${last.kind === 'install' ? 'Installed' : 'Updated'} from ${last.repo}@${last.ref} at ${new Date(last.at).toLocaleString()}.`
            : `Last update failed: ${last.error || 'no reason recorded'}`,
        !last.ok,
    );
}

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
        loadUpdateBanner();
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
// every service, all of their data and the panel itself in one go.
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

// --------------------------------------------------------- update banner ---

/*
 * Later is remembered per version, so a newer one brings the banner back. One
 * entry per service, so this cannot grow. It lives in this browser because it is
 * one person's "not now": everybody else should still be told.
 */
const DISMISSED_KEY = 'qsh-updates-later';
let dismissedUpdates = {};
try {
    dismissedUpdates = JSON.parse(localStorage.getItem(DISMISSED_KEY)) ?? {};
} catch {
    /* Private window or blocked storage: Later then lasts until the page reloads. */
}

function dismissUpdate(item) {
    dismissedUpdates[item.key] = item.id;
    try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissedUpdates));
    } catch {
        /* As above. */
    }
}

/*
 * Runs the check on arrival because the Update buttons on those pages only open
 * after one, and this is what shows the full detail, major version warning included.
 */
function openUpdate(item) {
    selectTab(item.tab);
    document.querySelector(`[data-subtab="${item.subtab}"]`)?.click();
    if (item.key === 'panel') {
        $('global-repo').value = item.repo;
        $('global-ref').value = item.ref;
        $('global-check-btn').click();
    } else {
        $(`${item.key}-check`)?.click();
    }
}

function updateBannerRow(item) {
    const row = document.createElement('div');
    row.className = `update-banner-row${item.major ? ' is-major' : ''}`;

    const dot = document.createElement('span');
    dot.className = 'status-dot';

    // textContent, because the detail carries a commit subject from GitHub.
    const body = document.createElement('div');
    body.className = 'update-banner-body';
    const head = document.createElement('strong');
    head.textContent = item.head;
    const detail = document.createElement('span');
    detail.className = 'update-banner-detail';
    detail.textContent = item.detail;
    body.append(head, detail);

    const see = document.createElement('button');
    see.type = 'button';
    see.className = 'primary';
    see.textContent = 'See update';
    see.addEventListener('click', () => openUpdate(item));

    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'ghost';
    later.textContent = 'Later';
    later.addEventListener('click', () => {
        dismissUpdate(item);
        row.remove();
        $('update-banner').hidden = !$('update-banner').childElementCount;
    });

    const actions = document.createElement('div');
    actions.className = 'update-banner-actions';
    actions.append(see, later);

    row.append(dot, body, actions);
    return row;
}

async function loadUpdateBanner() {
    let items;
    try {
        ({ items } = await api('/api/system/updates'));
    } catch {
        return;
    }
    const banner = $('update-banner');
    banner.replaceChildren(...items.filter((i) => dismissedUpdates[i.key] !== i.id).map(updateBannerRow));
    banner.hidden = !banner.childElementCount;
}

// The scan is hourly and lives on the server, so this only reads its answer.
setInterval(() => {
    if (!document.hidden && !$('app').classList.contains('hidden')) loadUpdateBanner();
}, 60_000);

// ------------------------------------------------------------------- boot ---

// Which services exist at all, which decides whether each row shows a button or
// a switch. Refreshed alongside the status poll so an install or an uninstall
// finishing is reflected without a reload.
// Ten seconds, not thirty: this is now the only thing that writes the switches,
// so how stale it is, is how stale they are.
// Paused while the tab is hidden or signed out, like the status poll; see
// pollable().
setInterval(() => pollable() && loadServices().catch(() => {}), 10_000);

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
            // showApp starts the polls, the services one included.
            showApp();
            loadUpdateBanner();
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

// ----------------------------------------------------------------- backups --

/**
 * The Backups page: one drive, each app's data as nightly dated copies, and
 * Nextcloud's files as a running copy -- plus the Restore tab.
 *
 * Destinations are chosen from a discovered list rather than typed, because a
 * mistyped path here does not fail: Docker creates a bind mount source that is
 * missing, so the copy would run onto the internal disk and report success.
 */
let backupSources = [];
let backupDrives = [];
let snapState = null;

function renderBackupSources() {
    const note = $('backup-sources-note');
    if (!note) return;
    if (!backupSources.length) {
        note.className = 'verdict bad';
        note.textContent = 'Nextcloud is not installed, or keeps no files yet, so there is nothing here to copy.';
        return;
    }
    note.className = 'verdict';
    note.textContent = `Copies what Nextcloud is serving: ${backupSources.join(', ')}.`;
}

function renderBackupDrives(selected) {
    const sel = $('backup-destination');
    if (!sel) return;
    if (!backupDrives.length) {
        sel.innerHTML = '<option value="">No drives found</option>';
    } else {
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
    }
    // A destination saved earlier for a drive that is not plugged in now would
    // otherwise silently become "Choose a drive", and saving would clear it.
    if (selected && !backupDrives.some((d) => d.path === selected)) {
        sel.insertAdjacentHTML(
            'beforeend',
            `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} — not plugged in</option>`,
        );
    }
}

/** "3 hours ago", or the date once it is far enough back for that to read better. */
function whenAgo(iso) {
    const t = new Date(iso);
    const mins = Math.round((Date.now() - t) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
    return t.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function snapLastLine(s) {
    if (!s.present) return '<span class="muted">Not installed</span>';
    const last = s.last;
    if (!last) return '<span class="muted">Not backed up yet</span>';
    if (last.ok === false) return `<span class="bad-text">Failed ${escapeHtml(whenAgo(last.at))}: ${escapeHtml(last.result ?? '')}</span>`;
    const size = last.bytes ? ` · ${humanBytes(last.bytes)}` : '';
    return `<span class="ok-text">Backed up ${escapeHtml(whenAgo(last.at))}${size}</span>`;
}

function renderSnapshots(keepEdits) {
    const box = $('snap-services');
    if (!snapState || !box) return;
    const c = snapState.config;
    if (!keepEdits) {
        $('snap-enabled').checked = Boolean(c.enabled);
        $('snap-keep').value = c.keep ?? 3;
    }
    const checked = (s) => (keepEdits && $(`snap-svc-${s.key}`) ? $(`snap-svc-${s.key}`).checked : s.included);
    box.innerHTML = snapState.services
        .map(
            (s) => `
        <div class="snap-row${s.present ? '' : ' absent'}">
          <label class="check">
            <input type="checkbox" id="snap-svc-${s.key}"${checked(s) ? ' checked' : ''}${s.present ? '' : ' disabled'}>
            <strong>${escapeHtml(s.label)}</strong>
          </label>
          <p class="hint">${escapeHtml(s.what)}</p>
          <div class="snap-status">${snapLastLine(s)}</div>
          <button type="button" class="ghost mini" data-snap-run="${s.key}"${s.present ? '' : ' disabled'}>Back up now</button>
        </div>`,
        )
        .join('');
    const next = $('snap-next');
    if (!snapState.nextRunAt) {
        next.textContent = c.enabled ? 'Choose a drive above and save, and the nightly copies start.' : 'Nightly copies are off. Back up now still works.';
    } else {
        const at = new Date(snapState.nextRunAt);
        next.textContent = `Next copy: ${at.toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' })} (${c.timezone}).`;
    }
}

async function loadBackup() {
    let r;
    let snaps;
    try {
        [r, snaps] = await Promise.all([api('/api/backup'), api('/api/snapshots')]);
    } catch {
        return;
    }
    const c = r.config ?? {};
    backupDrives = r.drives ?? [];
    backupSources = r.sources ?? [];
    snapState = snaps;
    renderBackupSources();
    // The drive list is always redrawn -- a drive may have been plugged in --
    // but while the form has unsaved edits it keeps the drive picked in it,
    // and the boxes keep what was typed. See dirtyForms.
    const editing = isDirty('backup');
    if (editing) {
        renderBackupDrives($('backup-destination').value || c.destination);
    } else {
        renderBackupDrives(c.destination);
        $('backup-enabled').checked = Boolean(c.enabled);
        $('backup-mirror').checked = Boolean(c.mirrorDeletes);
        $('backup-interval').value = c.intervalMinutes ?? 15;
    }
    renderSnapshots(editing);

    const last = $('backup-last');
    last.hidden = false;
    if (c.lastRunAt) {
        last.className = c.lastOk === false ? 'verdict bad' : 'verdict ok';
        last.textContent = `${c.lastOk === false ? 'Last attempt failed' : 'Last copy'}: ${c.lastResult ?? ''} (${new Date(c.lastRunAt).toLocaleString()})`;
    } else {
        last.className = 'verdict';
        last.textContent = 'Nextcloud\'s files have not been copied yet.';
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
    const services = {};
    for (const s of snapState?.services ?? []) {
        const box = $(`snap-svc-${s.key}`);
        if (box && s.present) services[s.key] = box.checked;
    }
    try {
        // The drive first: the nightly copies need one to be switched on.
        await api('/api/backup', {
            method: 'PUT',
            body: {
                enabled: $('backup-enabled').checked,
                destination: $('backup-destination').value,
                intervalMinutes: Number($('backup-interval').value),
                mirrorDeletes: $('backup-mirror').checked,
            },
        });
        await api('/api/snapshots', {
            method: 'PUT',
            body: { enabled: $('snap-enabled').checked, keep: Number($('snap-keep').value), services },
        });
        setFormDirty('backup', false);
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
        title: 'Copying Nextcloud files',
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

/** Backs up one app, or every one that is ticked when `service` is null. */
async function runSnapshots(service) {
    if (isDirty('backup')) {
        toast('Save or discard your changes first.', 'bad');
        return;
    }
    const label = service ? snapState?.services.find((s) => s.key === service)?.label : null;
    const pending = runAction({
        key: 'snapshots',
        title: label ? `Backing up ${label}` : 'Backing up app data',
        note: 'Copying to the drive. This runs in the manager, so closing this page does not stop it.',
        request: () => api('/api/snapshots/run', { method: 'POST', body: service ? { service } : {} }),
    });
    if (pendingAction) {
        pendingAction.snapTotal = service ? 1 : (snapState?.services ?? []).filter((s) => s.present && s.included).length || 1;
        pendingAction.snapIndex = -1;
    }
    const job = await pending;
    if (job) loadBackup().catch(() => {});
}

$('snap-run-all').addEventListener('click', () => runSnapshots(null));
$('snap-services').addEventListener('click', (event) => {
    const button = event.target.closest('[data-snap-run]');
    if (button) runSnapshots(button.dataset.snapRun);
});

// --------------------------------------------------------------- restore --

const COPY_KIND = { nightly: 'Nightly', manual: 'Backed up by hand', 'before-restore': 'Saved before a restore' };

const RESTORE_WARNINGS = {
    nextcloud:
        'Nextcloud is unavailable for a few minutes. Users, shares, calendars, contacts and settings go back to how they were then. ' +
        'Your files stay as they are now, and Nextcloud checks every one of them afterwards.',
    kachat: 'KaChat Nextcloud is unavailable for a few minutes. Its accounts, links and every file in it go back to how they were then.',
    jellyfin: 'Jellyfin stops for a minute. Users, watch history and libraries go back to how they were then.',
    mealplan: 'Meal Plan stops for a moment. Every week, recipe and list goes back to how it was then.',
    minecraft: 'The Minecraft server stops, and everyone playing is disconnected. The worlds go back to how they were then.',
    panel:
        'The panel restarts. Every setting and password it keeps goes back to how it was then, including the password you sign in to this panel with. ' +
        'Apps keep running; a changed setting takes effect the next time that app is updated or restarted.',
};

async function loadRestore() {
    const box = $('restore-list');
    const err = $('restore-error');
    err.hidden = true;
    box.innerHTML = '<p class="muted">Reading the drive…</p>';
    if (!snapState) await loadBackup();
    let r;
    try {
        r = await api('/api/snapshots/copies');
    } catch (e) {
        r = { copies: {}, error: e.message };
    }
    if (r.error) {
        err.hidden = false;
        err.textContent = r.error;
    }
    const services = snapState?.services ?? [];
    box.innerHTML = services
        .map((s) => {
            const copies = r.copies?.[s.key] ?? [];
            const rows = copies.length
                ? copies
                      .map(
                          (c) => `
                <li class="restore-copy">
                  <span class="restore-when">${escapeHtml(new Date(c.createdAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span>
                  <span class="muted">${escapeHtml(COPY_KIND[c.kind] ?? c.kind)} · ${humanBytes(c.bytes)}</span>
                  <button type="button" class="ghost mini" data-restore="${escapeHtml(c.id)}" data-restore-when="${escapeHtml(c.createdAt)}">Restore</button>
                </li>`,
                      )
                      .join('')
                : '<li class="muted">No copies on the drive yet.</li>';
            const options =
                (s.key === 'nextcloud'
                    ? `<label class="check"><input type="checkbox" id="restore-putback-${s.key}"> Also put back files that are missing from Nextcloud, from the copy of its files on the drive</label>`
                    : '') +
                `<label class="check"><input type="checkbox" id="restore-nosave-${s.key}"> Don't save it as it is now first (only if it is too broken to be copied)</label>`;
            return `
            <article class="card">
              <h3>${escapeHtml(s.label)}</h3>
              <ul class="restore-copies">${rows}</ul>
              ${copies.length ? `<div class="restore-options">${options}</div>` : ''}
            </article>`;
        })
        .join('');
}

$('restore-refresh').addEventListener('click', () => loadRestore());
$('backups-restore-tab').addEventListener('click', () => loadRestore());

$('restore-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-restore]');
    if (!button) return;
    const id = button.dataset.restore;
    const key = id.split('/')[0];
    const s = snapState?.services.find((x) => x.key === key);
    const when = new Date(button.dataset.restoreWhen).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const putBack = Boolean($(`restore-putback-${key}`)?.checked);
    const saveFirst = !$(`restore-nosave-${key}`)?.checked;
    const ok = await askConfirm({
        title: `Restore ${s?.label ?? key} to ${when}?`,
        body:
            `${RESTORE_WARNINGS[key] ?? ''}\n\n` +
            (saveFirst
                ? 'It is saved as it is now first, so you can undo this from the same list.'
                : 'It will NOT be saved first, so this cannot be undone.') +
            (putBack ? '\n\nMissing files are copied back from the drive; files that are there now are left alone.' : ''),
        confirmLabel: 'Restore',
        danger: true,
    });
    if (!ok) return;
    const job = await runAction({
        key: 'restore',
        title: `Restoring ${s?.label ?? key}`,
        note: 'This runs in the manager, so closing this page does not stop it.',
        request: () => api('/api/snapshots/restore', { method: 'POST', body: { id, putBack, saveFirst } }),
    });
    if (job) {
        loadBackup().catch(() => {});
        loadRestore().catch(() => {});
    }
});
