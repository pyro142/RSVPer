import { env, exports } from 'cloudflare:workers';
import { WeddingRepo } from '../src/db/repo';
import { DEFAULTS, type SectionName, type Settings } from '../src/settings';

export const BASE = 'https://rsvp.example.test';

export function repo(weddingId = 'default') {
  return new WeddingRepo(env.DB, weddingId);
}

export async function fetchWorker(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(BASE + path, init));
}

export function post(path: string, body: unknown, ip = '203.0.113.1'): Promise<Response> {
  return fetchWorker(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

export async function setSettings<K extends SectionName>(
  section: K,
  patch: Partial<Settings[K]>,
  weddingId = 'default',
) {
  const r = repo(weddingId);
  const current = (await r.settings())[section];
  await r.saveSection(section, { ...current, ...patch } as Settings[K]);
}

export async function markReady(weddingId = 'default') {
  await repo(weddingId).markSetupComplete();
}

interface SeedGuest {
  id: string;
  name: string;
  plusOne?: boolean;
}

export async function seedInvite(opts: {
  id: string;
  code: string;
  household: string;
  max: number;
  guests: SeedGuest[];
  receptionOnly?: boolean;
  weddingId?: string;
}) {
  const w = opts.weddingId ?? 'default';
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO invites (id, wedding_id, code, household_name, max_party_size, reception_only) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(opts.id, w, opts.code, opts.household, opts.max, opts.receptionOnly ? 1 : 0),
    ...opts.guests.map((g, i) =>
      env.DB.prepare(
        'INSERT INTO invite_guests (id, wedding_id, invite_id, name, allows_plus_one, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(g.id, w, opts.id, g.name, g.plusOne ? 1 : 0, i),
    ),
  ]);
}

/** A ready wedding with one household: two guests, the second may bring a +1. */
export async function standardFixture() {
  await markReady();
  await seedInvite({
    id: 'inv-1',
    code: 'ABCDEF',
    household: 'The Example Family',
    max: 3,
    guests: [
      { id: 'g-1', name: 'Pat Example' },
      { id: 'g-2', name: 'Chris Example', plusOne: true },
    ],
  });
}

export { DEFAULTS };
