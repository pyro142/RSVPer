// Free-text sanitising for anything a guest or admin types.
//
// Output is always rendered with textContent / HTMLRewriter text APIs and CSV
// cells are formula-guarded on export, so the job here is not HTML escaping:
// it is keeping stored text tidy and bounded.

// C0/C1 control characters, plus bidi overrides that can disguise text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

/** Single-line text: names, titles. Collapses all whitespace. */
export function cleanLine(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFC').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return [...text].length > maxLength ? null : text;
}

/** Multi-line text: messages, notes. Keeps newlines, caps blank runs. */
export function cleanBlock(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;
  return [...text].length > maxLength ? null : text;
}

/** Distinguishes "empty" (null, fine) from "too long" (an error). */
export function tooLong(raw: unknown, maxLength: number): boolean {
  return typeof raw === 'string' && [...raw.trim()].length > maxLength;
}
