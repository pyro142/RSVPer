/** Bindings and configuration available to the Worker. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  /** Only "true" on the public demo (wrangler.demo.jsonc). Never set otherwise. */
  DEMO_MODE?: string;

  /** "password" (default) or "access". */
  ADMIN_AUTH_MODE?: string;

  // Secrets — see .dev.vars.example.
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}
