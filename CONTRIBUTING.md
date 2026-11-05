# Contributing to RSVPer

Thanks for your interest in RSVPer! 💐

## A note before you start

RSVPer was originally built for my own wedding, and has since been tidied up and
made available for other couples to use. It's a side project, and I may not be
able to maintain it regularly, so **issues and pull requests may take a while to
get a response**. Please don't take a slow reply personally. Every bug report and
idea is genuinely appreciated.

If something is urgent for your own wedding, you're very welcome to fix it in
your own copy first.

## Ways to help

- **Report a bug** using the bug report template. Steps to reproduce help a lot.
- **Suggest a feature** using the feature request template. Explaining the problem
  you're trying to solve is more useful than a specific solution.
- **Improve the docs**: typos, unclear steps, missing FAQ entries.
- **Send a pull request** (see below).

For security problems, **don't open a public issue**: see [SECURITY.md](SECURITY.md).

## Local development

You'll need Node 20 or newer.

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in ADMIN_PASSWORD (12+ chars) and SESSION_SECRET (32+ chars)
npm run db:seed:local            # optional: fake households to play with
npm run dev
```

Then open:

- http://localhost:8787/admin: the admin (your `.dev.vars` password)
- http://localhost:8787/GUEST3: a household that hasn't replied (after seeding)

If `npm install` fails with an `edgesOut` error, that's an npm 10 bug. Use
`npx npm@11 install` instead.

### Useful scripts

| Script                  | What it does                                                             |
| ----------------------- | ------------------------------------------------------------------------ |
| `npm run dev`           | Builds assets, migrates the local database, starts Wrangler              |
| `npm test`              | Runs the test suite (Vitest in the Workers runtime, against a local D1)  |
| `npm run lint`          | ESLint, Prettier, and a check that every query is scoped by `wedding_id` |
| `npm run typecheck`     | TypeScript                                                               |
| `npm run format`        | Fix formatting                                                           |
| `npm run db:seed:local` | Reset the local database to fake demo data (never touches production)    |

### Project layout

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Pull requests

- **Open an issue first** for anything bigger than a small fix, so we can agree on
  the approach before you spend time on it.
- Keep changes focused. One feature or fix per pull request.
- Add or update tests for behaviour changes. `npm run lint`, `npm run typecheck`
  and `npm test` must pass (CI runs them too).
- Follow the existing patterns:
  - All database access goes through the repo classes in `src/db/`, and every
    query must be scoped by `wedding_id`.
  - Anything shown to guests comes from settings, never hard-coded text.
  - Never build HTML from strings. Use `textContent` in the browser and
    HTMLRewriter's text APIs on the server.
  - Keep it free-tier friendly and dependency-light. Ask before adding a dependency.
  - New settings need validation in `src/settings.ts`.
- **Never include personal data**: no real names, guest lists, domains, keys or
  exports, even in tests or screenshots.

### Licence and the contributor agreement

RSVPer is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE): free to use, change and share for
non-commercial purposes, but not to sell.

By submitting a pull request you agree to the
[Contributor Licence Agreement](CLA.md). In short, you keep your copyright, your
contribution is available to everyone under the project's licence, and you give
the maintainer permission to use it in any way (including in a possible hosted
version). The pull request template has a checkbox for this.

## Code of conduct

Be kind and patient. This project is about weddings, after all.
