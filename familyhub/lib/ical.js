import { dayNumber, fromDayNumber } from './events.js';

/*
 * iCalendar text, both ways: reading what an iPhone sends when an event or a
 * reminder is saved in its Calendar or Reminders app, and writing each event
 * and reminder as the file the phone is given (see lib/caldav.js).
 *
 * Only as much of RFC 5545 as that takes: properties and their parameters,
 * nested components, dates and times, durations and repeat rules.
 */

/* Undoes the escaping of TEXT values: \n, \, \; and \\. */
export const unescapeText = (s) => String(s ?? '').replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));

/** One content line: its name, parameters and value, and the line itself. */
function parseLine(line) {
    let i = 0;
    while (i < line.length && line[i] !== ';' && line[i] !== ':') i++;
    const name = line.slice(0, i).toUpperCase();
    const params = {};
    while (line[i] === ';') {
        i++;
        const eq = line.indexOf('=', i);
        if (eq < 0) break;
        const key = line.slice(i, eq).toUpperCase();
        i = eq + 1;
        let value = '';
        // A parameter value can be quoted, and only then contain ; or :.
        while (i < line.length && line[i] !== ';' && line[i] !== ':') {
            if (line[i] === '"') {
                const close = line.indexOf('"', i + 1);
                if (close < 0) break;
                value += line.slice(i + 1, close);
                i = close + 1;
            } else {
                value += line[i++];
            }
        }
        params[key] = value;
    }
    return { name, params, value: line.slice(i + 1), raw: line };
}

/** The components in `text`, as { name, props, children } trees. */
export function parseCalendar(text) {
    const lines = String(text)
        .replace(/\r?\n[ \t]/g, '') // unfold
        .split(/\r?\n/)
        .filter((l) => l.trim());
    const root = { name: 'ROOT', props: [], children: [] };
    const stack = [root];
    for (const line of lines) {
        const prop = parseLine(line);
        const top = stack.at(-1);
        if (prop.name === 'BEGIN') {
            const comp = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
            top.children.push(comp);
            stack.push(comp);
        } else if (prop.name === 'END') {
            if (stack.length > 1) stack.pop();
        } else {
            top.props.push(prop);
        }
    }
    return root.children;
}

export const prop = (comp, name) => comp.props.find((p) => p.name === name);
export const props = (comp, name) => comp.props.filter((p) => p.name === name);

// ---------------------------------------------------------- dates and times --

/** The family's time zone, for the rare time a phone sends one in UTC. */
const serverZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const validZone = (tz) => {
    try {
        Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
};

/**
 * The zone to read UTC times in: the one the phone names elsewhere in the same
 * file if it names one -- which it nearly always does, as the TZID of the start
 * -- and the server's otherwise.
 */
export function zoneOf(components) {
    const seen = [];
    const walk = (c) => {
        for (const p of c.props) if (p.params.TZID) seen.push(p.params.TZID);
        c.children.forEach(walk);
    };
    components.forEach(walk);
    return seen.find(validZone) ?? serverZone();
}

/** A UTC instant as the wall-clock date and time in `zone`. */
function inZone(ms, zone) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: zone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        })
            .formatToParts(new Date(ms))
            .map((p) => [p.type, p.value]),
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * A DATE or DATE-TIME value as { date, time }, time being null for a date.
 *
 * Times with a TZID are taken as written: they are the phone's own wall
 * clock, which is the family's, and the hub keeps wall-clock times.
 */
export function parseWhen(value, zone) {
    const v = String(value ?? '').trim();
    let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
    m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
    if (!m) return null;
    if (m[7]) return inZone(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]), zone);
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}

/** A DURATION in minutes, signed; null if it is not one. */
export function parseDuration(value) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value ?? '').trim());
    if (!m) return null;
    const mins = (+m[2] || 0) * 10080 + (+m[3] || 0) * 1440 + (+m[4] || 0) * 60 + (+m[5] || 0) + Math.round((+m[6] || 0) / 60);
    return m[1] === '-' ? -mins : mins;
}

export const addDays = (iso, n) => fromDayNumber(dayNumber(iso) + n);

/** Minutes from one date and time to another. */
export const minutesBetween = (a, b) =>
    (dayNumber(b.date) - dayNumber(a.date)) * 1440 + toMinutes(b.time ?? '00:00') - toMinutes(a.time ?? '00:00');

const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};

/** A date and a number of minutes after its midnight, as { date, time }. */
export function atMinutes(date, minutes) {
    const days = Math.floor(minutes / 1440);
    const rest = minutes - days * 1440;
    return {
        date: addDays(date, days),
        time: `${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}`,
    };
}

// ---------------------------------------------------------- repeat rules --

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** An RRULE value as a plain object; `parts` keeps every key it had. */
export function parseRule(value) {
    const parts = {};
    for (const piece of String(value ?? '').split(';')) {
        const eq = piece.indexOf('=');
        if (eq > 0) parts[piece.slice(0, eq).trim().toUpperCase()] = piece.slice(eq + 1).trim().toUpperCase();
    }
    return {
        parts,
        freq: parts.FREQ,
        interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1,
        byday: parts.BYDAY ? parts.BYDAY.split(',') : [],
        until: parts.UNTIL ?? null,
        count: parts.COUNT ? Number(parts.COUNT) : null,
    };
}

