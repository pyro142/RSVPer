// Wedding settings: every couple-specific value the app shows, plus feature
// toggles and advanced security knobs.
//
// Stored in D1 as one JSON document per section (settings table, keyed by
// wedding_id + section). Reads merge stored values over DEFAULTS, so a new
// setting added in a later release just appears with its default — no
// migration needed. Writes are validated section by section; nothing reaches
// the database without passing through `validateSection`.

import { cleanBlock, cleanLine } from './lib/text';
import fonts from './fonts.json';

export const FONT_PAIRS = fonts.pairs;

export interface Settings {
  couple: {
    name_one: string;
    name_two: string;
    joiner: string;
  };
  event: {
    /** YYYY-MM-DD */
    date: string | null;
    /** IANA time zone, used for the RSVP deadline and date display. */
    timezone: string;
    /** BCP 47 locale for formatting dates and times, e.g. en-GB, en-US. */
    locale: string;
    /** HH:MM, 24-hour. */
    ceremony_time: string | null;
    reception_time: string | null;
  };
  venue: {
    name: string;
    address: string;
    /** Optional https link to a map. */
    map_url: string | null;
  };
  rsvp: {
    /** YYYY-MM-DD, inclusive, in event.timezone. Null = no deadline. */
    deadline: string | null;
    /** Contact line shown to guests who need to change a reply. */
    contact: string;
  };
  copy: {
    headline: string;
    code_prompt: string;
    code_help: string;
    /** May contain {date}. */
    intro: string;
    accept_label: string;
    decline_label: string;
    decline_note: string;
    accepted_title: string;
    accepted_message: string;
    declined_title: string;
    declined_message: string;
    already_title: string;
    already_message: string;
    closed_message: string;
  };
  evening: {
    /** Reception-only ("evening") invites and the day/evening choice. */
    enabled: boolean;
    day_label: string;
    evening_label: string;
    /** May contain {reception_time}. */
    evening_note: string;
  };
  images: {
    hero: ImageRef | null;
    hero_evening: ImageRef | null;
    hero_alt: string;
    decoration: 'botanical' | 'none';
  };
  privacy: {
    hide_from_search: boolean;
    /** Origins (https://example.com) allowed to embed the site in an iframe. */
    embed_origins: string[];
  };
  security: {
    /** Length of newly generated invite codes. */
    code_length: 5 | 6;
    /** Failed code lookups allowed per IP per hour before a cool-off. */
    lookup_failures_per_hour: number;
    /** Failed code lookups allowed per IP per day before a 24h lockout. */
    lookup_failures_per_day: number;
    /** Site-wide failed lookups per hour that trip the circuit breaker. */
    breaker_failures_per_hour: number;
    /** RSVP submissions allowed per IP per hour. */
    submits_per_hour: number;
  };
  features: {
    meals: boolean;
    dietary: boolean;
    song_request: boolean;
    message: boolean;
  };
  /**
   * The site's two colours (#RRGGBB). Null means "use RSVPer's own". The
   * premade themes in the admin only ever set these; no theme name is stored.
   */
  theme: {
    background: string | null;
    brand: string | null;
    /** A font pairing id from src/fonts.json. */
    font: string;
  };
}

export type ImageRef =
  | { kind: 'builtin'; name: 'arch' | 'arch-evening' }
  | { kind: 'url'; url: string }
  | { kind: 'upload'; id: string };

export type SectionName = keyof Settings;

export const DEFAULTS: Settings = {
  couple: { name_one: 'Alex', name_two: 'Sam', joiner: '&' },
  event: {
    date: null,
    timezone: 'UTC',
    locale: 'en-GB',
    ceremony_time: null,
    reception_time: null,
  },
  venue: { name: '', address: '', map_url: null },
  rsvp: { deadline: null, contact: 'Please contact us directly.' },
  copy: {
    headline: 'are getting married',
    code_prompt: 'Please enter your invite code',
    code_help: "You'll find it on your invitation.",
    intro: "We'd love to know if you can join us on {date}.",
    accept_label: 'Joyfully accepts',
    decline_label: 'Regretfully declines',
    decline_note: "We'll miss you.",
    accepted_title: 'Thank you',
    accepted_message: "We can't wait to celebrate with you.",
    declined_title: 'Thank you for letting us know.',
    declined_message: "We'll miss you dearly.",
    already_title: "You've already replied. Thank you!",
    already_message: "Please contact us if anything's changed.",
    closed_message: 'RSVPs have now closed. Please contact us directly.',
  },
  evening: {
    enabled: true,
    day_label: 'The whole day',
    evening_label: 'Evening only',
    evening_note: "We'll see you at the reception from {reception_time}.",
  },
  images: {
    hero: { kind: 'builtin', name: 'arch' },
    hero_evening: { kind: 'builtin', name: 'arch-evening' },
    hero_alt: '',
    decoration: 'botanical',
  },
  privacy: { hide_from_search: true, embed_origins: [] },
  security: {
    code_length: 6,
    lookup_failures_per_hour: 10,
    lookup_failures_per_day: 30,
    breaker_failures_per_hour: 200,
    submits_per_hour: 5,
  },
  features: { meals: false, dietary: false, song_request: false, message: false },
  theme: { background: null, brand: null, font: 'classic' },
};

