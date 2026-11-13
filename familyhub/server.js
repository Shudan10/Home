import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    authRequired,
    clearCookie,
    clientAddress,
    isAuthenticated,
    isPrivateAddress,
    issueSession,
    loginRetryAfter,
    noteLoginAttempt,
    noteLoginSuccess,
    passwordUnusable,
    sessionCookie,
    verifyPassword,
} from './lib/auth.js';
import {
    dateRange,
    ensureDataDir,
    isIsoDate,
    isoDate,
    loadMeals,
    loadPlan,
    normaliseMeal,
    randomFill,
    saveMeals,
    savePlan,
    setPlanSlot,
    SLOTS,
} from './lib/store.js';
import { loadMembers, MEMBER_COLOURS, normaliseMember, saveMembers } from './lib/family.js';
import { loadEvents, normaliseEvent, occurrences, REPEATS, saveEvents, unassignMember as unassignFromEvents } from './lib/events.js';
import { loadSettings, normaliseLocation, saveSettings, UNITS } from './lib/settings.js';
import {
    loadTasks,
    markDone,
    migrateTasks,
    normaliseTask,
    saveTasks,
    TASK_REPEATS,
    tasksOn,
    unassignMember as unassignFromTasks,
} from './lib/tasks.js';
import { handleDav } from './lib/caldav.js';
import { forecast, forgetForecast, searchPlaces } from './lib/weather.js';

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const log = (...args) => console.log(new Date().toISOString(), ...args);

/*
 * The last net. Every request is wrapped below, so nothing should reach this;
 * if something does, it is logged rather than left to Node's default for an
 * unhandled rejection, which is to end the process -- and with it the app for
 * the whole house, over one request.
 */
process.on('unhandledRejection', (err) => log('unhandled rejection', err));

// ------------------------------------------------------------- http helpers --

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    // Served with the right type or the browser ignores the manifest entirely
    // and the app is silently not installable -- which for a thing whose whole
    // point is living on a home screen is the only failure that matters.
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body, headers = {}) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
    });
    res.end(JSON.stringify(body));
}

const fail = (res, status, message, extra = {}) => sendJson(res, status, { error: message, ...extra });

/*
 * An error that is the client's to fix, with the status that says so.
 *
 * Anything thrown that is not one of these is ours, and the client gets a
 * plain "something went wrong" while the detail goes to the log: an error
 * message from deep inside can carry a file path or a stack of internals,
 * and none of it helps somebody who only wanted to plan Tuesday.
 */
class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function readBody(req, limit = 512 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new HttpError(413, 'Request body too large.');
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    let body;
    try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new HttpError(400, 'Request body is not valid JSON.');
    }
    // `null` or a bare number parses fine and then breaks every `body.x`.
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Request body is not a JSON object.');
    return body;
}

/*
 * Stamped on the page's own stylesheet and scripts, once per start.
 *
 * An update restarts the container, so the stamp changes, and the page asks
 * for style.css?v=<new> -- a name no browser has cached. Without it an iPad
 * could pair the new page with yesterday's stylesheet, which is how a new
 * button can arrive looking unstyled.
 */
