import crypto from 'node:crypto';
import { dayNumber, fromDayNumber } from './events.js';
import { dataPath, isIsoDate, readJson, writeJson } from './store.js';

/*
 * Reminders: feed the dog every day, bins out on Tuesdays, call the plumber.
 * Stored as "tasks", which is what they were first called; the file name and
 * the API kept it so the backups and the data on disk did not have to change.
 *
 * They work the way the iPhone's Reminders app does, because the same
 * reminders are in that app too (see lib/caldav.js), and two sets of rules
 * for one list would have the hub and the phone disagreeing about what is
 * still to do.
 *
 * So a reminder has one date it is due, or none. One that is done is done.
 * One that repeats is due on one day at a time: ticking it moves it on to the
 * next, and one nobody ticked stays where it was, late, on today's list --
 * yesterday's "feed the dog" waits to be ticked before today's comes round.
 */

const FILE = dataPath('tasks.json');

export const TASK_REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const MAX_TASKS = 500;
const MAX_EVERY = 99;

/*
 * How far back the ticks of a repeating reminder are kept.
 *
 * One done every day for years would otherwise grow a list of every one of
 * those days. A little over a year is enough to look back on and still small.
 */
const KEEP_DONE_DAYS = 400;

/*
 * The version of the rules a stored reminder follows. The first ones came
 * back fresh every day from a start date; see migrateTasks.
 */
const VERSION = 2;

export const loadTasks = () => readJson(FILE, []);
export const saveTasks = (list) => writeJson(FILE, list);

const newId = () => `t_${crypto.randomBytes(8).toString('hex')}`;

/** 0 for Sunday to 6 for Saturday, without a Date in local time. 1 January 1970 was a Thursday. */
export const weekday = (iso) => (((dayNumber(iso) + 4) % 7) + 7) % 7;

const ymd = (iso) => iso.split('-').map(Number);
const isoOf = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const realDate = (y, m, d) => d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

// -------------------------------------------------------------- the rules --

/** Whether day `iso` is one the rule lands on, ignoring how often. */
function onRule(task, iso, anchor = task.date) {
    switch (task.repeat) {
        case 'daily':
            return true;
        case 'weekly':
            return task.days.includes(weekday(iso));
        case 'monthly':
            return iso.slice(8) === anchor.slice(8);
        case 'yearly':
            return iso.slice(5) === anchor.slice(5);
        default:
            return false;
    }
}

/**
 * The day after `from` that a repeating reminder is next due, or null when its
 * repeating has ended.
 *
 * Monthly keeps the day of the month and skips a month that is too short for
 * it, and yearly does the same for 29 February -- the way the events do, and
 * the way the iPhone does.
 */
export function nextDue(task, from) {
    const every = task.every || 1;
    let next = null;
    if (task.repeat === 'daily') {
        next = fromDayNumber(dayNumber(from) + every);
    } else if (task.repeat === 'weekly') {
        const wd = weekday(from);
        const days = [...task.days].sort();
        const later = days.find((d) => d > wd);
        // Later the same week, or the first of the days in the next week it
        // runs in.
        next = fromDayNumber(dayNumber(from) + (later !== undefined ? later - wd : 7 - wd + 7 * (every - 1) + days[0]));
    } else if (task.repeat === 'monthly' || task.repeat === 'yearly') {
        const [y, m, d] = ymd(from);
        for (let k = 1; k <= 100 && !next; k++) {
            const months = task.repeat === 'monthly' ? every * k : 12 * every * k;
            const total = y * 12 + (m - 1) + months;
            const ny = Math.floor(total / 12);
            const nm = (total % 12) + 1;
            if (realDate(ny, nm, d)) next = isoOf(ny, nm, d);
        }
    }
    if (!next || (task.until && next > task.until)) return null;
    return next;
}

/** The first day on or after `iso` that the rule lands on: a weekly one due on a day it does not happen moves on. */
export function alignDue(task, iso) {
    for (let n = dayNumber(iso), end = n + 800; n <= end; n++) {
        const day = fromDayNumber(n);
        if (onRule(task, day, iso)) return day;
    }
    return iso;
}

