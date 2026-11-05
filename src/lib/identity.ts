// Hashed client identity for rate limiting and audit.
//
// Raw IPs are never stored. They're HMAC'd with a key derived from
// SESSION_SECRET, so the hash can't be reversed by enumerating the (small)
// IPv4 space, and no extra secret is needed at deploy time.

import type { Env } from '../env';
import { deriveHmacKey, hmacHex } from './crypto';
import { clientIp } from './http';

export class ConfigError extends Error {}

let cached: { secret: string; key: CryptoKey } | null = null;

export function requireSessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new ConfigError('SESSION_SECRET is missing or shorter than 32 characters.');
  }
  return secret;
}

/**
 * The unit rate limits count against. IPv4: the address. IPv6: the /64
 * network, because one household or attacker normally controls a whole /64
 * and could otherwise rotate addresses to dodge per-IP limits.
 */
export function rateLimitKey(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  return (
    groups
      .slice(0, 4)
      .map((g) => g.replace(/^0+(?=.)/, ''))
      .join(':') + '::/64'
  );
}

export async function ipHash(request: Request, env: Env): Promise<string> {
  const secret = requireSessionSecret(env);
  if (!cached || cached.secret !== secret) {
    cached = { secret, key: await deriveHmacKey(secret, 'ip-hash') };
  }
  return (await hmacHex(cached.key, rateLimitKey(clientIp(request)))).slice(0, 32);
}