const ASSET_VERSION = Date.now().toString(36);
const stampAssets = (html) =>
    html.toString('utf8').replace(/(\b(?:src|href)="(?!https?:|\/\/)[^"?]+\.(?:css|js))"/g, `$1?v=${ASSET_VERSION}"`);

function serveStatic(req, res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    // Path traversal guard: the resolved file must stay inside PUBLIC_DIR.
    if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) && file !== path.join(PUBLIC_DIR, 'index.html')) {
        return fail(res, 403, 'Forbidden');
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
                if (err2) return fail(res, 404, 'Not found');
                res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
                res.end(stampAssets(html));
            });
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
        });
        res.end(path.extname(file) === '.html' ? stampAssets(data) : data);
    });
}

// --------------------------------------------------------------- the routes --

const routes = [];
const route = (method, pattern, handler, { auth = true } = {}) =>
    routes.push({ method, pattern, handler, auth });

route('GET', /^\/healthz$/, async (req, res) => sendJson(res, 200, { ok: true }), { auth: false });

route(
    'GET',
    /^\/api\/session$/,
    async (req, res) =>
        sendJson(res, 200, {
            required: authRequired(),
            authenticated: !authRequired() || isAuthenticated(req),
            passwordUnusable: passwordUnusable(),
        }),
    { auth: false },
);

route(
    'POST',
    /^\/api\/login$/,
    async (req, res) => {
        const body = await readBody(req);
        if (!authRequired()) return sendJson(res, 200, { ok: true, required: false });

        // Checked before the password is even looked at, so a client that is
        // waiting out its cooldown costs no scrypt either.
        const client = clientAddress(req);
        const wait = loginRetryAfter(client);
        if (wait > 0) {
            const seconds = Math.ceil(wait / 1000);
            const minutes = Math.max(1, Math.ceil(wait / 60000));
            return sendJson(
                res,
                429,
                { error: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` },
                { 'Retry-After': String(seconds) },
            );
        }

        const attempt = noteLoginAttempt(client);
        if (!(await verifyPassword(String(body.password ?? '')))) {
            // The address only, never what was typed: a wrong password is
            // very often the right one for something else.
            log('failed login from', client);
            // Constant-ish delay so the endpoint is not a fast password oracle.
            await new Promise((r) => setTimeout(r, 500));
            return fail(res, 401, 'That password did not work.');
        }
        noteLoginSuccess(client, attempt);
        const { token } = issueSession();
        const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure }) });
    },
    { auth: false },
);

route('POST', /^\/api\/logout$/, async (req, res) => sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() }), {
    auth: false,
});

// ------------------------------------------------------------------ meals --

route('GET', /^\/api\/meals$/, async (req, res) => sendJson(res, 200, { meals: loadMeals(), slots: SLOTS }));

route('POST', /^\/api\/meals$/, async (req, res) => {
    const { meal, errors } = normaliseMeal(await readBody(req));
    if (errors.length) return fail(res, 400, errors[0], { errors });
    const meals = loadMeals();
    meals.push(meal);
    saveMeals(meals);
    sendJson(res, 201, { meal });
});

route('PUT', /^\/api\/meals\/([A-Za-z0-9_]+)$/, async (req, res, match) => {
    // The body first, then the library. The other way round, the library was
    // read, then the request waited on a slow phone's upload, and anything
    // saved meanwhile -- a meal added from the other phone -- was written over
    // with the copy from before it existed.
    const body = await readBody(req);
    const meals = loadMeals();
    const idx = meals.findIndex((m) => m.id === match[1]);
    if (idx < 0) return fail(res, 404, 'That meal is not in the library any more.');
    const { meal, errors } = normaliseMeal(body, meals[idx]);
    if (errors.length) return fail(res, 400, errors[0], { errors });
    meals[idx] = meal;
    saveMeals(meals);
    sendJson(res, 200, { meal });
});

route('DELETE', /^\/api\/meals\/([A-Za-z0-9_]+)$/, async (req, res, match) => {
    const id = match[1];
    const meals = loadMeals();
    const next = meals.filter((m) => m.id !== id);
    if (next.length === meals.length) return fail(res, 404, 'That meal is not in the library any more.');
    saveMeals(next);

    /*
     * Also taken out of the plan.
     *
     * A plan entry is a meal id, so leaving them behind would render as a slot
     * that looks empty but is not -- random fill would skip it as taken, and
     * clearing it would need a tap on something invisible. Removing the meal
     * removes the references with it.
     */
    const plan = loadPlan();
    let touched = 0;
    for (const [date, day] of Object.entries(plan)) {
        for (const slot of SLOTS) {
            if (day[slot] === id) {
                setPlanSlot(plan, date, slot, null);
                touched += 1;
            }
        }
    }
    if (touched) savePlan(plan);
    sendJson(res, 200, { ok: true, removedFromPlan: touched });
});

// ------------------------------------------------------------------- plan --

/** Reads from/to off the query string, defaulting to the week around today. */
function rangeFrom(url) {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (isIsoDate(from) && isIsoDate(to)) return { from, to, dates: dateRange(from, to) };
    const today = isoDate(new Date());
    return { from: today, to: today, dates: [today] };
}

