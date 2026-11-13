'use strict';

const $ = (id) => document.getElementById(id);

// One meal of the day. Mirrors SLOTS in lib/store.js; see the note there for
// why this is still a list.
const SLOTS = ['dinner'];
const SLOT_LABELS = { dinner: 'Dinner' };

/*
 * Weeks start on Sunday.
 *
 * One line to change if the household would rather they started on Monday --
 * see weekStart below -- and nothing else in the app depends on which it is.
 */
const WEEK_STARTS_ON = 0;

const state = {
    meals: [],
    members: [],
    settings: null,
    days: [],
    view: 'today',
    // The last of the three Meals views that was open, so the tab comes back
    // to it rather than always to the plan.
    foodView: 'plan',
    weekStart: null,
    monthStart: null, // the 1st of the month the calendar is showing
    // The calendar shows a month or a single week. A week shares weekStart
    // with the plan, so there is one "this week" in the app rather than two
    // that can drift apart.
    calScope: 'month',
    calDays: [], // the month grid's days, as the server has them
    taskDay: null, // the day the chore chart is showing, as YYYY-MM-DD
    picking: null, // { date, slot } while the picker is open
    editing: null, // the meal being edited, or null for a new one
};

// ------------------------------------------------------------------ api ----

async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
        data = await res.json();
    } catch {
        /* an empty body is fine */
    }
    if (res.status === 401) {
        // The session ran out while the app was open. Showing the gate again is
        // more honest than an error on every subsequent tap.
        showGate();
        throw new Error(data.error || 'Not signed in.');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

let toastTimer = null;
function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// --------------------------------------------------------------- dates -----

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => new Date(`${s}T00:00:00`);

/** The start of the week containing `d`. */
function weekStart(d) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    out.setDate(out.getDate() - ((out.getDay() - WEEK_STARTS_ON + 7) % 7));
    return out;
}

function weekDates(start) {
    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        return isoDate(d);
    });
}

/** The 1st of the month containing `d`. */
function monthStart(d) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    out.setDate(1);
    return out;
}

/**
 * The days a month grid has to show: whole weeks, from the week containing the
 * 1st to the week containing the last day.
 *
 * Length is computed rather than fixed at six weeks. A 28-day February starting
 * on the first day of the week needs exactly four, and padding it to six would
 * add two rows of greyed-out days that belong to neither month.
 */
function monthGrid(first) {
    const start = weekStart(first);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const days = Math.round((weekStart(last) - start) / 86_400_000) + 7;
    return Array.from({ length: days }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        return isoDate(d);
    });
}

const fmtDayName = (iso) => parseIso(iso).toLocaleDateString(undefined, { weekday: 'long' });
const fmtDayShort = (iso) => parseIso(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** What the stepper reads for a view: a month on the calendar, a week elsewhere. */
function stepperLabel(view) {
    if (view === 'tasks') return fmtTaskDay(state.taskDay);
    if (view !== 'cal') return fmtWeekLabel(state.weekStart);
    return state.calScope === 'week'
        ? fmtWeekLabel(state.weekStart)
        : state.monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function fmtWeekLabel(start) {
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const opts = { day: 'numeric', month: 'short' };
    const sameMonth = start.getMonth() === end.getMonth();
    const a = start.toLocaleDateString(undefined, sameMonth ? { day: 'numeric' } : opts);
    return `${a} – ${end.toLocaleDateString(undefined, opts)}`;
}

// ------------------------------------------------------------- confirm -----

/**
 * The app's own "are you sure", rather than the browser's confirm().
 *
 * Answered from the buttons as well as the dialog's close event: the buttons
 * cannot catch Escape or a tap on the backdrop, and `close` is dispatched as a
 * queued task, so anywhere those are not run the promise would stay pending and
 * a confirmation that never resolves is an action that silently hangs.
 */
function askConfirm({ title, body = '', confirmLabel = 'OK', danger = false }) {
    const dlg = $('confirm');
    const yes = $('confirm-yes');
    const no = $('confirm-no');
    const x = $('confirm-x');

    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    yes.textContent = confirmLabel;
    yes.className = danger ? 'primary danger' : 'primary';

    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            dlg.removeEventListener('close', onClose);
            dlg.removeEventListener('keydown', onKey);
            yes.removeEventListener('click', onYes);
            no.removeEventListener('click', onNo);
            x.removeEventListener('click', onNo);
            if (dlg.open) dlg.close();
            resolve(value);
        };
        const onYes = () => finish(true);
        const onNo = () => finish(false);
        const onKey = (e) => { if (e.key === 'Escape') finish(false); };
        const onClose = () => finish(dlg.returnValue === 'ok');

        yes.addEventListener('click', onYes);
        no.addEventListener('click', onNo);
        x.addEventListener('click', onNo);
        dlg.addEventListener('close', onClose);
        dlg.addEventListener('keydown', onKey);

        dlg.returnValue = '';
        dlg.showModal();
    });
}

// ------------------------------------------------------------- the gate ----

function showGate() {
    $('gate').hidden = false;
    $('app').hidden = true;
}

async function signIn(event) {
    event.preventDefault();
    const btn = $('gate-submit');
    const err = $('gate-error');
    err.hidden = true;
    btn.disabled = true;
    try {
        await api('/api/login', { method: 'POST', body: { password: $('gate-password').value } });
        $('gate-password').value = '';
        $('gate').hidden = true;
        $('app').hidden = false;
        await loadAll();
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    } finally {
        btn.disabled = false;
    }
}

// ----------------------------------------------------------- rendering -----

/*
 * Every destination, which tab it belongs to, and what it shows on top.
 *
 * The plan and the meals are two views behind one tab,
 * Meals, with a switch at the top: a phone's dock has room for five tabs, and
 * a family board needs more destinations than that.
 */
const VIEWS = {
    today: { tab: 'today', title: 'Overview' },
    cal: { tab: 'cal', title: 'Calendar', stepped: true },
    tasks: { tab: 'tasks', title: 'Reminders', stepped: true },
    plan: { tab: 'food', title: 'Meals', stepped: true },
    meals: { tab: 'food', title: 'Meals' },
    settings: { tab: 'settings', title: 'Settings' },
};
const FOOD_VIEWS = ['plan', 'meals'];

function setView(requested) {
    // The Meals tab opens whichever of its three was open last.
    let view = requested === 'food' ? state.foodView : requested;
    if (!VIEWS[view]) view = 'today';
    if (FOOD_VIEWS.includes(view)) state.foodView = view;
    state.view = view;
    const def = VIEWS[view];

    for (const tab of document.querySelectorAll('.tab')) {
        tab.classList.toggle('is-active', tab.dataset.view === def.tab);
    }
    for (const id of Object.keys(VIEWS)) $(`view-${id}`).hidden = id !== view;

    const food = FOOD_VIEWS.includes(view);
    $('food-tabs').hidden = !food;
    for (const b of document.querySelectorAll('#food-tabs [data-sub]')) {
        const on = b.dataset.sub === view;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', String(on));
    }

    // The stepper steps by a week on the plan, by a month or a week on the
    // calendar, and by a day on the reminders. The rest have nothing to step
    // through.
    $('weeknav').hidden = !def.stepped;
    $('btn-today').hidden = !def.stepped;
    $('btn-today').textContent =
        view === 'cal' ? (state.calScope === 'month' ? 'Week view' : 'Month view') : 'Today';
    $('view-title').textContent = def.title;

    /*
     * The label is set here, not only by whichever loader runs.
     *
     * Going from the calendar to another stepped view used to leave "October
     * 2026" above a week: that view's loader had no reason to touch the label,
     * so it kept whatever the calendar had put there. Deciding it from the view
     * is the only way it cannot disagree with what is on screen.
     */
    if (def.stepped) $('week-label').textContent = stepperLabel(view);

    if (view === 'today') loadToday();
    if (view === 'settings') renderSettings();
    if (view === 'cal') loadCalendar().catch((e) => toast(e.message));
    if (view === 'tasks') {
        showTaskDay();
        loadChores();
    }
    // Coming back to the plan from the calendar, where a day may have been
    // changed: the week on screen could be out of date.
    if (view === 'plan') loadWeek().catch(() => {});
}

// ---------------------------------------------------------- keeping fresh --

/*
 * What is on screen, read again: a reminder ticked on a phone, or an event
 * added in its Calendar app, reaches a board left on any tab.
 *
 * Every five minutes while the page is on screen, and at once when it comes
 * back -- the home-screen app reopened, the iPad woken -- after being away
 * for more than a few seconds. Not while the page is hidden, so a phone in a
 * pocket does not poll; not while a sheet or editor is open, so nothing moves
 * under somebody's finger; and not the meal library or Settings, which are
 * mostly forms and searches that a redraw would throw away.
 */
const REFRESH_EVERY_MS = 5 * 60_000;
const REFRESH_AFTER_AWAY_MS = 15_000;
let lastRefresh = Date.now();
let hiddenSince = null;

function refreshView() {
    if (document.hidden || document.querySelector('dialog[open]')) return;
    lastRefresh = Date.now();
    const quietly = (p) => Promise.resolve(p).catch(() => {});
    if (state.view === 'today') quietly(loadToday());
    if (state.view === 'cal') quietly(loadCalendar());
    if (state.view === 'tasks') quietly(loadChores());
    if (state.view === 'plan') quietly(loadWeek());
}

