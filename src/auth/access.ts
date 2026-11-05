// Cloudflare Access (Zero Trust) authentication for ADMIN_AUTH_MODE=access.
//
// Full JWT verification on every admin request rather than trusting that an
// Access policy exists at the edge: the Worker is also reachable on its
// *.workers.dev hostname (and preview URLs), where an Access policy for your
// custom domain doesn't apply. A forged Cf-Access-Jwt-Assertion header fails
// here because it can't carry a valid signature from your team's keys.

import type { Env } from '../env';
import { base64UrlDecode } from '../lib/crypto';
import { ConfigError } from '../lib/identity';

const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;

export type AccessResult = { ok: true; email: string } | { ok: false; reason: string };

function config(env: Env): { teamDomain: string; aud: string } {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = env.ACCESS_AUD || '';
  if (!teamDomain || !aud || !/^[a-z0-9.-]+$/i.test(teamDomain)) {
    throw new ConfigError(
      'ADMIN_AUTH_MODE is "access" but ACCESS_TEAM_DOMAIN / ACCESS_AUD are missing or invalid.',
    );
  }
  return { teamDomain, aud };
}

export async function verifyAccess(request: Request, env: Env): Promise<AccessResult> {
  const { teamDomain, aud } = config(env);
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') || readCookie(request, 'CF_Authorization');
  if (!token) return { ok: false, reason: 'no-token' };
  return verifyJwt(token, teamDomain, aud);
}

export async function verifyJwt(
  token: string,
  teamDomain: string,
  expectedAud: string,
  fetchKeys: (teamDomain: string) => Promise<Jwk[]> = fetchJwks,
): Promise<AccessResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, sig] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: {
    exp?: number;
    nbf?: number;
    iss?: string;
    aud?: string | string[];
    email?: string;
  };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(h)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(p)));
  } catch {
    return { ok: false, reason: 'undecodable' };
  }

  // Pin the algorithm: accepting whatever the token asks for is how "alg:none"
  // and HMAC-with-the-public-key forgeries work.
  if (header.alg !== 'RS256') return { ok: false, reason: 'unexpected-alg' };

  const keys = await fetchKeys(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown-key' };

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) return { ok: false, reason: 'bad-signature' };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < now) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > now) {
    return { ok: false, reason: 'not-yet-valid' };
  }
  if (payload.iss !== `https://${teamDomain}`) return { ok: false, reason: 'wrong-issuer' };
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(expectedAud)) return { ok: false, reason: 'wrong-audience' };

  return { ok: true, email: payload.email || 'unknown' };
}

async function fetchJwks(teamDomain: string): Promise<Jwk[]> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch Access certs: HTTP ${res.status}`);
  const { keys } = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { url, keys: keys || [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
