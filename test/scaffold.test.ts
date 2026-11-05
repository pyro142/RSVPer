import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('scaffold', () => {
  it('applies migrations and creates the default wedding', async () => {
    const row = await env.DB.prepare('SELECT id FROM weddings').first<{ id: string }>();
    expect(row?.id).toBe('default');
  });

  it('enforces tenant integrity in the database', async () => {
    await env.DB.prepare("INSERT INTO weddings (id) VALUES ('other')").run();
    await env.DB.prepare(
      "INSERT INTO invites (id, wedding_id, code, household_name, max_party_size) VALUES ('i1', 'default', 'ABCDE', 'Test', 2)",
    ).run();
    // A guest claiming to belong to 'other' cannot attach to a 'default' invite.
    await expect(
      env.DB.prepare(
        "INSERT INTO invite_guests (id, wedding_id, invite_id, name) VALUES ('g1', 'other', 'i1', 'X')",
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('rejects ambiguous characters in codes', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO invites (id, wedding_id, code, household_name, max_party_size) VALUES ('i2', 'default', 'ABC0O', 'Test', 2)",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });

  it('returns JSON 404 for unknown API routes with security headers', async () => {
    const res = await exports.default.fetch('https://example.test/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
