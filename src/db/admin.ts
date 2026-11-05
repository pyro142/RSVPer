// Admin data access. Same rule as WeddingRepo: every statement is scoped by
// this.weddingId, and nothing outside src/db writes SQL for guest data.

import { generateCode } from '../lib/codes';
import type { HouseholdInput } from '../lib/households';
import { WeddingRepo } from './repo';

export type InviteStatus = 'outstanding' | 'accepted' | 'declined';

export interface AdminGuest {
  id: string;
  name: string;
  allows_plus_one: boolean;
  sort_order: number;
  attending: boolean | null;
  dietary_notes: string | null;
  plus_one_name: string | null;
  plus_one_dietary_notes: string | null;
}

export interface AdminInvite {
  id: string;
  code: string;
  household_name: string;
  max_party_size: number;
  reception_only: boolean;
  chose_reception_only: boolean;
  evening_only: boolean;
  admin_notes: string | null;
  created_at: string;
  first_opened_at: string | null;
  last_opened_at: string | null;
  open_count: number;
  opened: boolean;
  status: InviteStatus;
  submitted_at: string | null;
  song_request: string | null;
  message: string | null;
  heads: number;
  guests: AdminGuest[];
}

export interface ImageMeta {
  id: string;
  content_type: string;
  size: number;
  created_at: string;
}

export class AdminRepo extends WeddingRepo {
  // --- credentials ----------------------------------------------------------

