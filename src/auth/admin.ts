// The one gate in front of every /admin page and /api/admin/* endpoint.
//
// src/index.ts routes everything under those prefixes through
// `authenticateAdmin` before any handler runs, so a new admin endpoint is
// protected by existing, not by remembering to call something.
//
// There is no development bypass of any kind: local dev uses password mode
// with the values in .dev.vars, exactly like production.

import type { Env } from '../env';
import { timingSafeEqual } from '../lib/crypto';
import { ConfigError } from '../lib/identity';
import { verifyAccess } from './access';
import { readSession, type SessionRow } from './session';

export type AuthMode = 'password' | 'access';

export function authMode(env: Env): AuthMode {
  const mode = (env.ADMIN_AUTH_MODE || 'password').trim().toLowerCase();
  if (mode === 'password' || mode === 'access') return mode;
  // An unknown value must never fall through to "no auth".
  throw new ConfigError(`ADMIN_AUTH_MODE must be "password" or "access", not "${mode}".`);
}

export type AdminAuth =
  | { ok: true; mode: 'password'; session: SessionRow; identity: string }
  | { ok: true; mode: 'access'; session: null; identity: string }
  | { ok: false; mode: AuthMode; status: 401 | 403; reason: string };

export async function authenticateAdmin(
  request: Request,
  env: Env,
  weddingId: string,
): Promise<AdminAuth> {
  const mode = authMode(env);

  if (mode === 'access') {
    const result = await verifyAccess(request, env);
    if (!result.ok) return { ok: false, mode, status: 403, reason: result.reason };
    return { ok: true, mode, session: null, identity: result.email };
  }

  const session = await readSession(env.DB, env, request, weddingId);
  if (!session) return { ok: false, mode, status: 401, reason: 'no-session' };
  return { ok: true, mode, session, identity: 'admin' };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for state-changing admin requests. Three independent checks:
 *   1. The request must come from this origin (Origin, or Sec-Fetch-Site).
 *   2. JSON bodies are required by readJson(), which cross-site forms can't send.
 *   3. In password mode, an X-CSRF-Token header must match the session's token.
 */
export async function csrfProblem(request: Request, auth: AdminAuth): Promise<string | null> {
  if (SAFE_METHODS.has(request.method)) return null;

  const expected = new URL(request.url).origin;
  const origin = request.headers.get('Origin');
  if (origin) {
    if (origin !== expected) return 'cross-origin';
  } else if (request.headers.get('Sec-Fetch-Site') !== 'same-origin') {
    return 'no-origin';
  }

  if (auth.ok && auth.mode === 'password') {
    const token = request.headers.get('X-CSRF-Token') || '';
    if (!token || !(await timingSafeEqual(token, auth.session.csrf_token))) return 'bad-token';
  }
  return null;
}