route('GET', /^\/api\/plan$/, async (req, res, match, url) => {
    const { from, to, dates } = rangeFrom(url);
    const plan = loadPlan();
    const days = dates.map((date) => ({ date, slots: plan[date] ?? {} }));
    sendJson(res, 200, { from, to, days });
});

route('PUT', /^\/api\/plan$/, async (req, res) => {
    const body = await readBody(req);
    const { date, slot } = body;
    if (!isIsoDate(date)) return fail(res, 400, 'That is not a date this app understands.');
    if (!SLOTS.includes(slot)) return fail(res, 400, `That is not a meal of the day this plans (${SLOTS.join(', ')}).`);

    const mealId = body.mealId ? String(body.mealId) : null;
    if (mealId && !loadMeals().some((m) => m.id === mealId)) {
        return fail(res, 400, 'That meal is not in the library.');
    }

    const plan = loadPlan();
    setPlanSlot(plan, date, slot, mealId);
    savePlan(plan);
    sendJson(res, 200, { ok: true, date, slot, mealId });
});

route('POST', /^\/api\/plan\/random$/, async (req, res) => {
    const body = await readBody(req);
    const from = body.from;
    const to = body.to;
    if (!isIsoDate(from) || !isIsoDate(to)) return fail(res, 400, 'Pick a week first.');

    const dates = dateRange(from, to);
    if (!dates.length) return fail(res, 400, 'That range runs backwards.');

    const slots = Array.isArray(body.slots) ? body.slots.filter((s) => SLOTS.includes(s)) : ['dinner'];
    if (!slots.length) return fail(res, 400, 'Nothing to fill: no meal of the day was asked for.');

    const meals = loadMeals();
    if (!meals.length) return fail(res, 400, 'Add some meals first -- there is nothing to choose from.');

    const plan = loadPlan();
    const filled = randomFill(plan, meals, {
        dates,
        slots,
        overwrite: Boolean(body.overwrite),
        avoidRepeats: body.avoidRepeats !== false,
        // Default on, so a caller that predates the option behaves as before.
        includeWeekends: body.includeWeekends !== false,
    });
    savePlan(plan);

    // Nothing filled is a real answer, not a failure: it happens when every slot
    // asked for already has something and overwrite is off.
    sendJson(res, 200, { ok: true, filled: filled.length, days: dates.length });
});

route('DELETE', /^\/api\/plan$/, async (req, res, match, url) => {
    const { dates } = rangeFrom(url);
    const plan = loadPlan();
    let cleared = 0;
    for (const date of dates) {
        if (plan[date]) {
            cleared += Object.keys(plan[date]).length;
            delete plan[date];
        }
    }
    savePlan(plan);
    sendJson(res, 200, { ok: true, cleared });
});

// ----------------------------------------------------------------- family --

route('GET', /^\/api\/members$/, async (req, res) => sendJson(res, 200, { members: loadMembers(), colours: MEMBER_COLOURS }));

route('POST', /^\/api\/members$/, async (req, res) => {
    const body = await readBody(req);
    const members = loadMembers();
    const { member, errors } = normaliseMember(body, members);
    if (errors.length) throw new HttpError(400, errors[0]);
    members.push(member);
    saveMembers(members);
    sendJson(res, 201, { member });
});

route('PUT', /^\/api\/members\/([A-Za-z0-9_]+)$/, async (req, res, match) => {
    const body = await readBody(req);
    const members = loadMembers();
    const idx = members.findIndex((m) => m.id === match[1]);
    if (idx < 0) throw new HttpError(404, 'That person is not in the family list any more.');
    const { member, errors } = normaliseMember(body, members, members[idx]);
    if (errors.length) throw new HttpError(400, errors[0]);
    members[idx] = member;
    saveMembers(members);
    sendJson(res, 200, { member });
});

route('DELETE', /^\/api\/members\/([A-Za-z0-9_]+)$/, async (req, res, match) => {
    const members = loadMembers();
    const next = members.filter((m) => m.id !== match[1]);
    if (next.length === members.length) throw new HttpError(404, 'That person is not in the family list any more.');
    saveMembers(next);
    // Their events and chores are not deleted with them: they lose the name and
    // become everybody's. See unassignMember in the events and tasks stores.
    unassignEverywhere(match[1]);
    sendJson(res, 200, { ok: true });
});

