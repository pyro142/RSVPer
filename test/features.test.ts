// Optional guest features: each one on and off.

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminRepo } from '../src/db/admin';
import { BASE, fetchWorker, post, setSettings, standardFixture } from './helpers';

const repo = () => new AdminRepo(env.DB, 'default');

async function adminSession() {
  const res = await fetchWorker('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ password: 'test-admin-password-123' }),
  });
  const cookie = (res.headers.get('Set-Cookie') || '').split(';')[0]!;
  const { csrf } = (await res.json()) as { csrf: string };
  return (path: string, method = 'GET', json?: unknown) =>
    fetchWorker(path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: BASE,
        'X-CSRF-Token': csrf,
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
}

async function setMenu() {
  await repo().saveMenu({
    courses: [
      {
        id: null,
        name: 'Main',
        options: [
          { id: null, name: 'Chicken', description: null },
          { id: null, name: 'Risotto', description: 'Vegetarian' },
        ],
      },
      { id: null, name: 'Dessert', options: [{ id: null, name: 'Cake', description: null }] },
    ],
  });
  const menu = await repo().menu();
  const opt = (course: string, name: string) =>
    menu.find((c) => c.name === course)!.options.find((o) => o.name === name)!.id;
  const course = (name: string) => menu.find((c) => c.name === name)!.id;
  return { menu, opt, course };
}

beforeEach(standardFixture);

