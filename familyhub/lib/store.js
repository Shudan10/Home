import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/*
 * JSON files in a Docker volume, not a database.
 *
 * A family's meal library is a few hundred records and a year of planning is
 * 365 small objects, so the whole dataset is read and written in one go without
 * anything noticing. SQLite would mean a native module, and the rule across
 * this stack is zero npm dependencies -- which is also what makes the data
 * recoverable with `cat` when something goes wrong.
 */

const DATA_DIR = process.env.MEALPLAN_DATA || '/data';
const MEALS_FILE = path.join(DATA_DIR, 'meals.json');
const PLAN_FILE = path.join(DATA_DIR, 'plan.json');

/*
 * The meals of the day this plans.
 *
 * One, now. It held breakfast, lunch and dinner, and in practice only dinner
 * was ever used -- so every day card carried two empty rows, every meal needed
 * saying which of the three it was, and the month had three names per cell
 * where it could have one.
 *
 * Kept as a list rather than dissolved into the code, because the whole app
 * reads it: putting lunch back is this line plus a label, not an archaeology
 * expedition. `dinner` stays the stored key for the same reason -- plans
 * already on disk keep working.
 */
export const SLOTS = ['dinner'];
export const SLOT_LABELS = { dinner: 'Dinner' };

export function ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** A file in the data volume. The family, events, tasks and settings each get one. */
export const dataPath = (name) => path.join(DATA_DIR, name);

/*
 * A missing file is an empty library; anything else is an error.
 *
 * It used to fall back to empty on every failure, and that is how data goes:
 * a file that will not parse -- a bad hand edit, a disk hiccup -- read back as
 * no meals, the next save wrote no meals over it, and the family's library was
 * gone without anything having said so. Now only "not there yet" means empty.
 * Every other failure is logged with the file it came from and thrown, so the
 * request fails with a 500 and the file stays exactly as it was, recoverable.
 */
export function readJson(file, fallback) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return structuredClone(fallback);
        console.error(new Date().toISOString(), `could not read ${file}:`, err.message);
        throw err;
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        console.error(new Date().toISOString(), `${file} is not valid JSON, leaving it untouched:`, err.message);
        throw new Error(`${path.basename(file)} is not valid JSON.`);
    }
}

/*
 * Written to a neighbouring temp file and renamed over the target.
 *
 * A plain writeFileSync truncates first, so a crash or a full disk midway
 * leaves a half-written file that parses as nothing and reads back as an empty
 * library. The temp file shares a directory with the target deliberately:
 * rename is only atomic within a filesystem, and /tmp is a different one.
 *
 * The fsyncs are what make the rename mean anything after a power cut. Without
 * the first, the rename can reach the disk before the data it points at, and
 * the file comes back empty anyway; without the second, the rename itself can
 * be lost and the old file comes back. The directory one is best effort, since
 * not every filesystem will open a directory to sync it.
 */
export function writeJson(file, value) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        const fd = fs.openSync(tmp, 'w');
        try {
            fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
    } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
    }
    try {
        const dirFd = fs.openSync(dir, 'r');
        try {
            fs.fsyncSync(dirFd);
        } finally {
            fs.closeSync(dirFd);
        }
    } catch {
        // The data is written and renamed; this only makes the rename durable.
    }
}

/*
 * Both readers fold away the slots that no longer exist.
 *
 * Done on the way in rather than by rewriting the files, so nothing is
 * destroyed on a read and a file written by the older version still opens. The
 * files tidy themselves the next time something saves.
 *
 * Without this a meal saved as breakfast would keep `slots: ['breakfast']`,
 * match no slot the app now offers, and quietly never be picked again -- a
 * meal that is in the library, visible, and unusable.
 */
export const loadMeals = () =>
    readJson(MEALS_FILE, []).map((meal) => ({ ...meal, slots: [...SLOTS] }));
export const saveMeals = (list) => writeJson(MEALS_FILE, list);

/** The plan is keyed by ISO date: { "2026-10-26": { dinner: "<meal id>" } }. */
export function loadPlan() {
    const raw = readJson(PLAN_FILE, {});
    const out = {};
    for (const [date, day] of Object.entries(raw)) {
        const kept = {};
        for (const slot of SLOTS) if (day?.[slot]) kept[slot] = day[slot];
        if (Object.keys(kept).length) out[date] = kept;
    }
    return out;
}
export const savePlan = (plan) => writeJson(PLAN_FILE, plan);