/*
 * What happens to someone's things when they are taken off the list. Filled in
 * by the stores that have things to hand back; a list so that adding events
 * and tasks does not mean editing the delete route.
 */
const unassigners = [];
function unassignEverywhere(memberId) {
    for (const fn of unassigners) fn(memberId);
}

// ----------------------------------------------------------------- events --

unassigners.push(unassignFromEvents);

/** A from/to pair off the query string, both real dates and the right way round. */
function eventRange(url) {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw new HttpError(400, 'Ask for a range of real dates.');
    if (dateRange(from, to).length >= 120) throw new HttpError(400, 'Ask for at most 120 days at a time.');
    return { from, to };
}

route('GET', /^\/api\/events$/, async (req, res, match, url) => {
    const { from, to } = eventRange(url);
    sendJson(res, 200, { from, to, occurrences: occurrences(loadEvents(), from, to), repeats: REPEATS });
});

route('GET', /^\/api\/events\/([A-Za-z0-9_]+)$/, async (req, res, match) => {
    const event = loadEvents().find((e) => e.id === match[1]);
    if (!event) throw new HttpError(404, 'That event is not on the calendar any more.');
    sendJson(res, 200, { event });
});

route('POST', /^\/api\/events$/, async (req, res) => {
    const body = await readBody(req);
    const events = loadEvents();
    const { event, errors } = normaliseEvent(body, loadMembers().map((m) => m.id), null, events.length);
    if (errors.length) throw new HttpError(400, errors[0]);
    events.push(event);
    saveEvents(events);
    sendJson(res, 201, { event });
});

route('PUT', /^\/api\/events\/([A-Za-z0-9_]+)$/, async (req, res, match) => {
    const body = await readBody(req);
    const events = loadEvents();
    const idx = events.findIndex((e) => e.id === match[1]);
    if (idx < 0) throw new HttpError(404, 'That event is not on the calendar any more.');
    const { event, errors } = normaliseEvent(body, loadMembers().map((m) => m.id), events[idx]);
    if (errors.length) throw new HttpError(400, errors[0]);
    events[idx] = event;
    saveEvents(events);
    sendJson(res, 200, { event });
});

/*
 * Delete the whole event, or -- for one that repeats -- just one day of it.
 *
 * "Just this one" adds the day to the series' skip list rather than splitting
 * the series in two, so the rest of it is still one thing to edit.
 */
route('DELETE', /^\/api\/events\/([A-Za-z0-9_]+)$/, async (req, res, match, url) => {
    const only = url.searchParams.get('occurrence');
    const events = loadEvents();
    const idx = events.findIndex((e) => e.id === match[1]);
    if (idx < 0) throw new HttpError(404, 'That event is not on the calendar any more.');
    const event = events[idx];

    if (only) {
        if (event.repeat === 'none') throw new HttpError(400, 'That event does not repeat, so there is only the one.');
        if (!isIsoDate(only)) throw new HttpError(400, 'That is not a date.');
        event.skip = [...new Set([...(event.skip ?? []), only])].sort();
        event.updatedAt = new Date().toISOString();
        saveEvents(events);
        return sendJson(res, 200, { ok: true, skipped: only });
    }
    events.splice(idx, 1);
    saveEvents(events);
    sendJson(res, 200, { ok: true });
});

// ------------------------------------------------------------------ tasks --

unassigners.push(unassignFromTasks);

/*
 * The day being looked at, and the asking device's today.
 *
 * Both from the page: what counts as late depends on the family's date, not
 * on the server's, which keeps UTC.
 */
function taskDays(url) {
    const date = url.searchParams.get('date');
    const today = url.searchParams.get('today') || date;
    if (!isIsoDate(date) || !isIsoDate(today)) throw new HttpError(400, 'Ask for a real date.');
    return { date, today };
}

