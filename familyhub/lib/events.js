import crypto from 'node:crypto';
import { dataPath, isIsoDate, readJson, writeJson } from './store.js';

/*
 * Calendar events: the dentist, soccer on Saturdays, Grandma's birthday.
 *
 * A repeating event is stored once, as its first date and a rule, never as a
 * copy per week -- a weekly practice saved as fifty-two records is fifty-two
 * things to edit when the time changes. The calendar asks for a range and
 * gets back what falls in it.
 *
 * Dates are counted in whole days from a fixed point rather than with Date
 * arithmetic on local time. Local midnight moves when the clocks change, and
 * "add seven days" across a clock change in local time lands on 11pm the day
 * before -- which is how a Saturday practice ends up on Friday every November.
 */

const FILE = dataPath('events.json');

export const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

/*
 * When a phone subscribed to the calendar reminds you: minutes before the
 * start. An all-day event starts at midnight, so its choices are the ones a
 * calendar app gives it -- on the day at 9am is -540, "nine hours after" --
 * rather than ten minutes before midnight.
 */
export const TIMED_ALERTS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
export const ALL_DAY_ALERTS = [-540, 900, 2340, 9540];
const MAX_SPAN_DAYS = 31;
/* Every so many days, weeks, months or years: "every 2 weeks" is 2. */
export const MAX_EVERY = 99;
const MAX_EVENTS = 2000;

export const loadEvents = () => readJson(FILE, []);
export const saveEvents = (list) => writeJson(FILE, list);

const newId = () => `e_${crypto.randomBytes(8).toString('hex')}`;

// ------------------------------------------------------------ whole days --

/** Days since 1 January 1970 for a YYYY-MM-DD, with no time zone in it. */
export const dayNumber = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

export const fromDayNumber = (n) => new Date(n * 86_400_000).toISOString().slice(0, 10);

const parts = (iso) => iso.split('-').map(Number);

const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s ?? ''));

// -------------------------------------------------------------- the rules --

/**
 * Whether an occurrence of `event` begins on day `n`.
 *
 * Monthly keeps the day of the month and simply has no occurrence in a month
 * that is too short for it: an event on the 31st happens seven times a year,
 * not on the 30th or the 1st. Yearly does the same for the 29th of February.
 * Calendars that slide such dates to the nearest real day disagree with each
 * other about which way to slide, and a birthday that moves is worse than one
 * that waits for a leap year.
 */
export function startsOn(event, n) {
    const base = dayNumber(event.date);
    if (n < base) return false;
    if (event.until && n > dayNumber(event.until)) return false;
    const iso = fromDayNumber(n);
    if (event.skip?.includes(iso)) return false;

    const every = event.every || 1;
    switch (event.repeat) {
        case 'daily':
            return (n - base) % every === 0;
        case 'weekly':
            return (n - base) % (7 * every) === 0;
        case 'monthly': {
            const [by, bm, bd] = parts(event.date);
            const [y, m, d] = parts(iso);
            return d === bd && ((y - by) * 12 + (m - bm)) % every === 0;
        }
        case 'yearly': {
            const [by, bm, bd] = parts(event.date);
            const [y, m, d] = parts(iso);
            return m === bm && d === bd && (y - by) % every === 0;
        }
        default:
            return n === base;
    }
}

/** How many days an event covers after its first, for a multi-day one. */
const spanOf = (event) => (event.allDay && event.endDate ? dayNumber(event.endDate) - dayNumber(event.date) : 0);

/**
 * Every day in [from, to] that some event touches, one entry per event per day.
 *
 * A three-day trip comes back as three entries, each knowing which day of it
 * it is, so the month can draw it on all three days without the page doing
 * any date arithmetic of its own.
 */