/* Repeat rule parts the hub keeps, or reads and checks; any other part means
   a rule it cannot keep. */
const KNOWN_RULE_PARTS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'UNTIL', 'COUNT', 'WKST']);

export const unknownRuleParts = (rule) => Object.keys(rule.parts).filter((k) => !KNOWN_RULE_PARTS.has(k));

// ------------------------------------------------- what is kept as it came --

/*
 * Properties the hub has no field for -- a reminder's flag and priority, a
 * link, the map pin behind an event's place -- kept as the lines they came in
 * on and sent back out with the rest, so that editing a reminder in the hub
 * does not quietly unflag it on the phone.
 *
 * Not the ones the hub writes itself, and not invitations: an event that goes
 * back out with attendees on it becomes a meeting to answer.
 */
const MANAGED = new Set([
    'UID', 'DTSTAMP', 'SUMMARY', 'DTSTART', 'DTEND', 'DUE', 'DURATION', 'RRULE', 'RDATE', 'EXDATE', 'EXRULE',
    'RECURRENCE-ID', 'LOCATION', 'DESCRIPTION', 'SEQUENCE', 'CREATED', 'LAST-MODIFIED', 'STATUS', 'COMPLETED',
    'PERCENT-COMPLETE', 'ATTENDEE', 'ORGANIZER', 'TRANSP',
]);
const MAX_EXTRA_LINES = 30;
const MAX_EXTRA_LINE = 2000;

export const extraLines = (comp) =>
    comp.props
        .filter((p) => !MANAGED.has(p.name) && /^[A-Z0-9-]+$/.test(p.name) && p.raw.length <= MAX_EXTRA_LINE)
        .slice(0, MAX_EXTRA_LINES)
        .map((p) => p.raw);

// ----------------------------------------------------------------- writing --

/* Commas, semicolons and backslashes mean something in iCalendar text. */
const text = (s) =>
    String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');

/*
 * Lines longer than 75 bytes are folded onto the next with a leading space.
 *
 * Bytes, not characters, and never through the middle of one: an emoji or an
 * accented name split across the fold arrives as two broken halves.
 */
function fold(line) {
    const out = [];
    let current = '';
    let bytes = 0;
    for (const ch of line) {
        const size = Buffer.byteLength(ch);
        const limit = out.length ? 74 : 75; // continuation lines start with a space
        if (bytes + size > limit) {
            out.push(current);
            current = '';
            bytes = 0;
        }
        current += ch;
        bytes += size;
    }
    out.push(current);
    return out.join('\r\n ');
}

const day = (iso) => iso.replace(/-/g, '');
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/*
 * Times are "floating": 10:00 means ten o'clock wherever the phone is.
 *
 * The hub keeps no time zone -- the family's day is the family's day -- and a
 * zone made up here would move every event the moment it was wrong.
 */
const dateTime = (iso, hhmm) => `${day(iso)}T${hhmm.replace(':', '')}00`;