route('GET', /^\/api\/tasks$/, async (req, res, match, url) => {
    // A run of days at once, for the week on the Overview: { days: { date: [...] } }.
    if (url.searchParams.has('from')) {
        const { from, to } = eventRange(url);
        const today = url.searchParams.get('today') || from;
        if (!isIsoDate(today)) throw new HttpError(400, 'Ask for a real date.');
        const tasks = loadTasks();
        if (migrateTasks(tasks, today)) saveTasks(tasks);
        const days = Object.fromEntries(dateRange(from, to).map((d) => [d, tasksOn(tasks, d, today)]));
        return sendJson(res, 200, { from, to, today, days });
    }
    const { date, today } = taskDays(url);
    const tasks = loadTasks();
    // Reminders saved under the first rules move to these the first time a
    // device asks, which is when the family's own today is known.
    if (migrateTasks(tasks, today)) saveTasks(tasks);
    sendJson(res, 200, { date, today, tasks: tasksOn(tasks, date, today), repeats: TASK_REPEATS });
});

route('GET', /^\/api\/tasks\/([A-Za-z0-9_]+)$/, async (req, res, match) => {
    const task = loadTasks().find((t) => t.id === match[1]);
    if (!task) throw new HttpError(404, 'That reminder is not on the list any more.');
    sendJson(res, 200, { task });
});

route('POST', /^\/api\/tasks$/, async (req, res) => {
    const body = await readBody(req);
    const tasks = loadTasks();
    const { task, errors } = normaliseTask(body, loadMembers().map((m) => m.id), null, tasks.length);
    if (errors.length) throw new HttpError(400, errors[0]);
    tasks.push(task);
    saveTasks(tasks);
    sendJson(res, 201, { task });
});

route('PUT', /^\/api\/tasks\/([A-Za-z0-9_]+)$/, async (req, res, match) => {
    const body = await readBody(req);
    const tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id === match[1]);
    if (idx < 0) throw new HttpError(404, 'That reminder is not on the list any more.');
    const { task, errors } = normaliseTask(body, loadMembers().map((m) => m.id), tasks[idx]);
    if (errors.length) throw new HttpError(400, errors[0]);
    tasks[idx] = task;
    saveTasks(tasks);
    sendJson(res, 200, { task });
});

/* Ticks a reminder off for a day, or unticks it. */
route('POST', /^\/api\/tasks\/([A-Za-z0-9_]+)\/done$/, async (req, res, match) => {
    const body = await readBody(req);
    const date = String(body.date ?? '');
    const today = String(body.today ?? date);
    if (!isIsoDate(date) || !isIsoDate(today)) throw new HttpError(400, 'That is not a date.');
    const tasks = loadTasks();
    const task = tasks.find((t) => t.id === match[1]);
    if (!task) throw new HttpError(404, 'That reminder is not on the list any more.');
    if (!markDone(task, date, body.done !== false, today)) {
        throw new HttpError(
            400,
            body.done === false && task.repeat !== 'none'
                ? 'Only the latest tick of a repeating reminder can be taken back.'
                : 'That reminder is not on that day.',
        );
    }
    saveTasks(tasks);
    sendJson(res, 200, { ok: true });
});

route('DELETE', /^\/api\/tasks\/([A-Za-z0-9_]+)$/, async (req, res, match) => {
    const tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id === match[1]);
    if (idx < 0) throw new HttpError(404, 'That reminder is not on the list any more.');
    tasks.splice(idx, 1);
    saveTasks(tasks);
    sendJson(res, 200, { ok: true });
});

// --------------------------------------------------------------- settings --

/*
 * The hub's public address, as https://name -- what a phone is told to use
 * for the calendar account, since it works anywhere.
 *
 * Taken from a signed-in visit that came through a proxy on this machine or
 * network (the Cloudflare tunnel, Tailscale serve) over https, at a name that
 * is not a home one. Signed in and proxied, because the Host header is
 * whatever the asker writes: a stranger who could set it would have the hub
 * telling the family to give their password to some other server.
 */
function publicOrigin(req) {
    if (authRequired() && !isAuthenticated(req)) return null;
    if (!isPrivateAddress(req.socket?.remoteAddress)) return null;
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
    const host = String(req.headers.host ?? '').toLowerCase();
    if (proto !== 'https' || !/^[a-z0-9.-]+(:\d+)?$/.test(host)) return null;
    const name = host.replace(/:\d+$/, '');
    if (!name.includes('.') || net.isIPv4(name) || name === 'localhost' || /\.(local|localhost)$/.test(name)) return null;
    return `https://${host}`;
}

