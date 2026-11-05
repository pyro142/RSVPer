// Fixed-window rate limiting backed by D1 (free tier: no WAF rules needed).
//
// FAILS CLOSED. If the counter can't be read or written, the request is
// refused. Every endpoint this protects needs D1 to do its job anyway, so when
// D1 is failing, failing closed costs a real guest nothing extra — and it means
// a broken limiter can never become an open door.

export interface Limit {
  limit: number;
  windowSeconds: number;
}

export interface LimitResult {
  ok: boolean;
  hits: number;
  retryAfter: number;
}

function bucketFor(key: string, windowSeconds: number, now: number) {
  const windowStart = now - (now % windowSeconds);
  return {
    bucket: `${key}:${windowSeconds}:${windowStart}`,
    expiresAt: windowStart + windowSeconds,
  };
}

/** Count a hit and report whether the caller is now over the limit. */
export async function hit(db: D1Database, key: string, rule: Limit): Promise<LimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const { bucket, expiresAt } = bucketFor(key, rule.windowSeconds, now);
  try {
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (bucket, hits, expires_at) VALUES (?, 1, ?)
         ON CONFLICT (bucket) DO UPDATE SET hits = hits + 1
         RETURNING hits`,
      )
      .bind(bucket, expiresAt)
      .first<{ hits: number }>();
    await maybeSweep(db, now);
    const hits = row?.hits ?? Number.POSITIVE_INFINITY;
    return { ok: hits <= rule.limit, hits, retryAfter: expiresAt - now };
  } catch (err) {
    console.error('rate limit write failed; failing closed', err);
    return { ok: false, hits: Number.POSITIVE_INFINITY, retryAfter: 60 };
  }
}

/** Read the current count without adding to it. */
export async function peek(db: D1Database, key: string, rule: Limit): Promise<LimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const { bucket, expiresAt } = bucketFor(key, rule.windowSeconds, now);
  try {
    const row = await db
      .prepare('SELECT hits FROM rate_limits WHERE bucket = ?')
      .bind(bucket)
      .first<{ hits: number }>();
    const hits = row?.hits ?? 0;
    return { ok: hits < rule.limit, hits, retryAfter: expiresAt - now };
  } catch (err) {
    console.error('rate limit read failed; failing closed', err);
    return { ok: false, hits: Number.POSITIVE_INFINITY, retryAfter: 60 };
  }
}

/** Drop expired buckets on ~2% of writes; the table stays tiny. */
async function maybeSweep(db: D1Database, now: number): Promise<void> {
  if (Math.random() > 0.02) return;
  try {
    await db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now).run();
  } catch {
    // Housekeeping only.
  }
}
