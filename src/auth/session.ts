// Admin sessions for ADMIN_AUTH_MODE=password.
//
// The cookie holds a random 256-bit id. The database stores only an HMAC of
// that id (keyed from SESSION_SECRET), so:
//   - a stolen database can't be turned into working cookies, and
//   - a forged cookie can't be made without SESSION_SECRET.
// Sessions are server-side, so logout and password changes revoke them.

import type { Env } from '../env';
import { deriveHmacKey, hmacHex, randomToken } from '../lib/crypto';
import { requireSessionSecret } from '../lib/identity';
import { readCookie } from './access';

export const SESSION_COOKIE = '__Host-rsvper_admin';
export const SESSION_TTL_S = 7 * 24 * 3600;

let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function sessionKey(env: Env): Promise<CryptoKey> {
  const secret = requireSessionSecret(env);
  if (!cachedKey || cachedKey.secret !== secret) {
    cachedKey = { secret, key: await deriveHmacKey(secret, 'admin-session') };
  }
  return cachedKey.key;
}

export interface SessionRow {
  id: string;
  wedding_id: string;
  csrf_token: string;
  expires_at: number;
}

export async function sessionDbId(env: Env, rawId: string): Promise<string> {
  return hmacHex(await sessionKey(env), rawId);
}

export async function createSession(
  db: D1Database,
  env: Env,
  weddingId: string,
  ipHash: string | null,
): Promise<{ cookie: string; csrf: string }> {
  const rawId = randomToken(32);
  const csrf = randomToken(32);
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db
      .prepare('DELETE FROM admin_sessions WHERE wedding_id = ? AND expires_at < ?')
      .bind(weddingId, now),
    db
      .prepare(
        `INSERT INTO admin_sessions (id, wedding_id, csrf_token, created_at, expires_at, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(await sessionDbId(env, rawId), weddingId, csrf, now, now + SESSION_TTL_S, ipHash),
  ]);
  return { cookie: sessionCookie(rawId, SESSION_TTL_S), csrf };
}

export async function readSession(
  db: D1Database,
  env: Env,
  request: Request,
  weddingId: string,
): Promise<SessionRow | null> {
  const rawId = readCookie(request, SESSION_COOKIE);
  if (!rawId || !/^[A-Za-z0-9_-]{43}$/.test(rawId)) return null;
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT id, wedding_id, csrf_token, expires_at FROM admin_sessions
        WHERE id = ? AND wedding_id = ? AND expires_at > ?`,
    )
    .bind(await sessionDbId(env, rawId), weddingId, now)
    .first<SessionRow>();
}

export async function destroySession(db: D1Database, session: SessionRow): Promise<void> {
  await db
    .prepare('DELETE FROM admin_sessions WHERE id = ? AND wedding_id = ?')
    .bind(session.id, session.wedding_id)
    .run();
}

/** Revoke every session for a wedding except, optionally, one to keep. */
export async function destroyOtherSessions(
  db: D1Database,
  weddingId: string,
  keepId: string | null,
): Promise<void> {
  await db
    .prepare('DELETE FROM admin_sessions WHERE wedding_id = ? AND id != ?')
    .bind(weddingId, keepId ?? '')
    .run();
}

export function sessionCookie(value: string, maxAge: number): string {
  // __Host- prefix: Secure, Path=/, no Domain — can't be set by a subdomain.
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return sessionCookie('', 0);
}
