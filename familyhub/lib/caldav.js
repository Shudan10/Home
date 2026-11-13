import crypto from 'node:crypto';

import { ALL_DAY_ALERTS, dayNumber, loadEvents, normaliseEvent, saveEvents, startsOn, TIMED_ALERTS } from './events.js';
import { loadMembers } from './family.js';
import { loadSettings, saveSettings } from './settings.js';
import {
    addDays,
    atMinutes,
    eventFile,
    eventUid,
    extraLines,
    parseCalendar,
    parseDuration,
    parseRule,
    parseWhen,
    prop,
    props,
    taskFile,
    taskUid,
    unescapeText,
    unknownRuleParts,
    WEEKDAYS,
    zoneOf,
} from './ical.js';
import { loadTasks, markDone, migrateTasks, nextDue, normaliseTask, saveTasks, weekday } from './tasks.js';

/*
 * The family calendar and reminders as a CalDAV account: the kind an iPhone
 * adds under Settings → Calendar → Accounts → Add CalDAV Account, the way it
 * adds iCloud or Google. It goes both ways: an event added in the phone's
 * Calendar app, or a reminder ticked in its Reminders app, is added or ticked
 * here.
 *
 * What there is:
 *
 *   /dav/principal/                  the one user, "the family"
 *   /dav/calendars/events/           the events, one calendar
 *   /dav/calendars/reminders-<who>/  a reminders list per person, and one
 *                                    for everyone ("reminders-everyone")
 *
 * each event or reminder a file of its own under its collection. Lists are
 * the family and are changed in the hub, not made or deleted on a phone.
 *
 * Enough of WebDAV (RFC 4918) and CalDAV (RFC 4791) for the Apple apps: the
 * PROPFINDs they find things with, calendar-multiget and calendar-query to
 * fetch them, and PUT, DELETE and MOVE to change them. Not sync-collection --
 * a phone falls back to comparing the collection's ctag and each item's ETag,
 * which for a family's calendar is plenty -- and not scheduling or sharing.
 */

const NS = {
    DAV: 'DAV:',
    CAL: 'urn:ietf:params:xml:ns:caldav',
    CS: 'http://calendarserver.org/ns/',
    ICAL: 'http://apple.com/ns/ical/',
};
const PREFIX = { [NS.DAV]: 'd', [NS.CAL]: 'c', [NS.CS]: 'cs', [NS.ICAL]: 'ic' };

const ROOT = '/dav/';
const PRINCIPAL = '/dav/principal/';
const HOME = '/dav/calendars/';
const EVENTS = `${HOME}events/`;
const LIST_PREFIX = 'reminders-';
const EVERYONE = 'everyone';

const MAX_BODY = 256 * 1024;
/* A file name a phone may give an event or reminder. Apple's are UUIDs. */
const ITEM_NAME = /^[A-Za-z0-9._~@+=-]{1,200}$/;

// ------------------------------------------------------------------- XML --

const decodeEntities = (s) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
        const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
        if (named) return named;
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });

const esc = (s) =>
    String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

/**
 * A request body as an element tree with namespaces resolved: { ns, name,
 * attrs, children, text }. Small and forgiving, for the handful of request
 * shapes a calendar client sends; null when it is not XML at all.
 */
export function parseXml(text) {
    const src = String(text)
        .replace(/<\?[\s\S]*?\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, t) => esc(t));
    const tag = /<(\/?)([A-Za-z_][\w.-]*(?::[\w.-]+)?)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    const root = { children: [], scope: { xml: 'http://www.w3.org/XML/1998/namespace' } };
    const stack = [root];
    let m;
    while ((m = tag.exec(src))) {
        const top = stack.at(-1);
        if (m[5] !== undefined) {
            if (stack.length > 1) top.text += decodeEntities(m[5]);
            continue;
        }
        if (m[1]) {
            if (stack.length > 1) stack.pop();
            continue;
        }
        const attrs = {};
        const scope = { ...top.scope };
        for (const a of m[3].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
            const value = decodeEntities(a[2] ?? a[3] ?? '');
            if (a[1] === 'xmlns') scope[''] = value;
            else if (a[1].startsWith('xmlns:')) scope[a[1].slice(6)] = value;
            else attrs[a[1]] = value;
        }
        const [pfx, local] = m[2].includes(':') ? m[2].split(':') : ['', m[2]];
        const el = { ns: scope[pfx] ?? '', name: local, attrs, children: [], text: '', scope };
        top.children.push(el);
        if (!m[4]) stack.push(el);
    }
    return root.children[0] ?? null;
}

const kids = (el, ns, name) => (el?.children ?? []).filter((c) => (!ns || c.ns === ns) && (!name || c.name === name));
const kid = (el, ns, name) => kids(el, ns, name)[0];

/** The properties a PROPFIND or REPORT asks for, or null for "all of them". */
function wanted(body) {
    const p = kid(body, NS.DAV, 'prop');
    if (!p) return null;
    return p.children.map((c) => ({ ns: c.ns, name: c.name }));
}

