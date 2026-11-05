import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  // Read once in Node, then hand to the Workers runtime as a binding so each
  // test file can apply them to its own isolated local D1.
  const migrations = await readD1Migrations('./migrations');

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_PASSWORD: 'test-admin-password-123',
            SESSION_SECRET: 'test-session-secret-that-is-at-least-32-chars',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
