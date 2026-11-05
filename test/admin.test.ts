import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { verifyJwt } from '../src/auth/access';
import { base64UrlEncode } from '../src/lib/crypto';
import { BASE, fetchWorker, markReady, seedInvite, setSettings } from './helpers';

const PASSWORD = 'test-admin-password-123';

async function login(password = PASSWORD, ip = '203.0.113.50') {
  const res = await fetchWorker('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'CF-Connecting-IP': ip },
    body: JSON.stringify({ password }),
  });
  const cookie = (res.headers.get('Set-Cookie') || '').split(';')[0] ?? '';
  const body = (await res.json()) as { csrf?: string; error?: string };
  return { res, cookie, csrf: body.csrf ?? '' };
}

async function admin(
  path: string,
  s: { cookie: string; csrf: string },
  init: { method?: string; json?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    Cookie: s.cookie,
    Origin: BASE,
    ...(init.headers ?? {}),
  };
  if (init.method && init.method !== 'GET') headers['X-CSRF-Token'] = s.csrf;
  if (init.json !== undefined) headers['Content-Type'] = 'application/json';
  return fetchWorker(path, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    redirect: 'manual',
  });
}

/** Call the worker with a modified environment (e.g. Access mode). */
async function fetchWith(overrides: Partial<Env>, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(BASE + path, init),
    { ...env, ...overrides } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('password mode', () => {
  it('protects every admin page and API route', async () => {
    for (const path of [
      '/admin',
      '/admin/settings',
      '/admin/setup',
      '/admin/dashboard.html',
      '/Admin',
    ]) {
      const res = await fetchWorker(path, { redirect: 'manual' });
      expect([302, 404], path).toContain(res.status);
      if (res.status === 302) expect(res.headers.get('Location')).toBe('/admin/login');
    }
    for (const path of [
      '/api/admin/session',
      '/api/admin/invites',
      '/api/admin/settings',
      '/api/admin/export.csv',
    ]) {
      expect((await fetchWorker(path)).status, path).toBe(401);
    }
  });

  it('serves the login page without a session', async () => {
    const res = await fetchWorker('/admin/login');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  it('rejects a wrong password and accepts the right one', async () => {
    expect((await login('wrong password!!')).res.status).toBe(401);
    const ok = await login();
    expect(ok.res.status).toBe(200);
    expect(ok.cookie).toMatch(/^__Host-rsvper_admin=/);
    const setCookie = ok.res.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect((await admin('/api/admin/session', ok)).status).toBe(200);
  });

  it('rate limits failed logins per IP', async () => {
    for (let i = 0; i < 5; i++) await login('nope nope nope', '198.51.100.20');
    const blocked = await login(PASSWORD, '198.51.100.20');
    expect(blocked.res.status).toBe(429);
  });

  it('rejects forged or tampered session cookies', async () => {
    const forged = { cookie: '__Host-rsvper_admin=' + 'A'.repeat(43), csrf: '' };
    expect((await admin('/api/admin/session', forged)).status).toBe(401);
  });

  it('requires the CSRF token and same origin for changes', async () => {
    const s = await login();
    const noToken = await admin(
      '/api/admin/settings/couple',
      { cookie: s.cookie, csrf: '' },
      {
        method: 'PUT',
        json: { name_one: 'A', name_two: 'B' },
      },
    );
    expect(noToken.status).toBe(403);
    const crossOrigin = await admin('/api/admin/settings/couple', s, {
      method: 'PUT',
      json: { name_one: 'A', name_two: 'B' },
      headers: { Origin: 'https://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);
    const ok = await admin('/api/admin/settings/couple', s, {
      method: 'PUT',
      json: { name_one: 'A', name_two: 'B' },
    });
    expect(ok.status).toBe(200);
  });

  it('logs out and revokes the session', async () => {
    const s = await login();
    expect((await admin('/api/admin/logout', s, { method: 'POST', json: {} })).status).toBe(200);
    expect((await admin('/api/admin/session', s)).status).toBe(401);
  });

  it('changes the password, which then takes precedence and signs out other sessions', async () => {
    const a = await login();
    const b = await login();
    const res = await admin('/api/admin/password', a, {
      method: 'POST',
      json: { current: PASSWORD, new: 'a much better passphrase' },
    });
    expect(res.status).toBe(200);
    expect((await admin('/api/admin/session', b)).status).toBe(401);
    expect((await admin('/api/admin/session', a)).status).toBe(200);
    expect((await login(PASSWORD)).res.status).toBe(401);
    expect((await login('a much better passphrase')).res.status).toBe(200);
  });

  it('refuses short new passwords', async () => {
    const s = await login();
    const res = await admin('/api/admin/password', s, {
      method: 'POST',
      json: { current: PASSWORD, new: 'short' },
    });
    expect(res.status).toBe(400);
  });

  it('fails closed when ADMIN_PASSWORD is too short', async () => {
    const res = await fetchWith({ ADMIN_PASSWORD: 'short' }, '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ password: 'short' }),
    });
    expect(res.status).toBe(503);
  });

  it('fails closed on an unknown auth mode', async () => {
    const res = await fetchWith({ ADMIN_AUTH_MODE: 'none' }, '/api/admin/session');
    expect(res.status).toBe(503);
  });
});

describe('access mode', () => {
  const accessEnv = {
    ADMIN_AUTH_MODE: 'access',
    ACCESS_TEAM_DOMAIN: 'team.example.com',
    ACCESS_AUD: 'aud-123',
  };

  it('rejects requests with no Access JWT', async () => {
    expect((await fetchWith(accessEnv, '/api/admin/session')).status).toBe(403);
    expect((await fetchWith(accessEnv, '/admin')).status).toBe(403);
  });

  it('rejects a forged unsigned JWT', async () => {
    const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
    const forged = `${enc({ alg: 'none', kid: 'x' })}.${enc({ aud: 'aud-123', email: 'x@y' })}.`;
    const res = await fetchWith(accessEnv, '/api/admin/session', {
      headers: { 'Cf-Access-Jwt-Assertion': forged },
    });
    expect(res.status).toBe(403);
  });

  it('fails closed when Access is selected but not configured', async () => {
    const res = await fetchWith({ ADMIN_AUTH_MODE: 'access' }, '/api/admin/session');
    expect(res.status).toBe(503);
  });

  describe('JWT verification', () => {
    async function signer() {
      const pair = (await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair;
      const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
      const keys = [{ kid: 'k1', kty: 'RSA', n: jwk.n!, e: jwk.e! }];
      const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
      async function sign(payload: Record<string, unknown>, header = { alg: 'RS256', kid: 'k1' }) {
        const data = `${enc(header)}.${enc(payload)}`;
        const sig = await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          pair.privateKey,
          new TextEncoder().encode(data),
        );
        return `${data}.${base64UrlEncode(new Uint8Array(sig))}`;
      }
      return { keys, sign };
    }
    const now = () => Math.floor(Date.now() / 1000);
    const good = () => ({
      iss: 'https://team.example.com',
      aud: ['aud-123'],
      exp: now() + 300,
      email: 'a@b.c',
    });

    it('accepts a valid token', async () => {
      const { keys, sign } = await signer();
      const r = await verifyJwt(
        await sign(good()),
        'team.example.com',
        'aud-123',
        async () => keys,
      );
      expect(r.ok).toBe(true);
    });

    it('rejects wrong audience, issuer, expiry and tampering', async () => {
      const { keys, sign } = await signer();
      const k = async () => keys;
      expect(
        (
          await verifyJwt(
            await sign({ ...good(), aud: ['other'] }),
            'team.example.com',
            'aud-123',
            k,
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await verifyJwt(
            await sign({ ...good(), iss: 'https://evil.com' }),
            'team.example.com',
            'aud-123',
            k,
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await verifyJwt(
            await sign({ ...good(), exp: now() - 3600 }),
            'team.example.com',
            'aud-123',
            k,
          )
        ).ok,
      ).toBe(false);
      const token = await sign(good());
      const [h, , s] = token.split('.');
      const tampered = `${h}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...good(), email: 'evil@x' })))}.${s}`;
      expect((await verifyJwt(tampered, 'team.example.com', 'aud-123', k)).ok).toBe(false);
    });

    it('rejects tokens signed by an unknown key', async () => {
      const a = await signer();
      const b = await signer();
      expect(
        (await verifyJwt(await b.sign(good()), 'team.example.com', 'aud-123', async () => a.keys))
          .ok,
      ).toBe(false);
    });
  });
});

describe('settings and setup', () => {
  let s: { cookie: string; csrf: string };
  beforeEach(async () => {
    s = await login();
  });

  it('redirects the dashboard to setup until setup is complete', async () => {
    const res = await admin('/admin', s);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/setup');
  });

  it('validates settings and rejects unsafe values', async () => {
    const bad = await admin('/api/admin/settings/venue', s, {
      method: 'PUT',
      json: { name: 'Hall', address: '', map_url: 'javascript:alert(1)' },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { field: string }).field).toBe('map_url');
    const badDate = await admin('/api/admin/settings/event', s, {
      method: 'PUT',
      json: { date: '2027-02-30' },
    });
    expect(badDate.status).toBe(400);
  });

  it('completes setup only once the essentials are present', async () => {
    expect((await admin('/api/admin/setup/complete', s, { method: 'POST', json: {} })).status).toBe(
      400,
    );
    await admin('/api/admin/settings/couple', s, {
      method: 'PUT',
      json: { name_one: 'Alex', name_two: 'Sam' },
    });
    await admin('/api/admin/settings/event', s, { method: 'PUT', json: { date: '2030-06-01' } });
    expect((await admin('/api/admin/setup/complete', s, { method: 'POST', json: {} })).status).toBe(
      200,
    );
    expect((await admin('/admin', s)).status).toBe(200);
  });

  it('reports a Turnstile warning when it is not configured', async () => {
    const body = (await (await admin('/api/admin/session', s)).json()) as {
      warnings: { message: string }[];
    };
    expect(body.warnings.some((w) => w.message.includes('Turnstile'))).toBe(true);
  });
});

describe('invites, import and export', () => {
  let s: { cookie: string; csrf: string };
  beforeEach(async () => {
    await markReady();
    s = await login();
  });

  const csv = [
    'household,guest,plus_one,max_party_size,evening',
    'The Example Family,Pat Example,no,3,no',
    'The Example Family,Chris Example,yes,3,no',
    'Robin Sample,Robin Sample,,,',
  ].join('\n');

  it('previews then imports a CSV, generating unambiguous codes', async () => {
    const preview = await admin('/api/admin/import', s, {
      method: 'POST',
      json: { csv, dry_run: true },
    });
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { households: unknown[] }).households).toHaveLength(2);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM invites').first<{ n: number }>())?.n,
    ).toBe(0);

    const res = await admin('/api/admin/import', s, {
      method: 'POST',
      json: { csv, dry_run: false },
    });
    expect(res.status).toBe(201);
    const { results } = await env.DB.prepare('SELECT code, max_party_size FROM invites').all<{
      code: string;
      max_party_size: number;
    }>();
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    // Max party size defaults to named guests + permitted plus ones.
    expect(results.map((r) => r.max_party_size).sort()).toEqual([1, 3]);
  });

  it('rejects a CSV with problems, importing nothing', async () => {
    const broken = csv + '\nNo Guest,,no,,\nToo Small,Ann,yes,1,no';
    const res = await admin('/api/admin/import', s, {
      method: 'POST',
      json: { csv: broken, dry_run: false },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { line: number }[] };
    expect(body.errors.map((e) => e.line)).toEqual([5, 6]);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM invites').first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it('refuses evening rows while evening invites are off', async () => {
    await setSettings('evening', { enabled: false });
    const res = await admin('/api/admin/import', s, {
      method: 'POST',
      json: { csv: 'household,guest,evening\nA,B,yes', dry_run: true },
    });
    expect(res.status).toBe(422);
  });

  it('exports replies with formula-injection protection and only enabled columns', async () => {
    await setSettings('evening', { enabled: false });
    await seedInvite({
      id: 'i1',
      code: 'ABCDEF',
      household: '=HYPERLINK("x")',
      max: 1,
      guests: [{ id: 'g1', name: 'Pat' }],
    });
    const raw = new Uint8Array(await (await admin('/api/admin/export.csv', s)).arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
    let text = new TextDecoder().decode(raw);
    expect(text.split('\r\n')[0]).toBe(
      '"household","code","link","guest_name","is_plus_one","attending","submitted_at"',
    );
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);

    await setSettings('features', { dietary: true, song_request: true, message: true });
    await setSettings('evening', { enabled: true });
    text = await (await admin('/api/admin/export.csv', s)).text();
    const header = text.split('\r\n')[0]!;
    for (const col of ['invited_to', 'attending_as', 'dietary_notes', 'song_request', 'message']) {
      expect(header).toContain(col);
    }
  });

  it('resets a reply so the household can reply again', async () => {
    await seedInvite({
      id: 'i1',
      code: 'ABCDEF',
      household: 'H',
      max: 1,
      guests: [{ id: 'g1', name: 'Pat' }],
    });
    const submit = () =>
      fetchWorker('/api/rsvp/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.200' },
        body: JSON.stringify({ code: 'ABCDEF', attending: false }),
      });
    expect((await submit()).status).toBe(200);
    expect((await submit()).status).toBe(409);
    expect(
      (await admin('/api/admin/invites/i1/reset-reply', s, { method: 'POST', json: {} })).status,
    ).toBe(200);
    expect((await submit()).status).toBe(200);
  });

  it('locks the guest list after a reply', async () => {
    await seedInvite({
      id: 'i1',
      code: 'ABCDEF',
      household: 'H',
      max: 2,
      guests: [{ id: 'g1', name: 'Pat' }],
    });
    await env.DB.prepare(
      "INSERT INTO rsvps (id, wedding_id, invite_id, attending) VALUES ('r1', 'default', 'i1', 0)",
    ).run();
    const res = await admin('/api/admin/invites/i1', s, {
      method: 'PATCH',
      json: { guests: [{ name: 'Someone Else' }] },
    });
    expect(res.status).toBe(409);
  });
});

describe('images', () => {
  let s: { cookie: string; csrf: string };
  beforeEach(async () => {
    s = await login();
  });

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  async function upload(bytes: Uint8Array, type: string) {
    return fetchWorker('/api/admin/images', {
      method: 'POST',
      headers: { Cookie: s.cookie, Origin: BASE, 'X-CSRF-Token': s.csrf, 'Content-Type': type },
      body: bytes,
    });
  }

  it('accepts a real PNG and serves it publicly with nosniff', async () => {
    const res = await upload(png, 'image/png');
    expect(res.status).toBe(201);
    const { url } = (await res.json()) as { url: string };
    const media = await fetchWorker(url);
    expect(media.status).toBe(200);
    expect(media.headers.get('Content-Type')).toBe('image/png');
    expect(media.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('refuses SVG and anything that is not really an image', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect((await upload(svg, 'image/png')).status).toBe(415);
    expect((await upload(svg, 'image/svg+xml')).status).toBe(415);
  });

  it('refuses images over 1 MB', async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(png);
    expect((await upload(big, 'image/png')).status).toBe(413);
  });
});
