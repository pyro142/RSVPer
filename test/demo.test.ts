// The public demo: per-visitor sandboxes, no sign-in, never the real wedding.

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import mainConfig from '../wrangler.jsonc?raw';
import demoConfig from '../wrangler.demo.jsonc?raw';
import worker from '../src/index';
import type { Env } from '../src/env';
import { BASE, markReady, seedInvite } from './helpers';

const demoEnv = { ...env, DEMO_MODE: 'true' } as Env;

/** A browser: remembers its demo cookie between requests. */
function visitor(ip = '203.0.113.9') {
  let cookie = '';
  return async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    headers.set('CF-Connecting-IP', ip);
    if (init.method && init.method !== 'GET') headers.set('Origin', BASE);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(BASE + path, { ...init, headers, redirect: 'manual' }),
      demoEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const set = res.headers.get('Set-Cookie');
    if (set?.startsWith('__Host-rsvper_demo=')) cookie = set.split(';')[0]!;
    return res;
  };
}

describe('demo mode', () => {
  it('is only switched on by the separate demo config', () => {
    expect(mainConfig).not.toContain('DEMO_MODE');
    expect(demoConfig).toContain('"DEMO_MODE": "true"');
    expect(demoConfig).toContain('"database_name": "rsvper-demo"');
  });

  it('gives a visitor a seeded sandbox and the admin with no sign-in', async () => {
    const v = visitor();
    const page = await v('/admin');
    expect(page.status).toBe(200);
    expect(page.headers.get('Set-Cookie')).toMatch(/^__Host-rsvper_demo=demo-/);
    expect(await page.text()).toContain('demo-banner');
    const invites = (await (await v('/api/admin/invites')).json()) as { invites: unknown[] };
    expect(invites.invites).toHaveLength(8);
  });

  it('keeps each visitor’s changes to themselves', async () => {
    const a = visitor('203.0.113.1');
    const b = visitor('203.0.113.2');
    await a('/admin');
    await b('/admin');
    await a('/api/admin/settings/couple', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name_one: 'Changed', name_two: 'ByA' }),
    });
    expect(await (await a('/')).text()).toContain('Changed');
    expect(await (await b('/')).text()).not.toContain('Changed');
  });

  it('never reads or touches the real wedding', async () => {
    await markReady();
    await seedInvite({
      id: 'real',
      code: 'RE4K23',
      household: 'Real Guests',
      max: 1,
      guests: [{ id: 'rg', name: 'Real Person' }],
    });
    const v = visitor();
    const list = await (await v('/api/admin/invites')).text();
    expect(list).not.toContain('Real Guests');
    const lookup = await v('/api/rsvp/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'RE4K23' }),
    });
    expect(lookup.status).toBe(404);
  });

  it('a forged cookie just gets a fresh sandbox', async () => {
    const v = visitor();
    const res = await v('/admin', { headers: { Cookie: '__Host-rsvper_demo=default' } });
    expect(res.headers.get('Set-Cookie')).toMatch(/demo-/);
  });

  it('resets on request, and the old sandbox is gone', async () => {
    const v = visitor();
    await v('/admin');
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM weddings WHERE id LIKE 'demo-%'",
    ).first<{ n: number }>();
    const reset = await v('/demo/reset?to=admin', { method: 'POST' });
    expect(reset.status).toBe(303);
    expect(reset.headers.get('Location')).toBe('/admin');
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM weddings WHERE id LIKE 'demo-%'",
    ).first<{ n: number }>();
    expect(after!.n).toBe(before!.n - 1);
  });

  it('switches off password changes, Turnstile keys and uploads', async () => {
    const v = visitor();
    await v('/admin');
    const json = { 'Content-Type': 'application/json' };
    expect(
      (await v('/api/admin/password', { method: 'POST', headers: json, body: '{}' })).status,
    ).toBe(403);
    expect(
      (await v('/api/admin/turnstile', { method: 'PUT', headers: json, body: '{}' })).status,
    ).toBe(403);
    expect(
      (
        await v('/api/admin/images', {
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
          body: new Uint8Array(10),
        })
      ).status,
    ).toBe(403);
  });

  it('cleans up expired sandboxes', async () => {
    const v = visitor();
    await v('/admin');
    await env.DB.prepare("UPDATE weddings SET demo_expires_at = 1 WHERE id LIKE 'demo-%'").run();
    await visitor('198.51.100.3')('/admin');
    const { n } = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM weddings WHERE id LIKE 'demo-%'",
    ).first<{ n: number }>())!;
    expect(n).toBe(1);
    expect(
      (await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM invites WHERE wedding_id LIKE 'demo-%'",
      ).first<{ n: number }>())!.n,
    ).toBe(8);
  });

  it('limits how many sandboxes one visitor can create', async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await visitor('192.0.2.77')('/admin')).status;
    expect(last).toBe(503);
  });

  it('is off without DEMO_MODE: real sign-in applies and demo routes do nothing', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(BASE + '/admin', { redirect: 'manual' }),
      env as Env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login');
  });
});
