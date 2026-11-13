import crypto from 'node:crypto';
import { dataPath, readJson, writeJson } from './store.js';

/*
 * The people in the house.
 *
 * Each one is a name and a colour. The colour is what lets the calendar and
 * the chore chart answer "whose is this?" at a glance from across a kitchen,
 * which is most of what makes a family board readable at all -- a column of
 * black text titles is a list, a column of coloured ones is a household.
 */

const FILE = dataPath('members.json');

/*
 * Picked from a fixed set rather than a free colour picker.
 *
 * Ten that stay distinct from each other and readable as a dot, a border or an
 * avatar on every theme, light or dark. A free picker gets two people who both
 * chose "blue" and a calendar where they cannot be told apart.
 */
export const MEMBER_COLOURS = [
    '#3b82f6', // blue
    '#ef4444', // red
    '#22c55e', // green
    '#f59e0b', // amber
    '#a855f7', // purple
    '#ec4899', // pink
    '#14b8a6', // teal
    '#f97316', // orange
    '#84cc16', // lime
    '#64748b', // slate
];

const MAX_MEMBERS = 12;

export const loadMembers = () => readJson(FILE, []);
export const saveMembers = (list) => writeJson(FILE, list);

const newId = () => `p_${crypto.randomBytes(6).toString('hex')}`;

/** The first colour nobody is using yet, so a new person is never a repeat by default. */
export function nextColour(members) {
    const used = new Set(members.map((m) => m.colour));
    return MEMBER_COLOURS.find((c) => !used.has(c)) ?? MEMBER_COLOURS[members.length % MEMBER_COLOURS.length];
}

export function normaliseMember(input, members, existing = null) {
    const errors = [];
    const name = String(input.name ?? '').trim();
    if (!name) errors.push('Give them a name.');
    if (name.length > 40) errors.push('That name is too long.');
    if (!existing && members.length >= MAX_MEMBERS) errors.push(`A household here tops out at ${MAX_MEMBERS} people.`);

    const others = members.filter((m) => m.id !== existing?.id);
    const clash = name && others.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (clash) errors.push(`There is already someone called ${clash.name}.`);

    const colour = MEMBER_COLOURS.includes(input.colour) ? input.colour : existing?.colour ?? nextColour(others);

    return {
        member: {
            id: existing?.id ?? newId(),
            name,
            colour,
            createdAt: existing?.createdAt ?? new Date().toISOString(),
        },
        errors,
    };
}