export const SECTIONS = Object.keys(DEFAULTS) as SectionName[];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class SettingsError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

type Raw = Record<string, unknown>;

function line(raw: Raw, key: string, max: number, opts: { required?: boolean } = {}): string {
  const value = raw[key];
  if (value === undefined || value === null || value === '') {
    if (opts.required) throw new SettingsError(key, 'This field is required.');
    return '';
  }
  const clean = cleanLine(value, max);
  if (clean === null) {
    if (typeof value === 'string' && !value.trim()) {
      if (opts.required) throw new SettingsError(key, 'This field is required.');
      return '';
    }
    throw new SettingsError(key, `Must be text of at most ${max} characters.`);
  }
  return clean;
}

function block(raw: Raw, key: string, max: number): string {
  const value = raw[key];
  if (value === undefined || value === null || value === '') return '';
  const clean = cleanBlock(value, max);
  if (clean === null && typeof value === 'string' && value.trim()) {
    throw new SettingsError(key, `Must be at most ${max} characters.`);
  }
  return clean ?? '';
}

function bool(raw: Raw, key: string): boolean {
  const value = raw[key];
  if (typeof value !== 'boolean') throw new SettingsError(key, 'Must be true or false.');
  return value;
}

function int(raw: Raw, key: string, min: number, max: number): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SettingsError(key, `Must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function date(raw: Raw, key: string): string | null {
  const value = raw[key];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !DATE.test(value)) {
    throw new SettingsError(key, 'Must be a date (YYYY-MM-DD).');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new SettingsError(key, 'Must be a real date.');
  }
  return value;
}

function time(raw: Raw, key: string): string | null {
  const value = raw[key];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !TIME.test(value)) {
    throw new SettingsError(key, 'Must be a time (HH:MM, 24-hour).');
  }
  return value;
}

/** Only https URLs (or none). Blocks javascript:, data: and friends. */
export function httpsUrl(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 500) {
    throw new SettingsError(field, 'Must be a link of at most 500 characters.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SettingsError(field, 'Must be a valid link.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new SettingsError(field, 'Must be an https:// link.');
  }
  return url.toString();
}

function origin(value: unknown, field: string): string {
  const url = httpsUrl(value, field);
  if (!url) throw new SettingsError(field, 'Must be an https:// origin.');
  return new URL(url).origin;
}

/** #RRGGBB, or null. An empty string clears the colour. */
function hexColour(raw: Raw, key: string): string | null {
  const value = raw[key];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new SettingsError(key, 'Must be a colour like #1F2D3A.');
  }
  return value.toUpperCase();
}

function timezone(raw: Raw, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length > 64) {
    throw new SettingsError(key, 'Must be a time zone such as Europe/London.');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
  } catch {
    throw new SettingsError(key, 'Unknown time zone.');
  }
  return value;
}

function locale(raw: Raw, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length > 35) {
    throw new SettingsError(key, 'Must be a locale such as en-GB.');
  }
  try {
    return Intl.getCanonicalLocales(value)[0] ?? 'en-GB';
  } catch {
    throw new SettingsError(key, 'Unknown locale.');
  }
}

function imageRef(value: unknown, field: string): ImageRef | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') throw new SettingsError(field, 'Invalid image.');
  const v = value as Raw;
  if (v.kind === 'builtin' && (v.name === 'arch' || v.name === 'arch-evening')) {
    return { kind: 'builtin', name: v.name };
  }
  if (v.kind === 'url') {
    const url = httpsUrl(v.url, field);
    if (!url) throw new SettingsError(field, 'Image link is required.');
    return { kind: 'url', url };
  }
  if (v.kind === 'upload' && typeof v.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v.id)) {
    return { kind: 'upload', id: v.id };
  }
  throw new SettingsError(field, 'Invalid image.');
}

const VALIDATORS: { [K in SectionName]: (raw: Raw) => Settings[K] } = {
  couple: (r) => ({
    name_one: line(r, 'name_one', 40, { required: true }),
    name_two: line(r, 'name_two', 40, { required: true }),
    joiner: line(r, 'joiner', 8) || '&',
  }),
  event: (r) => ({
    date: date(r, 'date'),
    timezone: timezone(r, 'timezone'),
    locale: locale(r, 'locale'),
    ceremony_time: time(r, 'ceremony_time'),
    reception_time: time(r, 'reception_time'),
  }),
  venue: (r) => ({
    name: line(r, 'name', 100),
    address: line(r, 'address', 200),
    map_url: httpsUrl(r.map_url, 'map_url'),
  }),
  rsvp: (r) => ({
    deadline: date(r, 'deadline'),
    contact: line(r, 'contact', 200),
  }),
  copy: (r) => {
    const out = {} as Settings['copy'];
    for (const key of Object.keys(DEFAULTS.copy) as (keyof Settings['copy'])[]) {
      out[key] = block(r, key, 300) || DEFAULTS.copy[key];
    }
    return out;
  },
  evening: (r) => ({
    enabled: bool(r, 'enabled'),
    day_label: line(r, 'day_label', 40) || DEFAULTS.evening.day_label,
    evening_label: line(r, 'evening_label', 40) || DEFAULTS.evening.evening_label,
    evening_note: line(r, 'evening_note', 200),
  }),
  images: (r) => ({
    hero: imageRef(r.hero, 'hero'),
    hero_evening: imageRef(r.hero_evening, 'hero_evening'),
    hero_alt: line(r, 'hero_alt', 150),
    decoration: r.decoration === 'none' ? 'none' : 'botanical',
  }),
  privacy: (r) => {
    const list = r.embed_origins;
    if (!Array.isArray(list) || list.length > 5) {
      throw new SettingsError('embed_origins', 'At most 5 origins.');
    }
    return {
      hide_from_search: bool(r, 'hide_from_search'),
      embed_origins: [...new Set(list.map((o) => origin(o, 'embed_origins')))],
    };
  },
  security: (r) => {
    const length = r.code_length;
    if (length !== 5 && length !== 6) throw new SettingsError('code_length', 'Must be 5 or 6.');
    return {
      code_length: length,
      lookup_failures_per_hour: int(r, 'lookup_failures_per_hour', 3, 60),
      lookup_failures_per_day: int(r, 'lookup_failures_per_day', 5, 500),
      breaker_failures_per_hour: int(r, 'breaker_failures_per_hour', 20, 5000),
      submits_per_hour: int(r, 'submits_per_hour', 2, 60),
    };
  },
  theme: (r) => {
    const font = r.font === undefined || r.font === null || r.font === '' ? 'classic' : r.font;
    if (typeof font !== 'string' || !FONT_PAIRS.some((p) => p.id === font)) {
      throw new SettingsError('font', 'Unknown font pairing.');
    }
    return { background: hexColour(r, 'background'), brand: hexColour(r, 'brand'), font };
  },
  features: (r) => ({
    meals: bool(r, 'meals'),
    dietary: bool(r, 'dietary'),
    song_request: bool(r, 'song_request'),
    message: bool(r, 'message'),
  }),
};

/**
 * Validate a (possibly partial) update to one section, merged over its
 * current value. Throws SettingsError with the offending field.
 */
export function validateSection<K extends SectionName>(
  section: K,
  current: Settings[K],
  patch: unknown,
): Settings[K] {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SettingsError(section, 'Malformed settings.');
  }
  const merged = { ...(current as object), ...(patch as object) } as Raw;
  return VALIDATORS[section](merged);
}

/** Merge stored JSON over defaults. Invalid stored data falls back safely. */
export function mergeStored(stored: Partial<Record<string, unknown>>): Settings {
  const out = structuredClone(DEFAULTS) as Settings;
  for (const section of SECTIONS) {
    const value = stored[section];
    if (value === undefined) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[section] = validateSection(section, DEFAULTS[section], value);
    } catch (err) {
      console.error(`Ignoring invalid stored settings for "${section}"`, err);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function coupleNames(s: Settings): string {
  return `${s.couple.name_one} ${s.couple.joiner} ${s.couple.name_two}`;
}

export function formatDate(s: Settings, iso: string | null): string {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat(s.event.locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

export function formatTime(s: Settings, hhmm: string | null): string {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(Date.UTC(2000, 0, 1, h, m));
  return new Intl.DateTimeFormat(s.event.locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(d);
}

/** Replace {placeholders} with plain text values. Unknown ones are left as-is. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (match, key: string) =>
    key in values ? (values[key] ?? '') : match,
  );
}

/** Today's date (YYYY-MM-DD) in the wedding's time zone. */
export function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function rsvpClosed(s: Settings, now = new Date()): boolean {
  return Boolean(s.rsvp.deadline && todayIn(s.event.timezone, now) > s.rsvp.deadline);
}
