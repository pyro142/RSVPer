// Brute-force protection for invite codes.
//
// The threat: someone guesses codes until one works, then submits a fake reply
// that locks the real household out. Layers, all configurable under Settings →
// Advanced:
//
//   1. Per-IP failure limits. Only FAILED lookups count, so a household
//      opening their own link repeatedly is never throttled. Hourly cool-off,
//      plus a daily cap that acts as a 24h lockout.
//   2. A site-wide circuit breaker. If failures across all IPs spike (a
//      distributed attempt), lookups then require Turnstile when it's
//      configured, or fall back to a much stricter per-IP limit when it isn't.
//   3. A per-IP ceiling on all lookups, so even valid traffic can't be used to
//      hammer the database.
//
// Everything fails closed (see ratelimit.ts).

import type { WeddingRepo } from '../db/repo';
import type { Settings } from '../settings';
import { hit, peek } from './ratelimit';

const HOUR = 3600;
const DAY = 86400;
/** Per-IP failures/hour while the breaker is tripped and Turnstile is off. */
const BREAKER_STRICT_PER_HOUR = 3;

export interface GuardVerdict {
  ok: boolean;
  retryAfter: number;
}

export class LookupGuard {
  constructor(
    private readonly repo: WeddingRepo,
    private readonly settings: Settings['security'],
    private readonly ipHash: string,
  ) {}

  private get keys() {
    return {
      hour: `lf:h:${this.repo.weddingId}:${this.ipHash}`,
      day: `lf:d:${this.repo.weddingId}:${this.ipHash}`,
      global: `lf:g:${this.repo.weddingId}`,
      all: `lk:${this.ipHash}`,
    };
  }

  /** Is the site-wide failure rate over the breaker threshold? */
  async breakerTripped(): Promise<boolean> {
    const r = await peek(this.repo.db, this.keys.global, {
      limit: this.settings.breaker_failures_per_hour,
      windowSeconds: HOUR,
    });
    return !r.ok;
  }

  /**
   * May this IP attempt a lookup right now? Counts toward the overall ceiling
   * but not toward failures.
   */
  async allow(opts: { strict: boolean }): Promise<GuardVerdict> {
    const ceiling = await hit(this.repo.db, this.keys.all, { limit: 60, windowSeconds: 60 });
    if (!ceiling.ok) return { ok: false, retryAfter: ceiling.retryAfter };

    const perHour = opts.strict
      ? Math.min(BREAKER_STRICT_PER_HOUR, this.settings.lookup_failures_per_hour)
      : this.settings.lookup_failures_per_hour;

    const [hour, day] = await Promise.all([
      peek(this.repo.db, this.keys.hour, { limit: perHour, windowSeconds: HOUR }),
      peek(this.repo.db, this.keys.day, {
        limit: this.settings.lookup_failures_per_day,
        windowSeconds: DAY,
      }),
    ]);
    if (!day.ok) return { ok: false, retryAfter: day.retryAfter };
    if (!hour.ok) return { ok: false, retryAfter: hour.retryAfter };
    return { ok: true, retryAfter: 0 };
  }

  /** Record a failed lookup (unknown code) against this IP and the site. */
  async recordFailure(): Promise<void> {
    await Promise.all([
      hit(this.repo.db, this.keys.hour, { limit: Infinity, windowSeconds: HOUR }),
      hit(this.repo.db, this.keys.day, { limit: Infinity, windowSeconds: DAY }),
      hit(this.repo.db, this.keys.global, { limit: Infinity, windowSeconds: HOUR }),
      this.repo.recordEvent('lookup_failed', this.ipHash),
    ]);
  }
}
