# Architecture

RSVPer is a single Cloudflare Worker with static assets and one D1 database.

```
Browser ──► Worker (src/index.ts)
              ├─ /, /ABC234          guest card, rendered from settings (HTMLRewriter)
              ├─ /api/rsvp/*         guest API: lookup, submit
              ├─ /admin*, /api/admin/*   ── one auth gate ──► admin pages + API
              ├─ /media/:id          uploaded images (from D1)
              └─ everything else ──► static assets (public/)
            Static /css /js /vendor /img are served by Cloudflare directly.
```

## Layout

| Path                | What it is                                                                       |
| ------------------- | -------------------------------------------------------------------------------- |
| `src/index.ts`      | Router, error boundary, security headers, the admin gate                         |
| `src/tenant.ts`     | Decides which wedding a request belongs to (always `default` today)              |
| `src/settings.ts`   | Every setting: shape, defaults, validation, display helpers                      |
| `src/db/repo.ts`    | Guest-side data access (`WeddingRepo`)                                           |
| `src/db/admin.ts`   | Admin data access (`AdminRepo extends WeddingRepo`)                              |
| `src/auth/`         | Password sessions, Cloudflare Access JWT verification, the gate and CSRF checks  |
| `src/routes/`       | Request handlers: guest card, guest API, admin API                               |
| `src/lib/`          | Codes, CSV, import, rate limiting, brute-force guard, Turnstile, text sanitising |
| `migrations/`       | D1 schema, applied by `wrangler d1 migrations apply`                             |
| `public/`           | Guest card template, admin pages, CSS, browser JS, default artwork               |
| `scripts/build.mjs` | Copies self-hosted fonts, confetti and the example CSV into `public/vendor/`     |

## Key decisions

**Settings live in D1, not code.** One JSON document per section per wedding.
Reads merge stored values over `DEFAULTS`, so new settings need no migration.
Every write goes through `validateSection`, which rejects anything malformed
(non-https links, impossible dates, unknown time zones).

**The guest card is rendered on the server.** `public/index.html` is a
template; `src/routes/card.ts` fills it with HTMLRewriter's text APIs, which
always escape. Couple-provided text can never become markup.

**Brute-force protection fails closed.** See `src/lib/guard.ts`: only failed
code lookups count against an IP; a daily cap acts as a 24-hour lockout; a
site-wide breaker tightens limits (or requires Turnstile, when configured)
during a distributed attempt. If the rate-limit table can't be read or
written, requests are refused.

**One admin gate.** Every `/admin*` and `/api/admin/*` request passes through
`authenticateAdmin` in `src/index.ts` before any handler runs. The only
exceptions are the login page and the login call. There is no development
bypass: local development uses password mode with `.dev.vars`.

**Admin auth modes.**

- `password` (default): the password is compared in constant time against the
  `ADMIN_PASSWORD` secret, or against a PBKDF2 hash stored in D1 once it has
  been changed from Settings. Sessions are server-side; the cookie holds a
  random id and the database stores only an HMAC of it. Mutations need a CSRF
  token, a same-origin `Origin`, and a JSON body.
- `access`: every admin request must carry a Cloudflare Access JWT whose
  signature, issuer, audience and expiry are verified against your team's
  public keys. Missing configuration fails closed.

**Images in D1.** Uploads are limited to 1 MB PNG/JPEG/WebP (checked by magic
bytes, not the declared type); SVG is refused because it can carry script.
This keeps the deploy button working with nothing else to provision. R2 would
be a sensible optional upgrade for larger galleries.

## Multi-tenancy (not built, but not blocked)

Today there is exactly one wedding, `default`. The groundwork for hosting
many couples on one deployment is already in place:

1. **Every table has `wedding_id`.** Child tables reference their parents with
   composite `(wedding_id, id)` foreign keys, so the database itself refuses a
   row that points at another wedding's data. (`rate_limits` is the deliberate
   exception: it is infrastructure keyed by hashed client identity.)
2. **All queries go through a repo bound to one wedding.** `WeddingRepo` and
   `AdminRepo` take a `weddingId` in their constructor and include it in every
   `WHERE` clause and `INSERT`. Handlers never write SQL for guest data.
   `test/tenancy.test.ts` checks that one wedding can't read, change or delete
   another's data.
3. **Wedding resolution is in one function.** `resolveWeddingId()` in
   `src/tenant.ts` is the only place that decides which wedding a request is
   for.
4. **Settings, sessions and passwords are per wedding.**
5. **Invite codes are unique per wedding**, not globally, so two couples can't
   collide.

To add hosting for multiple couples you would:

- Add a `wedding_hosts` table (hostname or subdomain → `wedding_id`), and make
  `resolveWeddingId()` look the request's hostname up in it (cache it in
  memory or KV). Unknown hosts get a 404.
- Add accounts: a `users` table and a `wedding_members` join table, with signup,
  email verification and password reset. Sessions would then carry a user id
  and the gate would check membership of the resolved wedding.
- Replace the deploy-time `ADMIN_PASSWORD` with per-user credentials.
- Add per-wedding quotas (invites, images, storage) and, if needed, billing.
- Consider moving uploads to R2 and rate limiting to Durable Objects or the
  Workers Rate Limiting binding at higher traffic.
- Consider one D1 database per wedding if isolation or size limits demand it;
  the repo layer is the only code that would need to know.

None of this requires changing the guest card, the settings model or the
handlers.