setInterval(() => {
    if (Date.now() - lastRefresh >= REFRESH_EVERY_MS - 1000) refreshView();
}, 30_000);

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        hiddenSince = Date.now();
    } else if (hiddenSince && Date.now() - hiddenSince > REFRESH_AFTER_AWAY_MS) {
        refreshView();
    }
});
// iOS can bring a home-screen app back from memory without a visibility
// change; this is the event it does send.
window.addEventListener('pageshow', (e) => {
    if (e.persisted) refreshView();
});

function mealById(id) {
    return state.meals.find((m) => m.id === id) || null;
}

/**
 * What is planned for a date and slot, from whichever view has that date.
 *
 * The picker can be opened from the week view or from the calendar's day sheet,
 * and those hold different ranges -- a date tapped in the calendar is usually
 * not in the loaded week at all. Asking both is what stops the picker opening
 * with nothing ticked on a day that clearly has something on it.
 */
function plannedAt(date, slot) {
    const fromWeek = state.days.find((d) => d.date === date)?.slots?.[slot];
    if (fromWeek) return fromWeek;
    return state.calDays.find((d) => d.date === date)?.slots?.[slot] ?? null;
}

function renderDays() {
    const host = $('days');
    const today = isoDate(new Date());

    if (!state.meals.length) {
        host.innerHTML =
            '<div class="empty"><strong>No meals yet</strong>' +
            'Add the things your family actually eats, then plan a week from them.</div>';
        return;
    }

    host.innerHTML = '';
    for (const day of state.days) {
        const card = document.createElement('div');
        card.className = `day${day.date === today ? ' is-today' : ''}`;

        const head = document.createElement('div');
        head.className = 'day-head';
        const name = document.createElement('span');
        name.className = 'day-name';
        name.textContent = fmtDayName(day.date);
        const date = document.createElement('span');
        date.className = 'day-date';
        date.textContent = fmtDayShort(day.date);
        head.append(name, date);
        card.append(head);

        for (const slot of SLOTS) {
            const meal = mealById(day.slots[slot]);
            const row = document.createElement('button');
            row.className = 'slot-row';
            row.dataset.date = day.date;
            row.dataset.slot = slot;

            const value = document.createElement('span');
            value.className = `slot-meal${meal ? '' : ' is-empty'}`;
            value.textContent = meal ? meal.name : 'Nothing planned';

            const chev = document.createElement('span');
            chev.className = 'slot-chevron';
            chev.setAttribute('aria-hidden', 'true');
            chev.textContent = '›';

            row.append(value, chev);
            card.append(row);
        }
        host.append(card);
    }
}

let mealSearching = false; // whether the box above the list is searching or adding

function renderMeals() {
    const host = $('meal-list');
    const q = mealSearching ? $('meal-input').value.trim().toLowerCase() : '';
    const list = state.meals
        .filter((m) => !q || m.name.toLowerCase().includes(q) || m.tags.some((t) => t.includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name));

    $('meals-count').textContent = state.meals.length
        ? `${state.meals.length} meal${state.meals.length === 1 ? '' : 's'} in the library`
        : '';

    if (!list.length) {
        host.innerHTML = state.meals.length
            ? '<div class="empty"><strong>Nothing matches</strong>Try a different word, or tap Add to add it.</div>'
            : '<div class="empty"><strong>No meals yet</strong>Type one above and tap Add.</div>';
        return;
    }

    host.innerHTML = '';
    for (const meal of list) {
        const card = document.createElement('button');
        card.className = 'meal-card';
        card.dataset.meal = meal.id;

        const main = document.createElement('div');
        main.className = 'meal-main';
        const name = document.createElement('div');
        name.className = 'meal-name';
        name.textContent = meal.name;
        main.append(name);

        const bits = [];
        if (meal.serves) bits.push(`serves ${meal.serves}`);
        if (meal.ingredients.length) bits.push(`${meal.ingredients.length} ingredients`);
        if (meal.method.length) bits.push(`${meal.method.length} steps`);
        if (meal.tags.length) bits.push(meal.tags.join(', '));
        if (bits.length) {
            const sub = document.createElement('div');
            sub.className = 'meal-sub';
            sub.textContent = bits.join(' · ');
            main.append(sub);
        }

        card.append(main);
        host.append(card);
    }
}

// ------------------------------------------------------------ calendar -----

/** One row of weekday initials, in the same order the grid runs. */
function renderWeekdays() {
    const host = $('cal-weekdays');
    if (host.childElementCount) return;
    const ref = weekStart(new Date());
    host.innerHTML = '';
    for (let i = 0; i < 7; i++) {
        const d = new Date(ref);
        d.setDate(d.getDate() + i);
        const cell = document.createElement('span');
        // Narrow rather than short: "S" twice over is no help at all, and the
        // locale decides what a sensible abbreviation looks like.
        cell.textContent = d.toLocaleDateString(undefined, { weekday: 'narrow' });
        cell.title = d.toLocaleDateString(undefined, { weekday: 'long' });
        host.append(cell);
    }
}

function renderCalendar() {
    const week = state.calScope === 'week';
    const host = $('cal-grid');
    const today = isoDate(new Date());
    const month = state.monthStart.getMonth();

    // A week names its own days inside each cell, so the strip of initials
    // above the month would just be repeating itself.
    $('cal-weekdays').hidden = week;
    if (!week) renderWeekdays();
    host.classList.toggle('is-week', week);

    host.innerHTML = '';
    for (const day of state.calDays) {
        const date = parseIso(day.date);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cal-day';
        if (!week && date.getMonth() !== month) cell.classList.add('is-outside');
        if (day.date === today) cell.classList.add('is-today');
        cell.dataset.date = day.date;
        cell.setAttribute(
            'aria-label',
            `${parseIso(day.date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`,
        );

        const num = document.createElement('span');
        num.className = 'cal-num';
        // A week has room to say which day it is in words; a month cell has
        // the column heading for that and only room for the number.
        num.textContent = week
            ? date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
            : String(date.getDate());
        cell.append(num);

        // Events first: a day reads "what is happening" before "what is for
        // dinner". A month cell has room for three before it says how many more.
        const events = state.calEvents?.get(day.date) ?? [];
        if (events.length) {
            const list = el('span', `cal-events${events.length <= 2 ? ' is-few' : ''}`);
            const shown = week ? events : events.slice(0, 3);
            for (const o of shown) list.append(eventChip(o, { compact: !week }));
            if (shown.length < events.length) {
                // "+2 more", or just "+2" in a phone's narrow cell.
                const more = el('span', 'cal-more', `+${events.length - shown.length}`);
                more.append(el('span', 'cal-more-word', ' more'));
                list.append(more);
            }
            cell.append(list);
        }

        const meals = document.createElement('span');
        meals.className = 'cal-meals';
        for (const slot of SLOTS) {
            const meal = mealById(day.slots[slot]);
            if (!meal) continue;
            const row = document.createElement('span');
            row.className = 'cal-meal';
            const dot = document.createElement('span');
            dot.className = `dot ${slot}`;
            const name = document.createElement('span');
            // The slot is on the name, not only on the dot beside it, so the
            // name itself carries the colour.
            name.className = `name ${slot}`;
            name.textContent = meal.name;
            row.append(dot, name);
            row.title = `${SLOT_LABELS[slot]}: ${meal.name}`;
            meals.append(row);
        }
        if (week && !meals.childElementCount && !events.length) {
            const none = document.createElement('span');
            none.className = 'cal-empty';
            none.textContent = 'Nothing planned';
            meals.append(none);
        }

        cell.append(meals);
        host.append(cell);
    }
}

async function loadCalendar() {
    const dates = state.calScope === 'week' ? weekDates(state.weekStart) : monthGrid(state.monthStart);
    const range = `from=${dates[0]}&to=${dates[dates.length - 1]}`;
    const [{ days }, { occurrences }] = await Promise.all([api(`/api/plan?${range}`), api(`/api/events?${range}`)]);
    state.calDays = days;
    state.calEvents = groupByDate(occurrences);
    $('week-label').textContent = stepperLabel('cal');
    renderCalendar();
}

/** The full names for one date, and a way to change any of them. */
function openDay(date) {
    const day = state.calDays.find((d) => d.date === date);
    state.dayOpen = date;
    const events = state.calEvents?.get(date) ?? [];
    $('day-events').replaceChildren(
        ...(events.length ? events.map((o) => eventRow(o)) : [el('p', 'hint', 'Nothing on this day.')]),
    );
    $('day-title').textContent = parseIso(date).toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
    });

    const host = $('day-slots');
    host.innerHTML = '';
    for (const slot of SLOTS) {
        const meal = mealById(day?.slots?.[slot]);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'day-slot';
        row.dataset.date = date;
        row.dataset.slot = slot;

        const value = document.createElement('span');
        value.className = `slot-meal${meal ? '' : ' is-empty'}`;
        value.textContent = meal ? meal.name : 'Nothing planned';
        const chev = document.createElement('span');
        chev.className = 'slot-chevron';
        chev.setAttribute('aria-hidden', 'true');
        chev.textContent = '\u203a';

        row.append(value, chev);
        host.append(row);
    }
    $('day').showModal();
}

// ------------------------------------------------------------- loading -----

async function loadMeals() {
    const { meals } = await api('/api/meals');
    state.meals = meals;
}

async function loadWeek() {
    const dates = weekDates(state.weekStart);
    const { days } = await api(`/api/plan?from=${dates[0]}&to=${dates[6]}`);
    state.days = days;
    $('week-label').textContent = stepperLabel(state.view);
    renderDays();
}

