// Data-access layer.
//
// Every query in the app goes through a WeddingRepo, which is bound to exactly
// one wedding_id at construction and includes it in every WHERE clause and
// every INSERT. Handlers never write SQL themselves. Combined with the
// composite foreign keys in the schema, data from one wedding can't be read
// or attached to another. test/tenancy.test.ts checks both properties.

import { mergeStored, type SectionName, type Settings } from '../settings';

export interface InviteRow {
  id: string;
  code: string;
  household_name: string;
  max_party_size: number;
  reception_only: number;
}

export interface InviteGuestRow {
  id: string;
  name: string;
  allows_plus_one: number;
  sort_order: number;
}

export interface RsvpRow {
  id: string;
  attending: number;
  attending_reception_only: number;
}

export interface NewRsvpGuest {
  inviteGuestId: string | null;
  hostGuestId: string | null;
  plusOneName: string | null;
  attending: boolean;
  dietaryNotes: string | null;
}

export interface NewRsvp {
  inviteId: string;
  attending: boolean;
  receptionOnly: boolean;
  songRequest: string | null;
  message: string | null;
  ipHash: string | null;
  guests: NewRsvpGuest[];
}

export class WeddingRepo {
  constructor(
    readonly db: D1Database,
    readonly weddingId: string,
  ) {}

  // --- wedding & settings ---------------------------------------------------

  async wedding(): Promise<{ id: string; setup_completed_at: string | null } | null> {
    return this.db
      .prepare('SELECT id, setup_completed_at FROM weddings WHERE id = ?')
      .bind(this.weddingId)
      .first();
  }

  async settings(): Promise<Settings> {
    const { results } = await this.db
      .prepare('SELECT key, value FROM settings WHERE wedding_id = ?')
      .bind(this.weddingId)
      .all<{ key: string; value: string }>();
    const stored: Record<string, unknown> = {};
    for (const row of results) {
      try {
        stored[row.key] = JSON.parse(row.value);
      } catch {
        // json_valid() CHECK makes this unreachable; ignore defensively.
      }
    }
    return mergeStored(stored);
  }

  async saveSection<K extends SectionName>(section: K, value: Settings[K]): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (wedding_id, key, value, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT (wedding_id, key)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(this.weddingId, section, JSON.stringify(value))
      .run();
  }

  async markSetupComplete(): Promise<void> {
    await this.db
      .prepare(
        "UPDATE weddings SET setup_completed_at = COALESCE(setup_completed_at, datetime('now')) WHERE id = ?",
      )
      .bind(this.weddingId)
      .run();
  }

  // --- guest flow -----------------------------------------------------------

  async inviteByCode(code: string): Promise<InviteRow | null> {
    return this.db
      .prepare(
        `SELECT id, code, household_name, max_party_size, reception_only
           FROM invites WHERE wedding_id = ? AND code = ?`,
      )
      .bind(this.weddingId, code)
      .first<InviteRow>();
  }

  async inviteGuests(inviteId: string): Promise<InviteGuestRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, name, allows_plus_one, sort_order
           FROM invite_guests
          WHERE wedding_id = ? AND invite_id = ?
          ORDER BY sort_order, name`,
      )
      .bind(this.weddingId, inviteId)
      .all<InviteGuestRow>();
    return results;
  }

  async rsvpForInvite(inviteId: string): Promise<RsvpRow | null> {
    return this.db
      .prepare(
        `SELECT id, attending, attending_reception_only
           FROM rsvps WHERE wedding_id = ? AND invite_id = ?`,
      )
      .bind(this.weddingId, inviteId)
      .first<RsvpRow>();
  }

  /** Everyone coming on a reply, named guests and plus ones, in seating order. */
  async attendingNames(rsvpId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT COALESCE(ig.name, rg.plus_one_name) AS name
           FROM rsvp_guests rg
           LEFT JOIN invite_guests ig
                  ON ig.wedding_id = rg.wedding_id AND ig.id = rg.invite_guest_id
           LEFT JOIN invite_guests host
                  ON host.wedding_id = rg.wedding_id AND host.id = rg.host_guest_id
          WHERE rg.wedding_id = ? AND rg.rsvp_id = ? AND rg.attending = 1
          ORDER BY COALESCE(ig.sort_order, host.sort_order),
                   COALESCE(ig.name, host.name),
                   CASE WHEN rg.host_guest_id IS NULL THEN 0 ELSE 1 END`,
      )
      .bind(this.weddingId, rsvpId)
      .all<{ name: string }>();
    return results.map((r) => r.name);
  }

  /** Note that a browser opened this invite. Never throws. */
  async recordOpen(inviteId: string): Promise<void> {
    try {
      await this.db
        .prepare(
          `UPDATE invites
              SET open_count      = open_count + 1,
                  last_opened_at  = datetime('now'),
                  first_opened_at = COALESCE(first_opened_at, datetime('now'))
            WHERE wedding_id = ? AND id = ?`,
        )
        .bind(this.weddingId, inviteId)
        .run();
    } catch (err) {
      console.error('Could not record invite open', err);
    }
  }

  /**
   * Insert a reply and its people in one transaction (D1 batches are atomic).
   * Throws 'ALREADY_SUBMITTED' if the household has already replied — the
   * UNIQUE (wedding_id, invite_id) constraint is the real lock, so two racing
   * submits can't both land.
   */
  async insertRsvp(rsvp: NewRsvp): Promise<void> {
    const rsvpId = crypto.randomUUID();
    const statements = [
      this.db
        .prepare(
          `INSERT INTO rsvps
             (id, wedding_id, invite_id, attending, attending_reception_only,
              song_request, message, submitter_ip_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          rsvpId,
          this.weddingId,
          rsvp.inviteId,
          rsvp.attending ? 1 : 0,
          rsvp.receptionOnly ? 1 : 0,
          rsvp.songRequest,
          rsvp.message,
          rsvp.ipHash,
        ),
      ...rsvp.guests.map((g) =>
        this.db
          .prepare(
            `INSERT INTO rsvp_guests
               (id, wedding_id, rsvp_id, invite_guest_id, host_guest_id,
                plus_one_name, attending, dietary_notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            this.weddingId,
            rsvpId,
            g.inviteGuestId,
            g.hostGuestId,
            g.plusOneName,
            g.attending ? 1 : 0,
            g.dietaryNotes,
          ),
      ),
    ];
    try {
      await this.db.batch(statements);
    } catch (err) {
      if (String(err).includes('UNIQUE')) throw new Error('ALREADY_SUBMITTED', { cause: err });
      throw err;
    }
  }

  // --- security events --------------------------------------------------------

  async recordEvent(kind: string, ipHash: string | null): Promise<void> {
    try {
      await this.db
        .prepare(
          'INSERT INTO security_events (wedding_id, kind, ip_hash, created_at) VALUES (?, ?, ?, ?)',
        )
        .bind(this.weddingId, kind, ipHash, Math.floor(Date.now() / 1000))
        .run();
    } catch (err) {
      console.error('Could not record security event', err);
    }
  }
}
