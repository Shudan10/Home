'use strict';

/*
 * The themes, and the one function that puts one on the page.
 *
 * Loaded in <head>, ahead of everything else, so a saved theme is in place
 * before the first paint. Loaded later, a Christmas iPad would flash blue on
 * every launch before turning green -- which on a home-screen app is every
 * time it is opened.
 *
 * This table is the only description of a theme. The picker draws its preview
 * cards from it and the tests read it to check every combination is legible,
 * so a theme cannot look one way in its card and another once applied.
 */

const THEME_KEY = 'mealplan.theme';

/** Which CSS custom property each token sets. */
const THEME_VARS = {
    bg: '--bg',
    grad: '--bg-grad',
    panel: '--panel',
    panel2: '--panel-2',
    line: '--line',
    text: '--text',
    muted: '--muted',
    accent: '--accent',
    accentDim: '--accent-dim',
    onAccent: '--on-accent',
    btnTop: '--btn-top',
    btnBottom: '--btn-bottom',
    onPrimary: '--on-primary',
    dinner: '--slot-dinner',
    dot: '--dot-dinner',
    glow: '--glow',
    shadow: '--shadow',
    danger: '--danger',
};

const DARK_SHADOW = '0 1px 2px rgba(0, 0, 0, 0.4), 0 10px 30px rgba(0, 0, 0, 0.45)';
const LIGHT_SHADOW = '0 1px 2px rgba(20, 20, 30, 0.06), 0 8px 24px rgba(20, 20, 30, 0.08)';

/** The soft glow at the top of the page, in a theme's own colour. */
const halo = (colour, top = '-240px') => `radial-gradient(1200px 600px at 50% ${top}, ${colour} 0%, transparent 70%)`;

const dark = (t) => ({ shadow: DARK_SHADOW, danger: '#ff6b62', ...t });
const light = (t) => ({ shadow: LIGHT_SHADOW, danger: '#c0372b', ...t });