const dropOne = (list, day) => {
    const i = list.indexOf(day);
    return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
};

// ----------------------------------------------------------------- the day --

/**
 * What is on the list for `day`, as seen on `today`.
 *
 * `today` comes from the device asking, not from the server's clock: the
 * server keeps UTC, and the family's evening would otherwise become tomorrow
 * at seven o'clock.
 */
export function tasksOn(tasks, day, today) {
    const out = [];
    for (const task of tasks) {
        const entry = (done, overdue) => ({
            id: task.id,
            title: task.title,
            member: task.member,
            repeat: task.repeat,
            every: task.every || 1,
            days: task.days,
            date: task.date,
            time: task.time ?? null,
            notes: task.notes ?? '',
            done,
            overdue,
        });
        // Ticks show on the day they were ticked. A repeating one can have a
        // tick and still be due the same day: yesterday's, ticked late this
        // morning, and today's, still to do.
        if (task.done.includes(day)) out.push(entry(true, false));
        if (task.repeat !== 'none' ? task.over : task.done.length) continue;

        if (task.date === day) {
            out.push(entry(false, false));
        } else if (day === today && (!task.date || task.date < today)) {
            // Undated ones, and late ones, wait on today's list.
            out.push(entry(false, Boolean(task.date)));
        }
    }
    // Late first, so they are not missed; then by time; done last.
    return out.sort(
        (a, b) =>
            Number(a.done) - Number(b.done) ||
            Number(b.overdue) - Number(a.overdue) ||
            (a.time ?? '99').localeCompare(b.time ?? '99') ||
            a.title.localeCompare(b.title),
    );
}

/** Ticks or unticks `task` on `day`. Returns false when there is nothing there to tick or untick. */
export function markDone(task, day, done, today) {
    const now = new Date().toISOString();
    if (task.repeat === 'none') {
        if (!tasksOn([task], day, today).length) return false;
        task.done = done ? [day] : [];
        task.completedAt = done ? now : null;
    } else if (done) {
        // The one that is due: on its day, or late on today's list.
        if (task.over || !(task.date === day || (day === today && task.date < today))) return false;
        task.last = { on: day, due: task.date };
        const oldest = dayNumber(day) - KEEP_DONE_DAYS;
        task.done = [...task.done, day].filter((d) => dayNumber(d) >= oldest).sort();
        task.completedAt = now;
        const next = nextDue(task, task.date);
        if (next) task.date = next;
        else task.over = true;
    } else {
        // Only the latest tick can be taken back: it is the only one that
        // still knows which day the reminder was due before it moved on.
        if (task.last?.on !== day) return false;
        task.date = task.last.due;
        task.done = dropOne(task.done, day);
        task.over = false;
        task.last = null;
    }
    task.updatedAt = now;
    return true;
}

/**
 * Brings reminders saved under the first rules up to these.
 *
 * Then a repeating one had a start date and came back fresh on every day of
 * its rule. Now it has the one day it is next due: the first of its days not
 * already ticked, from `today` on -- not from the start date, which would put
 * every daily reminder ever made on today's list as weeks late.
 */
export function migrateTasks(tasks, today) {
    let changed = false;
    for (const task of tasks) {
        if (task.v === VERSION) continue;
        changed = true;
        task.v = VERSION;
        task.every ??= 1;
        task.time ??= null;
        task.notes ??= '';
        if (task.repeat === 'none') continue;
        const lastDone = task.done.at(-1);
        let from = today;
        if (task.date && task.date > from) from = task.date;
        if (lastDone && lastDone >= from) from = fromDayNumber(dayNumber(lastDone) + 1);
        // Monthly ones keep their day of the month from the old start date.
        task.date = ['monthly', 'yearly'].includes(task.repeat) ? alignTo(task, task.date ?? from, from) : alignDue(task, from);
        task.over = false;
        task.last = null;
    }
    return changed;
}

