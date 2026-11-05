import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Setup files run outside per-test storage isolation, and applyD1Migrations
// only applies migrations that haven't run yet, so this is safe to repeat.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