const THEMES = [
    // ------------------------------------------------------------- colours --
    {
        id: 'blue',
        name: 'Blue',
        group: 'colour',
        // The original, and the only one that follows the device: dark when
        // the iPad is dark, light when it is light. Nothing is set inline, so
        // the stylesheet's own light and dark blocks decide. The tokens below
        // are only what its preview card shows.
        system: true,
        note: 'Follows the device, light or dark',
        scheme: 'dark',
        t: dark({
            bg: '#070e1f', grad: halo('#12275a'), panel: '#0f1a33', panel2: '#152445', line: '#22365f',
            text: '#e8efff', muted: '#91a4c8', accent: '#3b82f6', accentDim: '#27406e', onAccent: '#ffffff',
            btnTop: '#2563eb', btnBottom: '#1d4ed8', onPrimary: '#ffffff',
            dinner: '#60a5fa', dot: '#3b82f6', glow: 'rgba(37, 99, 235, 0.3)',
        }),
    },
    {
        id: 'black',
        name: 'Black',
        group: 'colour',
        scheme: 'dark',
        t: dark({
            bg: '#000000', grad: halo('#1c1c1f'), panel: '#0f0f11', panel2: '#18181b', line: '#2a2a2e',
            text: '#fafafa', muted: '#a1a1aa', accent: '#e4e4e7', accentDim: '#3f3f46', onAccent: '#09090b',
            btnTop: '#f4f4f5', btnBottom: '#a1a1aa', onPrimary: '#09090b',
            dinner: '#f4f4f5', dot: '#d4d4d8', glow: 'rgba(255, 255, 255, 0.12)',
        }),
    },
    {
        id: 'white',
        name: 'White',
        group: 'colour',
        scheme: 'light',
        t: light({
            bg: '#f6f6f7', grad: halo('#ffffff', '-200px'), panel: '#ffffff', panel2: '#f1f1f3', line: '#e2e2e6',
            text: '#111113', muted: '#5d5d68', accent: '#18181b', accentDim: '#a1a1aa', onAccent: '#ffffff',
            btnTop: '#3f3f46', btnBottom: '#09090b', onPrimary: '#ffffff',
            dinner: '#18181b', dot: '#3f3f46', glow: 'rgba(0, 0, 0, 0.18)',
        }),
    },
    {
        id: 'red',
        name: 'Red',
        group: 'colour',
        scheme: 'dark',
        t: dark({
            bg: '#120606', grad: halo('#4a1010'), panel: '#1d0a0a', panel2: '#280e0e', line: '#401818',
            text: '#fdeeee', muted: '#cfa3a3', accent: '#f87171', accentDim: '#5c1f1f', onAccent: '#1d0a0a',
            btnTop: '#dc2626', btnBottom: '#991b1b', onPrimary: '#ffffff',
            dinner: '#fca5a5', dot: '#f87171', glow: 'rgba(220, 38, 38, 0.35)',
        }),
    },
    {
        id: 'green',
        name: 'Green',
        group: 'colour',
        scheme: 'dark',
        t: dark({
            bg: '#05110a', grad: halo('#0f3d22'), panel: '#0a1c11', panel2: '#0f2718', line: '#1a3d28',
            text: '#eafaf0', muted: '#9cc4ab', accent: '#4ade80', accentDim: '#1f5c36', onAccent: '#05110a',
            btnTop: '#15803d', btnBottom: '#166534', onPrimary: '#ffffff',
            dinner: '#86efac', dot: '#4ade80', glow: 'rgba(22, 163, 74, 0.35)',
        }),
    },
    {
        id: 'purple',
        name: 'Purple',
        group: 'colour',
        scheme: 'dark',
        t: dark({
            bg: '#0d0819', grad: halo('#2e1a5c'), panel: '#171030', panel2: '#1f163d', line: '#322659',
            text: '#f5f3ff', muted: '#b3a7d6', accent: '#a78bfa', accentDim: '#3f2f73', onAccent: '#0d0819',
            btnTop: '#7c3aed', btnBottom: '#5b21b6', onPrimary: '#ffffff',
            dinner: '#c4b5fd', dot: '#a78bfa', glow: 'rgba(124, 58, 237, 0.38)',
        }),
    },
    {
        id: 'orange',
        name: 'Orange',
        group: 'colour',
        scheme: 'dark',
        t: dark({
            bg: '#140a03', grad: halo('#4a2208'), panel: '#211207', panel2: '#2c180a', line: '#462913',
            text: '#fff4ea', muted: '#d4b398', accent: '#fb923c', accentDim: '#5c3214', onAccent: '#140a03',
            btnTop: '#c2410c', btnBottom: '#9a3412', onPrimary: '#ffffff',
            dinner: '#fdba74', dot: '#fb923c', glow: 'rgba(234, 88, 12, 0.35)',
        }),
    },
    {
        id: 'pink',
        name: 'Pink',
        group: 'colour',
        scheme: 'dark',
        t: dark({
            bg: '#170811', grad: halo('#4d1636'), panel: '#250e1c', panel2: '#311226', line: '#4b1d3a',
            text: '#fdf2f8', muted: '#d6a6c1', accent: '#f472b6', accentDim: '#5e2148', onAccent: '#170811',
            btnTop: '#db2777', btnBottom: '#9d174d', onPrimary: '#ffffff',
            dinner: '#f9a8d4', dot: '#f472b6', glow: 'rgba(219, 39, 119, 0.35)',
        }),
    },
    {
        id: 'teal',
        name: 'Teal',
        group: 'colour',
        scheme: 'dark',
        t: dark({
            bg: '#03121a', grad: halo('#0b3b4a'), panel: '#071f29', panel2: '#0b2a36', line: '#154152',
            text: '#ecfeff', muted: '#9ac4ce', accent: '#2dd4bf', accentDim: '#11505a', onAccent: '#03121a',
            btnTop: '#0f766e', btnBottom: '#115e59', onPrimary: '#ffffff',
            dinner: '#5eead4', dot: '#2dd4bf', glow: 'rgba(13, 148, 136, 0.35)',
        }),
    },

    // ------------------------------------------------------------ holidays --
    // In calendar order. Each one carries a motif beside the page title and a
    // large faint mark in the corner of the screen -- enough to feel like the
    // season, not so much that it competes with the plan.
    {
        id: 'newyear',
        name: "New Year's",
        group: 'holiday',
        scheme: 'dark',
        motif: '🥂',
        mark: '🎆',
        t: dark({
            bg: '#080808', grad: halo('#3a2c0a'), panel: '#141312', panel2: '#1d1b18', line: '#332d1f',
            text: '#fdfaf0', muted: '#bcb092', accent: '#fbbf24', accentDim: '#5a4512', onAccent: '#141312',
            btnTop: '#fcd34d', btnBottom: '#f59e0b', onPrimary: '#1a1204',
            dinner: '#fcd34d', dot: '#fbbf24', glow: 'rgba(245, 158, 11, 0.32)',
        }),
    },
    {
        id: 'valentines',
        name: "Valentine's Day",
        group: 'holiday',
        scheme: 'dark',
        motif: '💝',
        mark: '❤️',
        t: dark({
            bg: '#17060e', grad: halo('#5c1030'), panel: '#240a17', panel2: '#300e1f', line: '#4a1830',
            text: '#fff0f6', muted: '#d9a6be', accent: '#fb7185', accentDim: '#5e1a32', onAccent: '#17060e',
            btnTop: '#e11d48', btnBottom: '#9f1239', onPrimary: '#ffffff',
            dinner: '#fda4af', dot: '#fb7185', glow: 'rgba(225, 29, 72, 0.38)',
        }),
    },
    {
        id: 'stpatricks',
        name: "St. Patrick's Day",
        group: 'holiday',
        scheme: 'dark',
        motif: '☘️',
        mark: '🍀',
        // Gold names on green: the pot at the end of it, and what keeps this
        // from being the plain Green theme with a clover stuck on.
        t: dark({
            bg: '#03140a', grad: halo('#14532d'), panel: '#072012', panel2: '#0b2c19', line: '#16432a',
            text: '#effcf3', muted: '#a0cfb1', accent: '#4ade80', accentDim: '#1a5c34', onAccent: '#03140a',
            btnTop: '#15803d', btnBottom: '#14532d', onPrimary: '#ffffff',
            dinner: '#fde68a', dot: '#fbbf24', glow: 'rgba(22, 163, 74, 0.38)',
        }),
    },
    {
        id: 'easter',
        name: 'Easter',
        group: 'holiday',
        // The one light holiday: pastels read as spring, and spring is not
        // dark at six in the evening.
        scheme: 'light',
        motif: '🐣',
        mark: '🥚',
        t: light({
            bg: '#fcf7ff', grad: halo('#fde7f3', '-200px'), panel: '#ffffff', panel2: '#f6eefc', line: '#eadcf5',
            text: '#2a1b3a', muted: '#6e5a84', accent: '#9333ea', accentDim: '#d8b4fe', onAccent: '#ffffff',
            btnTop: '#9333ea', btnBottom: '#7e22ce', onPrimary: '#ffffff',
            dinner: '#7e22ce', dot: '#a855f7', glow: 'rgba(168, 85, 247, 0.3)',
        }),
    },
    {
        id: 'fourth',
        name: 'Fourth of July',
        group: 'holiday',
        scheme: 'dark',
        motif: '🇺🇸',
        mark: '🎆',
        // Red buttons on navy, with the names in white.
        t: dark({
            bg: '#050d24', grad: halo('#5c1414'), panel: '#0b1736', panel2: '#111f44', line: '#1d3063',
            text: '#f8fafc', muted: '#a9b6d2', accent: '#f87171', accentDim: '#5c1f1f', onAccent: '#050d24',
            btnTop: '#dc2626', btnBottom: '#991b1b', onPrimary: '#ffffff',
            dinner: '#ffffff', dot: '#f87171', glow: 'rgba(220, 38, 38, 0.35)',
        }),
    },
    {
        id: 'halloween',
        name: 'Halloween',
        group: 'holiday',
        scheme: 'dark',
        motif: '🎃',
        mark: '🎃',
        t: dark({
            bg: '#0c0610', grad: halo('#3b1250'), panel: '#180d1e', panel2: '#221228', line: '#381e42',
            text: '#fff7ed', muted: '#c7a8bd', accent: '#fb923c', accentDim: '#5a2c14', onAccent: '#0c0610',
            btnTop: '#fb923c', btnBottom: '#ea580c', onPrimary: '#1c0a02',
            dinner: '#fdba74', dot: '#fb923c', glow: 'rgba(249, 115, 22, 0.38)',
        }),
    },
    {
        id: 'thanksgiving',
        name: 'Thanksgiving',
        group: 'holiday',
        scheme: 'dark',
        motif: '🦃',
        mark: '🍂',
        t: dark({
            bg: '#150c05', grad: halo('#4a2a0c'), panel: '#21140a', panel2: '#2c1b0d', line: '#462e18',
            text: '#fff7ed', muted: '#d0b297', accent: '#f59e0b', accentDim: '#5c3a0c', onAccent: '#150c05',
            btnTop: '#b45309', btnBottom: '#78350f', onPrimary: '#ffffff',
            dinner: '#fcd34d', dot: '#f59e0b', glow: 'rgba(217, 119, 6, 0.35)',
        }),
    },
    {
        id: 'hanukkah',
        name: 'Hanukkah',
        group: 'holiday',
        scheme: 'dark',
        motif: '🕎',
        mark: '🕎',
        t: dark({
            bg: '#060d24', grad: halo('#1e3a8a'), panel: '#0c1838', panel2: '#122046', line: '#1f3166',
            text: '#f1f5ff', muted: '#a9b6d8', accent: '#93c5fd', accentDim: '#24407a', onAccent: '#060d24',
            btnTop: '#2563eb', btnBottom: '#1e40af', onPrimary: '#ffffff',
            dinner: '#e0e7ff', dot: '#93c5fd', glow: 'rgba(37, 99, 235, 0.38)',
        }),
    },
    {
        id: 'christmas',
        name: 'Christmas',
        group: 'holiday',
        scheme: 'dark',
        motif: '🎄',
        mark: '🎄',
        // Green ground, red buttons, gold names.
        t: dark({
            bg: '#06170d', grad: halo('#5c1414'), panel: '#0b2415', panel2: '#10301d', line: '#1c4a2f',
            text: '#f4fbf6', muted: '#a8c9b3', accent: '#f87171', accentDim: '#5c1f1f', onAccent: '#06170d',
            btnTop: '#dc2626', btnBottom: '#991b1b', onPrimary: '#ffffff',
            dinner: '#fcd34d', dot: '#fcd34d', glow: 'rgba(220, 38, 38, 0.35)',
        }),
    },
];