route('GET', /^\/api\/settings$/, async (req, res) => {
    let settings = loadSettings();
    const origin = publicOrigin(req);
    if (origin && origin !== settings.publicOrigin) settings = saveSettings({ publicOrigin: origin });
    sendJson(res, 200, { settings, units: UNITS });
});

route('PUT', /^\/api\/settings$/, async (req, res) => {
    const body = await readBody(req);
    const next = {};
    if ('units' in body) {
        if (!UNITS.includes(body.units)) throw new HttpError(400, 'Units are fahrenheit or celsius.');
        next.units = body.units;
    }
    if ('location' in body) {
        if (body.location === null) {
            next.location = null;
        } else {
            const location = normaliseLocation(body.location);
            if (!location) throw new HttpError(400, 'That is not a place this can find the weather for.');
            next.location = location;
        }
    }
    const settings = saveSettings(next);
    forgetForecast();
    sendJson(res, 200, { settings });
});

// ---------------------------------------------------------------- weather --

route('GET', /^\/api\/weather\/places$/, async (req, res, match, url) => {
    try {
        sendJson(res, 200, { places: await searchPlaces(url.searchParams.get('q')) });
    } catch (err) {
        log('town search failed', err.message);
        throw new HttpError(502, 'The town search could not be reached. Try again in a moment.');
    }
});

route('GET', /^\/api\/weather$/, async (req, res) => {
    const { location, units } = loadSettings();
    // Not set yet is an answer, not an error: the Today screen shows a prompt.
    if (!location) return sendJson(res, 200, { configured: false });
    try {
        sendJson(res, 200, { configured: true, ...(await forecast(location, units)) });
    } catch (err) {
        // The rest of the Today screen still works without the weather.
        log('weather failed', err.message);
        sendJson(res, 200, { configured: true, unavailable: true, place: location.name });
    }
});

// ------------------------------------------------------------------ guards --

/*
 * Which Host headers are believed when there is no password.
 *
 * Without a password the only thing between a web page and the plan is that
 * the page has to be served from here -- and DNS rebinding gets around that: a
 * site points its own name at this machine's LAN address, and the browser then
 * treats requests to it as same-origin with that site. What the attack cannot
 * fake is the Host header, which carries the attacker's name. So a Host is
 * accepted only if it is something a family member could actually be typing:
 * an IP address, localhost, a Tailscale *.ts.net name, a name with no dots (a
 * MagicDNS short name, the container's own name) or a .local one -- neither of
 * which a stranger can register -- or a name in MEALPLAN_ALLOWED_HOSTS.
 *
 * With a password set this is not applied at all. The session cookie does the
 * job, and the Cloudflare tunnel's public name is not on any list here.
 */
const ALLOWED_HOSTS = (process.env.MEALPLAN_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);

function hostAllowed(header) {
    // No Host at all is not a browser, and a browser is what rebinding needs.
    if (!header) return true;
    let name;
    try {
        name = new URL(`http://${header}`).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
        return false;
    }
    if (name.startsWith('[') || net.isIPv4(name)) return true;
    if (name === 'localhost' || name.endsWith('.localhost')) return true;
    if (name.endsWith('.ts.net') || name.endsWith('.local') || !name.includes('.')) return true;
    // An entry starting with a dot allows the whole domain under it.
    return ALLOWED_HOSTS.some((h) => (h.startsWith('.') ? name.endsWith(h) : name === h));
}

/*
 * Same-origin guard for state changes. The cookie is SameSite=Lax already;
 * this closes the gap for clients that ignore it -- and, with no password,
 * there is no cookie at all and this is the whole of the protection.
 *
 * A form posted from another site carries an Origin, which is checked. Where
 * the Origin is missing, a browser still says where the request came from in
 * Sec-Fetch-Site, so "cross-site" is refused too. Neither header present is a
 * script or curl, which no browser page can make on someone else's behalf.
 */
function crossOrigin(req) {
    const origin = req.headers.origin;
    if (origin) {
        try {
            return new URL(origin).host !== req.headers.host;
        } catch {
            return true;
        }
    }
    return req.headers['sec-fetch-site'] === 'cross-site';
}

