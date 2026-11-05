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

export async function ipHash(request: Request, env: Env): Promise<string> {
  const secret = requireSessionSecret(env);
  if (!cached || cached.secret !== secret) {
    cached = { secret, key: await deriveHmacKey(secret, 'ip-hash') };
  }
  return (await hmacHex(cached.key, clientIp(request))).slice(0, 32);
}