/** A time plus minutes, rolling into the next day if it has to. */
function later(iso, hhmm, minutes) {
    const [h, m] = hhmm.split(':').map(Number);
    const total = h * 60 + m + minutes;
    const date = fromDayNumber(dayNumber(iso) + Math.floor(total / 1440));
    const t = total % 1440;
    return dateTime(date, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
}

/** Minutes before the start as an iCalendar trigger: 15 is -PT15M, -540 is PT9H. */
function trigger(minutes) {
    const sign = minutes > 0 ? '-' : '';
    let m = Math.abs(minutes);
    const d = Math.floor(m / 1440);
    m %= 1440;
    const h = Math.floor(m / 60);
    m %= 60;
    const time = h || m || !d ? `T${h ? `${h}H` : ''}${m || (!h && !d) ? `${m}M` : ''}` : '';
    return `${sign}P${d ? `${d}D` : ''}${time}`;
}

const names = (ids, members) => (ids ?? []).map((id) => members.find((m) => m.id === id)?.name).filter(Boolean);

/* Whose it is, after the name: every event on the phone is one colour, so the
   colour no longer says whose the dentist appointment is. lib/caldav.js reads
   it back the same way. */
const withWho = (title, who) => (who.length ? `${title} (${who.join(', ')})` : title);

/** The UID an event goes out under: the iPhone's own, for one added there. */
export const eventUid = (event) => event.uid ?? `${event.id}@family-hub`;

function eventLines(event, members, now) {
    const who = names(event.members, members);
    const lines = ['BEGIN:VEVENT', `UID:${eventUid(event)}`, `DTSTAMP:${stamp(now)}`];
    if (event.updatedAt) lines.push(`LAST-MODIFIED:${stamp(new Date(event.updatedAt))}`);
    lines.push(`SUMMARY:${text(withWho(event.title, who))}`);

    if (event.allDay) {
        const last = event.endDate || event.date;
        lines.push(`DTSTART;VALUE=DATE:${day(event.date)}`);
        // The end of an all-day event is the day after its last, by the standard.
        lines.push(`DTEND;VALUE=DATE:${day(fromDayNumber(dayNumber(last) + 1))}`);
    } else {
        lines.push(`DTSTART:${dateTime(event.date, event.start)}`);
        // An event with no end shows as an hour, which is what a phone would
        // assume anyway, but said rather than left to each app to guess.
        lines.push(`DTEND:${event.end ? dateTime(event.date, event.end) : later(event.date, event.start, 60)}`);
    }

    if (event.repeat && event.repeat !== 'none') {
        // Monthly on the 31st and yearly on 29 February skip the months and
        // years that do not have that day -- as the hub does, and as the
        // standard says a rule must.
        const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' }[event.repeat];
        let rule = `RRULE:FREQ=${freq}`;
        if (event.every > 1) rule += `;INTERVAL=${event.every}`;
        if (event.repeat === 'monthly') rule += `;BYMONTHDAY=${Number(event.date.slice(8))}`;
        if (event.until) rule += `;UNTIL=${event.allDay ? day(event.until) : `${day(event.until)}T235959`}`;
        lines.push(rule);
        if (event.skip?.length) {
            lines.push(
                event.allDay
                    ? `EXDATE;VALUE=DATE:${event.skip.map(day).join(',')}`
                    : `EXDATE:${event.skip.map((d) => dateTime(d, event.start)).join(',')}`,
            );
        }
    }

    if (event.location) lines.push(`LOCATION:${text(event.location)}`);
    // The notes and nothing else: whatever goes out comes back when the phone
    // saves the event, so anything added here would come back in the notes.
    if (event.notes) lines.push(`DESCRIPTION:${text(event.notes)}`);
    lines.push(...(event.extra ?? []));
    if (Number.isInteger(event.alert)) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(event.title)}`, `TRIGGER:${trigger(event.alert)}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
    return lines;
}

const HEADER = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Hub//Home Server//EN',
    'CALSCALE:GREGORIAN',
];
const finish = (lines) => `${[...lines, 'END:VCALENDAR'].map(fold).join('\r\n')}\r\n`;

/**
 * One event as a calendar file of its own, the way the calendar account hands
 * them out.
 *
 * Stamped with when it last changed rather than now, so the same event is the
 * same text every time it is asked for -- its ETag is a hash of this, and a
 * phone that saw a new ETag on every sync would fetch everything every time.
 */
export function eventFile(event, members) {
    const changed = new Date(event.updatedAt ?? event.createdAt ?? 0);
    return finish([...HEADER, ...eventLines(event, members, changed)]);
}

export const taskUid = (task) => task.uid ?? `${task.id}@family-hub`;

/**
 * One reminder as a calendar file, for the Reminders app.
 *
 * A timed one carries an alarm at its time, which is what makes the phone
 * remind anybody of it; one with only a day is left to the phone, which
 * reminds of those at the hour it is set to in its own settings.
 */
export function taskFile(task) {
    const changed = new Date(task.updatedAt ?? task.createdAt ?? 0);
    const lines = ['BEGIN:VTODO', `UID:${taskUid(task)}`, `DTSTAMP:${stamp(changed)}`];
    if (task.createdAt) lines.push(`CREATED:${stamp(new Date(task.createdAt))}`);
    lines.push(`LAST-MODIFIED:${stamp(changed)}`, `SUMMARY:${text(task.title)}`);
    if (task.notes) lines.push(`DESCRIPTION:${text(task.notes)}`);
    if (task.date) {
        const when = task.time ? `:${dateTime(task.date, task.time)}` : `;VALUE=DATE:${day(task.date)}`;
        lines.push(`DTSTART${when}`, `DUE${when}`);
    }
    if (task.repeat !== 'none' && task.date) {
        const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' }[task.repeat];
        let rule = `RRULE:FREQ=${freq}`;
        if (task.every > 1) rule += `;INTERVAL=${task.every}`;
        if (task.repeat === 'weekly') rule += `;BYDAY=${task.days.map((d) => WEEKDAYS[d]).join(',')}`;
        if (task.until) rule += `;UNTIL=${task.time ? `${day(task.until)}T235959` : day(task.until)}`;
        lines.push(rule);
    }
    const done = task.repeat === 'none' ? task.done.length > 0 : Boolean(task.over);
    if (done) {
        const at = task.completedAt ? new Date(task.completedAt) : new Date(`${task.done.at(-1) ?? task.date}T12:00:00Z`);
        lines.push('STATUS:COMPLETED', `COMPLETED:${stamp(at)}`, 'PERCENT-COMPLETE:100');
    } else {
        lines.push('STATUS:NEEDS-ACTION');
    }
    lines.push(...(task.extra ?? []));
    if (task.time && !done) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(task.title)}`, 'TRIGGER:PT0S', 'END:VALARM');
    }
    lines.push('END:VTODO');
    return finish([...HEADER, ...lines]);
}
