# The public demo

The demo at **demo.rsvper.app** runs the real app with `DEMO_MODE=true`:

- No sign-in. Every visitor gets their own private copy (a "sandbox") of a made-up
  wedding with households in every state: replied, declined, evening guests, plus ones,
  meals, messages.
- Changes are only visible to that visitor. The sandbox is deleted after 24 hours, or
  straight away with **Reset demo** in the banner.
- Password changes, Turnstile keys and image uploads are switched off.
- Abuse limits: at most 20 new sandboxes per visitor per hour, and 2,000 live at once.

Demo mode never reads or writes a real wedding: it only ever uses sandbox weddings
(ids starting `demo-`), and admin access without sign-in is refused for anything else.

## Deploy it

It's a separate Worker with its own database, configured in `wrangler.demo.jsonc`
(the Deploy to Cloudflare button and `npm run deploy` never use that file).

```bash
npx wrangler d1 create rsvper-demo
```

Paste the printed `database_id` into `wrangler.demo.jsonc`, then:

```bash
npx wrangler secret put SESSION_SECRET -c wrangler.demo.jsonc
```

```bash
npm run deploy:demo
```

Then add the custom domain `demo.rsvper.app` to the `rsvper-demo` Worker (dashboard →
Workers & Pages → rsvper-demo → Settings → Domains & Routes).

## Try it locally

```bash
npm run dev:demo
```

Open http://localhost:8787/admin. No password needed.