const themeById = (id) => THEMES.find((theme) => theme.id === id) ?? THEMES[0];

/*
 * Saved in this browser, not on the server.
 *
 * Wrapped because private browsing and blocked site data make localStorage
 * throw rather than return nothing, and a theme that cannot be saved is no
 * reason for the app not to start.
 */
function readSavedTheme() {
    try {
        return localStorage.getItem(THEME_KEY) || 'blue';
    } catch {
        return 'blue';
    }
}

function saveTheme(id) {
    try {
        localStorage.setItem(THEME_KEY, id);
    } catch {
        /* the theme still applies, it just will not survive a reload */
    }
}

/** Puts a theme on the page. Every token is cleared first, so nothing from the
 *  previous theme can be left behind when the new one does not set it. */
function applyTheme(id) {
    const theme = themeById(id);
    const root = document.documentElement;

    for (const name of Object.values(THEME_VARS)) root.style.removeProperty(name);
    root.style.removeProperty('--theme-mark');
    root.style.removeProperty('--theme-motif');
    root.style.colorScheme = '';
    root.dataset.theme = theme.id;

    if (!theme.system) {
        for (const [key, value] of Object.entries(theme.t)) {
            if (THEME_VARS[key]) root.style.setProperty(THEME_VARS[key], value);
        }
        // So form controls and scrollbars match, not just our own colours.
        root.style.colorScheme = theme.scheme;
    }

    // JSON.stringify yields a quoted string, which is what `content:` wants.
    if (theme.mark) root.style.setProperty('--theme-mark', JSON.stringify(theme.mark));
    if (theme.motif) root.style.setProperty('--theme-motif', JSON.stringify(theme.motif));

    // The iOS status bar, which is otherwise left in the old colour.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme.system ? '#0b1b3a' : theme.t.bg;

    return theme;
}

applyTheme(readSavedTheme());