export function occurrences(events, from, to) {
    const start = dayNumber(from);
    const end = dayNumber(to);
    const out = [];
    for (const event of events) {
        const span = spanOf(event);
        // An occurrence that began up to `span` days before the range still
        // reaches into it.
        for (let n = start - span; n <= end; n++) {
            if (!startsOn(event, n)) continue;
            for (let k = 0; k <= span; k++) {
                const day = n + k;
                if (day < start || day > end) continue;
                out.push({
                    id: event.id,
                    title: event.title,
                    date: fromDayNumber(day),
                    occurrence: fromDayNumber(n),
                    allDay: event.allDay,
                    start: event.allDay ? null : event.start,
                    end: event.allDay ? null : event.end,
                    members: event.members,
                    location: event.location,
                    repeat: event.repeat,
                    every: event.every || 1,
                    // Second and later days of a multi-day event, so the month
                    // can show the trip continuing rather than starting again.
                    continues: k > 0,
                    lastDay: k === span,
                });
            }
        }
    }
    // All-day first, then by time, then by title: the order a person reads a day.
    return out.sort(
        (a, b) =>
            a.date.localeCompare(b.date) ||
            Number(b.allDay) - Number(a.allDay) ||
            String(a.start ?? '').localeCompare(String(b.start ?? '')) ||
            a.title.localeCompare(b.title),
    );
}

// ------------------------------------------------------------- the input --

export function normaliseEvent(input, memberIds, existing = null, count = 0) {
    const errors = [];
    const s = (v) => String(v ?? '').trim();

    const title = s(input.title);
    if (!title) errors.push('Give it a name.');
    if (title.length > 120) errors.push('That name is too long.');
    if (!existing && count >= MAX_EVENTS) errors.push('The calendar is full. Delete some old events first.');

    const date = s(input.date);
    if (!isIsoDate(date)) errors.push('Pick the day it happens.');

    const allDay = input.allDay === true || !s(input.start);
    let start = null;
    let end = null;
    if (!allDay) {
        start = s(input.start);
        if (!isTime(start)) errors.push('Pick a start time.');
        end = s(input.end) || null;
        if (end && !isTime(end)) errors.push('That end time is not a time.');
        if (end && isTime(start) && end <= start) errors.push('It has to end after it starts.');
    }

    let endDate = null;
    if (allDay && s(input.endDate) && s(input.endDate) !== date) {
        endDate = s(input.endDate);
        if (!isIsoDate(endDate)) errors.push('Pick the last day.');
        else if (isIsoDate(date)) {
            const span = dayNumber(endDate) - dayNumber(date);
            if (span < 0) errors.push('The last day has to be on or after the first.');
            if (span > MAX_SPAN_DAYS) errors.push(`An event can run for up to ${MAX_SPAN_DAYS} days.`);
        }
    }

    const repeat = REPEATS.includes(input.repeat) ? input.repeat : 'none';
    const everyIn = Number(input.every ?? 1);
    const every = repeat !== 'none' && Number.isInteger(everyIn) && everyIn >= 1 && everyIn <= MAX_EVERY ? everyIn : 1;
    let until = null;
    if (repeat !== 'none' && s(input.until)) {
        until = s(input.until);
        if (!isIsoDate(until)) errors.push('That end date for the repeat is not a date.');
        else if (isIsoDate(date) && until < date) errors.push('It cannot stop repeating before it starts.');
    }

    const alertIn = input.alert === '' || input.alert == null ? null : Number(input.alert);
    const alert = (allDay ? ALL_DAY_ALERTS : TIMED_ALERTS).includes(alertIn) ? alertIn : null;

    const known = new Set(memberIds);
    const members = [...new Set(Array.isArray(input.members) ? input.members : [])].filter((id) => known.has(id));

    const event = {
        id: existing?.id ?? newId(),
        title,
        date,
        endDate,
        allDay,
        start,
        end,
        members,
        location: s(input.location).slice(0, 200),
        notes: s(input.notes).slice(0, 2000),
        repeat,
        every,
        until,
        alert,
        // Where an iPhone keeps it, for one added there: its own name for the
        // event, and the file name it put it under. See lib/caldav.js.
        ...(existing?.uid ? { uid: existing.uid, href: existing.href } : {}),
        // What the phone sent that the hub has no field for. See lib/ical.js.
        ...(existing?.extra?.length ? { extra: existing.extra } : {}),
        // Skipped occurrences belong to the series, so editing the series keeps
        // them -- unless it no longer repeats, when there is nothing to skip.
        skip: repeat === 'none' ? [] : (existing?.skip ?? []),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    return { event, errors };
}

/** Takes someone off every event; the events themselves stay. */
export function unassignMember(memberId) {
    const events = loadEvents();
    let changed = false;
    for (const event of events) {
        if (event.members?.includes(memberId)) {
            event.members = event.members.filter((id) => id !== memberId);
            changed = true;
        }
    }
    if (changed) saveEvents(events);
}