/** An XML element for a property, with its namespace's prefix. */
function element(ns, name, inner) {
    const pfx = PREFIX[ns];
    const open = pfx ? `${pfx}:${name}` : `x:${name} xmlns:x="${esc(ns)}"`;
    const close = pfx ? `${pfx}:${name}` : `x:${name}`;
    return inner === '' || inner === undefined ? `<${open}/>` : `<${open}>${inner}</${close}>`;
}

const href = (path) => `<d:href>${esc(path)}</d:href>`;

function multistatus(responses) {
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        `<d:multistatus xmlns:d="${NS.DAV}" xmlns:c="${NS.CAL}" xmlns:cs="${NS.CS}" xmlns:ic="${NS.ICAL}">` +
        responses.join('') +
        '</d:multistatus>'
    );
}

// ------------------------------------------------------------- resources --

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
const quoted = (s) => `"${s}"`;
const itemName = (thing) => thing.href ?? `${thing.id}.ics`;

/** Who a reminders list is for: a member, or the family as a whole. */
function lists(members) {
    return [
        { key: EVERYONE, member: null, name: 'Everyone', colour: '#8E8E93' },
        ...members.map((m) => ({ key: m.id, member: m.id, name: m.name, colour: m.colour })),
    ];
}

const listPath = (list) => `${HOME}${LIST_PREFIX}${list.key}/`;

/**
 * Everything the account holds right now, read once per request: every
 * collection with its items, each item with its text and ETag.
 */
function snapshot() {
    const members = loadMembers();
    const looks = loadSettings().calendarLooks ?? {};
    const events = loadEvents();
    const tasks = loadTasks();
    // The server's date, as near as there is to the family's here; the hub's
    // own pages usually get there first with the real one.
    if (migrateTasks(tasks, new Date().toISOString().slice(0, 10))) saveTasks(tasks);
    const item = (thing, text, parent, component) => ({
        kind: 'item',
        path: `${parent}${itemName(thing)}`,
        thing,
        text,
        etag: quoted(hash(text).slice(0, 24)),
        component,
    });
    const collections = [
        {
            kind: 'calendar',
            path: EVENTS,
            key: 'events',
            name: 'Family Hub',
            description: 'The family calendar',
            colour: looks.events?.colour ?? '#3478F6',
            component: 'VEVENT',
            order: looks.events?.order ?? 0,
            items: events.map((e) => item(e, eventFile(e, members), EVENTS, 'VEVENT')),
        },
        ...lists(members).map((list, i) => ({
            kind: 'calendar',
            path: listPath(list),
            key: `list:${list.key}`,
            list,
            name: list.name,
            description: `Reminders for ${list.member ? list.name : 'everyone'}`,
            colour: looks[`list:${list.key}`]?.colour ?? list.colour,
            component: 'VTODO',
            order: looks[`list:${list.key}`]?.order ?? i + 1,
            items: tasks
                .filter((t) => (t.member ?? null) === list.member)
                .map((t) => item(t, taskFile(t), listPath(list), 'VTODO')),
        })),
    ];
    for (const c of collections) {
        // The ctag changes whenever anything in the collection does, which is
        // what a phone checks first to know whether to look any closer.
        c.ctag = hash(`${c.name}|${c.colour}|${c.items.map((i) => `${i.path}${i.etag}`).join('|')}`).slice(0, 24);
    }
    return { members, events, tasks, collections };
}