/*
 * The family password, as a phone's calendar account sends it: with every
 * request, as Basic auth, since a calendar app keeps no cookie.
 *
 * The same limiter as the sign-in form, so a phone cannot be used to guess
 * faster than the form can. And once a password has been found right, its
 * hash is remembered for a few minutes: a phone syncing asks a dozen things in
 * a row, and a dozen scrypts would make every sync slow for the whole house.
 */
const DAV_REMEMBER_MS = 10 * 60 * 1000;
let davGood = null; // { digest, until }

async function davAuthorised(req) {
    if (!authRequired()) return true;
    const header = String(req.headers.authorization ?? '');
    if (!/^basic /i.test(header)) return false;
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    // The user name is not checked: there is one family, and one password.
    const password = decoded.slice(decoded.indexOf(':') + 1);
    const digest = crypto.createHash('sha256').update(password).digest('hex');
    if (davGood && davGood.until > Date.now() && davGood.digest === digest) return true;

    const client = clientAddress(req);
    if (loginRetryAfter(client) > 0) return 'throttled';
    const attempt = noteLoginAttempt(client);
    if (!(await verifyPassword(password))) {
        log('failed calendar account sign-in from', client);
        await new Promise((r) => setTimeout(r, 500));
        return false;
    }
    noteLoginSuccess(client, attempt);
    davGood = { digest, until: Date.now() + DAV_REMEMBER_MS };
    return true;
}

/* What is the calendar account's: /dav, the address a phone looks it up by, and a phone probing '/'. */
const isDav = (method, pathname) =>
    pathname === '/dav' ||
    pathname.startsWith('/dav/') ||
    pathname.startsWith('/.well-known/caldav') ||
    (pathname === '/' && !['GET', 'HEAD', 'POST'].includes(method));

// ------------------------------------------------------------------ server --

async function handle(req, res) {
    // Never framed, so no other page can lay this one under a decoy and have
    // somebody tap "Clear week" through it.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // A fixed base rather than the Host header: only the path and query are
    // used, and a malformed Host made this throw before anything could catch.
    let url;
    try {
        url = new URL(req.url, 'http://localhost');
    } catch {
        return fail(res, 400, 'Bad request.');
    }

    if (!authRequired() && !hostAllowed(req.headers.host)) {
        log('refused host', JSON.stringify(String(req.headers.host).slice(0, 200)));
        return fail(res, 421, 'Meal Plan does not answer to this address. It can be added to MEALPLAN_ALLOWED_HOSTS.');
    }

    if (isDav(req.method, url.pathname)) {
        if (['PUT', 'DELETE', 'MOVE', 'PROPPATCH'].includes(req.method) && crossOrigin(req)) {
            return fail(res, 403, 'Cross-origin request refused.');
        }
        return handleDav(req, res, url, { authorised: () => davAuthorised(req), log });
    }

    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';

    if (!isApi) return serveStatic(req, res, url.pathname);

    const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!match) return fail(res, 404, 'Not found');

    if (match.auth && authRequired() && !isAuthenticated(req)) {
        return fail(res, 401, 'Not signed in.');
    }

    if (['POST', 'PUT', 'DELETE'].includes(req.method) && crossOrigin(req)) {
        return fail(res, 403, 'Cross-origin request refused.');
    }

    try {
        await match.handler(req, res, match.pattern.exec(url.pathname), url);
    } catch (err) {
        if (err instanceof HttpError) {
            if (!res.headersSent) fail(res, err.status, err.message);
            return;
        }
        log('request failed', url.pathname, err);
        if (!res.headersSent) fail(res, 500, 'Something went wrong on the server.');
    }
}

/*
 * Wrapped whole, so that nothing a request does -- in a route or in the
 * parsing before it -- can escape as a rejection this async listener would
 * otherwise hand to Node unhandled.
 */
const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
        log('request failed outside its handler', req.url, err);
        try {
            if (!res.headersSent) fail(res, 500, 'Something went wrong on the server.');
            else res.destroy();
        } catch {
            res.destroy();
        }
    });
});

ensureDataDir();
server.listen(PORT, '0.0.0.0', () => {
    log(`Meal Plan listening on :${PORT}`);
    if (!authRequired()) log('no password set -- anyone who can reach this port can change the plan');
    if (passwordUnusable()) log('the stored password hash is malformed, so no password will be accepted');
});
