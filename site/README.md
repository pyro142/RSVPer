# rsvper.app landing page

A single static page: what RSVPer is, a link to the code, and "hosted version coming
soon". No JavaScript, no tracking, no third-party requests.

## Deploy

From this folder:

```bash
npx wrangler deploy
```

Then in the Cloudflare dashboard open the `rsvper-site` Worker → Settings → Domains &
Routes → Add → Custom domain, and enter `rsvper.app` (and `www.rsvper.app` if you
like).

The screenshot (`public/invitation.png`) uses the made-up demo data.