const newId = () => `m_${crypto.randomBytes(8).toString('hex')}`;

// ------------------------------------------------------------------ meals --

const str = (v) => String(v ?? '').trim();

/** Splits a textarea into trimmed lines, dropping blank ones. */
const lines = (v) => {
    if (Array.isArray(v)) return v.map(str).filter(Boolean);
    return str(v)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
};

/**
 * Cleans one meal coming off the wire and says what is wrong with it.
 *
 * Everything except the name is optional on purpose. The library only gets
 * filled in if adding "Tacos" takes one field and three seconds; a form that
 * insists on ingredients and a method before it will save anything is a form
 * that stays empty, and a meal with just a name still plans a week perfectly
 * well. Recipes can be filled in later, from the sofa.
 */
export function normaliseMeal(input, existing = null) {
    const errors = [];

    const name = str(input.name);
    if (!name) errors.push('A meal needs a name.');
    if (name.length > 120) errors.push('That name is too long.');

    // There is one meal of the day, so every meal is for it. Kept as a list
    // because the rest of the code still asks which slots a meal suits.
    const slots = [...SLOTS];

    const servesRaw = input.serves;
    let serves = null;
    if (servesRaw !== '' && servesRaw != null) {
        const n = Number(servesRaw);
        if (!Number.isFinite(n) || n < 1 || n > 99) errors.push('Serves has to be a number between 1 and 99.');
        else serves = Math.round(n);
    }

    const meal = {
        id: existing?.id ?? newId(),
        name,
        slots,
        tags: (Array.isArray(input.tags) ? input.tags : str(input.tags).split(','))
            .map((t) => str(t).toLowerCase())
            .filter(Boolean)
            .slice(0, 12),
        serves,
        ingredients: lines(input.ingredients).slice(0, 100),
        method: lines(input.method).slice(0, 60),
        notes: str(input.notes).slice(0, 2000),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    return { meal, errors };
}

// ------------------------------------------------------------------- plan --

/** ISO date for a Date, in local terms rather than UTC. */
export function isoDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/*
 * A real calendar date, not just the shape of one. The pattern alone let
 * 2026-02-31 through, which Date quietly rolls over into March -- so a plan
 * entry would be stored under a key no calendar ever asks for. Built in UTC and
 * read back, so a day that does not exist comes back as a different one.
 */
export const isIsoDate = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
    if (!m) return false;
    const [y, mo, d] = m.slice(1).map(Number);
    const date = new Date(0);
    date.setUTCFullYear(y, mo - 1, d); // not Date.UTC, which reads 0099 as 1999
    return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
};

/** Every date from `from` to `to` inclusive. Caps the span so one bad request
 *  cannot ask for a decade and get a response to match. */
export function dateRange(from, to, maxDays = 120) {
    const out = [];
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return out;
    for (const d = start; d <= end && out.length < maxDays; d.setDate(d.getDate() + 1)) {
        out.push(isoDate(d));
    }
    return out;
}

/** Sets or clears one slot on one day, pruning days that end up empty. */
export function setPlanSlot(plan, date, slot, mealId) {
    const day = { ...(plan[date] ?? {}) };
    if (mealId) day[slot] = mealId;
    else delete day[slot];

    // An empty day is dropped rather than stored as {}, so the file stays a
    // record of what was planned instead of every date ever looked at.
    if (Object.keys(day).length) plan[date] = day;
    else delete plan[date];
    return plan;
}

/**
 * Meals that should not come round more than so often in one week.
 *
 * Matched on the name rather than on a meal id, because "anything to do with
 * tacos" is a family -- Tacos, Taco salad, Taco soup -- and not one record.
 * Adding another rule is a line here; the matching is a plain lowercase
 * substring, so `taco` also catches `Tacos` and `Taco night`.
 */
export const WEEKLY_LIMITS = [{ match: 'taco', label: 'tacos', maxPerWeek: 1 }];