async function loadAll() {
    await Promise.all([loadMeals(), loadMembers(), loadSettings()]);
    await loadWeek();
    renderMeals();
}

// -------------------------------------------------------------- picker -----

function openPicker(date, slot) {
    state.picking = { date, slot };
    const current = plannedAt(date, slot);
    $('picker-title').textContent = fmtDayName(date);
    $('picker-search').value = '';
    renderPicker(current);
    $('picker').showModal();
}

function renderPicker(current) {
    const q = $('picker-search').value.trim().toLowerCase();
    const host = $('picker-list');

    // Every meal is for the one meal of the day, so there is nothing to sort
    // into eligible and the rest any more: it is the library, in order.
    const list = [...state.meals]
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter((m) => !q || m.name.toLowerCase().includes(q));

    if (!list.length) {
        host.innerHTML = '<p class="hint">No meals match.</p>';
        return;
    }

    host.innerHTML = '';
    for (const meal of list) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `picker-row${meal.id === current ? ' is-current' : ''}`;
        row.dataset.pick = meal.id;
        const name = document.createElement('span');
        name.textContent = meal.name;
        row.append(name);
        if (meal.id === current) {
            const tick = document.createElement('span');
            tick.textContent = '✓';
            row.append(tick);
        }
        host.append(row);
    }
}

async function pick(mealId) {
    const { date, slot } = state.picking;
    $('picker').close();
    try {
        await api('/api/plan', { method: 'PUT', body: { date, slot, mealId } });
        // Whichever view is on screen is the one that has to be right. The other
        // reloads when it is next opened, so there is nothing to keep in step.
        if (state.view === 'cal') await loadCalendar();
        else if (state.view === 'today') await loadWeekOverview();
        else await loadWeek();
    } catch (e) {
        toast(e.message);
    }
}

// -------------------------------------------------------------- editor -----

function openEditor(meal) {
    state.editing = meal;
    $('editor-title').textContent = meal ? 'Edit meal' : 'New meal';
    $('editor-error').hidden = true;
    $('ed-name').value = meal?.name ?? '';
    $('ed-serves').value = meal?.serves ?? '';
    $('ed-tags').value = (meal?.tags ?? []).join(', ');
    $('ed-ingredients').value = (meal?.ingredients ?? []).join('\n');
    $('ed-method').value = (meal?.method ?? []).join('\n');
    $('ed-notes').value = meal?.notes ?? '';
    $('ed-delete').hidden = !meal;
    $('editor').showModal();
}

