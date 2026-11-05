// Onboarding: deadline rules, the admin-only live preview, defaults.

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/settings';
import { BASE, fetchWorker } from './helpers';

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
      redirect: 'manual',
      headers: {
        Cookie: cookie,
        Origin: BASE,
        'X-CSRF-Token': csrf,
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
}

describe('RSVP deadline vs wedding date', () => {
  let admin: Awaited<ReturnType<typeof adminSession>>;
  beforeEach(async () => {
    admin = await adminSession();
    await admin('/api/admin/settings/event', 'PUT', { date: '2030-06-15' });
  });

  it('refuses a deadline after the wedding', async () => {
    const res = await admin('/api/admin/settings/rsvp', 'PUT', { deadline: '2030-06-16' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'deadline' });
  });

  it('accepts a deadline on or before the wedding', async () => {
    expect(
      (await admin('/api/admin/settings/rsvp', 'PUT', { deadline: '2030-06-15' })).status,
    ).toBe(200);
    expect(
      (await admin('/api/admin/settings/rsvp', 'PUT', { deadline: '2030-05-01' })).status,
    ).toBe(200);
  });

  it('refuses moving the wedding before an existing deadline', async () => {
    await admin('/api/admin/settings/rsvp', 'PUT', { deadline: '2030-05-01' });
    const res = await admin('/api/admin/settings/event', 'PUT', { date: '2030-04-01' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'date' });
  });
});

describe('live preview', () => {
  it('is admin-only', async () => {
    const res = await fetchWorker('/admin/preview', { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('renders the card in preview mode, embeddable only by the admin itself', async () => {
    const admin = await adminSession();
    const res = await admin('/admin/preview');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'");
    expect(res.headers.get('X-Frame-Options')).toBeNull();
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    const html = await res.text();
    expect(html).toContain('data-slot="name-one"');
    expect(html).toContain('/js/preview.js');
    expect(html).not.toContain('challenges.cloudflare.com');
  });

  it('leaves the real guest card unchanged', async () => {
    const res = await fetchWorker('/');
    const html = await res.text();
    expect(html).not.toContain('data-slot');
    expect(html).not.toContain('/js/preview.js');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('the wizard may embed only same-origin frames; guest pages none', async () => {
    const admin = await adminSession();
    expect((await admin('/admin/setup')).headers.get('Content-Security-Policy')).toContain(
      "frame-src 'self';",
    );
    expect((await fetchWorker('/')).headers.get('Content-Security-Policy')).toContain(
      "frame-src 'none';",
    );
  });

  it('other admin pages still refuse framing', async () => {
    const admin = await adminSession();
    const res = await admin('/admin/setup');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('defaults', () => {
  it('turns evening invites on for new weddings', () => {
    expect(DEFAULTS.evening.enabled).toBe(true);
  });
});
