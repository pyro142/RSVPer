// Guest list import: CSV, one row per named guest, grouped by household.
//
//   household,guest,plus_one,max_party_size,evening
//   The Example Family,Pat Example,no,3,no
//   The Example Family,Chris Example,yes,,
//
// Only `household` and `guest` are required. `max_party_size` defaults to the
// named guests plus their permitted plus ones. See examples/guests.csv.

import { parseCsv } from './csv';
import { validateHousehold, type HouseholdInput } from './households';

export const MAX_IMPORT_HOUSEHOLDS = 300;

const HEADER_ALIASES: Record<string, string> = {
  household: 'household',
  'household name': 'household',
  household_name: 'household',
  guest: 'guest',
  'guest name': 'guest',
  guest_name: 'guest',
  name: 'guest',
  plus_one: 'plus_one',
  'plus one': 'plus_one',
  plusone: 'plus_one',
  '+1': 'plus_one',
  max_party_size: 'max_party_size',
  'max party size': 'max_party_size',
  max: 'max_party_size',
  evening: 'evening',
  reception_only: 'evening',
  'evening only': 'evening',
};

export interface ImportRowError {
  line: number;
  error: string;
}

export interface ImportResult {
  households: (HouseholdInput & { lines: number[] })[];
  errors: ImportRowError[];
}

function yes(value: string | undefined): boolean | null {
  const v = (value ?? '').trim().toLowerCase();
  if (['', 'no', 'n', 'false', '0', '-'].includes(v)) return false;
  if (['yes', 'y', 'true', '1', '+1', 'x'].includes(v)) return true;
  return null;
}

export function parseGuestCsv(text: string, opts: { eveningEnabled: boolean }): ImportResult {
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (err) {
    return { households: [], errors: [{ line: 0, error: (err as Error).message }] };
  }
  if (rows.length === 0)
    return { households: [], errors: [{ line: 0, error: 'The file is empty.' }] };

  const header = rows[0]!.map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? '');
  const col = (name: string) => header.indexOf(name);
  if (col('household') === -1 || col('guest') === -1) {
    return {
      households: [],
      errors: [
        { line: 1, error: 'The first row must be a header with "household" and "guest" columns.' },
      ],
    };
  }

  const errors: ImportRowError[] = [];
  const groups = new Map<
    string,
    {
      name: string;
      lines: number[];
      guests: { name: string; allows_plus_one: boolean }[];
      max: Set<string>;
      evening: Set<boolean>;
    }
  >();

  rows.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const get = (name: string) => {
      const i = col(name);
      return i === -1 ? '' : (cells[i] ?? '').trim();
    };
    const household = get('household');
    const guest = get('guest');
    if (!household && !guest) return; // blank row
    if (!household) return void errors.push({ line, error: 'Missing household.' });
    if (!guest) return void errors.push({ line, error: 'Missing guest name.' });

    const plusOne = yes(get('plus_one'));
    if (plusOne === null) return void errors.push({ line, error: 'plus_one must be yes or no.' });
    const evening = yes(get('evening'));
    if (evening === null) return void errors.push({ line, error: 'evening must be yes or no.' });
    if (evening && !opts.eveningEnabled) {
      return void errors.push({
        line,
        error: 'Evening invites are turned off. Turn them on in Settings first.',
      });
    }

    const key = household.toLowerCase().replace(/\s+/g, ' ');
    let group = groups.get(key);
    if (!group) {
      group = { name: household, lines: [], guests: [], max: new Set(), evening: new Set() };
      groups.set(key, group);
    }
    group.lines.push(line);
    group.guests.push({ name: guest, allows_plus_one: plusOne });
    const max = get('max_party_size');
    if (max) group.max.add(max);
    group.evening.add(evening);
  });

  if (groups.size > MAX_IMPORT_HOUSEHOLDS) {
    errors.push({ line: 0, error: `At most ${MAX_IMPORT_HOUSEHOLDS} households per import.` });
  }

  const households: ImportResult['households'] = [];
  for (const group of groups.values()) {
    const first = group.lines[0]!;
    if (group.max.size > 1) {
      errors.push({ line: first, error: `"${group.name}" has different max_party_size values.` });
      continue;
    }
    if (group.evening.size > 1) {
      errors.push({ line: first, error: `"${group.name}" has mixed evening values.` });
      continue;
    }
    const [max] = [...group.max];
    const result = validateHousehold({
      household_name: group.name,
      max_party_size: max === undefined ? undefined : Number(max),
      reception_only: [...group.evening][0] === true,
      guests: group.guests,
    });
    if ('error' in result) {
      errors.push({ line: first, error: `"${group.name}": ${result.error}` });
      continue;
    }
    households.push({ ...result.value, lines: group.lines });
  }

  errors.sort((a, b) => a.line - b.line);
  return { households, errors };
}
