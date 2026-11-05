// Cloudflare Turnstile — optional, verified server-side, fails closed.

import type { Env } from '../env';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const TURNSTILE_KEY = /^[0-3]x[A-Za-z0-9_-]{10,100}$/;

/**
 * Fill in Turnstile keys saved from the admin when the deploy-time secrets
 * aren't set. Secrets always win, so an operator can pin keys at deploy time.
 */
export function withStoredTurnstile(
  env: Env,
  stored: { site_key: string; secret_key: string } | null,
): Env {
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) return env;
  if (!stored) return env;
  return { ...env, TURNSTILE_SITE_KEY: stored.site_key, TURNSTILE_SECRET_KEY: stored.secret_key };
}

/** Turnstile is on only when both keys are configured. */
export function turnstileEnabled(env: Env): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstile(
  env: Env,
  token: unknown,
  remoteIp: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: false, reason: 'not-configured' };
  if (typeof token !== 'string' || !token || token.length > 4096) {
    return { ok: false, reason: 'missing-token' };
  }

  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (remoteIp && remoteIp !== 'local') body.append('remoteip', remoteIp);

  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    return data.success
      ? { ok: true }
      : { ok: false, reason: (data['error-codes'] || []).join(',') || 'rejected' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
