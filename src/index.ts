// Worker entry point: one Worker serves the guest card, the API and (later)
// the admin dashboard. Static files in /css, /js, /vendor and /img are served
// directly by Cloudflare without invoking this code (see wrangler.jsonc).

import type { Env } from './env';
import { WeddingRepo } from './db/repo';
import { CODE_PATH } from './lib/codes';
import {
  DEFAULT_HEADER_OPTIONS,
  applyHeaders,
  error,
  securityHeaders,
  type HeaderOptions,
} from './lib/http';
import { ConfigError } from './lib/identity';
import { turnstileEnabled } from './lib/turnstile';
import { renderCard, robotsTxt } from './routes/card';
import { lookup, submit } from './routes/rsvp';
import type { Settings } from './settings';
import { resolveWeddingId } from './tenant';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    let headerOptions: HeaderOptions = DEFAULT_HEADER_OPTIONS;

    try {
      const repo = new WeddingRepo(env.DB, resolveWeddingId(request, env));
      const settings = await repo.settings();
      headerOptions = headerOptionsFor(settings, env);

      const response = await route(request, env, ctx, url, repo, settings);
      return applyHeaders(response, securityHeaders(headerOptions));
    } catch (err) {
      // Error boundary: guests get a readable message, details go to the log.
      // Never echo internals (table names, stack traces) back to the browser.
      console.error('Unhandled error', url.pathname, err);
      const configProblem = err instanceof ConfigError;
      const message = configProblem
        ? 'This site is not fully configured yet. If you run it, check the deploy secrets.'
        : 'Something went wrong at our end. Please try again.';
      const response = isApi
        ? error(message, configProblem ? 503 : 500)
        : new Response(message, {
            status: configProblem ? 503 : 500,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
          });
      return applyHeaders(response, securityHeaders(headerOptions));
    }
  },
} satisfies ExportedHandler<Env>;

function headerOptionsFor(s: Settings, env: Env): HeaderOptions {
  return {
    noindex: s.privacy.hide_from_search,
    turnstile: turnstileEnabled(env),
    frameAncestors: s.privacy.embed_origins,
  };
}

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  repo: WeddingRepo,
  settings: Settings,
): Promise<Response> {
  const { pathname } = url;
  const method = request.method;
  const c = { request, env, repo, settings, ctx };

  // --- guest API -----------------------------------------------------------
  if (pathname === '/api/rsvp/lookup') {
    return method === 'POST' ? lookup(c) : methodNotAllowed('POST');
  }
  if (pathname === '/api/rsvp/submit') {
    return method === 'POST' ? submit(c) : methodNotAllowed('POST');
  }
  if (pathname.startsWith('/api/')) return error('Not found.', 404);

  // --- pages ---------------------------------------------------------------
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');

  if (pathname === '/robots.txt') return robotsTxt(settings);

  // The card at "/", "/index.html", and personalised links like "/ABC234".
  if (pathname === '/' || pathname === '/index.html' || CODE_PATH.test(pathname)) {
    return renderCard(request, env, repo, settings);
  }

  // Admin arrives in a later phase; until then it simply doesn't exist.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return new Response('Not found.', { status: 404 });
  }

  return env.ASSETS.fetch(request);
}

function methodNotAllowed(allow: string): Response {
  return error('Method not allowed.', 405, { Allow: allow });
}