/** What a path names, in `snap`. A collection may be asked for with or without its slash. */
function resolve(pathname, snap) {
    let p;
    try {
        p = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    if (p === '/' || p === '/dav' || p === ROOT) return { kind: 'root', path: ROOT };
    const dir = p.endsWith('/') ? p : `${p}/`;
    if (dir === PRINCIPAL) return { kind: 'principal', path: PRINCIPAL };
    if (dir === HOME) return { kind: 'home', path: HOME };
    const coll = snap.collections.find((c) => c.path === dir);
    if (coll) return coll;
    const slash = p.lastIndexOf('/');
    const parent = snap.collections.find((c) => c.path === p.slice(0, slash + 1));
    if (!parent) return null;
    const name = p.slice(slash + 1);
    const found = parent.items.find((i) => i.path === p);
    return found ? { ...found, parent } : { kind: 'missing', path: p, parent, name };
}

const READ = ['read', 'read-current-user-privilege-set'];
const WRITE = [...READ, 'write', 'write-content', 'write-properties', 'bind', 'unbind'];
const privileges = (list) => list.map((p) => `<d:privilege><d:${p}/></d:privilege>`).join('');

/** A property of a resource as XML, or undefined when it has none. */
function propValue(res, ns, name, opts = {}) {
    const isColl = res.kind === 'calendar';
    if (ns === NS.DAV) {
        switch (name) {
            case 'resourcetype':
                if (res.kind === 'principal') return '<d:principal/><d:collection/>';
                if (isColl) return '<d:collection/><c:calendar/>';
                if (res.kind === 'item') return '';
                return '<d:collection/>';
            case 'displayname':
                return {
                    root: 'Family Hub',
                    principal: 'Family',
                    home: 'Family Hub',
                    calendar: esc(res.name ?? ''),
                }[res.kind];
            case 'current-user-principal':
            case 'principal-URL':
                return href(PRINCIPAL);
            case 'owner':
                return isColl ? href(PRINCIPAL) : undefined;
            case 'principal-collection-set':
                return href(ROOT);
            case 'current-user-privilege-set':
                return privileges(isColl || res.kind === 'item' ? WRITE : READ);
            case 'supported-report-set':
                if (!isColl && res.kind !== 'home') return undefined;
                return ['calendar-multiget', 'calendar-query']
                    .map((r) => `<d:supported-report><d:report><c:${r}/></d:report></d:supported-report>`)
                    .join('');
            case 'getetag':
                if (res.kind === 'item') return esc(res.etag);
                return isColl ? esc(quoted(res.ctag)) : undefined;
            case 'getcontenttype':
                return res.kind === 'item' ? `text/calendar; charset=utf-8; component=${res.component.toLowerCase()}` : undefined;
            case 'getlastmodified':
                if (res.kind !== 'item') return undefined;
                return new Date(res.thing.updatedAt ?? res.thing.createdAt ?? 0).toUTCString();
            default:
                return undefined;
        }
    }
    if (ns === NS.CAL) {
        switch (name) {
            case 'calendar-home-set':
                return res.kind === 'principal' || res.kind === 'root' ? href(HOME) : undefined;
            case 'supported-calendar-component-set':
                return isColl ? `<c:comp name="${res.component}"/>` : undefined;
            case 'supported-calendar-data':
                return isColl ? '<c:calendar-data content-type="text/calendar" version="2.0"/>' : undefined;
            case 'calendar-description':
                return isColl ? esc(res.description) : undefined;
            case 'max-resource-size':
                return isColl ? String(MAX_BODY) : undefined;
            case 'calendar-data':
                return res.kind === 'item' && opts.data ? esc(res.text) : undefined;
            default:
                return undefined;
        }
    }
    if (ns === NS.CS && name === 'getctag') return isColl ? esc(res.ctag) : undefined;
    // With its opacity on the end, the way Apple writes them: #RRGGBBAA.
    if (ns === NS.ICAL && name === 'calendar-color') return isColl ? (res.colour.length === 9 ? res.colour : `${res.colour}FF`) : undefined;
    if (ns === NS.ICAL && name === 'calendar-order') return isColl ? String(res.order) : undefined;
    return undefined;
}

const ALLPROP = ['resourcetype', 'displayname', 'getetag', 'getcontenttype', 'getlastmodified'].map((name) => ({
    ns: NS.DAV,
    name,
}));

/** One resource's <response>: what it has of `props` under 200, the rest under 404. */
function response(res, props, opts) {
    const found = [];
    const missing = [];
    for (const { ns, name } of props ?? ALLPROP) {
        const v = propValue(res, ns, name, opts);
        if (v === undefined) missing.push(element(ns, name));
        else found.push(element(ns, name, v));
    }
    const stat = (list, status) =>
        list.length ? `<d:propstat><d:prop>${list.join('')}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>` : '';
    return `<d:response>${href(res.path)}${stat(found, '200 OK')}${props ? stat(missing, '404 Not Found') : ''}</d:response>`;
}

function children(res, snap) {
    if (res.kind === 'root') return [{ kind: 'principal', path: PRINCIPAL }, { kind: 'home', path: HOME }];
    if (res.kind === 'home') return snap.collections;
    if (res.kind === 'calendar') return res.items;
    return [];
}

// ------------------------------------------------- from the phone: events --

/** A refusal the phone is told about, as a CalDAV precondition. */
class Refusal extends Error {
    constructor(message, condition = 'c:valid-calendar-data') {
        super(message);
        this.condition = condition;
    }
}

/*
 * Whose an event is, from the end of its name: "Swim (Emma)" is Emma's swim,
 * "Dinner out (Mom, Dad)" theirs. The hub writes events that way for the
 * phone, so it reads them back the same -- and it is how somebody adding an
 * event on a phone says whose it is. Brackets that are not all family names
 * are just part of the name.
 */
export function splitWho(summary, members) {
    const m = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(summary);
    if (m) {
        const ids = m[2].split(',').map((n) => members.find((x) => x.name.toLowerCase() === n.trim().toLowerCase())?.id);
        if (ids.every(Boolean)) return { title: m[1], members: [...new Set(ids)] };
    }
    return { title: summary, members: [] };
}

/** The alert nearest to `minutes` of the ones the hub offers. */
const nearest = (minutes, choices) =>
    choices.reduce((best, c) => (Math.abs(c - minutes) < Math.abs(best - minutes) ? c : best), choices[0]);

/** Minutes before the start of the first alarm a person would see, or null. */
function alarmOf(comp) {
    for (const alarm of comp.children.filter((c) => c.name === 'VALARM')) {
        const action = prop(alarm, 'ACTION')?.value.trim().toUpperCase();
        const trigger = prop(alarm, 'TRIGGER');
        // Apple writes a "none" alarm at a date in 1976 to say "no default
        // alert"; an alarm at a fixed time, or from the end, is not one the hub
        // can keep either.
        if (!trigger || action === 'NONE' || trigger.params.VALUE === 'DATE-TIME' || trigger.params.RELATED === 'END') {
            continue;
        }
        const offset = parseDuration(trigger.value);
        if (offset !== null) return -offset;
    }
    return null;
}

const ruleRefusal = (what) =>
    new Refusal(`Family Hub can repeat ${what} every so many days, weeks, months or years, but not like that.`);

/** The dates in EXDATE properties, in the family's time. */
const exdates = (comp, zone) =>
    props(comp, 'EXDATE')
        .flatMap((p) => p.value.split(','))
        .map((v) => parseWhen(v, zone)?.date)
        .filter(Boolean);

/** A VEVENT as what the hub's own editor would send for it. */
function eventInput(ve, zone, members, { series = true } = {}) {
    const who = splitWho(unescapeText(prop(ve, 'SUMMARY')?.value ?? ''), members);
    const start = parseWhen(prop(ve, 'DTSTART')?.value, zone);
    if (!start) throw new Refusal('An event needs a start.');
    const allDay = start.time === null;

    let end = parseWhen(prop(ve, 'DTEND')?.value, zone);
    const duration = parseDuration(prop(ve, 'DURATION')?.value);
    if (!end && duration !== null) {
        end = allDay ? { date: addDays(start.date, Math.round(duration / 1440)), time: null } : atMinutes(start.date, toMin(start.time) + duration);
    }

    const input = {
        title: who.title,
        members: who.members,
        date: start.date,
        allDay,
        start: allDay ? '' : start.time,
        end: '',
        endDate: '',
        location: unescapeText(prop(ve, 'LOCATION')?.value ?? ''),
        notes: unescapeText(prop(ve, 'DESCRIPTION')?.value ?? ''),
        repeat: 'none',
        every: 1,
        until: '',
        alert: null,
    };
    if (allDay && end) {
        // The end of an all-day event is the morning after its last day.
        const last = addDays(end.date, -1);
        if (last > start.date) input.endDate = last;
    } else if (end && end.date === start.date && end.time > start.time) {
        input.end = end.time;
    }
    // An event running past midnight keeps its start; the hub's timed events
    // are within a day, and shows it as starting then.

    const alarm = alarmOf(ve);
    if (alarm !== null) input.alert = nearest(alarm, allDay ? ALL_DAY_ALERTS : TIMED_ALERTS);

    const rrule = prop(ve, 'RRULE');
    if (series && rrule) Object.assign(input, eventRule(parseRule(rrule.value), start.date, zone));
    if (series && (prop(ve, 'RDATE') || prop(ve, 'EXRULE'))) throw ruleRefusal('an event');
    return input;
}

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function eventRule(rule, date, zone) {
    const freq = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[rule.freq];
    if (!freq || unknownRuleParts(rule).length || !Number.isInteger(rule.interval) || rule.interval < 1) {
        throw ruleRefusal('an event');
    }
    const [, m, d] = date.split('-').map(Number);
    const p = rule.parts;
    const byday = rule.byday;
    // The hub's event repeats on the same day each time; a rule that names
    // other days, or "the first Monday", is one it cannot keep.
    const sameWeekday = byday.length === 1 && byday[0] === WEEKDAYS[weekday(date)];
    if (byday.length && !(freq === 'weekly' && sameWeekday)) throw ruleRefusal('an event');
    if (p.BYMONTHDAY && (freq === 'daily' || freq === 'weekly' || Number(p.BYMONTHDAY) !== d)) throw ruleRefusal('an event');
    if (p.BYMONTH && (freq !== 'yearly' || Number(p.BYMONTH) !== m)) throw ruleRefusal('an event');

    let until = rule.until ? (parseWhen(rule.until, zone)?.date ?? '') : '';
    if (rule.count) {
        // "Ten times" becomes the day of the tenth.
        const probe = { date, repeat: freq, every: rule.interval, skip: [] };
        let seen = 0;
        for (let n = dayNumber(date), end = n + 366 * 100; n <= end; n++) {
            if (startsOn(probe, n) && ++seen === rule.count) {
                until = new Date(n * 86_400_000).toISOString().slice(0, 10);
                break;
            }
        }
    }
    return { repeat: freq, every: rule.interval, until };
}

/** What a PUT to the events calendar becomes: the event, and any one-off days split off it. */
export function eventFromPhone(text, { members, existing }) {
    const comps = parseCalendar(text);
    const cal = comps.find((c) => c.name === 'VCALENDAR') ?? { children: comps };
    if (cal.children.some((c) => c.name === 'VTODO')) throw new Refusal('This calendar only takes events.', 'c:supported-calendar-component');
    const vevents = cal.children.filter((c) => c.name === 'VEVENT');
    const master = vevents.find((v) => !prop(v, 'RECURRENCE-ID'));
    if (!master) throw new Refusal('There is no event in that.');
    const zone = zoneOf(comps);

    const input = eventInput(master, zone, members);
    const skip = new Set(exdates(master, zone));

    // One day of a repeating event changed on the phone ("this event only")
    // comes as a second event for that day. The hub has no such thing, so the
    // day is taken out of the series and becomes an event of its own -- which
    // is what the phone sees the next time it looks.
    const singles = [];
    for (const ov of vevents.filter((v) => prop(v, 'RECURRENCE-ID'))) {
        const day = parseWhen(prop(ov, 'RECURRENCE-ID').value, zone)?.date;
        if (!day) continue;
        const already = existing?.skip?.includes(day);
        skip.add(day);
        const cancelled = prop(ov, 'STATUS')?.value.trim().toUpperCase() === 'CANCELLED';
        if (!already && !cancelled) singles.push({ input: eventInput(ov, zone, members, { series: false }), extra: extraLines(ov) });
    }
    return {
        uid: prop(master, 'UID')?.value.trim() || null,
        input,
        skip: [...skip].sort(),
        extra: extraLines(master),
        singles,
    };
}

// ---------------------------------------------- from the phone: reminders --

function taskRule(rule, date, zone) {
    let freq = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[rule.freq];
    if (!freq || unknownRuleParts(rule).length || !Number.isInteger(rule.interval) || rule.interval < 1) {
        throw ruleRefusal('a reminder');
    }
    const [, m, d] = date.split('-').map(Number);
    const p = rule.parts;
    // Weekdays, weekends, Mondays and Thursdays: a weekly rule on those days.
    // "The second Tuesday" has a number in front, and is not one.
    if (rule.byday.some((c) => !WEEKDAYS.includes(c))) throw ruleRefusal('a reminder');
    let days = rule.byday.map((c) => WEEKDAYS.indexOf(c));
    if (freq === 'daily' && days.length) freq = 'weekly';
    if ((freq === 'monthly' || freq === 'yearly') && days.length) throw ruleRefusal('a reminder');
    if (freq === 'weekly' && !days.length) days = [weekday(date)];
    const onDate = freq === 'monthly' || freq === 'yearly';
    if (p.BYMONTHDAY && (!onDate || Number(p.BYMONTHDAY) !== d)) throw ruleRefusal('a reminder');
    if (p.BYMONTH && (freq !== 'yearly' || Number(p.BYMONTH) !== m)) throw ruleRefusal('a reminder');

    const out = { repeat: freq, every: rule.interval, days, until: '' };
    if (rule.until) out.until = parseWhen(rule.until, zone)?.date ?? '';
    if (rule.count) {
        let due = date;
        for (let i = 1; i < rule.count && due; i++) due = nextDue({ ...out, until: null }, due);
        out.until = due ?? '';
    }
    return out;
}

/** A VTODO as what the hub's editor would send, plus whether it is ticked and when. */
export function taskFromPhone(text) {
    const comps = parseCalendar(text);
    const cal = comps.find((c) => c.name === 'VCALENDAR') ?? { children: comps };
    if (cal.children.some((c) => c.name === 'VEVENT')) throw new Refusal('A reminders list only takes reminders.', 'c:supported-calendar-component');
    const todo = cal.children.find((c) => c.name === 'VTODO' && !prop(c, 'RECURRENCE-ID'));
    if (!todo) throw new Refusal('There is no reminder in that.');
    const zone = zoneOf(comps);

    const due = parseWhen((prop(todo, 'DUE') ?? prop(todo, 'DTSTART'))?.value, zone);
    const input = {
        title: unescapeText(prop(todo, 'SUMMARY')?.value ?? ''),
        notes: unescapeText(prop(todo, 'DESCRIPTION')?.value ?? ''),
        date: due?.date ?? '',
        time: due?.time ?? '',
        repeat: 'none',
        every: 1,
        days: [],
        until: '',
    };
    const rrule = prop(todo, 'RRULE');
    if (rrule) {
        if (!due) throw new Refusal('A repeating reminder needs a date.');
        Object.assign(input, taskRule(parseRule(rrule.value), due.date, zone));
    }
    const completedProp = prop(todo, 'COMPLETED');
    const completed = prop(todo, 'STATUS')?.value.trim().toUpperCase() === 'COMPLETED' || Boolean(completedProp);
    return {
        uid: prop(todo, 'UID')?.value.trim() || null,
        input,
        completed,
        completedOn: completedProp ? (parseWhen(completedProp.value, zone)?.date ?? null) : null,
        extra: extraLines(todo),
    };
}

/**
 * Ticks the reminder that is due. Late, it is ticked on the day the phone
 * says it was done, the way the hub ticks a late one on today's list; on time
 * or early, on its own day.
 */
function tickDue(task, on) {
    if (on && on > task.date) return markDone(task, on, true, on);
    return markDone(task, task.date, true, task.date);
}

// ----------------------------------------------------------------- the API --

async function readText(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

const DAV_HEADERS = {
    DAV: '1, 3, calendar-access',
    Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MOVE, PROPFIND, PROPPATCH, REPORT',
};

function send(res, status, body = '', headers = {}) {
    res.writeHead(status, {
        'Cache-Control': 'no-store',
        ...DAV_HEADERS,
        ...(body ? { 'Content-Type': headers['Content-Type'] ?? 'application/xml; charset=utf-8' } : {}),
        ...headers,
    });
    res.end(body);
}

/* `condition` is the precondition's name with its prefix: "c:" for CalDAV's, "d:" for WebDAV's. */
const errorBody = (condition, message) =>
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<d:error xmlns:d="${NS.DAV}" xmlns:c="${NS.CAL}"><${condition}/>` +
    `<d:responsedescription>${esc(message)}</d:responsedescription></d:error>`;

/** The ETag preconditions on a write: If-Match and If-None-Match. False when they fail. */
function preconditions(req, current) {
    const ifMatch = req.headers['if-match'];
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.trim() === '*' && current) return false;
    if (ifMatch && ifMatch.trim() !== '*' && (!current || !ifMatch.split(',').map((s) => s.trim()).includes(current.etag))) return false;
    if (ifMatch && ifMatch.trim() === '*' && !current) return false;
    return true;
}

function propfind(req, res, url, snap, body) {
    const target = resolve(url.pathname, snap);
    if (!target || target.kind === 'missing') return send(res, 404);
    const depth = String(req.headers.depth ?? 'infinity').trim();
    const ask = wanted(body);
    // Asked of '/', the answer is about the account's root, at '/'.
    const self = url.pathname === '/' ? { ...target, path: '/' } : target;
    const out = [response(self, ask)];
    if (depth !== '0') for (const child of children(target, snap)) out.push(response(child, ask));
    send(res, 207, multistatus(out));
}

function report(req, res, url, snap, body) {
    const target = resolve(url.pathname, snap);
    if (!target || target.kind === 'missing') return send(res, 404);
    const ask = wanted(body) ?? [{ ns: NS.DAV, name: 'getetag' }];
    const opts = { data: true };
    if (body?.ns === NS.CAL && body.name === 'calendar-multiget') {
        const out = kids(body, NS.DAV, 'href').map((h) => {
            const path = h.text.trim().replace(/^https?:\/\/[^/]+/i, '');
            const item = resolve(path, snap);
            if (!item || item.kind !== 'item') return `<d:response>${href(path)}<d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
            return response({ ...item, path }, ask, opts);
        });
        return send(res, 207, multistatus(out));
    }
    if (body?.ns === NS.CAL && body.name === 'calendar-query') {
        // Every item, whatever the filter: a phone asking for the next month
        // and getting the year is slower, never wrong.
        const items = target.kind === 'calendar' ? target.items : target.kind === 'item' ? [target] : [];
        return send(res, 207, multistatus(items.map((i) => response(i, ask, opts))));
    }
    send(res, 403, errorBody('d:supported-report', 'That report is not supported here.'));
}