describe('meal choices', () => {
  it('are not asked for, and are ignored, when the feature is off', async () => {
    const { opt, course } = await setMenu();
    const lookup = (await (await post('/api/rsvp/lookup', { code: 'ABCDEF' })).json()) as {
      menu: unknown[];
      features: { meals: boolean };
    };
    expect(lookup.features.meals).toBe(false);
    expect(lookup.menu).toEqual([]);

    const res = await post('/api/rsvp/submit', {
      code: 'ABCDEF',
      attending: true,
      guests: [{ invite_guest_id: 'g-1', meals: { [course('Main')]: opt('Main', 'Chicken') } }],
    });
    expect(res.status).toBe(200);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM rsvp_guest_meals').first<{ n: number }>())
        ?.n,
    ).toBe(0);
  });

  describe('when on', () => {
    let ids: Awaited<ReturnType<typeof setMenu>>;
    beforeEach(async () => {
      ids = await setMenu();
      await setSettings('features', { meals: true });
    });

    const meals = (main: string) => ({
      [ids.course('Main')]: ids.opt('Main', main),
      [ids.course('Dessert')]: ids.opt('Dessert', 'Cake'),
    });

    it('sends the active menu with the lookup', async () => {
      const body = (await (await post('/api/rsvp/lookup', { code: 'ABCDEF' })).json()) as {
        menu: { name: string; options: unknown[] }[];
      };
      expect(body.menu.map((c) => c.name)).toEqual(['Main', 'Dessert']);
      expect(body.menu[0]!.options).toHaveLength(2);
    });

    it('requires a choice per course for every attending guest and plus one', async () => {
      const missing = await post('/api/rsvp/submit', {
        code: 'ABCDEF',
        attending: true,
        guests: [
          { invite_guest_id: 'g-1', meals: { [ids.course('Main')]: ids.opt('Main', 'Chicken') } },
        ],
      });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toMatch(/dessert/);

      const noPlusOneMeal = await post('/api/rsvp/submit', {
        code: 'ABCDEF',
        attending: true,
        guests: [
          { invite_guest_id: 'g-1', meals: meals('Chicken') },
          { invite_guest_id: 'g-2', meals: meals('Risotto'), plus_one: true, plus_one_name: 'Sam' },
        ],
      });
      expect(noPlusOneMeal.status).toBe(400);

      const ok = await post('/api/rsvp/submit', {
        code: 'ABCDEF',
        attending: true,
        guests: [
          { invite_guest_id: 'g-1', meals: meals('Chicken') },
          {
            invite_guest_id: 'g-2',
            meals: meals('Risotto'),
            plus_one: true,
            plus_one_name: 'Sam',
            plus_one_meals: meals('Risotto'),
          },
        ],
      });
      expect(ok.status).toBe(200);
      expect(
        (await env.DB.prepare('SELECT COUNT(*) AS n FROM rsvp_guest_meals').first<{ n: number }>())
          ?.n,
      ).toBe(6);
    });

    it('does not ask guests who are not attending', async () => {
      const res = await post('/api/rsvp/submit', {
        code: 'ABCDEF',
        attending: true,
        guests: [
          { invite_guest_id: 'g-1', meals: meals('Chicken') },
          { invite_guest_id: 'g-2', attending: false },
        ],
      });
      expect(res.status).toBe(200);
    });

    it('rejects an option from the wrong course or a retired option', async () => {
      const wrong = await post('/api/rsvp/submit', {
        code: 'ABCDEF',
        attending: true,
        guests: [
          {
            invite_guest_id: 'g-1',
            meals: {
              [ids.course('Main')]: ids.opt('Dessert', 'Cake'),
              [ids.course('Dessert')]: ids.opt('Dessert', 'Cake'),
            },
          },
        ],
      });
      expect(wrong.status).toBe(400);

      await env.DB.prepare('UPDATE meal_options SET is_active = 0 WHERE id = ?')
        .bind(ids.opt('Main', 'Chicken'))
        .run();
      const retired = await post('/api/rsvp/submit', {
        code: 'ABCDEF',
        attending: true,
        guests: [{ invite_guest_id: 'g-1', meals: meals('Chicken') }],
      });
      expect(retired.status).toBe(400);
    });

    it('counts meals in stats and adds a column per course to the export', async () => {
      await setSettings('evening', { enabled: false });
      await post('/api/rsvp/submit', {
        code: 'ABCDEF',
        attending: true,
        guests: [
          { invite_guest_id: 'g-1', meals: meals('Chicken') },
          {
            invite_guest_id: 'g-2',
            meals: meals('Risotto'),
            plus_one: true,
            plus_one_name: 'Sam',
            plus_one_meals: meals('Risotto'),
          },
        ],
      });
      const admin = await adminSession();
      const stats = (await (await admin('/api/admin/stats')).json()) as {
        meals: { courses: { name: string; options: { name: string; count: number }[] }[] };
      };
      const main = stats.meals.courses.find((c) => c.name === 'Main')!;
      expect(Object.fromEntries(main.options.map((o) => [o.name, o.count]))).toEqual({
        Chicken: 1,
        Risotto: 2,
      });

      const csv = await (await admin('/api/admin/export.csv')).text();
      const [header, ...rows] = csv.trim().split('\r\n');
      expect(header).toContain('"meal: Main","meal: Dessert"');
      expect(rows.join('\n')).toContain('"Sam","yes","yes","Risotto","Cake"');
    });

    it('retires a chosen option instead of deleting it, and refuses to drop a used course', async () => {
      await post('/api/rsvp/submit', {
        code: 'ABCDEF',
        attending: true,
        guests: [{ invite_guest_id: 'g-1', meals: meals('Chicken') }],
      });
      const admin = await adminSession();
      const current = (await (await admin('/api/admin/menu')).json()) as {
        courses: { id: string; name: string; options: { id: string; name: string }[] }[];
      };
      const [main, dessert] = current.courses;

      // Drop Chicken (chosen) and Risotto (unused) from Main.
      const res = await admin('/api/admin/menu', 'PUT', {
        courses: [{ id: main!.id, name: 'Main', options: [{ id: null, name: 'Fish' }] }, dessert],
      });
      expect(res.status).toBe(200);
      const all = await repo().menu({ includeRetired: true });
      const names = all[0]!.options.map((o) => `${o.name}:${o.is_active}`);
      expect(names).toContain('Chicken:false');
      expect(names).not.toContain('Risotto:true');
      expect(names.some((n) => n.startsWith('Risotto'))).toBe(false);

      // The export still names the retired choice.
      const csv = await (await admin('/api/admin/export.csv')).text();
      expect(csv).toContain('"Chicken"');

      const drop = await admin('/api/admin/menu', 'PUT', { courses: [dessert] });
      expect(drop.status).toBe(409);
    });

    it('validates the menu', async () => {
      const admin = await adminSession();
      expect(
        (
          await admin('/api/admin/menu', 'PUT', {
            courses: [{ name: '', options: [{ name: 'A' }] }],
          })
        ).status,
      ).toBe(400);
      expect(
        (await admin('/api/admin/menu', 'PUT', { courses: [{ name: 'Main', options: [] }] }))
          .status,
      ).toBe(400);
      expect(
        (
          await admin('/api/admin/menu', 'PUT', {
            courses: [{ name: 'Main', options: [{ name: 'A' }, { name: 'a' }] }],
          })
        ).status,
      ).toBe(400);
    });
  });
});

