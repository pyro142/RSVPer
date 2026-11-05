import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

// Every test starts from an empty, freshly migrated database: reset() wipes
// all local storage, then the migrations rebuild the schema and the default
// wedding row.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
