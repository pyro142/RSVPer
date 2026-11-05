// Deploy-time safety: what the Deploy to Cloudflare button will prompt for,
// and Turnstile keys saved from the admin.

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import devVarsExample from '../.dev.vars.example?raw';
import pkg from '../package.json';
import worker from '../src/index';
import type { Env } from '../src/env';
import { BASE, fetchWorker, post, standardFixture } from './helpers';

describe('.dev.vars.example (the deploy form)', () => {
  const active = devVarsExample
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  it('only requires what a first deploy genuinely needs', () => {
    expect(active.map((l) => l.split('=')[0])).toEqual(['ADMIN_PASSWORD', 'SESSION_SECRET']);
  });

  it('ships no values, dev conveniences, bypasses or localhost URLs', () => {
    for (const line of active) expect(line).toMatch(/^[A-Z_]+=$/);
    expect(devVarsExample).not.toMatch(/localhost|127\.0\.0\.1|BYPASS|DISABLE_AUTH|DEV_/i);
  });

  it('documents every secret on the deploy form', () => {
    const described = Object.keys(pkg.cloudflare.bindings);
    for (const name of ['DB', 'ADMIN_PASSWORD', 'SESSION_SECRET'])
      expect(described).toContain(name);
  });

  it('applies migrations as part of deploy, by binding name', () => {
    expect(pkg.scripts.deploy).toContain('db:migrate:remote');
    expect(pkg.scripts['db:migrate:remote']).toBe('wrangler d1 migrations apply DB --remote');
    expect(pkg.scripts.deploy.indexOf('db:migrate:remote')).toBeLessThan(
      pkg.scripts.deploy.indexOf('wrangler deploy'),
    );
  });
});

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

const SITE = '1x00000000000000000000AA';
const SECRET = '1x0000000000000000000000000000000AA';

describe('Turnstile keys saved from the admin', () => {
  it('turn Turnstile on for guests without exposing the secret', async () => {
    await standardFixture();
    const admin = await adminSession();
    const bad = await admin('/api/admin/turnstile', 'PUT', {
      site_key: 'nope',
      secret_key: SECRET,
    });
    expect(bad.status).toBe(400);

    const saved = await admin('/api/admin/turnstile', 'PUT', {
      site_key: SITE,
      secret_key: SECRET,
    });
    expect(saved.status).toBe(200);
    const body = await saved.text();
    expect(body).not.toContain(SECRET);
    expect(JSON.parse(body)).toMatchObject({
      source: 'settings',
      site_key: SITE,
      secret_set: true,
    });
    expect(await (await admin('/api/admin/settings')).text()).not.toContain(SECRET);

    // Guest card now loads the widget, and CSP allows it.
    const card = await fetchWorker('/');
    expect(card.headers.get('Content-Security-Policy')).toContain('challenges.cloudflare.com');
    expect(await card.text()).toContain('turnstile/v0/api.js');

    // Submitting without a token is refused before anything is written.
    const res = await post('/api/rsvp/submit', { code: 'ABCDEF', attending: false });
    expect(res.status).toBe(403);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM rsvps').first<{ n: number }>())?.n,
    ).toBe(0);

    // And can be turned off again.
    expect((await admin('/api/admin/turnstile', 'DELETE')).status).toBe(200);
    expect((await post('/api/rsvp/submit', { code: 'ABCDEF', attending: false })).status).toBe(200);
  });

  it('defer to deploy-time secrets when those are set', async () => {
    const ctx = createExecutionContext();
    const login = await worker.fetch(
      new Request(BASE + '/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: BASE },
        body: JSON.stringify({ password: 'test-admin-password-123' }),
      }),
      env as Env,
      ctx,
    );
    const cookie = (login.headers.get('Set-Cookie') || '').split(';')[0]!;
    const res = await worker.fetch(
      new Request(BASE + '/api/admin/turnstile', { headers: { Cookie: cookie } }),
      { ...env, TURNSTILE_SITE_KEY: SITE, TURNSTILE_SECRET_KEY: SECRET } as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await res.json()).toMatchObject({ source: 'deploy', site_key: SITE });
  });
});

describe('misconfiguration', () => {
  it('tells the admin plainly when ADMIN_PASSWORD is too short', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(BASE + '/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: BASE },
        body: JSON.stringify({ password: 'x' }),
      }),
      { ...env, ADMIN_PASSWORD: 'short' } as Env,
      ctx,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain('ADMIN_PASSWORD');
  });

  it('never reveals config details to guests', async () => {
    await standardFixture();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(BASE + '/api/rsvp/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'ABCDEF' }),
      }),
      { ...env, SESSION_SECRET: '' } as Env,
      ctx,
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('SESSION_SECRET');
  });
});