/** For the migration: the first day on or after `from` with the old start date's day (and month). */
function alignTo(task, anchor, from) {
    for (let n = dayNumber(from), end = n + 800; n <= end; n++) {
        const day = fromDayNumber(n);
        if (task.repeat === 'monthly' ? day.slice(8) === anchor.slice(8) : day.slice(5) === anchor.slice(5)) return day;
    }
    return from;
}

// ------------------------------------------------------------- the input --

/*
 * `input` is what the hub's editor sends, or what lib/caldav.js made of what
 * a phone sent. A field left out keeps what it was: the hub's editor has no
 * place for when a repeat ends, and saving there must not clear one set on
 * the phone.
 */
export function normaliseTask(input, memberIds, existing = null, count = 0) {
    const errors = [];
    const s = (v) => String(v ?? '').trim();
    const has = (key) => Object.hasOwn(input, key);

    const title = s(input.title);
    if (!title) errors.push('Say what needs doing.');
    if (title.length > 200) errors.push('That is too long for a reminder.');
    if (!existing && count >= MAX_TASKS) errors.push('The list is full. Delete some old ones first.');

    const repeat = TASK_REPEATS.includes(input.repeat) ? input.repeat : 'none';
    const everyIn = Number(input.every ?? existing?.every ?? 1);
    const every = repeat !== 'none' && Number.isInteger(everyIn) && everyIn >= 1 && everyIn <= MAX_EVERY ? everyIn : 1;

    let days = [];
    if (repeat === 'weekly') {
        const raw = Array.isArray(input.days) ? input.days : [];
        days = [...new Set(raw.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
        if (!days.length) errors.push('Pick the days it happens.');
    }

    // When it is due; a repeating one, when it is next due.
    let date = s(input.date) || null;
    if (date && !isIsoDate(date)) errors.push('That is not a date.');
    if (repeat !== 'none' && !date) errors.push('Pick the day it is next due.');
    if (repeat === 'weekly' && date && isIsoDate(date) && days.length) date = alignDue({ repeat, days }, date);

    const time = s(input.time) || null;
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.push('That is not a time.');
    if (time && !date) errors.push('Pick a day for the time to be on.');

    const until = has('until') ? s(input.until) || null : (existing?.until ?? null);
    if (until && !isIsoDate(until)) errors.push('That end date for the repeat is not a date.');

    // Somebody's, or anybody's. Someone who has since been removed is anybody.
    const member = memberIds.includes(input.member) ? input.member : null;

    // Ticks belong to the reminder, so editing it keeps them -- except when it
    // changes between one-off and repeating, where they mean different things.
    const sameKind = existing && (existing.repeat === 'none') === (repeat === 'none');
    // A repeating one whose due day was moved by hand has nothing left to
    // take back: the last tick no longer knows where to put it.
    const sameDue = sameKind && existing.date === date;

    const task = {
        id: existing?.id ?? newId(),
        v: VERSION,
        title,
        member,
        notes: (has('notes') ? s(input.notes) : (existing?.notes ?? '')).slice(0, 4000),
        repeat,
        every,
        days,
        date,
        time: date ? time : null,
        until: repeat === 'none' ? null : until,
        done: sameKind ? existing.done : [],
        over: repeat !== 'none' && sameDue ? Boolean(existing.over) : false,
        last: repeat !== 'none' && sameDue ? (existing.last ?? null) : null,
        completedAt: sameKind ? (existing.completedAt ?? null) : null,
        ...(existing?.uid ? { uid: existing.uid, href: existing.href } : {}),
        ...(existing?.extra?.length ? { extra: existing.extra } : {}),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    return { task, errors };
}

/** Gives someone's reminders to everybody; the reminders themselves stay. */
export function unassignMember(memberId) {
    const tasks = loadTasks();
    let changed = false;
    for (const task of tasks) {
        if (task.member === memberId) {
            task.member = null;
            changed = true;
        }
    }
    if (changed) saveTasks(tasks);
}
