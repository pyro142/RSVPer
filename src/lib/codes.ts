// Invite codes: uppercase, unambiguous.
//
// The alphabet drops the characters people confuse when reading a code off a
// printed invite: O/0 and I/L/1 are all absent, so a misread can never land on
// a different valid code — it just fails to parse.
//
// 31 symbols: 5 characters ≈ 28.6 million codes, 6 characters ≈ 887 million.

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const MIN_CODE_LENGTH = 5;
export const MAX_CODE_LENGTH = 8;

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${MIN_CODE_LENGTH},${MAX_CODE_LENGTH}}$`);

/** A path segment that could be a personalised invite link, e.g. "/ABC23". */
export const CODE_PATH = new RegExp(
  `^/([${CODE_ALPHABET}]{${MIN_CODE_LENGTH},${MAX_CODE_LENGTH}})/?$`,
  'i',
);

/**
 * Uppercase and strip spaces/hyphens, so "ab 12-c" and "AB12C" are the same.
 * Deliberately strips nothing else: silently dropping junk could turn one
 * guest's typo into another guest's valid code.
 */
export function normaliseCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\s-]/g, '').toUpperCase().slice(0, 32);
}

export function isValidCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/**
 * One cryptographically random code, using rejection sampling: 256 is not a
 * multiple of 31, so naive `byte % 31` would bias the first few symbols.
 */
export function generateCode(length: number): string {
  if (!Number.isInteger(length) || length < MIN_CODE_LENGTH || length > MAX_CODE_LENGTH) {
    throw new Error(`Code length must be ${MIN_CODE_LENGTH}–${MAX_CODE_LENGTH}`);
  }
  const n = CODE_ALPHABET.length;
  const max = Math.floor(256 / n) * n; // 248
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte >= max) continue;
      out += CODE_ALPHABET[byte % n];
      if (out.length === length) break;
    }
  }
  return out;
}