  async passwordHash(): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT password_hash FROM admin_credentials WHERE wedding_id = ?')
      .bind(this.weddingId)
      .first<{ password_hash: string }>();
    return row?.password_hash ?? null;
  }

  async setPasswordHash(hash: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO admin_credentials (wedding_id, password_hash, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT (wedding_id) DO UPDATE SET password_hash = excluded.password_hash,
                                                updated_at = excluded.updated_at`,
      )
      .bind(this.weddingId, hash)
      .run();
  }

  // --- invites: read model ----------------------------------------------------

  /**
   * Every invite with its guests and reply state. Plus ones are stored as
   * their own rsvp_guests rows and reattached to their host here.
   */
  async loadInvites(): Promise<AdminInvite[]> {
    const w = this.weddingId;
    const [invites, guests, plusOnes] = await this.db.batch([
      this.db
        .prepare(
          `SELECT i.id, i.code, i.household_name, i.max_party_size, i.reception_only,
                  i.admin_notes, i.created_at, i.first_opened_at, i.last_opened_at, i.open_count,
                  r.id AS rsvp_id, r.attending, r.attending_reception_only, r.submitted_at,
                  r.song_request, r.message
             FROM invites i
             LEFT JOIN rsvps r ON r.wedding_id = i.wedding_id AND r.invite_id = i.id
            WHERE i.wedding_id = ?
            ORDER BY i.household_name COLLATE NOCASE`,
        )
        .bind(w),
      this.db
        .prepare(
          `SELECT ig.id, ig.invite_id, ig.name, ig.allows_plus_one, ig.sort_order,
                  rg.attending AS rsvp_attending, rg.dietary_notes
             FROM invite_guests ig
             LEFT JOIN rsvps r ON r.wedding_id = ig.wedding_id AND r.invite_id = ig.invite_id
             LEFT JOIN rsvp_guests rg
                    ON rg.wedding_id = ig.wedding_id AND rg.rsvp_id = r.id
                   AND rg.invite_guest_id = ig.id
            WHERE ig.wedding_id = ?
            ORDER BY ig.invite_id, ig.sort_order, ig.name`,
        )
        .bind(w),
      this.db
        .prepare(
          `SELECT rg.host_guest_id, rg.plus_one_name, rg.dietary_notes
             FROM rsvp_guests rg
            WHERE rg.wedding_id = ? AND rg.host_guest_id IS NOT NULL`,
        )
        .bind(w),
    ]);

    const plusOneByHost = new Map<string, { name: string; dietary: string | null }>();
    for (const row of plusOnes!.results as Record<string, string | null>[]) {
      plusOneByHost.set(row.host_guest_id!, {
        name: row.plus_one_name!,
        dietary: row.dietary_notes ?? null,
      });
    }

    const guestsByInvite = new Map<string, AdminGuest[]>();
    for (const row of guests!.results as Record<string, unknown>[]) {
      const inviteId = row.invite_id as string;
      if (!guestsByInvite.has(inviteId)) guestsByInvite.set(inviteId, []);
      const plusOne = plusOneByHost.get(row.id as string);
      guestsByInvite.get(inviteId)!.push({
        id: row.id as string,
        name: row.name as string,
        allows_plus_one: Boolean(row.allows_plus_one),
        sort_order: row.sort_order as number,
        attending: row.rsvp_attending === null ? null : Boolean(row.rsvp_attending),
        dietary_notes: (row.dietary_notes as string | null) ?? null,
        plus_one_name: plusOne?.name ?? null,
        plus_one_dietary_notes: plusOne?.dietary ?? null,
      });
    }

    return (invites!.results as Record<string, unknown>[]).map((row) => {
      const guestList = guestsByInvite.get(row.id as string) ?? [];
      const replied = row.rsvp_id !== null;
      const status: InviteStatus = !replied
        ? 'outstanding'
        : row.attending
          ? 'accepted'
          : 'declined';
      const invitedEvening = Boolean(row.reception_only);
      const choseEvening = Boolean(row.attending_reception_only);
      const openCount = (row.open_count as number) || 0;
      return {
        id: row.id as string,
        code: row.code as string,
        household_name: row.household_name as string,
        max_party_size: row.max_party_size as number,
        reception_only: invitedEvening,
        chose_reception_only: choseEvening,
        evening_only: invitedEvening || choseEvening,
        admin_notes: (row.admin_notes as string | null) ?? null,
        created_at: row.created_at as string,
        first_opened_at: (row.first_opened_at as string | null) ?? null,
        last_opened_at: (row.last_opened_at as string | null) ?? null,
        open_count: openCount,
        opened: openCount > 0,
        status,
        submitted_at: (row.submitted_at as string | null) ?? null,
        song_request: (row.song_request as string | null) ?? null,
        message: (row.message as string | null) ?? null,
        heads: status === 'accepted' ? countHeads(guestList) : 0,
        guests: guestList,
      };
    });
  }

  async inviteById(id: string) {
    return this.db
      .prepare(
        `SELECT id, code, household_name, max_party_size, reception_only
           FROM invites WHERE wedding_id = ? AND id = ?`,
      )
      .bind(this.weddingId, id)
      .first<{
        id: string;
        code: string;
        household_name: string;
        max_party_size: number;
        reception_only: number;
      }>();
  }

  // --- invites: writes ----------------------------------------------------------

  async existingCodes(): Promise<Set<string>> {
    const { results } = await this.db
      .prepare('SELECT code FROM invites WHERE wedding_id = ?')
      .bind(this.weddingId)
      .all<{ code: string }>();
    return new Set(results.map((r) => r.code));
  }

  /** Create households in one transaction: a bulk import lands whole or not at all. */
  async createInvites(
    households: HouseholdInput[],
    codeLength: number,
  ): Promise<{ id: string; code: string; household_name: string }[]> {
    const taken = await this.existingCodes();
    const created: { id: string; code: string; household_name: string }[] = [];
    const statements: D1PreparedStatement[] = [];

    for (const h of households) {
      let code = generateCode(codeLength);
      for (let i = 0; taken.has(code); i++) {
        if (i > 20) throw new Error('Could not find an unused invite code');
        code = generateCode(codeLength);
      }
      taken.add(code);
      const id = crypto.randomUUID();
      statements.push(
        this.db
          .prepare(
            `INSERT INTO invites (id, wedding_id, code, household_name, max_party_size, reception_only)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            this.weddingId,
            code,
            h.household_name,
            h.max_party_size,
            h.reception_only ? 1 : 0,
          ),
      );
      h.guests.forEach((g, index) => {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO invite_guests (id, wedding_id, invite_id, name, allows_plus_one, sort_order)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              crypto.randomUUID(),
              this.weddingId,
              id,
              g.name,
              g.allows_plus_one ? 1 : 0,
              index,
            ),
        );
      });
      created.push({ id, code, household_name: h.household_name });
    }

    if (statements.length) await this.db.batch(statements);
    return created;
  }

  async guestSeats(inviteId: string): Promise<{ count: number; plus_ones: number }> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(allows_plus_one), 0) AS plus_ones
           FROM invite_guests WHERE wedding_id = ? AND invite_id = ?`,
      )
      .bind(this.weddingId, inviteId)
      .first<{ count: number; plus_ones: number }>();
    return row ?? { count: 0, plus_ones: 0 };
  }

  async updateInvite(
    id: string,
    patch: {
      household_name?: string;
      max_party_size?: number;
      reception_only?: boolean;
      admin_notes?: string | null;
      guests?: HouseholdInput['guests'];
      code?: string;
    },
  ): Promise<void> {
    const w = this.weddingId;
    const statements: D1PreparedStatement[] = [];
    const set = (column: string, value: unknown) =>
      statements.push(
        this.db
          .prepare(`UPDATE invites SET ${column} = ? WHERE wedding_id = ? AND id = ?`)
          .bind(value, w, id),
      );

    if (patch.household_name !== undefined) set('household_name', patch.household_name);
    if (patch.max_party_size !== undefined) set('max_party_size', patch.max_party_size);
    if (patch.reception_only !== undefined) set('reception_only', patch.reception_only ? 1 : 0);
    if (patch.admin_notes !== undefined) set('admin_notes', patch.admin_notes);
    if (patch.code !== undefined) set('code', patch.code);
    if (patch.guests) {
      statements.push(
        this.db
          .prepare('DELETE FROM invite_guests WHERE wedding_id = ? AND invite_id = ?')
          .bind(w, id),
      );
      patch.guests.forEach((g, index) =>
        statements.push(
          this.db
            .prepare(
              `INSERT INTO invite_guests (id, wedding_id, invite_id, name, allows_plus_one, sort_order)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(crypto.randomUUID(), w, id, g.name, g.allows_plus_one ? 1 : 0, index),
        ),
      );
    }
    if (statements.length) await this.db.batch(statements);
  }

  async deleteInvite(id: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM invites WHERE wedding_id = ? AND id = ?')
      .bind(this.weddingId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** Clear a household's reply (e.g. a mistaken or forged one) so they can reply again. */
  async resetReply(inviteId: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM rsvps WHERE wedding_id = ? AND invite_id = ?')
      .bind(this.weddingId, inviteId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  // --- images -----------------------------------------------------------------

  async insertImage(contentType: string, bytes: ArrayBuffer): Promise<string> {
    const id = crypto.randomUUID().replace(/-/g, '');
    await this.db
      .prepare('INSERT INTO images (id, wedding_id, content_type, bytes) VALUES (?, ?, ?, ?)')
      .bind(id, this.weddingId, contentType, bytes)
      .run();
    return id;
  }

  async image(id: string): Promise<{ content_type: string; bytes: ArrayBuffer } | null> {
    return this.db
      .prepare('SELECT content_type, bytes FROM images WHERE wedding_id = ? AND id = ?')
      .bind(this.weddingId, id)
      .first<{ content_type: string; bytes: ArrayBuffer }>();
  }

  async listImages(): Promise<ImageMeta[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, content_type, length(bytes) AS size, created_at
           FROM images WHERE wedding_id = ? ORDER BY created_at DESC`,
      )
      .bind(this.weddingId)
      .all<ImageMeta>();
    return results;
  }

  async deleteImage(id: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM images WHERE wedding_id = ? AND id = ?')
      .bind(this.weddingId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  // --- activity ---------------------------------------------------------------

  async recentEvents(sinceSeconds: number): Promise<{ kind: string; count: number }[]> {
    const since = Math.floor(Date.now() / 1000) - sinceSeconds;
    const { results } = await this.db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM security_events
          WHERE wedding_id = ? AND created_at >= ? GROUP BY kind`,
      )
      .bind(this.weddingId, since)
      .all<{ kind: string; count: number }>();
    return results;
  }
}

/** Confirmed attendees for a household, counting plus ones as people. */
export function countHeads(guests: AdminGuest[]): number {
  return guests.reduce(
    (total, g) => total + (g.attending ? 1 : 0) + (g.attending && g.plus_one_name ? 1 : 0),
    0,
  );
}

/** Dashboard counters. */
export function summarise(invites: AdminInvite[]) {
  const total = invites.length;
  const accepted = invites.filter((i) => i.status === 'accepted');
  const declined = invites.filter((i) => i.status === 'declined');
  const responded = accepted.length + declined.length;
  const sum = (list: AdminInvite[], f: (i: AdminInvite) => number) =>
    list.reduce((n, i) => n + f(i), 0);

  return {
    total_invites: total,
    total_heads_invited: sum(invites, (i) => i.max_party_size),
    day_heads_invited: sum(
      invites.filter((i) => !i.reception_only),
      (i) => i.max_party_size,
    ),
    evening_heads_invited: sum(
      invites.filter((i) => i.reception_only),
      (i) => i.max_party_size,
    ),
    accepted: accepted.length,
    declined: declined.length,
    outstanding: total - responded,
    total_heads: sum(accepted, (i) => i.heads),
    day_heads: sum(
      accepted.filter((i) => !i.evening_only),
      (i) => i.heads,
    ),
    evening_heads: sum(
      accepted.filter((i) => i.evening_only),
      (i) => i.heads,
    ),
    downgraded_heads: sum(
      accepted.filter((i) => i.chose_reception_only),
      (i) => i.heads,
    ),
    unopened: invites.filter((i) => i.status === 'outstanding' && !i.opened).length,
    opened_no_reply: invites.filter((i) => i.status === 'outstanding' && i.opened).length,
    response_rate: total === 0 ? 0 : Math.round((responded / total) * 100),
    dietary_notes: accepted.reduce(
      (n, i) =>
        n +
        i.guests.filter((g) => g.attending && g.dietary_notes).length +
        i.guests.filter((g) => g.plus_one_dietary_notes).length,
      0,
    ),
    song_requests: invites.filter((i) => i.song_request).length,
    messages: invites.filter((i) => i.message).length,
  };
}
