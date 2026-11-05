// Demo mode: the public demo at demo.rsvper.app.
//
// Enabled ONLY when the Worker's DEMO_MODE variable is exactly "true", which
// is set in wrangler.demo.jsonc (the Deploy to Cloudflare button never uses
// that file).
//
// Each visitor gets a private sandbox: a wedding row of their own, seeded with
// made-up data, identified by a random cookie and deleted after 24 hours.
// Nothing a visitor does is visible to anyone else, and the real 'default'
// wedding is never read or written in demo mode, so even a misconfigured
// real deployment couldn't expose real guests this way.

import type { Env } from './env';
import { randomToken } from './lib/crypto';
import { ipHash } from './lib/identity';
import { hit } from './lib/ratelimit';
import { readCookie } from './auth/access';

export const DEMO_COOKIE = '__Host-rsvper_demo';
export const DEMO_TTL_S = 24 * 3600;
const MAX_LIVE_SANDBOXES = 2000;
const SANDBOXES_PER_IP_PER_HOUR = 20;

export function isDemo(env: Env): boolean {
  return env.DEMO_MODE === 'true';
}

const SANDBOX_ID = /^demo-[A-Za-z0-9_-]{22,64}$/;

export function demoCookie(id: string, maxAge = DEMO_TTL_S): string {
  return `${DEMO_COOKIE}=${id}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export class DemoBusyError extends Error {}

/**
 * The visitor's sandbox wedding id, creating (and seeding) one if they don't
 * have a live one. Returns a Set-Cookie value when a new sandbox was made.
 */
export async function resolveSandbox(
  request: Request,
  env: Env,
): Promise<{ weddingId: string; setCookie: string | null }> {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const existing = readCookie(request, DEMO_COOKIE);
  if (existing && SANDBOX_ID.test(existing)) {
    const row = await db
      .prepare('SELECT id FROM weddings WHERE id = ? AND demo_expires_at > ?')
      .bind(existing, now)
      .first<{ id: string }>();
    if (row) return { weddingId: row.id, setCookie: null };
  }

  // New sandbox. Clear out expired ones first (everything cascades).
  await db
    .prepare(
      '/* tenant-admin: expired demo sandboxes */ DELETE FROM weddings WHERE demo_expires_at IS NOT NULL AND demo_expires_at <= ?',
    )
    .bind(now)
    .run();

  const live = await db
    .prepare(
      '/* tenant-admin: count demo sandboxes */ SELECT COUNT(*) AS n FROM weddings WHERE demo_expires_at IS NOT NULL',
    )
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= MAX_LIVE_SANDBOXES) throw new DemoBusyError('too many sandboxes');

  const limit = await hit(db, `demo:create:${await ipHash(request, env)}`, {
    limit: SANDBOXES_PER_IP_PER_HOUR,
    windowSeconds: 3600,
  });
  if (!limit.ok) throw new DemoBusyError('rate limited');

  const id = `demo-${randomToken(18)}`;
  await db.batch([
    db
      .prepare(
        "/* tenant-admin: create a demo sandbox */ INSERT INTO weddings (id, setup_completed_at, demo_expires_at) VALUES (?, datetime('now'), ?)",
      )
      .bind(id, now + DEMO_TTL_S),
    ...seedStatements(db, id),
  ]);
  return { weddingId: id, setCookie: demoCookie(id) };
}

/** Delete the visitor's sandbox (the "Reset demo" button). */
export async function resetSandbox(request: Request, env: Env): Promise<void> {
  const existing = readCookie(request, DEMO_COOKIE);
  if (!existing || !SANDBOX_ID.test(existing)) return;
  await env.DB.prepare(
    '/* tenant-admin: reset one demo sandbox */ DELETE FROM weddings WHERE id = ? AND demo_expires_at IS NOT NULL',
  )
    .bind(existing)
    .run();
}

// ---------------------------------------------------------------------------
// Demo data (made up). Mirrors scripts/seed-local.mjs.
// ---------------------------------------------------------------------------

interface DemoHousehold {
  code: string;
  name: string;
  max: number;
  state: 'pending' | 'opened' | 'accepted' | 'declined' | 'evening-choice';
  evening?: boolean;
  guests: [name: string, plusOne: boolean, meal?: string, dietary?: string][];
  plusOne?: { host: number; name: string; meal: string };
  song?: string;
  message?: string;
}

const HOUSEHOLDS: DemoHousehold[] = [
  {
    code: 'GUEST2',
    name: 'The Example Family',
    max: 4,
    state: 'accepted',
    guests: [
      ['Pat Example', false, 'chicken'],
      ['Chris Example', true, 'risotto', 'No nuts'],
      ['Jamie Example', false, 'chicken'],
    ],
    plusOne: { host: 1, name: 'Sam Guest', meal: 'salmon' },
    song: 'September',
    message: 'So happy for you both!',
  },
  {
    code: 'GUEST3',
    name: 'Robin Sample',
    max: 2,
    state: 'pending',
    guests: [['Robin Sample', true]],
  },
  {
    code: 'GUEST4',
    name: 'Taylor & Morgan Placeholder',
    max: 2,
    state: 'declined',
    guests: [
      ['Taylor Placeholder', false],
      ['Morgan Placeholder', false],
    ],
    message: 'Sorry we can’t make it, have a wonderful day.',
  },
  {
    code: 'GUEST5',
    name: 'Casey Demo',
    max: 1,
    state: 'accepted',
    evening: true,
    guests: [['Casey Demo', false, 'risotto', 'Vegan']],
  },
  {
    code: 'GUEST6',
    name: 'The Test Household',
    max: 3,
    state: 'opened',
    guests: [
      ['Drew Test', false],
      ['Jordan Test', false],
      ['Riley Test', false],
    ],
  },
  {
    code: 'GUEST7',
    name: 'Quinn Fictional',
    max: 2,
    state: 'evening-choice',
    guests: [['Quinn Fictional', true, 'chicken']],
    plusOne: { host: 0, name: 'Avery Friend', meal: 'chicken' },
    song: 'Mr. Brightside',
  },
  {
    code: 'GUEST8',
    name: 'Sky & Rowan Invented',
    max: 2,
    state: 'pending',
    evening: true,
    guests: [
      ['Sky Invented', false],
      ['Rowan Invented', false],
    ],
  },
  {
    code: 'GUEST9',
    name: 'Frankie Madeup',
    max: 1,
    state: 'accepted',
    guests: [['Frankie Madeup', false, 'salmon']],
  },
];

function seedStatements(db: D1Database, w: string): D1PreparedStatement[] {
  const year = new Date().getUTCFullYear() + 1;
  const settings: Record<string, unknown> = {
    couple: { name_one: 'Alex', name_two: 'Sam', joiner: '&' },
    event: {
      date: `${year}-06-12`,
      timezone: 'Europe/London',
      locale: 'en-GB',
      ceremony_time: '13:00',
      reception_time: '19:30',
    },
    venue: { name: 'The Old Orchard', address: 'Somewhere Lane', map_url: null },
    rsvp: { deadline: `${year}-05-01`, contact: 'Message us if anything changes.' },
    evening: {
      enabled: true,
      day_label: 'The whole day',
      evening_label: 'Evening only',
      evening_note: "We'll see you at the reception from {reception_time}.",
    },
    features: { meals: true, dietary: true, song_request: true, message: true },
  };

  const s: D1PreparedStatement[] = [];
  const run = (sql: string, ...values: unknown[]) => s.push(db.prepare(sql).bind(...values));

  for (const [key, value] of Object.entries(settings)) {
    run(
      'INSERT INTO settings (wedding_id, key, value) VALUES (?, ?, ?)',
      w,
      key,
      JSON.stringify(value),
    );
  }

  const course = `${w}-c-main`;
  const meal = (name: string) => `${w}-m-${name}`;
  run(
    'INSERT INTO meal_courses (id, wedding_id, name, sort_order) VALUES (?, ?, ?, 0)',
    course,
    w,
    'Main',
  );
  [
    ['chicken', 'Roast chicken', 'With seasonal vegetables'],
    ['risotto', 'Mushroom risotto', 'Vegetarian'],
    ['salmon', 'Baked salmon', null],
  ].forEach(([key, name, description], i) =>
    run(
      'INSERT INTO meal_options (id, wedding_id, course_id, name, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      meal(key!),
      w,
      course,
      name,
      description,
      i,
    ),
  );

  HOUSEHOLDS.forEach((h, i) => {
    const inv = `${w}-inv-${i}`;
    const opened = h.state !== 'pending';
    run(
      `INSERT INTO invites (id, wedding_id, code, household_name, max_party_size, reception_only,
                            open_count, first_opened_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ${opened ? "datetime('now', '-3 days')" : 'NULL'}, ${opened ? "datetime('now', '-3 days')" : 'NULL'})`,
      inv,
      w,
      h.code,
      h.name,
      h.max,
      h.evening ? 1 : 0,
      opened ? 1 : 0,
    );
    h.guests.forEach(([name, plus], gi) =>
      run(
        'INSERT INTO invite_guests (id, wedding_id, invite_id, name, allows_plus_one, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
        `${inv}-g${gi}`,
        w,
        inv,
        name,
        plus ? 1 : 0,
        gi,
      ),
    );

    if (h.state !== 'accepted' && h.state !== 'declined' && h.state !== 'evening-choice') return;
    const attending = h.state !== 'declined';
    const rsvp = `${inv}-r`;
    run(
      `INSERT INTO rsvps (id, wedding_id, invite_id, attending, attending_reception_only, song_request, message, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
      rsvp,
      w,
      inv,
      attending ? 1 : 0,
      h.state === 'evening-choice' ? 1 : 0,
      attending ? (h.song ?? null) : null,
      h.message ?? null,
      `-${i + 1} days`,
    );
    h.guests.forEach(([, , mealKey, dietary], gi) => {
      const rg = `${rsvp}-g${gi}`;
      run(
        'INSERT INTO rsvp_guests (id, wedding_id, rsvp_id, invite_guest_id, attending, dietary_notes) VALUES (?, ?, ?, ?, ?, ?)',
        rg,
        w,
        rsvp,
        `${inv}-g${gi}`,
        attending ? 1 : 0,
        attending ? (dietary ?? null) : null,
      );
      if (attending && mealKey) {
        run(
          'INSERT INTO rsvp_guest_meals (id, wedding_id, rsvp_guest_id, course_id, meal_option_id) VALUES (?, ?, ?, ?, ?)',
          `${rg}-m`,
          w,
          rg,
          course,
          meal(mealKey),
        );
      }
    });
    if (attending && h.plusOne) {
      const rg = `${rsvp}-p`;
      run(
        'INSERT INTO rsvp_guests (id, wedding_id, rsvp_id, host_guest_id, plus_one_name, attending) VALUES (?, ?, ?, ?, ?, 1)',
        rg,
        w,
        rsvp,
        `${inv}-g${h.plusOne.host}`,
        h.plusOne.name,
      );
      run(
        'INSERT INTO rsvp_guest_meals (id, wedding_id, rsvp_guest_id, course_id, meal_option_id) VALUES (?, ?, ?, ?, ?)',
        `${rg}-m`,
        w,
        rg,
        course,
        meal(h.plusOne.meal),
      );
    }
  });
  return s;
}
