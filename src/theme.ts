// Colour themes.
//
// A wedding stores exactly two colours: a background and a brand colour.
// Everything else (text, muted text, lines, tints, button text) is derived
// here as CSS custom properties, mostly with color-mix(), so any pair stays
// readable. Premade themes in the admin only set these two values; the theme
// itself is never stored.
//
// The few decisions color-mix can't make (is the background dark? should
// button text be white or near-black?) are made here, server-side, so no
// colour maths ships to guests' browsers.

export const HEX = /^#[0-9a-fA-F]{6}$/;

export interface ThemeColours {
  background: string | null;
  brand: string | null;
}

/** RSVPer's own palette ("the template"), from public/css/tokens.css. */
const TEMPLATE = {
  light: { bg: '#FFF8EF', ink: '#4A4038', brand: '#E66C78' },
  dark: { bg: '#201A24', ink: '#EFE6DC', brand: '#F0808C' },
};

const LIGHT_INK_ON_DARK = '#F5F5F4';
const NEAR_BLACK = '#1A1A1C';

export function validHex(value: unknown): string | null {
  return typeof value === 'string' && HEX.test(value) ? value.toUpperCase() : null;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.round(Math.min(255, Math.max(0, v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  );
}

function linear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** OKLab, for perceptual comparisons. */
export function oklab(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabDistance(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** Dark enough that text should flip to light. */
export function isDark(hex: string): boolean {
  return oklab(hex)[0] < 0.6;
}

/** White or near-black, whichever reads better on this colour. */
export function onAccent(hex: string): string {
  return contrast(hex, '#FFFFFF') >= contrast(hex, NEAR_BLACK) ? '#FFFFFF' : NEAR_BLACK;
}

function mix(a: string, b: string, weightA: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(
    [0, 1, 2].map((i) => x[i]! * weightA + y[i]! * (1 - weightA)) as [number, number, number],
  );
}

/** Accent tokens for a brand colour on a given surface. */
function accentVars(brand: string, surface: string, dark: boolean): string[] {
  return [
    `--rose: ${brand}`,
    `--rose-deep: color-mix(in srgb, ${brand} 80%, ${dark ? 'white' : 'black'})`,
    `--submit-ink: ${onAccent(brand)}`,
    `--rose-tint: color-mix(in srgb, ${brand} 12%, ${surface})`,
    `--rose-tint-2: color-mix(in srgb, ${brand} 18%, ${surface})`,
  ];
}

/** Surface tokens derived from a background colour. */
function surfaceVars(surface: string): string[] {
  const dark = isDark(surface);
  const ink = dark ? LIGHT_INK_ON_DARK : TEMPLATE.light.ink;
  const lift = dark ? 'white' : 'black';
  return [
    `color-scheme: ${dark ? 'dark' : 'light'}`,
    `--bg: ${surface}`,
    `--card-bg: color-mix(in srgb, ${surface} ${dark ? 92 : 55}%, white)`,
    `--surface-2: color-mix(in srgb, ${surface} 94%, ${lift})`,
    `--input-bg: color-mix(in srgb, ${surface} ${dark ? 82 : 30}%, ${dark ? 'black' : 'white'})`,
    `--row-bg: color-mix(in srgb, ${surface} ${dark ? 88 : 35}%, white)`,
    `--sub-row-bg: color-mix(in srgb, ${surface} 94%, ${lift})`,
    `--code-bg: color-mix(in srgb, ${ink} 8%, ${surface})`,
    `--ink: ${ink}`,
    `--ink-soft: color-mix(in srgb, ${ink} 72%, ${surface})`,
    `--line: color-mix(in srgb, ${ink} 12%, transparent)`,
    `--row-checked-line: color-mix(in srgb, ${ink} 22%, transparent)`,
    `--toast-bg: ${ink}`,
    `--toast-ink: ${surface}`,
  ];
}

/** The template's dark tokens, reused when a custom background is dark. */
const DARK_EXTRAS = [
  '--gold: #E5B65C',
  '--sage: #A8C08F',
  '--sage-soft: #2A3327',
  '--error-bg: #3A252C',
  '--error-line: #5E3742',
  '--error-ink: #F2A2AC',
  '--danger: #E0707E',
  '--danger-hover: #EC8894',
  '--pill-ok-bg: #2A3A2A',
  '--pill-ok-ink: #A8C08F',
  '--pill-no-bg: #3A252C',
  '--pill-no-ink: #F0A0AA',
  '--pill-wait-bg: #3A3020',
  '--pill-wait-ink: #E5B65C',
  '--pill-eve-bg: #332A3D',
  '--pill-eve-ink: #C9A9D1',
  '--pill-choice-bg: #24313D',
  '--pill-choice-ink: #92B8D6',
  '--backdrop: rgba(0, 0, 0, 0.62)',
  '--card-shadow: 0 34px 80px -30px rgba(0, 0, 0, 0.6), 0 2px 12px rgba(0, 0, 0, 0.35)',
];

/** The template's light tokens, restored when a custom background is light
 * (so the admin's dark mode doesn't leave dark pills or errors behind). */
const LIGHT_EXTRAS = [
  '--gold: #D9A441',
  '--sage: #7E9668',
  '--sage-soft: #EEF2E8',
  '--error-bg: #FDF0F1',
  '--error-line: #F5D9DC',
  '--error-ink: #C6505F',
  '--danger: #C6505F',
  '--danger-hover: #A63F4C',
  '--pill-ok-bg: #EEF2E8',
  '--pill-ok-ink: #7E9668',
  '--pill-no-bg: #FDF0F1',
  '--pill-no-ink: #C6505F',
  '--pill-wait-bg: #FBF1DC',
  '--pill-wait-ink: #9A7220',
  '--pill-eve-bg: #EFE6F4',
  '--pill-eve-ink: #6B4C7A',
  '--pill-choice-bg: #E4EDF4',
  '--pill-choice-ink: #3F6280',
  '--backdrop: rgba(74, 56, 48, 0.42)',
  '--card-shadow: 0 30px 70px -30px rgba(74, 56, 48, 0.28), 0 2px 10px rgba(74, 56, 48, 0.06)',
];

/**
 * CSS for a wedding's colours, or '' when both are unset.
 *
 * - Default look (light guest card, light admin): both colours apply.
 * - Evening guests and admin dark mode keep their dark surface, but take the
 *   brand colour (lifted if it would vanish on the dark background).
 *
 * Only validated hex values are ever interpolated, so this is safe to put in
 * a <style> element.
 */
export function themeCss(theme: ThemeColours): string {
  const background = validHex(theme.background);
  const brand = validHex(theme.brand);
  if (!background && !brand) return '';

  const rules: string[] = [];
  const nightBg = TEMPLATE.dark.bg;
  // Keep the brand visible against the night surface.
  const nightBrand =
    brand && (oklabDistance(brand, nightBg) < 0.3 ? mix(brand, '#FFFFFF', 0.55) : brand);

  if (background) {
    // A chosen background IS the light/dark choice: it applies to the guest
    // card and to the admin whatever the admin's own dark-mode toggle says
    // (the toggle is hidden then). Only evening guests keep the night look.
    const dark = isDark(background);
    const vars = [...surfaceVars(background), ...(dark ? DARK_EXTRAS : LIGHT_EXTRAS)];
    if (brand) vars.push(...accentVars(brand, background, dark));
    rules.push(`:root:not([data-theme="evening"]) { ${vars.join('; ')}; }`);
    if (nightBrand) {
      rules.push(
        `:root[data-theme="evening"] { ${accentVars(nightBrand, nightBg, true).join('; ')}; }`,
      );
    }
    return rules.join('\n');
  }

  // Brand only: the default light look takes the brand; the night look
  // (evening guests, admin dark mode) takes a version that stays visible.
  rules.push(
    `:root:not([data-theme]) { ${accentVars(brand!, TEMPLATE.light.bg, false).join('; ')}; }`,
    `:root[data-theme="evening"], :root[data-theme="dark"] { ${accentVars(nightBrand!, nightBg, true).join('; ')}; }`,
  );
  return rules.join('\n');
}