describe('dietary notes', () => {
  const guests = [{ invite_guest_id: 'g-1', dietary_notes: '  No nuts  ' }];

  it('are ignored when off', async () => {
    await post('/api/rsvp/submit', { code: 'ABCDEF', attending: true, guests });
    const row = await env.DB.prepare(
      "SELECT dietary_notes AS d FROM rsvp_guests WHERE invite_guest_id = 'g-1'",
    ).first<{ d: string | null }>();
    expect(row?.d).toBeNull();
  });

  it('are stored trimmed when on, and limited in length', async () => {
    await setSettings('features', { dietary: true });
    const tooLong = await post('/api/rsvp/submit', {
      code: 'ABCDEF',
      attending: true,
      guests: [{ invite_guest_id: 'g-1', dietary_notes: 'x'.repeat(301) }],
    });
    expect(tooLong.status).toBe(400);
    await post('/api/rsvp/submit', { code: 'ABCDEF', attending: true, guests });
    const row = await env.DB.prepare(
      "SELECT dietary_notes AS d FROM rsvp_guests WHERE invite_guest_id = 'g-1'",
    ).first<{ d: string | null }>();
    expect(row?.d).toBe('No nuts');
  });
});

describe('song request and message', () => {
  const reply = {
    code: 'ABCDEF',
    attending: true,
    guests: [{ invite_guest_id: 'g-1' }],
    song_request: 'Dancing Queen',
    message: 'Congratulations!\u0007\u202E',
  };

  it('are ignored when off', async () => {
    await post('/api/rsvp/submit', reply);
    const row = await env.DB.prepare('SELECT song_request, message FROM rsvps').first();
    expect(row).toEqual({ song_request: null, message: null });
  });

  it('are stored, sanitised, when on', async () => {
    await setSettings('features', { song_request: true, message: true });
    await post('/api/rsvp/submit', reply);
    const row = await env.DB.prepare('SELECT song_request, message FROM rsvps').first();
    // Control and bidi-override characters are stripped.
    expect(row).toEqual({ song_request: 'Dancing Queen', message: 'Congratulations!' });
  });

  it('keep the message but drop the song request on a decline', async () => {
    await setSettings('features', { song_request: true, message: true });
    await post('/api/rsvp/submit', { ...reply, attending: false });
    const row = await env.DB.prepare('SELECT song_request, message FROM rsvps').first();
    expect(row).toEqual({ song_request: null, message: 'Congratulations!' });
  });

  it('enforce length limits', async () => {
    await setSettings('features', { song_request: true, message: true });
    expect((await post('/api/rsvp/submit', { ...reply, message: 'x'.repeat(1001) })).status).toBe(
      400,
    );
    expect(
      (await post('/api/rsvp/submit', { ...reply, song_request: 'x'.repeat(201) })).status,
    ).toBe(400);
  });
});