async function saveMeal(event) {
    event.preventDefault();
    const err = $('editor-error');
    err.hidden = true;

    const body = {
        name: $('ed-name').value,
        slots: SLOTS,
        serves: $('ed-serves').value,
        tags: $('ed-tags').value,
        ingredients: $('ed-ingredients').value,
        method: $('ed-method').value,
        notes: $('ed-notes').value,
    };

    try {
        if (state.editing) await api(`/api/meals/${state.editing.id}`, { method: 'PUT', body });
        else await api('/api/meals', { method: 'POST', body });
        $('editor').close();
        await loadMeals();
        renderMeals();
        renderDays();
        toast(state.editing ? 'Saved' : 'Added');
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
}

function setMealSearch(on) {
    mealSearching = on;
    const input = $('meal-input');
    const button = $('btn-search-meals');
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? 'Done' : 'Search';
    input.placeholder = on ? 'Search meals' : 'New meal';
    input.setAttribute('aria-label', input.placeholder);
    input.enterKeyHint = on ? 'search' : 'done';
    // Leaving the search empties the box: what was typed was a search, not a
    // meal waiting to be added.
    if (!on) input.value = '';
    renderMeals();
    input.focus();
}

/*
 * Add straight from the box: just the name, which is all a meal needs.
 * Tapping it in the list fills in the rest when there is time. With nothing
 * typed, Add opens the full editor instead.
 */
async function quickAddMeal(e) {
    e.preventDefault();
    const input = $('meal-input');
    // Return on the keyboard while searching is "search", not "add this".
    if (mealSearching && e.submitter?.id !== 'btn-add-meal') return input.blur();
    const name = input.value.trim();
    if (!name) return openEditor(null);
    const same = state.meals.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (same) return toast(`${same.name} is already there`);
    try {
        await api('/api/meals', { method: 'POST', body: { name, slots: SLOTS } });
        await loadMeals();
        input.value = '';
        if (mealSearching) setMealSearch(false);
        else renderMeals();
        renderDays();
        toast(`Added ${name}`);
    } catch (ex) {
        toast(ex.message);
    }
}

async function deleteMeal() {
    const meal = state.editing;
    if (!meal) return;
    const sure = await askConfirm({
        title: `Delete ${meal.name}?`,
        body: 'It is taken out of the library and off any day it was planned for.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!sure) return;
    try {
        const { removedFromPlan } = await api(`/api/meals/${meal.id}`, { method: 'DELETE' });
        $('editor').close();
        await loadMeals();
        await loadWeek();
        renderMeals();
        toast(removedFromPlan ? `Deleted, and cleared from ${removedFromPlan} day(s)` : 'Deleted');
    } catch (e) {
        toast(e.message);
    }
}

// -------------------------------------------------------------- random -----

function openRandomer() {
    if (!state.meals.length) return toast('Add some meals first.');
    $('randomer-range').textContent = `Week of ${fmtWeekLabel(state.weekStart)}`;
    $('randomer-error').hidden = true;
    $('randomer').showModal();
}

async function runRandom(event) {
    event.preventDefault();
    const err = $('randomer-error');
    const dates = weekDates(state.weekStart);
    try {
        const out = await api('/api/plan/random', {
            method: 'POST',
            body: {
                from: dates[0],
                to: dates[6],
                slots: SLOTS,
                overwrite: $('rn-overwrite').checked,
                avoidRepeats: $('rn-norepeat').checked,
                includeWeekends: $('rn-weekends').checked,
            },
        });
        $('randomer').close();
        await loadWeek();
        // Nothing filled is a real outcome, not a failure, and saying so beats a
        // silent no-op: it happens when every slot asked for is already taken.
        toast(
            out.filled
                ? `Filled ${out.filled} meal${out.filled === 1 ? '' : 's'}`
                : 'Nothing to fill — those slots are already planned',
        );
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
}

async function clearWeek() {
    const sure = await askConfirm({
        title: 'Clear this week?',
        body: `Everything planned for ${fmtWeekLabel(state.weekStart)} is removed. Your meal library is untouched.`,
        confirmLabel: 'Clear it',
        danger: true,
    });
    if (!sure) return;
    const dates = weekDates(state.weekStart);
    try {
        const { cleared } = await api(`/api/plan?from=${dates[0]}&to=${dates[6]}`, { method: 'DELETE' });
        await loadWeek();
        toast(cleared ? `Cleared ${cleared} meal${cleared === 1 ? '' : 's'}` : 'That week was already empty');
    } catch (e) {
        toast(e.message);
    }
}

// ----------------------------------------------------------------- events --

/** Occurrences keyed by the day they fall on, for drawing a grid. */
function groupByDate(list) {
    const map = new Map();
    for (const o of list) {
        if (!map.has(o.date)) map.set(o.date, []);
        map.get(o.date).push(o);
    }
    return map;
}

/** "10 AM", "3:15 PM" -- the minutes only when there are some. */
function fmtTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(2000, 0, 1, h, m);
    return d.toLocaleTimeString(undefined, m ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' });
}

function whenText(o) {
    if (o.allDay) return 'All day';
    return o.end ? `${fmtTime(o.start)} – ${fmtTime(o.end)}` : fmtTime(o.start);
}

/* The colour an event is drawn in: its first person's, or a neutral one for an
   event that is everybody's. */
const eventColour = (o) => memberById(o.members?.[0])?.colour ?? 'var(--muted)';

function memberDots(ids) {
    const wrap = el('span', 'member-dots');
    for (const id of ids ?? []) {
        const m = memberById(id);
        if (!m) continue;
        const dot = el('span', 'member-dot');
        dot.style.background = m.colour;
        dot.title = m.name;
        wrap.append(dot);
    }
    return wrap;
}

/** One event as a line in a calendar cell. */
function eventChip(o, { compact }) {
    const chip = el('span', `cal-event${o.allDay ? ' is-allday' : ''}${o.continues ? ' continues' : ''}`);
    chip.style.setProperty('--ev', eventColour(o));
    if (!o.allDay) chip.append(el('span', 'cal-event-time', fmtTime(o.start)));
    chip.append(el('span', 'cal-event-title', o.title));
    if (!compact && o.members?.length > 1) chip.append(memberDots(o.members));
    chip.title = `${whenText(o)} · ${o.title}`;
    return chip;
}

/** One event as a tappable row, for the day sheet and the Today screen. */
function eventRow(o) {
    const row = el('button', 'event-row');
    row.type = 'button';
    row.dataset.event = o.id;
    row.dataset.occurrence = o.occurrence;
    row.dataset.date = o.date;
    row.style.setProperty('--ev', eventColour(o));
    const when = el('span', 'event-when', whenText(o));
    const main = el('span', 'event-main');
    main.append(el('span', 'event-title', o.title));
    const people = (o.members ?? []).map((id) => memberById(id)?.name).filter(Boolean);
    const sub = [people.join(', '), o.location].filter(Boolean).join(' · ');
    if (sub) main.append(el('span', 'event-sub', sub));
    row.append(when, main, memberDots(o.members));
    return row;
}

let editingEvent = null; // { event, occurrence } while the sheet is open

/* The alert choices, minutes before the start; an all-day event's are times on a day. */
const ALERTS = {
    timed: [
        [0, 'At the time'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'],
        [30, '30 minutes before'], [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before'],
        [2880, '2 days before'], [10080, '1 week before'],
    ],
    allDay: [[-540, 'On the day (9 am)'], [900, '1 day before (9 am)'], [2340, '2 days before (9 am)'], [9540, '1 week before (9 am)']],
};
// Switching to or from all day keeps the alert as near as it can.
const ALERT_SWAP = { '-540': 15, 900: 1440, 2340: 2880, 9540: 10080 };

function fillAlerts(allDay, value) {
    const sel = $('ev-alert');
    const list = allDay ? ALERTS.allDay : ALERTS.timed;
    if (value != null && !list.some(([m]) => m === value)) {
        const back = Object.entries(ALERT_SWAP).find(([, t]) => t === value);
        value = allDay ? (back ? Number(back[0]) : -540) : (ALERT_SWAP[value] ?? 15);
    }
    const option = (v, label) => Object.assign(el('option', null, label), { value: v });
    sel.replaceChildren(option('', 'None'), ...list.map(([m, label]) => option(String(m), label)));
    sel.value = value == null ? '' : String(value);
    sel.dataset.allDay = String(allDay);
}

/*
 * The Repeats choice, as "weekly" or "weekly:2". One made on a phone can be
 * every three months or every four years; it gets a choice of its own in
 * the list rather than showing as something it is not.
 */
function setEventRepeat(repeat, every) {
    const sel = $('ev-repeat');
    sel.querySelector('[data-custom]')?.remove();
    const value = every > 1 ? `${repeat}:${every}` : repeat;
    if (![...sel.options].some((o) => o.value === value)) {
        const unit = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[repeat];
        const option = el('option', null, `Every ${every} ${unit}`);
        option.value = value;
        option.dataset.custom = '';
        sel.append(option);
    }
    sel.value = value;
}

function eventFieldsShown() {
    const allDay = $('ev-allday').checked;
    if ($('ev-alert').dataset.allDay !== String(allDay)) {
        fillAlerts(allDay, $('ev-alert').value === '' ? null : Number($('ev-alert').value));
    }
    $('ev-alert-hint').hidden = $('ev-alert').value === '';
    $('ev-times').hidden = allDay;
    $('ev-enddate-row').hidden = !allDay;
    const repeats = $('ev-repeat').value !== 'none';
    $('ev-until-row').hidden = !repeats;
    $('ev-series-note').hidden = !(repeats && editingEvent?.event);
}

async function openEventEditor(id, { date, occurrence } = {}) {
    let event = null;
    if (id) {
        try {
            ({ event } = await api(`/api/events/${id}`));
        } catch (e) {
            return toast(e.message);
        }
    }
    editingEvent = { event, occurrence: occurrence ?? null };

    $('event-heading').textContent = event ? 'Edit event' : 'New event';
    $('event-error').hidden = true;
    $('ev-title').value = event?.title ?? '';
    $('ev-date').value = event?.date ?? date ?? isoDate(new Date());
    $('ev-enddate').value = event?.endDate ?? '';
    $('ev-allday').checked = event ? event.allDay : false;
    $('ev-start').value = event?.start ?? '';
    $('ev-end').value = event?.end ?? '';
    setEventRepeat(event?.repeat ?? 'none', event?.every ?? 1);
    $('ev-until').value = event?.until ?? '';
    $('ev-location').value = event?.location ?? '';
    $('ev-notes').value = event?.notes ?? '';
    fillAlerts($('ev-allday').checked, event?.alert ?? null);

    // Who: a chip per person, in their colour. None ticked is everybody's.
    const who = $('ev-members');
    who.querySelectorAll('label, .hint').forEach((n) => n.remove());
    if (!state.members.length) who.append(el('p', 'hint', 'Add the family under Settings to give events a person.'));
    for (const m of state.members) {
        const label = el('label', 'who-chip');
        label.style.setProperty('--who', m.colour);
        const input = el('input');
        input.type = 'checkbox';
        input.value = m.id;
        input.checked = event?.members?.includes(m.id) ?? false;
        label.append(input, avatar(m, 'avatar small'), el('span', null, m.name));
        who.append(label);
    }

    // "Delete this day" only makes sense for one day of a repeating series.
    $('ev-delete').hidden = !event;
    $('ev-delete').textContent = event && event.repeat !== 'none' ? 'Delete all' : 'Delete';
    $('ev-delete-one').hidden = !(event && event.repeat !== 'none' && occurrence);
    eventFieldsShown();
    $('event-editor').showModal();
    if (!event) $('ev-title').focus();
}

/** Whatever is on screen that shows events, read again. */
async function refreshEvents() {
    if (state.view === 'cal') await loadCalendar();
    if (state.view === 'today') await loadWeekOverview();
}

async function saveEvent(e) {
    e.preventDefault();
    const err = $('event-error');
    err.hidden = true;
    const allDay = $('ev-allday').checked;
    const body = {
        title: $('ev-title').value,
        date: $('ev-date').value,
        endDate: allDay ? $('ev-enddate').value : '',
        allDay,
        start: allDay ? '' : $('ev-start').value,
        end: allDay ? '' : $('ev-end').value,
        members: [...$('ev-members').querySelectorAll('input:checked')].map((i) => i.value),
        repeat: $('ev-repeat').value.split(':')[0],
        every: Number($('ev-repeat').value.split(':')[1] ?? 1),
        until: $('ev-until').value,
        location: $('ev-location').value,
        notes: $('ev-notes').value,
        alert: $('ev-alert').value,
    };
    // A timed event needs its time; saying so here beats a round trip that
    // only comes back to say it.
    if (!allDay && !body.start) {
        err.textContent = 'Pick a start time, or tick All day.';
        err.hidden = false;
        return;
    }
    try {
        const { event } = editingEvent ?? {};
        if (event) await api(`/api/events/${event.id}`, { method: 'PUT', body });
        else await api('/api/events', { method: 'POST', body });
        $('event-editor').close();
        await refreshEvents();
        toast(event ? 'Saved' : 'Added to the calendar');
    } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
    }
}

async function deleteEvent(onlyThisDay) {
    const { event, occurrence } = editingEvent ?? {};
    if (!event) return;
    const day = occurrence ? parseIso(occurrence).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : '';
    const sure = await askConfirm(
        onlyThisDay
            ? { title: `Delete ${event.title} on ${day}?`, body: 'Only that day. Every other time it repeats stays.', confirmLabel: 'Delete this day', danger: true }
            : {
                  title: `Delete ${event.title}?`,
                  body: event.repeat === 'none' ? 'It comes off the calendar.' : 'Every time it repeats comes off the calendar, past and future.',
                  confirmLabel: event.repeat === 'none' ? 'Delete' : 'Delete all',
                  danger: true,
              },
    );
    if (!sure) return;
    try {
        const q = onlyThisDay ? `?occurrence=${occurrence}` : '';
        await api(`/api/events/${event.id}${q}`, { method: 'DELETE' });
        $('event-editor').close();
        await refreshEvents();
        toast('Deleted');
    } catch (ex) {
        toast(ex.message);
    }
}


// ------------------------------------------------------------------ tasks --

/* A weekday's name from its number, 0 for Sunday. 1 November 2026 was one. */
const dayName = (i, weekday = 'short') => new Date(2026, 10, 1 + i).toLocaleDateString(undefined, { weekday });

/** The days of the week in the order the calendar shows them. */
const weekOrder = () => Array.from({ length: 7 }, (_, k) => (WEEK_STARTS_ON + k) % 7);

function addDays(iso, n) {
    const d = parseIso(iso);
    d.setDate(d.getDate() + n);
    return isoDate(d);
}

/** "Today", "Tomorrow", or the day itself, for the stepper over the chart. */
function fmtTaskDay(iso) {
    const today = isoDate(new Date());
    if (iso === today) return 'Today';
    if (iso === addDays(today, 1)) return 'Tomorrow';
    if (iso === addDays(today, -1)) return 'Yesterday';
    return parseIso(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/** The small line under a reminder: its time, and how often or how late. */
function choreWhen(t) {
    const parts = [];
    if (t.time && !t.done) parts.push(fmtTime(t.time));
    if (t.overdue) parts.push(`Late · was due ${fmtDayShort(t.date)}`);
    else if (t.repeat !== 'none') parts.push(repeatText(t));
    return parts.filter(Boolean).join(' · ');
}

/** How often a reminder comes round, in words. */
function repeatText(t) {
    const n = t.every || 1;
    const every = (one, many) => (n > 1 ? `Every ${n} ${many}` : `Every ${one}`);
    if (t.repeat === 'daily') return every('day', 'days');
    if (t.repeat === 'weekly') {
        const d = t.days.join();
        let which = weekOrder().filter((i) => t.days.includes(i)).map((i) => dayName(i)).join(', ');
        if (d === '0,1,2,3,4,5,6') which = 'every day';
        else if (d === '1,2,3,4,5') which = 'weekdays';
        else if (d === '0,6') which = 'weekends';
        else if (t.days.length === 1) which = dayName(t.days[0], 'long');
        if (n > 1) return `Every ${n} weeks · ${which}`;
        if (t.days.length === 1) return `Every ${which}`;
        return which[0].toUpperCase() + which.slice(1);
    }
    if (t.repeat === 'monthly') return `${every('month', 'months')} on the ${ordinal(Number(t.date.slice(8)))}`;
    if (t.repeat === 'yearly') {
        const day = parseIso(t.date).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
        return `${every('year', 'years')} on ${day}`;
    }
    return '';
}

/** 1st, 2nd, 3rd, 11th, 22nd. */
function ordinal(n) {
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
    return `${n}${suffix}`;
}

/* Somebody's colour, or a neutral one for a reminder that is anybody's. */
const choreColour = (t) => memberById(t.member)?.colour ?? 'var(--muted)';

const anyoneAvatar = (className = 'avatar') => {
    const a = el('span', `${className} anyone`, '★');
    a.setAttribute('aria-hidden', 'true');
    return a;
};

/**
 * One chore: a big tick target, and a pencil beside it.
 *
 * The tick is the whole row, because ticking is what a chart is used for many
 * times a day -- a small eight-year-old's finger should not have to find a
 * checkbox. Editing is the rare thing and gets the small button.
 */
function choreRow(t, day, { owner = false } = {}) {
    const row = el('div', `chore${t.done ? ' is-done' : ''}${t.overdue ? ' is-late' : ''}`);
    row.style.setProperty('--who', choreColour(t));

    const tick = el('button', 'chore-tick');
    tick.type = 'button';
    tick.dataset.task = t.id;
    tick.dataset.date = day;
    tick.setAttribute('aria-pressed', String(t.done));
    tick.append(el('span', 'chore-box'));
    if (owner) {
        const m = memberById(t.member);
        tick.append(m ? avatar(m, 'avatar small') : anyoneAvatar('avatar small'));
    }
    const text = el('span', 'chore-text');
    text.append(el('span', 'chore-title', t.title));
    const when = choreWhen(t);
    if (when) text.append(el('span', 'chore-when', when));
    tick.append(text);

    const edit = el('button', 'chore-edit', '✎');
    edit.type = 'button';
    edit.dataset.edit = t.id;
    edit.setAttribute('aria-label', `Edit ${t.title}`);
    row.append(tick, edit);
    return row;
}

/** The stepper over the chart, and the way back to today when it is elsewhere. */
function showTaskDay() {
    $('week-label').textContent = stepperLabel('tasks');
    $('btn-today').hidden = state.taskDay === isoDate(new Date());
}

const fetchChores = async (day) =>
    (await api(`/api/tasks?date=${day}&today=${isoDate(new Date())}`)).tasks;

async function loadChores() {
    const day = state.taskDay;
    let tasks;
    try {
        tasks = await fetchChores(day);
    } catch (e) {
        return toast(e.message);
    }
    // Stepped on, or left, while this was on its way.
    if (state.view !== 'tasks' || state.taskDay !== day) return;

    const columns = state.members.map((m) => ({ member: m, tasks: tasks.filter((t) => t.member === m.id) }));
    const anyone = tasks.filter((t) => !memberById(t.member));
    if (anyone.length || !state.members.length) columns.push({ member: null, tasks: anyone });
    $('chore-board').replaceChildren(...columns.map((c) => choreColumn(c, day)));
}

function choreColumn({ member, tasks }, day) {
    const col = el('article', 'panel-card chore-col');
    col.style.setProperty('--who', member?.colour ?? 'var(--muted)');

    const done = tasks.filter((t) => t.done).length;
    const head = el('div', 'chore-head');
    head.append(
        member ? avatar(member) : anyoneAvatar(),
        el('h2', 'chore-name', member?.name ?? 'Anyone'),
        el('span', 'chore-count', tasks.length ? `${done}/${tasks.length}` : ''),
    );
    const bar = el('div', 'chore-bar');
    const fill = el('span');
    fill.style.width = tasks.length ? `${(done / tasks.length) * 100}%` : '0';
    bar.append(fill);

    const list = el('div', 'chore-list');
    if (!tasks.length) list.append(el('p', 'hint', day === isoDate(new Date()) ? 'Nothing today.' : 'Nothing this day.'));
    else list.append(...tasks.map((t) => choreRow(t, day)));
    if (tasks.length && done === tasks.length) list.append(el('p', 'chore-cheer', 'All done 🎉'));

    col.append(head, bar, list);
    return col;
}


/** Whatever is on screen that shows chores, read again. */
async function refreshChores() {
    if (state.view === 'tasks') await loadChores();
    if (state.view === 'today') await loadWeekOverview();
}

/*
 * Ticked on screen at once, then told to the server.
 *
 * Waiting for the round trip before the box fills makes a child tap it twice,
 * which unticks it.
 */
async function toggleChore(tick) {
    const row = tick.closest('.chore');
    const done = !row.classList.contains('is-done');
    row.classList.toggle('is-done', done);
    tick.setAttribute('aria-pressed', String(done));
    try {
        await api(`/api/tasks/${tick.dataset.task}/done`, {
            method: 'POST',
            body: { date: tick.dataset.date, today: isoDate(new Date()), done },
        });
    } catch (e) {
        toast(e.message);
    }
    await refreshChores();
}

function onChoreClick(e) {
    const edit = e.target.closest('.chore-edit');
    if (edit) return openTaskEditor(edit.dataset.edit);
    const tick = e.target.closest('.chore-tick');
    if (tick) toggleChore(tick);
}

let editingTask = null;
let taskRepeat = 'none'; // what the Repeats buttons are set to

function setTaskRepeat(repeat) {
    taskRepeat = repeat;
    for (const b of $('tk-repeat').querySelectorAll('[data-repeat]')) {
        const on = b.dataset.repeat === repeat;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', String(on));
    }
    // Weekly with no day picked yet starts on the day it starts, which is
    // nearly always the one meant, rather than an error at Save.
    if (repeat === 'weekly' && !$('tk-days').querySelector('input:checked')) {
        const from = $('tk-date').value || isoDate(new Date());
        const box = $('tk-days').querySelector(`input[value="${parseIso(from).getDay()}"]`);
        if (box) box.checked = true;
    }
    taskFieldsShown();
}

const EVERY_UNITS = { daily: ['day', 'days'], weekly: ['week', 'weeks'], monthly: ['month', 'months'], yearly: ['year', 'years'] };

function taskFieldsShown() {
    const repeat = taskRepeat;
    $('tk-days').hidden = repeat !== 'weekly';
    $('tk-every-row').hidden = repeat === 'none';
    if (repeat !== 'none') {
        const [one, many] = EVERY_UNITS[repeat];
        $('tk-every-unit').textContent = Number($('tk-every').value) > 1 ? many : one;
    }
    $('tk-date-label').textContent = repeat === 'none' ? 'Due' : 'Next due';
    const hint = $('tk-date-hint');
    if (repeat === 'none') {
        hint.textContent = "Leave the day empty and it waits on today's list until it is done.";
    } else {
        // How a repeating one behaves is the iPhone's way, and worth saying
        // once: it is not the same as a fresh one every day.
        let text = 'Tick it and it moves on to the next one. Missed, it waits on today’s list until it is ticked.';
        const n = Number(($('tk-date').value || isoDate(new Date())).slice(8));
        if (repeat === 'monthly' && n > 28) text += ` Months with no ${ordinal(n)} are skipped.`;
        hint.textContent = text;
    }
    if (editingTask?.until && repeat !== 'none') hint.textContent += ` It stops repeating after ${fmtDayShort(editingTask.until)}.`;
}

async function openTaskEditor(id, { date } = {}) {
    let task = null;
    if (id) {
        try {
            ({ task } = await api(`/api/tasks/${id}`));
        } catch (e) {
            return toast(e.message);
        }
    }
    editingTask = task;

    $('task-heading').textContent = task ? 'Edit reminder' : 'New reminder';
    $('task-error').hidden = true;
    $('tk-title').value = task?.title ?? '';
    // A new reminder added while looking at today waits on today's list with
    // no day of its own; one added while looking at another day is due that day.
    $('tk-date').value = task ? task.date ?? '' : date && date !== isoDate(new Date()) ? date : '';
    $('tk-time').value = task?.time ?? '';
    $('tk-every').value = String(task?.every ?? 1);
    $('tk-notes').value = task?.notes ?? '';

    // Whose: one person, or anybody.
    const who = $('tk-member');
    who.querySelectorAll('label').forEach((n) => n.remove());
    const current = task && memberById(task.member) ? task.member : '';
    for (const m of [null, ...state.members]) {
        const label = el('label', 'who-chip');
        label.style.setProperty('--who', m?.colour ?? 'var(--muted)');
        const input = el('input');
        input.type = 'radio';
        input.name = 'tk-member';
        input.value = m?.id ?? '';
        input.checked = input.value === current;
        label.append(input, m ? avatar(m, 'avatar small') : anyoneAvatar('avatar small'), el('span', null, m?.name ?? 'Anyone'));
        who.append(label);
    }

    const days = $('tk-days');
    days.querySelectorAll('label').forEach((n) => n.remove());
    for (const i of weekOrder()) {
        const label = el('label', 'day-chip');
        const input = el('input');
        input.type = 'checkbox';
        input.value = String(i);
        input.checked = task?.days?.includes(i) ?? false;
        label.append(input, el('span', null, dayName(i)));
        days.append(label);
    }

    $('tk-delete').hidden = !task;
    setTaskRepeat(task?.repeat ?? 'none');
    $('task-editor').showModal();
    if (!task) $('tk-title').focus();
}

async function saveTask(e) {
    e.preventDefault();
    const err = $('task-error');
    err.hidden = true;
    const body = {
        title: $('tk-title').value,
        member: $('tk-member').querySelector('input:checked')?.value || null,
        repeat: taskRepeat,
        days: [...$('tk-days').querySelectorAll('input:checked')].map((i) => Number(i.value)),
        date: $('tk-date').value,
        time: $('tk-time').value,
        every: Number($('tk-every').value) || 1,
        notes: $('tk-notes').value,
    };
    // A repeating one is always due some day; left empty, that is today.
    if (body.repeat !== 'none' && !body.date) body.date = isoDate(new Date());
    if (body.time && !body.date) {
        err.textContent = 'Pick a day for the time to be on.';
        err.hidden = false;
        return;
    }
    if (body.repeat === 'weekly' && !body.days.length) {
        err.textContent = 'Pick the days it happens.';
        err.hidden = false;
        return;
    }
    try {
        if (editingTask) await api(`/api/tasks/${editingTask.id}`, { method: 'PUT', body });
        else await api('/api/tasks', { method: 'POST', body });
        $('task-editor').close();
        await refreshChores();
        toast(editingTask ? 'Saved' : 'Added');
    } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
    }
}

async function deleteTask() {
    const task = editingTask;
    if (!task) return;
    const sure = await askConfirm({
        title: `Delete ${task.title}?`,
        body: task.repeat === 'none' ? 'It comes off the list.' : 'It stops repeating, and the record of when it was done goes with it.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!sure) return;
    try {
        await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
        $('task-editor').close();
        await refreshChores();
        toast('Deleted');
    } catch (ex) {
        toast(ex.message);
    }
}

// ------------------------------------------------------------------ today --

/*
 * Open-Meteo's weather codes, as a word and a picture.
 *
 * Emoji rather than an icon set: they are already on every iPad and phone,
 * they are drawn in colour at any size, and a board read from across a room
 * needs a sun that looks like a sun more than it needs a consistent stroke.
 */
const WEATHER = [
    [[0], 'Clear', '☀️', '🌙'],
    [[1], 'Mostly clear', '🌤️', '🌙'],
    [[2], 'Partly cloudy', '⛅', '☁️'],
    [[3], 'Cloudy', '☁️', '☁️'],
    [[45, 48], 'Fog', '🌫️', '🌫️'],
    [[51, 53, 55, 56, 57], 'Drizzle', '🌦️', '🌧️'],
    [[61, 63, 65, 66, 67], 'Rain', '🌧️', '🌧️'],
    [[71, 73, 75, 77], 'Snow', '🌨️', '🌨️'],
    [[80, 81, 82], 'Showers', '🌦️', '🌧️'],
    [[85, 86], 'Snow showers', '🌨️', '🌨️'],
    [[95, 96, 99], 'Thunderstorms', '⛈️', '⛈️'],
];

function weatherFor(code, isDay = true) {
    const row = WEATHER.find(([codes]) => codes.includes(code));
    if (!row) return { label: '', icon: '🌡️' };
    return { label: row[1], icon: isDay ? row[2] : row[3] };
}

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
};

let clockTimer = null;
let todayShown = null; // the date the Today screen was last drawn for

function tickClock() {
    const now = new Date();
    $('today-time').textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    $('today-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    // Left open overnight, as a board is, it has to notice that today is now
    // tomorrow -- otherwise it shows yesterday's dinner until someone touches it.
    if (todayShown && isoDate(now) !== todayShown && state.view === 'today') loadToday();
}

async function loadToday() {
    todayShown = isoDate(new Date());
    tickClock();
    if (!clockTimer) clockTimer = setInterval(tickClock, 1000);
    await Promise.all([loadOverviewWeather(), loadWeekOverview()]);
}

/*
 * The week's weather, a column a day over the same seven days as the week
 * beneath it. Today's column has the weather now as well as the day's.
 */
async function loadOverviewWeather() {
    const host = $('ov-weather');
    let w;
    try {
        w = await api('/api/weather');
    } catch {
        return host.replaceChildren(el('h2', 'panel-label', 'Weather'), el('p', 'hint', 'The weather could not be loaded.'));
    }
    if (!w.configured) {
        const go = el('button', 'ghost', 'Choose your town');
        go.type = 'button';
        go.addEventListener('click', () => setView('settings'));
        return host.replaceChildren(
            el('h2', 'panel-label', 'Weather'),
            el('p', 'hint', 'Tell it where you are and the weather shows here.'),
            go,
        );
    }
    if (w.unavailable) {
        return host.replaceChildren(
            el('h2', 'panel-label', w.place),
            el('p', 'hint', 'The weather service could not be reached just now. It will try again in a few minutes.'),
        );
    }

    const today = isoDate(new Date());
    const days = overviewDates().map((date) => w.days.find((d) => d.date === date));
    const row = el('div', 'wx-week');
    days.forEach((day, k) => {
        const cell = el('div', `wx-day${k === 0 ? ' is-today' : ''}`);
        const date = overviewDates()[k];
        cell.append(el('span', 'wx-dname', date === today ? 'Today' : parseIso(date).toLocaleDateString(undefined, { weekday: 'short' })));
        if (k === 0) {
            const now = weatherFor(w.current.code, w.current.isDay);
            const head = el('span', 'wx-now');
            head.append(el('span', 'wx-dicon', now.icon), el('span', 'wx-temp', `${w.current.temp}°`));
            cell.append(head, el('span', 'wx-label', now.label));
        } else if (day) {
            cell.append(el('span', 'wx-dicon', weatherFor(day.code).icon));
        }
        if (day) {
            const range = el('span', 'wx-drange');
            range.append(el('b', null, `${day.high}°`), el('span', null, ` ${day.low}°`));
            cell.append(range);
            // Rain worth knowing about: a 10% chance is not.
            if (day.rain >= 30) cell.append(el('span', 'wx-rain', `💧 ${day.rain}%`));
        }
        row.append(cell);
    });
    host.replaceChildren(el('h2', 'panel-label', w.place), row);
}

/** Today and the six days after it: the week the Overview shows. */
function overviewDates() {
    const now = new Date();
    return Array.from({ length: 7 }, (_, k) => isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + k)));
}

/*
 * The week on the Overview: seven days from today, each with what is on the
 * calendar, what is for dinner and what is to be done.
 *
 * From today rather than from Sunday, so there is never a day gone by taking
 * up a column, and so each day lines up under its forecast. It is for looking:
 * events and dinners are changed on their own tabs. The one thing done here is
 * ticking off a reminder, which is what somebody walking past wants to do.
 * Late reminders are on today, as they are on the reminders tab.
 */
async function loadWeekOverview() {
    const host = $('week-overview');
    const today = isoDate(new Date());
    const dates = overviewDates();
    const range = `from=${dates[0]}&to=${dates[6]}`;
    let plan;
    let events;
    let tasks;
    try {
        [plan, events, tasks] = await Promise.all([
            api(`/api/plan?${range}`),
            api(`/api/events?${range}`),
            api(`/api/tasks?${range}&today=${today}`),
        ]);
    } catch {
        return host.replaceChildren(el('p', 'hint', 'The week could not be loaded.'));
    }
    const byDate = groupByDate(events.occurrences);
    $('week-overview-range').textContent = fmtWeekLabel(parseIso(dates[0]));

    host.replaceChildren(
        ...dates.map((date) => {
            const d = parseIso(date);
            const day = el('section', `wk-day${date === today ? ' is-today' : ''}`);
            const head = el('div', 'wk-head');
            head.append(
                el('span', 'wk-name', date === today ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' })),
                el('span', 'wk-num', String(d.getDate())),
            );
            const items = el('div', 'wk-items');
            items.append(...dayItems(date, { byDate, plan, tasks }));
            day.append(head, items);
            return day;
        }),
    );

    // Today again, beside the clock, where it can be read from across the
    // kitchen: the column for today is narrow, and today is what most of the
    // looking is for.
    const todayItems = dayItems(today, { byDate, plan, tasks });
    const list = el('div', 'ov-today-list');
    list.append(...todayItems);
    // Down one column and then the next, four to a column at least, so a
    // short day is one column and a long one splits evenly.
    list.style.setProperty('--rows', String(Math.max(4, Math.ceil(todayItems.length / 2))));
    $('ov-today').replaceChildren(el('h2', 'panel-label', 'Today'), list);
}

/** One day's events, dinner and reminders, as rows, for the week and for today. */
function dayItems(date, { byDate, plan, tasks }) {
    const out = [];
    for (const o of byDate.get(date) ?? []) {
        const row = el('div', `wk-event${o.allDay ? ' is-allday' : ''}`);
        row.style.setProperty('--ev', eventColour(o));
        if (!o.allDay) row.append(el('span', 'wk-time', fmtTime(o.start)));
        row.append(el('span', 'wk-title', o.title));
        row.title = `${whenText(o)} · ${o.title}`;
        out.push(row);
    }

    const meal = mealById(plan.days.find((p) => p.date === date)?.slots?.dinner);
    const dinner = el('div', `wk-dinner${meal ? '' : ' is-empty'}`);
    dinner.append(el('span', 'wk-dinner-icon', '🍽'), el('span', 'wk-title', meal ? meal.name : 'No dinner yet'));
    out.push(dinner);

    for (const t of tasks.days[date] ?? []) {
        const row = el('button', `wk-rem${t.done ? ' is-done' : ''}${t.overdue ? ' is-late' : ''}`);
        row.type = 'button';
        row.style.setProperty('--who', choreColour(t));
        row.dataset.task = t.id;
        row.dataset.date = date;
        row.dataset.done = String(t.done);
        row.setAttribute('aria-pressed', String(t.done));
        row.append(el('span', 'wk-box'), el('span', 'wk-title', t.title));
        if (t.time && !t.done) row.append(el('span', 'wk-time', fmtTime(t.time)));
        out.push(row);
    }
    return out;
}

async function onWeekOverviewClick(e) {
    const rem = e.target.closest('.wk-rem');
    if (!rem) return;
    const done = rem.dataset.done !== 'true';
    // Ticked on screen at once, as the reminder lists are.
    rem.classList.toggle('is-done', done);
    try {
        await api(`/api/tasks/${rem.dataset.task}/done`, {
            method: 'POST',
            body: { date: rem.dataset.date, today: isoDate(new Date()), done },
        });
    } catch (ex) {
        toast(ex.message);
    }
    await refreshChores();
}


// --------------------------------------------------------------- settings --

function renderSettings() {
    renderMembers();
    renderWeatherSettings();
    renderAccountSettings();
    renderThemes();
}

async function loadMembers() {
    const { members, colours } = await api('/api/members');
    state.members = members;
    state.memberColours = colours;
}

async function loadSettings() {
    const { settings } = await api('/api/settings');
    state.settings = settings;
}

const memberById = (id) => state.members.find((m) => m.id === id) || null;

/*
 * Text that stays readable on any of the family colours: whichever of white or
 * near-black stands out more from it. Lime and amber need dark text and blue
 * and purple need light, and guessing by name gets that wrong.
 */
function inkOn(hex) {
    const lum = (h) => {
        const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
            .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    };
    const L = lum(hex);
    return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.0555) ? '#ffffff' : '#0b1220';
}

function avatar(member, className = 'avatar') {
    const a = el('span', className, (member.name.trim()[0] || '?').toUpperCase());
    a.style.background = member.colour;
    a.style.color = inkOn(member.colour);
    a.setAttribute('aria-hidden', 'true');
    return a;
}

function renderMembers() {
    const host = $('member-list');
    if (!state.members.length) {
        return host.replaceChildren(el('div', 'empty', 'Nobody yet. Add the people in the house, and give each one a colour.'));
    }
    host.replaceChildren(
        ...state.members.map((m) => {
            const row = el('button', 'member-row');
            row.type = 'button';
            row.dataset.member = m.id;
            row.append(avatar(m), el('span', 'member-name', m.name), el('span', 'slot-chevron', '›'));
            return row;
        }),
    );
}

let editingMember = null;

function openMemberEditor(member) {
    editingMember = member;
    $('member-title').textContent = member ? `Edit ${member.name}` : 'Add someone';
    $('member-name').value = member?.name ?? '';
    $('member-error').hidden = true;
    $('member-delete').hidden = !member;

    // A colour someone else already has is still offered -- twins in matching
    // colours is a choice -- but the first free one is picked for a new person.
    const taken = new Set(state.members.filter((m) => m.id !== member?.id).map((m) => m.colour));
    const chosen = member?.colour ?? state.memberColours.find((c) => !taken.has(c)) ?? state.memberColours[0];
    const host = $('member-colours');
    host.querySelectorAll('label').forEach((n) => n.remove());
    for (const colour of state.memberColours) {
        const label = el('label', 'swatch');
        const input = el('input');
        input.type = 'radio';
        input.name = 'member-colour';
        input.value = colour;
        input.checked = colour === chosen;
        const dot = el('span', 'swatch-dot');
        dot.style.background = colour;
        label.title = taken.has(colour) ? 'Someone else has this colour' : '';
        label.append(input, dot);
        host.append(label);
    }
    $('member-editor').showModal();
    $('member-name').focus();
}

async function saveMember(event) {
    event.preventDefault();
    const err = $('member-error');
    err.hidden = true;
    const body = {
        name: $('member-name').value,
        colour: document.querySelector('input[name="member-colour"]:checked')?.value,
    };
    try {
        if (editingMember) await api(`/api/members/${editingMember.id}`, { method: 'PUT', body });
        else await api('/api/members', { method: 'POST', body });
        $('member-editor').close();
        await loadMembers();
        renderMembers();
    } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
    }
}

async function removeMember() {
    const member = editingMember;
    if (!member) return;
    const sure = await askConfirm({
        title: `Remove ${member.name}?`,
        body: 'Anything that was theirs stays, and becomes everybody\'s instead.',
        confirmLabel: 'Remove',
        danger: true,
    });
    if (!sure) return;
    try {
        await api(`/api/members/${member.id}`, { method: 'DELETE' });
        $('member-editor').close();
        await loadMembers();
        renderMembers();
    } catch (e) {
        toast(e.message);
    }
}

function renderWeatherSettings() {
    const place = state.settings?.location?.name;
    $('weather-place').textContent = place
        ? `Showing the weather for ${place}.`
        : 'No town chosen yet. Search for yours and pick it from the list.';
    for (const b of document.querySelectorAll('#units [data-units]')) {
        const on = b.dataset.units === state.settings?.units;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', String(on));
    }
}

async function searchPlaces(event) {
    event.preventDefault();
    const q = $('place-search').value.trim();
    const host = $('place-results');
    if (q.length < 2) return host.replaceChildren(el('p', 'hint', 'Type at least two letters of the town.'));
    host.replaceChildren(el('p', 'hint', 'Searching…'));
    try {
        const { places } = await api(`/api/weather/places?q=${encodeURIComponent(q)}`);
        if (!places.length) return host.replaceChildren(el('p', 'hint', `Nothing found for "${q}". Try the nearest larger town.`));
        host.replaceChildren(
            ...places.map((place) => {
                const b = el('button', 'picker-row', place.name);
                b.type = 'button';
                b.addEventListener('click', () => choosePlace(place));
                return b;
            }),
        );
    } catch (e) {
        host.replaceChildren(el('p', 'error', e.message));
    }
}

async function choosePlace(place) {
    try {
        const { settings } = await api('/api/settings', { method: 'PUT', body: { location: place } });
        state.settings = settings;
        $('place-results').replaceChildren();
        $('place-search').value = '';
        renderWeatherSettings();
        toast(`Weather set to ${place.name}`);
    } catch (e) {
        toast(e.message);
    }
}

async function chooseUnits(units) {
    try {
        const { settings } = await api('/api/settings', { method: 'PUT', body: { units } });
        state.settings = settings;
        renderWeatherSettings();
    } catch (e) {
        toast(e.message);
    }
}

// ------------------------------------------------------------ on iPhone --

/** Whether a host name only means anything on the home network. */
function localOnly(hostname) {
    return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith('[') ||
        hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.localhost') || !hostname.includes('.');
}

/*
 * The calendar account: where a phone finds it, and what to type.
 *
 * The address is the hub's public one whenever the hub knows it -- the server
 * notes it the first time somebody signed in opens the hub there -- because
 * that is the one that works away from home and over https. Only before then
 * is it the address this page happens to be open at.
 */
function renderAccountSettings() {
    const origin = state.settings?.publicOrigin ?? location.origin;
    const url = new URL(origin);
    $('account-url').value = `${origin}/dav/`;
    $('account-ssl').hidden = url.protocol === 'https:';
    $('account-password').textContent = state.passwordRequired === false ? 'anything (Family Hub has no password yet)' : 'the family password';
    const local = localOnly(url.hostname);
    $('account-local').hidden = !local;
    if (local) {
        $('account-local').textContent =
            `This is the home address ${url.host}, so a phone set up with it only syncs on your home Wi-Fi. ` +
            'Open Family Hub once at its public address and this changes to that one, which works anywhere.';
    }
}

/*
 * Copied with the clipboard where the browser allows it, which is only on
 * https or localhost; at a home address over plain http it falls back to
 * selecting the text so a long press can copy it.
 */
async function copyField(input) {
    try {
        await navigator.clipboard.writeText(input.value);
        toast('Copied');
    } catch {
        input.focus();
        input.select();
        toast(document.execCommand?.('copy') ? 'Copied' : 'Selected: copy it from the menu');
    }
}

// --------------------------------------------------------------- themes ----

/*
 * One card per theme, drawn from the same table that applies them.
 *
 * Each card is a small mock of the app in that theme -- a page, a card on it
 * with a meal name, and a button -- rather than a row of swatches. Five hex
 * colours side by side do not tell anybody what the Plan tab will look like;
 * a miniature of the Plan tab does.
 */
function themeCard(theme, active) {
    const t = theme.t;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `theme-card${active ? ' is-active' : ''}`;
    card.dataset.theme = theme.id;
    card.setAttribute('aria-pressed', String(active));

    const preview = document.createElement('span');
    preview.className = 'theme-preview';
    preview.style.background = `${t.grad}, ${t.bg}`;
    preview.style.borderColor = t.line;

    const panel = document.createElement('span');
    panel.className = 'tp-panel';
    panel.style.background = t.panel;
    panel.style.borderColor = t.line;
    const day = document.createElement('span');
    day.className = 'tp-day';
    day.style.color = t.muted;
    day.textContent = 'Friday';
    const meal = document.createElement('span');
    meal.className = 'tp-meal';
    meal.style.color = t.dinner;
    meal.textContent = 'Tacos';
    panel.append(day, meal);

    const button = document.createElement('span');
    button.className = 'tp-button';
    button.style.background = `linear-gradient(180deg, ${t.btnTop}, ${t.btnBottom})`;
    button.style.color = t.onPrimary;
    button.textContent = 'Random';

    preview.append(panel, button);
    if (theme.mark) {
        const mark = document.createElement('span');
        mark.className = 'tp-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = theme.mark;
        preview.append(mark);
    }

    const label = document.createElement('span');
    label.className = 'theme-label';
    const name = document.createElement('span');
    name.className = 'theme-name';
    name.textContent = theme.motif ? `${theme.motif} ${theme.name}` : theme.name;
    label.append(name);
    if (theme.note) {
        const note = document.createElement('span');
        note.className = 'theme-note';
        note.textContent = theme.note;
        label.append(note);
    }

    card.append(preview, label);
    return card;
}

function renderThemes() {
    const current = readSavedTheme();
    for (const group of ['colour', 'holiday']) {
        const host = $(`theme-grid-${group}`);
        host.innerHTML = '';
        for (const theme of THEMES.filter((x) => x.group === group)) {
            host.append(themeCard(theme, theme.id === current));
        }
    }
}

function chooseTheme(id) {
    const theme = applyTheme(id);
    saveTheme(theme.id);
    // Only the pressed state changes; redrawing the cards would reset the
    // scroll position of a page that is mostly cards.
    for (const card of document.querySelectorAll('.theme-card')) {
        const on = card.dataset.theme === theme.id;
        card.classList.toggle('is-active', on);
        card.setAttribute('aria-pressed', String(on));
    }
}

// --------------------------------------------------------------- wiring ----

/** Steps whichever period the current view is showing. */
function step(dir) {
    if (state.view === 'tasks') {
        state.taskDay = addDays(state.taskDay, dir);
        showTaskDay();
        loadChores();
        return;
    }
    if (state.view === 'cal') {
        if (state.calScope === 'week') {
            const nextWeek = new Date(state.weekStart);
            nextWeek.setDate(nextWeek.getDate() + dir * 7);
            state.weekStart = nextWeek;
            loadCalendar().catch((e) => toast(e.message));
            return;
        }
        const next = new Date(state.monthStart);
        // Set the day first: stepping from the 31st into a 30-day month would
        // otherwise roll over into the one after it.
        next.setDate(1);
        next.setMonth(next.getMonth() + dir);
        state.monthStart = next;
        loadCalendar().catch((e) => toast(e.message));
        return;
    }
    const next = new Date(state.weekStart);
    next.setDate(next.getDate() + dir * 7);
    state.weekStart = next;
    loadWeek();
}

$('gate-form').addEventListener('submit', signIn);

for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
}
for (const b of document.querySelectorAll('#food-tabs [data-sub]')) {
    b.addEventListener('click', () => setView(b.dataset.sub));
}

// --- tasks ---
$('chore-board').addEventListener('click', onChoreClick);
$('week-overview').addEventListener('click', onWeekOverviewClick);
$('ov-today').addEventListener('click', onWeekOverviewClick);
$('btn-add-task').addEventListener('click', () => openTaskEditor(null, { date: state.taskDay }));
$('task-form').addEventListener('submit', saveTask);
$('task-close').addEventListener('click', () => $('task-editor').close());
$('tk-repeat').addEventListener('click', (e) => {
    const b = e.target.closest('[data-repeat]');
    if (b) setTaskRepeat(b.dataset.repeat);
});
$('tk-date').addEventListener('change', taskFieldsShown);
$('tk-every').addEventListener('input', taskFieldsShown);
$('tk-days').addEventListener('change', () => { $('task-error').hidden = true; });
$('tk-delete').addEventListener('click', deleteTask);

// --- settings: the iPhone link ---
$('btn-account-copy').addEventListener('click', () => copyField($('account-url')));

// --- settings: family and weather ---
$('btn-add-member').addEventListener('click', () => openMemberEditor(null));

// --- events ---
const fromRow = (row) => openEventEditor(row.dataset.event, { occurrence: row.dataset.occurrence });
// Like the picker, the day sheet makes way rather than stacking a sheet on a
// sheet, which a phone has no room for.
$('day-events').addEventListener('click', (e) => {
    const row = e.target.closest('.event-row');
    if (!row) return;
    $('day').close();
    fromRow(row);
});
$('day-add-event').addEventListener('click', () => {
    const date = state.dayOpen;
    $('day').close();
    openEventEditor(null, { date });
});
$('event-form').addEventListener('submit', saveEvent);
$('event-close').addEventListener('click', () => $('event-editor').close());
$('ev-allday').addEventListener('change', eventFieldsShown);
$('ev-repeat').addEventListener('change', eventFieldsShown);
$('ev-alert').addEventListener('change', eventFieldsShown);
$('ev-delete').addEventListener('click', () => deleteEvent(false));
$('ev-delete-one').addEventListener('click', () => deleteEvent(true));
$('member-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-member]');
    if (row) openMemberEditor(memberById(row.dataset.member));
});
$('member-form').addEventListener('submit', saveMember);
$('member-close').addEventListener('click', () => $('member-editor').close());
$('member-delete').addEventListener('click', removeMember);
$('place-form').addEventListener('submit', searchPlaces);
for (const b of document.querySelectorAll('#units [data-units]')) {
    b.addEventListener('click', () => chooseUnits(b.dataset.units));
}

$('week-prev').addEventListener('click', () => step(-1));
$('week-next').addEventListener('click', () => step(1));
$('btn-today').addEventListener('click', () => {
    if (state.view === 'cal') {
        // Switches between the month and a single week, and lands on the
        // current one either way -- so it doubles as the way back to today
        // after stepping off into March.
        state.calScope = state.calScope === 'month' ? 'week' : 'month';
        state.monthStart = monthStart(new Date());
        state.weekStart = weekStart(new Date());
        $('btn-today').textContent = state.calScope === 'month' ? 'Week view' : 'Month view';
        loadCalendar().catch((e) => toast(e.message));
        return;
    }
    if (state.view === 'tasks') {
        state.taskDay = isoDate(new Date());
        showTaskDay();
        loadChores();
        return;
    }
    state.weekStart = weekStart(new Date());
    loadWeek();
});

// Delegated: the rows are rebuilt on every render, so listeners on them would
// have to be rebuilt too.
$('days').addEventListener('click', (e) => {
    const row = e.target.closest('.slot-row');
    if (row) openPicker(row.dataset.date, row.dataset.slot);
});

$('meal-list').addEventListener('click', (e) => {
    const card = e.target.closest('[data-meal]');
    if (card) openEditor(mealById(card.dataset.meal));
});

$('cal-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-day');
    if (cell) openDay(cell.dataset.date);
});

