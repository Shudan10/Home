/*
 * The weather, from Open-Meteo.
 *
 * Free and needs no account or key, which matters for something a household
 * sets up once and forgets: a key would be one more thing to expire. Asked
 * from here rather than from each device, so the town is set once for the
 * house, the answer is shared, and only the server talks to the outside.
 *
 * Only the town's coordinates leave the house -- never anything about who
 * lives in it.
 */

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';

/*
 * Kept for a quarter of an hour.
 *
 * The forecast does not change faster than that, the wall iPad asks every few
 * minutes, and four phones opening the app at breakfast should not be four
 * requests to somebody else's free service.
 */
const TTL_MS = 15 * 60_000;
let cache = { key: null, at: 0, value: null };

async function getJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`The weather service answered ${res.status}.`);
    return res.json();
}

/** Towns matching what was typed, for the settings search. */
export async function searchPlaces(query) {
    const q = String(query ?? '').trim();
    if (q.length < 2) return [];
    const url = `${GEOCODE}?name=${encodeURIComponent(q.slice(0, 80))}&count=6&language=en&format=json`;
    const data = await getJson(url);
    // An empty search has no `results` key at all rather than an empty list.
    return (data.results ?? []).map((r) => ({
        name: [r.name, r.admin1, r.country_code === 'US' ? null : r.country].filter(Boolean).join(', '),
        lat: r.latitude,
        lon: r.longitude,
    }));
}

/**
 * Now and the week ahead for a place: today and the six days after it.
 *
 * `timezone=auto` makes "today" the town's today rather than the server's,
 * which runs on UTC: without it the forecast rolls over to tomorrow at seven
 * in the evening on the east coast.
 */
export async function forecast(location, units = 'fahrenheit') {
    const key = `${location.lat},${location.lon},${units}`;
    if (cache.key === key && Date.now() - cache.at < TTL_MS) return cache.value;

    const params = new URLSearchParams({
        latitude: String(location.lat),
        longitude: String(location.lon),
        current: 'temperature_2m,weather_code,is_day',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        temperature_unit: units === 'celsius' ? 'celsius' : 'fahrenheit',
        timezone: 'auto',
        forecast_days: '7',
    });
    const data = await getJson(`${FORECAST}?${params}`);

    const d = data.daily ?? {};
    const value = {
        place: location.name,
        units: units === 'celsius' ? 'C' : 'F',
        current: {
            temp: Math.round(data.current?.temperature_2m),
            code: data.current?.weather_code,
            isDay: data.current?.is_day === 1,
        },
        days: (d.time ?? []).map((date, i) => ({
            date,
            code: d.weather_code?.[i],
            high: Math.round(d.temperature_2m_max?.[i]),
            low: Math.round(d.temperature_2m_min?.[i]),
            rain: d.precipitation_probability_max?.[i] ?? null,
        })),
        fetchedAt: new Date().toISOString(),
    };
    cache = { key, at: Date.now(), value };
    return value;
}

/** Forgets the cached forecast, for when the town or the units change. */
export const forgetForecast = () => {
    cache = { key: null, at: 0, value: null };
};