/*
 * A phone setting a calendar's colour, or where it sits in the list.
 *
 * Both are kept, for the account as a whole: a colour that was taken and then
 * forgotten came straight back on the next sync, and the phone showed it as
 * "Custom" -- not one of its own -- however often somebody picked another.
 * Kept apart from the family's colours, which stay as the hub has them;
 * removing the phone's choice goes back to those. Anything else a phone sets
 * is answered as done and not kept, as there is nowhere for it to go.
 */
function proppatch(res, url, snap, body) {
    const target = resolve(url.pathname, snap);
    if (!target || target.kind === 'missing') return send(res, 404);
    const changes = [
        ...kids(body, NS.DAV, 'set').map((s) => ['set', s]),
        ...kids(body, NS.DAV, 'remove').map((s) => ['remove', s]),
    ].flatMap(([how, s]) => kids(s, NS.DAV, 'prop').flatMap((p) => p.children.map((c) => ({ how, prop: c }))));

    if (target.kind === 'calendar') {
        const looks = { ...(loadSettings().calendarLooks ?? {}) };
        const mine = { ...(looks[target.key] ?? {}) };
        for (const { how, prop: c } of changes) {
            if (c.ns !== NS.ICAL) continue;
            const value = c.text.trim();
            if (c.name === 'calendar-color') {
                if (how === 'remove') delete mine.colour;
                else if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) mine.colour = value.toUpperCase();
            } else if (c.name === 'calendar-order') {
                if (how === 'remove') delete mine.order;
                else if (/^\d{1,6}$/.test(value)) mine.order = Number(value);
            }
        }
        if (Object.keys(mine).length) looks[target.key] = mine;
        else delete looks[target.key];
        saveSettings({ calendarLooks: looks });
    }

    const names = changes.map(({ prop: c }) => element(c.ns, c.name));
    send(
        res,
        207,
        multistatus([
            `<d:response>${href(target.path)}<d:propstat><d:prop>${names.join('')}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
        ]),
    );
}

function getItem(req, res, url, snap) {
    const target = resolve(url.pathname, snap);
    if (target?.kind === 'root' && url.pathname !== '/') {
        return send(res, 200, 'Family Hub calendar account. Add it on an iPhone as a CalDAV account.\n', {
            'Content-Type': 'text/plain; charset=utf-8',
        });
    }
    if (!target || target.kind !== 'item') return send(res, 404);
    send(res, 200, req.method === 'HEAD' ? '' : target.text, {
        'Content-Type': 'text/calendar; charset=utf-8',
        ETag: target.etag,
    });
}

function remove(req, res, url, snap) {
    const target = resolve(url.pathname, snap);
    if (!target || target.kind === 'missing') return send(res, 404);
    if (target.kind !== 'item') return send(res, 403, errorBody('d:need-privileges', 'Calendars and lists are the family, and are changed in Family Hub.'));
    if (!preconditions(req, target)) return send(res, 412);
    if (target.component === 'VEVENT') {
        saveEvents(snap.events.filter((e) => e !== target.thing));
    } else {
        saveTasks(snap.tasks.filter((t) => t !== target.thing));
    }
    send(res, 204);
}

function putEvent(target, snap, text, current) {
    const { uid, input, skip, extra, singles } = eventFromPhone(text, { members: snap.members, existing: current?.thing });
    const memberIds = snap.members.map((m) => m.id);
    const events = snap.events;
    if (!current && uid && events.some((e) => eventUid(e) === uid)) {
        throw new Refusal('That event is already on the calendar under another name.', 'c:no-uid-conflict');
    }
    const { event, errors } = normaliseEvent(input, memberIds, current?.thing ?? null, events.length);
    if (errors.length) throw new Refusal(errors[0]);
    event.skip = event.repeat === 'none' ? [] : skip;
    if (extra.length) event.extra = extra;
    else delete event.extra;
    if (!current) {
        event.uid = uid ?? eventUid(event);
        event.href = target.name;
    }
    const added = [];
    for (const single of singles) {
        const made = normaliseEvent(single.input, memberIds, null, events.length + added.length + 1);
        if (made.errors.length) continue;
        if (single.extra.length) made.event.extra = single.extra;
        added.push(made.event);
    }
    const list = current ? events.map((e) => (e === current.thing ? event : e)) : [...events, event];
    saveEvents([...list, ...added]);
}

const sameReminder = (a, b) => a.title.trim().toLowerCase() === b.title.trim().toLowerCase();

function putTask(target, snap, text, current) {
    const { uid, input, completed, completedOn, extra } = taskFromPhone(text);
    const member = target.parent.list.member;
    const tasks = snap.tasks;
    let existing = current?.thing ?? null;
    // Moved to another list on the phone: gone from the old list, and here
    // under the same UID. Kept as the one reminder, with its ticks.
    if (!existing && uid) existing = tasks.find((t) => taskUid(t) === uid) ?? null;

    if (!existing) {
        const twin = tasks.find((t) => t.repeat !== 'none' && !t.over && (t.member ?? null) === member && sameReminder(t, input));
        // Ticking a repeating reminder, a phone may save the tick as a new,
        // finished reminder beside it, or save a new repeating one for the
        // next time. Either way the hub's one reminder is what both are: the
        // tick is taken, the copy is not kept, and the phone sees the one
        // reminder on its next look.
        if (twin && completed && input.repeat === 'none') {
            if (input.date === twin.date || !input.date) tickDue(twin, completedOn);
            else {
                twin.done = [...twin.done, completedOn ?? input.date].sort();
                twin.updatedAt = new Date().toISOString();
            }
            saveTasks(tasks);
            return 'merged';
        }
        if (twin && !completed && input.repeat !== 'none' && input.date && input.date <= twin.date) {
            return 'merged';
        }
    }

    const memberIds = snap.members.map((m) => m.id);
    // A repeating one sent back finished is the phone ticking it -- with or
    // without its repeat rule still on it, depending on how it saves the tick.
    if (existing && existing.repeat !== 'none' && completed) {
        if (input.repeat === 'none') Object.assign(input, { repeat: existing.repeat, every: existing.every, days: existing.days, until: existing.until ?? '' });
    }
    const { task, errors } = normaliseTask({ ...input, member }, memberIds, existing, tasks.length);
    if (errors.length) throw new Refusal(errors[0]);
    if (extra.length) task.extra = extra;
    else delete task.extra;

    if (task.repeat === 'none') {
        const day = completedOn ?? existing?.done?.[0] ?? task.date ?? new Date().toISOString().slice(0, 10);
        task.done = completed ? [day] : [];
        task.completedAt = completed ? (existing?.done?.length ? existing.completedAt : new Date().toISOString()) : null;
    } else if (completed && !task.over) {
        tickDue(task, completedOn);
    } else if (!completed && existing?.repeat !== 'none' && existing?.over) {
        task.over = false;
    }

    if (!current) {
        task.uid = existing?.uid ?? uid ?? taskUid(task);
        task.href = target.name;
    }
    const list = existing ? tasks.map((t) => (t === existing ? task : t)) : [...tasks, task];
    saveTasks(list);
    return existing ? 'updated' : 'created';
}

async function put(req, res, url, snap) {
    const target = resolve(url.pathname, snap);
    if (!target || (target.kind !== 'item' && target.kind !== 'missing')) {
        return send(res, 403, errorBody('d:need-privileges', 'Only events and reminders can be saved here.'));
    }
    if (target.kind === 'missing' && !ITEM_NAME.test(target.name)) {
        return send(res, 403, errorBody('c:valid-calendar-object-resource', 'Not a name for an event.'));
    }
    const current = target.kind === 'item' ? target : null;
    if (!preconditions(req, current)) return send(res, 412);
    const text = await readText(req);
    if (target.parent.component === 'VEVENT') putEvent(target, snap, text, current);
    else putTask(target, snap, text, current);
    // No ETag back: what is stored is the hub's version of what was sent,
    // not the same bytes, and saying otherwise would leave the phone showing
    // its own copy. Without one it fetches the event again.
    send(res, current ? 204 : 201);
}

function move(req, res, url, snap) {
    const target = resolve(url.pathname, snap);
    if (!target || target.kind !== 'item') return send(res, 404);
    let dest;
    try {
        dest = resolve(new URL(req.headers.destination ?? '', 'http://x').pathname, snap);
    } catch {
        dest = null;
    }
    if (!dest || target.component !== 'VTODO' || dest.parent?.component !== 'VTODO') {
        return send(res, 403, errorBody('d:need-privileges', 'That cannot be moved there.'));
    }
    if (dest.kind === 'item' && dest.thing !== target.thing) return send(res, 412);
    if (dest.kind === 'missing' && !ITEM_NAME.test(dest.name)) return send(res, 403);
    // Into someone else's list is giving it to them.
    target.thing.member = dest.parent.list.member;
    target.thing.href = dest.kind === 'missing' ? dest.name : target.thing.href;
    target.thing.uid ??= taskUid(target.thing);
    target.thing.updatedAt = new Date().toISOString();
    saveTasks(snap.tasks);
    send(res, 201);
}

/**
 * Answers one request under /dav, or a phone's probe of '/'. `authorised` is
 * the server's check of the family password; see server.js.
 */
export async function handleDav(req, res, url, { authorised, log }) {
    if (url.pathname.startsWith('/.well-known/caldav')) return send(res, 301, '', { Location: ROOT });
    if (req.method === 'OPTIONS') return send(res, 200);

    const auth = await authorised();
    if (auth !== true) {
        if (auth === 'throttled') return send(res, 429, '', { 'Retry-After': '900' });
        return send(res, 401, '', { 'WWW-Authenticate': 'Basic realm="Family Hub", charset="UTF-8"' });
    }

    const snapNow = snapshot();
    try {
        switch (req.method) {
            case 'PROPFIND':
                return propfind(req, res, url, snapNow, parseXml(await readText(req)));
            case 'REPORT':
                return report(req, res, url, snapNow, parseXml(await readText(req)));
            case 'PROPPATCH':
                return proppatch(res, url, snapNow, parseXml(await readText(req)));
            case 'GET':
            case 'HEAD':
                return getItem(req, res, url, snapNow);
            case 'PUT':
                return await put(req, res, url, snapNow);
            case 'DELETE':
                return remove(req, res, url, snapNow);
            case 'MOVE':
                return move(req, res, url, snapNow);
            case 'MKCALENDAR':
            case 'MKCOL':
                return send(res, 403, errorBody('d:need-privileges', 'Lists are the family: add someone in Family Hub to give them a list.'));
            default:
                return send(res, 405);
        }
    } catch (err) {
        if (err instanceof Refusal) {
            log('calendar account refused', req.method, url.pathname, err.message);
            return send(res, 403, errorBody(err.condition, err.message));
        }
        if (err.status === 413) return send(res, 413);
        throw err;
    }
}
