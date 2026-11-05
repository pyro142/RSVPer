// wedding_id scoping: a query must never return or touch another wedding's data.

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminRepo } from '../src/db/admin';
import { markReady, seedInvite } from './helpers';

describe('tenant isolation', () => {
  let mine: AdminRepo;
  let theirs: AdminRepo;

  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO weddings (id) VALUES ('other')").run();
    await markReady('default');
    await markReady('other');
    mine = new AdminRepo(env.DB, 'default');
    theirs = new AdminRepo(env.DB, 'other');
    await seedInvite({
      id: 'mine-1',
      code: 'ABCDEF',
      household: 'Mine',
      max: 2,
      guests: [{ id: 'mg-1', name: 'Me' }],
    });
    await seedInvite({
      id: 'theirs-1',
      code: 'GHJKMN',
      household: 'Theirs',
      max: 2,
      guests: [{ id: 'tg-1', name: 'Them' }],
      weddingId: 'other',
    });
    await theirs.saveSection('couple', { name_one: 'Other', name_two: 'Couple', joiner: '&' });
  });

  it('lists only its own invites', async () => {
    expect((await mine.loadInvites()).map((i) => i.id)).toEqual(['mine-1']);
    expect((await theirs.loadInvites()).map((i) => i.id)).toEqual(['theirs-1']);
  });

  it('cannot look up, read, edit, reset or delete another wedding’s invite', async () => {
    expect(await mine.inviteByCode('GHJKMN')).toBeNull();
    expect(await mine.inviteById('theirs-1')).toBeNull();
    expect(await mine.inviteGuests('theirs-1')).toEqual([]);
    expect(await mine.deleteInvite('theirs-1')).toBe(false);
    expect(await mine.resetReply('theirs-1')).toBe(false);
    await mine.updateInvite('theirs-1', { household_name: 'Hijacked' });
    expect((await theirs.inviteById('theirs-1'))?.household_name).toBe('Theirs');
  });

  it('keeps settings separate', async () => {
    expect((await mine.settings()).couple.name_one).not.toBe('Other');
    expect((await theirs.settings()).couple.name_one).toBe('Other');
  });

  it('allows the same code in two weddings without collision', async () => {
    await seedInvite({
      id: 'theirs-2',
      code: 'ABCDEF',
      household: 'Twin',
      max: 1,
      guests: [],
      weddingId: 'other',
    });
    expect((await mine.inviteByCode('ABCDEF'))?.id).toBe('mine-1');
    expect((await theirs.inviteByCode('ABCDEF'))?.id).toBe('theirs-2');
  });

  it('the database refuses cross-wedding references', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO rsvps (id, wedding_id, invite_id, attending) VALUES ('r', 'default', 'theirs-1', 1)",
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});
