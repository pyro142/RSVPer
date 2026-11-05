// Colour themes: storage rules, derived tokens, and the acceptance checks.

import { beforeEach, describe, expect, it } from 'vitest';
import coloursJs from '../public/js/admin/colours.js?raw';
import { contrast, isDark, oklabDistance, onAccent, themeCss } from '../src/theme';
import { BASE, fetchWorker, markReady } from './helpers';

const premade = [...coloursJs.matchAll(/\['([^']+)', '(#[0-9A-F]{6})', '(#[0-9A-F]{6})'\]/g)].map(
  (m) => ({ name: m[1]!, background: m[2]!, brand: m[3]! }),
);

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

/** The ink the theme CSS will use on this background. */
function inkFor(background: string): string {
  return isDark(background) ? '#F5F5F4' : '#4A4038';
}

describe('premade themes (acceptance)', () => {
  it('has seven light and seven dark themes', () => {
    expect(premade).toHaveLength(14);
    expect(premade.slice(0, 7).every((t) => !isDark(t.background))).toBe(true);
    expect(premade.slice(7).every((t) => isDark(t.background))).toBe(true);
  });

  for (const t of premade) {
    it(`${t.name}: readable text, buttons and a visible brand`, () => {
      // Body text on the background.
      expect(contrast(inkFor(t.background), t.background)).toBeGreaterThanOrEqual(7);
      // Text on buttons.
      expect(contrast(onAccent(t.brand), t.brand)).toBeGreaterThanOrEqual(4.5);
      // Brand stands out from the background (no low-contrast warning).
      expect(oklabDistance(t.brand, t.background)).toBeGreaterThanOrEqual(0.2);
    });
  }

  it('dark themes turn text light with no other setting', () => {
    const css = themeCss({ background: '#0F1B2D', brand: '#E0A526' });
    expect(css).toContain('--ink: #F5F5F4');
    expect(css).toContain('color-scheme: dark');
  });

  it('lines are a mix of the text colour, so they show on light and dark', () => {
    expect(themeCss({ background: '#0A0A0A', brand: null })).toContain(
      '--line: color-mix(in srgb, #F5F5F4 12%, transparent)',
    );
  });
});

describe('theme CSS', () => {
  it('is empty when no colours are set, so the default palette applies', () => {
    expect(themeCss({ background: null, brand: null })).toBe('');
  });

  it('ignores anything that is not a 6-digit hex', () => {
    expect(themeCss({ background: 'red', brand: '#FFF' })).toBe('');
    expect(themeCss({ background: '#000000;}</style><script>', brand: null })).toBe('');
  });

  it('a brand alone keeps the default surface and text', () => {
    const css = themeCss({ background: null, brand: '#177AED' });
    expect(css).toContain('--rose: #177AED');
    expect(css).not.toContain('--bg:');
    expect(css).not.toContain('--ink:');
  });

  it('keeps evening guests on a dark surface but with the brand colour', () => {
    const css = themeCss({ background: '#FFFFFF', brand: '#1B6068' });
    expect(css).toContain(':root[data-theme="evening"]');
    // A dark teal would vanish on the night background, so it is lifted.
    const night = css.split('\n')[1]!;
    expect(night).not.toContain('--rose: #1B6068');
  });
});

describe('storing colours', () => {
  let admin: Awaited<ReturnType<typeof adminSession>>;
  beforeEach(async () => {
    admin = await adminSession();
  });

  it('merges: changing one colour never overwrites the other', async () => {
    await admin('/api/admin/settings/theme', 'PUT', { background: '#0f1b2d', brand: '#E0A526' });
    const res = await admin('/api/admin/settings/theme', 'PUT', { brand: '#38BDF8' });
    expect(await res.json()).toMatchObject({ value: { background: '#0F1B2D', brand: '#38BDF8' } });
  });

  it('an empty string clears a colour (back to the default)', async () => {
    await admin('/api/admin/settings/theme', 'PUT', { background: '#0F1B2D', brand: '#E0A526' });
    const res = await admin('/api/admin/settings/theme', 'PUT', { background: '' });
    expect(await res.json()).toMatchObject({ value: { background: null, brand: '#E0A526' } });
  });

  it('rejects invalid colours', async () => {
    expect((await admin('/api/admin/settings/theme', 'PUT', { brand: 'blue' })).status).toBe(400);
    expect((await admin('/api/admin/settings/theme', 'PUT', { brand: '#12345' })).status).toBe(400);
  });

  it('applies the colours to the guest card and admin pages', async () => {
    await markReady();
    await admin('/api/admin/settings/theme', 'PUT', { background: '#0F1B2D', brand: '#E0A526' });
    expect(await (await fetchWorker('/')).text()).toContain('--rose: #E0A526');
    expect(await (await admin('/admin')).text()).toContain('--rose: #E0A526');
  });

  it('serves preview CSS to admins only, and only for valid colours', async () => {
    expect(
      (await fetchWorker('/admin/theme.css?brand=%23E0A526', { redirect: 'manual' })).status,
    ).toBe(302);
    const ok = await admin('/admin/theme.css?brand=%23E0A526');
    expect(ok.headers.get('Content-Type')).toContain('text/css');
    expect(await ok.text()).toContain('--rose: #E0A526');
    const bad = await admin('/admin/theme.css?brand=%3C%2Fstyle%3E');
    expect(await bad.text()).toBe('');
  });
});
