import { dataPath, readJson, writeJson } from './store.js';

/*
 * The household's settings: where it is, for the weather, and which units.
 *
 * Stored on the server rather than per device like the theme, because these
 * are facts about the house rather than preferences of whoever is holding the
 * iPad: everybody's weather should be for the same town.
 */

const FILE = dataPath('settings.json');

const DEFAULTS = {
    // { name, lat, lon } once somebody has picked a town.
    location: null,
    units: 'fahrenheit',
    // The hub's public address, once it has been opened there: what phones
    // are told to use for the calendar account. See publicOrigin in server.js.
    publicOrigin: null,
    // The colour and place in the list a phone gave each calendar of the
    // calendar account, keyed "events" or a reminders list's key. See
    // proppatch in lib/caldav.js.
    calendarLooks: {},
};

/* What the read-only calendar link used to keep, dropped the next time the
   settings are saved: the link is gone, and its token with it. */
const RETIRED = ['feedToken', 'feedDinners', 'feedChores'];

export const UNITS = ['fahrenheit', 'celsius'];

export function loadSettings() {
    const saved = readJson(FILE, {});
    for (const key of RETIRED) delete saved[key];
    return { ...DEFAULTS, ...saved };
}

export function saveSettings(next) {
    writeJson(FILE, { ...loadSettings(), ...next });
    return loadSettings();
}

/** A place from the town search, checked before it is kept. */
export function normaliseLocation(input) {
    const lat = Number(input?.lat);
    const lon = Number(input?.lon);
    const name = String(input?.name ?? '').trim().slice(0, 120);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return null;
    }
    // These are the town's own coordinates from the search, never the house's.
    // Two decimal places is about a kilometre -- far finer than a forecast
    // needs, and nothing more precise is worth sending to a weather service.
    return { name, lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}
