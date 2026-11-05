import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { fetchWorker, post, seedInvite, setSettings, standardFixture } from './helpers';

const accept = (guests: unknown[], extra: Record<string, unknown> = {}) => ({
  code: 'ABCDEF',
  attending: true,
  guests,
  ...extra,
});

describe('guest card', () => {
  it('renders couple settings as escaped text', async () => {
    await setSettings('couple', { name_one: '<script>alert(1)</script>', name_two: 'Jo' });
    const res = await fetchWorker('/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('data-slot');
  });

  it('serves personalised code links as the card', async () => {
    const res = await fetchWorker('/ABCDEF');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('hides from search engines by default', async () => {
    const res = await fetchWorker('/');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(await res.text()).toContain('name="robots"');
    const robots = await (await fetchWorker('/robots.txt')).text();
    expect(robots).toContain('Disallow: /');
  });

  it('allows indexing when the couple turns it on', async () => {
    await setSettings('privacy', { hide_from_search: false });
    const res = await fetchWorker('/');
    expect(res.headers.get('X-Robots-Tag')).toBeNull();
    expect(await res.text()).not.toContain('name="robots"');
  });

  it('sends a strict CSP with no third parties when Turnstile is off', async () => {
    const csp = (await fetchWorker('/')).headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('challenges.cloudflare.com');
  });

  it('allows embedding only on configured origins', async () => {
    await setSettings('privacy', { embed_origins: ['https://our-wedding.example'] });
    const res = await fetchWorker('/');
    expect(res.headers.get('Content-Security-Policy')).toContain(
      'frame-ancestors https://our-wedding.example',
    );
    expect(res.headers.get('X-Frame-Options')).toBeNull();
  });
});

describe('lookup', () => {
  beforeEach(standardFixture);

  it('returns the household for a valid code', async () => {
    const res = await post('/api/rsvp/lookup', { code: 'abc-def' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { household_name: string; guests: unknown[] };
    expect(body.household_name).toBe('The Example Family');
    expect(body.guests).toHaveLength(2);
  });

  it('gives one vague 404 for unknown and malformed codes', async () => {
    const a = await post('/api/rsvp/lookup', { code: 'ZZZZZZ' });
    const b = await post('/api/rsvp/lookup', { code: 'O0O0O0' });
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.json()).toEqual(await b.json());
  });

  it('records the open', async () => {
    await post('/api/rsvp/lookup', { code: 'ABCDEF' });
    const row = await env.DB.prepare("SELECT open_count FROM invites WHERE id = 'inv-1'").first<{
      open_count: number;
    }>();
    expect(row?.open_count).toBe(1);
  });

  it('requires a JSON content type (blocks form-based CSRF)', async () => {
    const res = await fetchWorker('/api/rsvp/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ code: 'ABCDEF' }),
    });
    expect(res.status).toBe(400);
  });

  it('locks an IP out after too many failed guesses, even for a valid code', async () => {
    await setSettings('security', { lookup_failures_per_hour: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await post('/api/rsvp/lookup', { code: `ZZZZZ${i + 2}` })).status).toBe(404);
    }
    const locked = await post('/api/rsvp/lookup', { code: 'ABCDEF' });
    expect(locked.status).toBe(429);
    expect(locked.headers.get('Retry-After')).toBeTruthy();
    // Another IP is unaffected.
    expect((await post('/api/rsvp/lookup', { code: 'ABCDEF' }, '198.51.100.7')).status).toBe(200);
  });

  it('does not count successful lookups as failures', async () => {
    await setSettings('security', { lookup_failures_per_hour: 3 });
    for (let i = 0; i < 6; i++) {
      expect((await post('/api/rsvp/lookup', { code: 'ABCDEF' })).status).toBe(200);
    }
  });

  it('trips the site-wide breaker and tightens limits for everyone', async () => {
    await setSettings('security', { breaker_failures_per_hour: 20, lookup_failures_per_hour: 10 });
    // 20 failures spread across many IPs.
    for (let i = 0; i < 20; i++) {
      await post('/api/rsvp/lookup', { code: 'ZZZZZZ' }, `192.0.2.${i}`);
    }
    // A fresh IP now gets only 3 failures before lockout (Turnstile is off).
    const ip = '198.51.100.99';
    for (let i = 0; i < 3; i++) await post('/api/rsvp/lookup', { code: 'ZZZZZZ' }, ip);
    expect((await post('/api/rsvp/lookup', { code: 'ABCDEF' }, ip)).status).toBe(429);
  });

  it('fails closed if the rate limiter cannot work', async () => {
    await env.DB.prepare('DROP TABLE rate_limits').run();
    expect((await post('/api/rsvp/lookup', { code: 'ABCDEF' })).status).toBe(429);
  });

  it('refuses everything until setup is complete', async () => {
    await env.DB.prepare(
      "UPDATE weddings SET setup_completed_at = NULL WHERE id = 'default'",
    ).run();
    expect((await post('/api/rsvp/lookup', { code: 'ABCDEF' })).status).toBe(503);
  });
});

describe('submit', () => {
  beforeEach(standardFixture);

  const everyone = [
    { invite_guest_id: 'g-1', attending: true },
    { invite_guest_id: 'g-2', attending: true, plus_one: true, plus_one_name: 'Sam Guest' },
  ];

  it('records an acceptance with a plus one as its own person', async () => {
    const res = await post('/api/rsvp/submit', accept(everyone));
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare(
      'SELECT plus_one_name, attending FROM rsvp_guests ORDER BY plus_one_name',
    ).all();
    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.attending === 1)).toHaveLength(3);
  });

  it('enforces the party-size cap server-side', async () => {
    await env.DB.prepare("UPDATE invites SET max_party_size = 2 WHERE id = 'inv-1'").run();
    const res = await post('/api/rsvp/submit', accept(everyone));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/up to 2 guests/);
  });

  it('requires a name for a plus one', async () => {
    const res = await post(
      '/api/rsvp/submit',
      accept([
        { invite_guest_id: 'g-1', attending: true },
        { invite_guest_id: 'g-2', attending: true, plus_one: true, plus_one_name: '   ' },
      ]),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/plus one's name/);
  });

  it('refuses a plus one for a guest who is not allowed one', async () => {
    const res = await post(
      '/api/rsvp/submit',
      accept([{ invite_guest_id: 'g-1', attending: true, plus_one: true, plus_one_name: 'X' }]),
    );
    expect(res.status).toBe(400);
  });

  it('does not allow editing after submit', async () => {
    expect((await post('/api/rsvp/submit', accept(everyone))).status).toBe(200);
    const again = await post('/api/rsvp/submit', { code: 'ABCDEF', attending: false });
    expect(again.status).toBe(409);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM rsvps').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('rejects guest ids from another household', async () => {
    await seedInvite({
      id: 'inv-2',
      code: 'GHJKMN',
      household: 'Others',
      max: 1,
      guests: [{ id: 'g-other', name: 'Other' }],
    });
    const res = await post('/api/rsvp/submit', accept([{ invite_guest_id: 'g-other' }]));
    expect(res.status).toBe(400);
  });

  it('records a decline for the whole household, ignoring guest detail', async () => {
    const res = await post('/api/rsvp/submit', {
      code: 'ABCDEF',
      attending: false,
      guests: everyone,
    });
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare('SELECT attending FROM rsvp_guests').all();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.attending === 0)).toBe(true);
  });

  it('refuses replies after the deadline', async () => {
    await setSettings('rsvp', { deadline: '2000-01-01' });
    const res = await post('/api/rsvp/submit', accept(everyone));
    expect(res.status).toBe(403);
  });

  it('ignores an evening-only choice when the feature is off', async () => {
    await post('/api/rsvp/submit', accept(everyone, { reception_only: true }));
    const row = await env.DB.prepare('SELECT attending_reception_only AS r FROM rsvps').first<{
      r: number;
    }>();
    expect(row?.r).toBe(0);
  });

  it('records an evening-only choice when the feature is on', async () => {
    await setSettings('evening', { enabled: true });
    await post('/api/rsvp/submit', accept(everyone, { reception_only: true }));
    const row = await env.DB.prepare('SELECT attending_reception_only AS r FROM rsvps').first<{
      r: number;
    }>();
    expect(row?.r).toBe(1);
  });

  it('rate limits submissions per IP', async () => {
    await setSettings('security', { submits_per_hour: 2 });
    await post('/api/rsvp/submit', { code: 'ZZZZZZ', attending: false });
    await post('/api/rsvp/submit', { code: 'ZZZZZZ', attending: false });
    expect((await post('/api/rsvp/submit', accept(everyone))).status).toBe(429);
  });
});

describe('IPv6 rate limiting', () => {
  beforeEach(standardFixture);

  it('treats addresses in the same /64 as one visitor', async () => {
    await setSettings('security', { lookup_failures_per_hour: 3 });
    for (let i = 1; i <= 3; i++) {
      await post('/api/rsvp/lookup', { code: 'ZZZZZZ' }, `2001:db8:1:2::${i}`);
    }
    expect((await post('/api/rsvp/lookup', { code: 'ABCDEF' }, '2001:db8:1:2::99')).status).toBe(
      429,
    );
    expect((await post('/api/rsvp/lookup', { code: 'ABCDEF' }, '2001:db8:1:3::1')).status).toBe(
      200,
    );
  });
});