// The day sheet closes before the picker opens: two stacked modals on a phone
// leave no room for either, and coming back to the sheet afterwards would show
// the value it was opened with rather than the one just chosen.
$('day-slots').addEventListener('click', (e) => {
    const row = e.target.closest('.day-slot');
    if (!row) return;
    $('day').close();
    openPicker(row.dataset.date, row.dataset.slot);
});
$('day-close').addEventListener('click', () => $('day').close());

$('meal-bar').addEventListener('submit', quickAddMeal);
$('meal-input').addEventListener('input', () => { if (mealSearching) renderMeals(); });
$('btn-search-meals').addEventListener('click', () => setMealSearch(!mealSearching));

$('view-settings').addEventListener('click', (e) => {
    const card = e.target.closest('.theme-card');
    if (card) chooseTheme(card.dataset.theme);
});

$('picker-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-pick]');
    if (row) pick(row.dataset.pick);
});
$('picker-search').addEventListener('input', () => {
    const { date, slot } = state.picking;
    renderPicker(plannedAt(date, slot));
});
$('picker-clear').addEventListener('click', () => pick(null));
$('picker-close').addEventListener('click', () => $('picker').close());

$('editor-form').addEventListener('submit', saveMeal);
$('editor-close').addEventListener('click', () => $('editor').close());
$('ed-delete').addEventListener('click', deleteMeal);

$('btn-random').addEventListener('click', openRandomer);
$('btn-clear').addEventListener('click', clearWeek);
$('randomer-form').addEventListener('submit', runRandom);
$('randomer-close').addEventListener('click', () => $('randomer').close());

// ----------------------------------------------------------------- boot ----

(async function boot() {
    state.weekStart = weekStart(new Date());
    state.monthStart = monthStart(new Date());
    state.taskDay = isoDate(new Date());
    try {
        const session = await fetch('/api/session').then((r) => r.json());
        if (session.passwordUnusable) {
            showGate();
            $('gate-error').textContent =
                'The stored password cannot be read, so no password will work. Whoever set this up needs to set it again.';
            $('gate-error').hidden = false;
            return;
        }
        if (!session.authenticated) return showGate();
        state.passwordRequired = session.required;
        $('gate').hidden = true;
        $('app').hidden = false;
        await loadAll();
        setView('today');
    } catch {
        showGate();
    }
})();

// A pass-through service worker: registered so the app is installable, and
// caching nothing, because a meal plan that shows yesterday's answer from a
// cache is worse than one that says it cannot reach the server.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
