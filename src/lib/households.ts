// Validation for households created or edited by the admin (form or import).

import { cleanLine } from './text';

export const MAX_NAME_LENGTH = 120;
export const MAX_PARTY_SIZE = 20;
export const MAX_GUESTS_PER_HOUSEHOLD = 20;

export interface HouseholdInput {
  household_name: string;
  max_party_size: number;
  reception_only: boolean;
  guests: { name: string; allows_plus_one: boolean }[];
}

export function seatsError(max: number, named: number, plusOnes: number): string {
  const namedPart = `${named} named guest${named === 1 ? '' : 's'}`;
  if (plusOnes === 0) return `Max party size (${max}) is smaller than the ${namedPart}`;
  const plusPart = `${plusOnes} plus one${plusOnes === 1 ? '' : 's'}`;
  return (
    `Max party size (${max}) is smaller than the ${namedPart} and ${plusPart} ` +
    `(${named + plusOnes} seats needed) — raise the cap or remove a plus one`
  );
}

/**
 * Validate one household. The cap must fit every named guest *and* every
 * permitted plus one, or the household would get a link it can't use.
 */
export function validateHousehold(input: unknown): { value: HouseholdInput } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'Malformed household' };
  const raw = input as Record<string, unknown>;

  const householdName = cleanLine(raw.household_name, MAX_NAME_LENGTH);
  if (!householdName) {
    return {
      error:
        typeof raw.household_name === 'string' && raw.household_name.trim()
          ? `Household name must be under ${MAX_NAME_LENGTH} characters`
          : 'Household name is required',
    };
  }

  if (!Array.isArray(raw.guests) || raw.guests.length === 0) {
    return { error: 'At least one named guest is required' };
  }
  if (raw.guests.length > MAX_GUESTS_PER_HOUSEHOLD) {
    return { error: `At most ${MAX_GUESTS_PER_HOUSEHOLD} guests per household` };
  }

  const guests: HouseholdInput['guests'] = [];
  const seen = new Set<string>();
  for (const g of raw.guests as unknown[]) {
    const gr = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>;
    const name = cleanLine(gr.name, MAX_NAME_LENGTH);
    if (!name) return { error: 'Every guest needs a name (under 120 characters)' };
    const key = name.toLowerCase();
    if (seen.has(key)) return { error: `"${name}" is listed twice` };
    seen.add(key);
    guests.push({ name, allows_plus_one: gr.allows_plus_one === true });
  }

  const plusOnes = guests.filter((g) => g.allows_plus_one).length;
  const minimumSeats = guests.length + plusOnes;
  const max =
    raw.max_party_size === undefined || raw.max_party_size === null || raw.max_party_size === ''
      ? minimumSeats
      : Number(raw.max_party_size);
  if (!Number.isInteger(max) || max < 1 || max > MAX_PARTY_SIZE) {
    return { error: `Max party size must be a whole number between 1 and ${MAX_PARTY_SIZE}` };
  }
  if (max < minimumSeats) return { error: seatsError(max, guests.length, plusOnes) };

  return {
    value: {
      household_name: householdName,
      max_party_size: max,
      reception_only: raw.reception_only === true,
      guests,
    },
  };
}
