// Admin password hashing with PBKDF2 (SHA-256) via WebCrypto (no dependencies).
//
// 100,000 iterations is the most the Workers runtime allows for PBKDF2. The
// stored format records algorithm, iterations and salt, so the cost can be
// raised later without breaking existing hashes.

import { base64UrlDecode, base64UrlEncode, timingSafeEqual } from '../lib/crypto';

const ITERATIONS = 100_000;
const SCHEME = 'pbkdf2-sha256';
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return base64UrlEncode(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return [SCHEME, String(ITERATIONS), base64UrlEncode(salt), hash].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  const iterations = Number(iter);
  if (scheme !== SCHEME || !Number.isInteger(iterations) || iterations < 1 || !salt || !hash) {
    return false;
  }
  if (iterations > ITERATIONS) return false;
  const actual = await derive(password, base64UrlDecode(salt), iterations);
  return timingSafeEqual(actual, hash);
}

/** Problems with a proposed new password, or null if it's acceptable. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || !password) return 'Please enter a password.';
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. A few random words works well.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return 'That password is too long.';
  return null;
}