/** The rule a meal falls under, or null if nothing limits it. */
export function limitFor(meal) {
    const name = String(meal?.name ?? '').toLowerCase();
    return WEEKLY_LIMITS.find((rule) => name.includes(rule.match)) ?? null;
}

/** Saturday and Sunday, for the weekends toggle. */
export const isWeekend = (iso) => {
    const day = new Date(`${iso}T00:00:00`).getDay();
    return day === 0 || day === 6;
};

/**
 * Fills the given days and slots with random meals.
 *
 * Two rules worth stating, because both are what makes the result usable rather
 * than merely random:
 *
 * `avoidRepeats` draws without replacement from a shuffled pool, so a week does
 * not come back as the same thing four times -- which is what a naive pick per
 * slot produces surprisingly often with a small library. The pool refills when
 * it runs dry, so a library smaller than the week still works; it just repeats
 * once it has been round.
 *
 * `overwrite` off means it only fills blanks, so somebody who has already
 * decided on Friday keeps Friday.
 */
export function randomFill(
    plan,
    meals,
    { dates, slots, overwrite = false, avoidRepeats = true, includeWeekends = true },
) {
    const filled = [];

    // Asked for on the sheet. Weekends are when a household eats differently --
    // eating out, leftovers, somebody else cooking -- so filling them in with
    // the weekday rotation is often just work to undo.
    const days = includeWeekends ? dates : dates.filter((d) => !isWeekend(d));
    if (!days.length) return filled;

    /*
     * How many of each limited family the week already has.
     *
     * Counted across the whole range, including days this fill is not
     * touching: chicken tacos already on Tuesday make beef tacos on Friday the
     * second time this week.
     *
     * This tracks what is actually in the plan, and is kept in step as the
     * fill goes. Discounting everything that `overwrite` was going to replace
     * up front looked simpler and was wrong: a slot whose replacement cannot
     * be found keeps what it had, so a taco written off as replaced was still
     * sitting there at the end, and the week got two.
     */
    const byId = new Map(meals.map((m) => [m.id, m]));
    const used = new Map();
    const bump = (meal, by) => {
        const rule = limitFor(meal);
        if (rule) used.set(rule.match, Math.max(0, (used.get(rule.match) ?? 0) + by));
    };
    const count = (meal) => bump(meal, 1);
    const uncount = (meal) => bump(meal, -1);

    for (const date of dates) {
        for (const slot of SLOTS) {
            const planned = plan[date]?.[slot];
            if (planned) count(byId.get(planned));
        }
    }

    const blocked = (meal) => {
        const rule = limitFor(meal);
        return Boolean(rule) && (used.get(rule.match) ?? 0) >= rule.maxPerWeek;
    };

    for (const slot of slots) {
        const eligible = meals.filter((m) => m.slots.includes(slot));
        if (!eligible.length) continue;

        let pool = [];
        const draw = () => {
            if (!pool.length) {
                pool = [...eligible];
                // Fisher-Yates. Math.random is right here: this is dinner, not
                // a key, and crypto randomness would buy nothing.
                for (let i = pool.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [pool[i], pool[j]] = [pool[j], pool[i]];
                }
            }
            return avoidRepeats ? pool.pop() : eligible[Math.floor(Math.random() * eligible.length)];
        };

        for (const date of days) {
            const existingId = plan[date]?.[slot];
            if (!overwrite && existingId) continue;

            // Whatever is here is on its way out, so it stops counting against
            // the week while a replacement is looked for -- otherwise swapping
            // one taco for another would be refused by the taco already there.
            const previous = existingId ? byId.get(existingId) : null;
            if (previous) uncount(previous);

            // Draw until something is not already at its weekly limit. Bounded,
            // because a library where everything is blocked would otherwise
            // spin: twice the pool has seen every meal once even after a refill.
            let meal = null;
            for (let tries = 0; tries < eligible.length * 2 + 2; tries++) {
                const pick = draw();
                if (!pick) break;
                if (!blocked(pick)) {
                    meal = pick;
                    break;
                }
            }

            // Nothing to put here, so what was here stays -- and counts again.
            if (!meal) {
                if (previous) count(previous);
                continue;
            }

            setPlanSlot(plan, date, slot, meal.id);
            count(meal);
            filled.push({ date, slot, mealId: meal.id });
        }
    }

    return filled;
}
