// Worker entry point: one Worker serves the guest card, the API and the admin
// dashboard. Static files in /css, /js, /vendor and /img are served directly
// by Cloudflare without invoking this code (see wrangler.jsonc).

import type { Env } from './env';
import { authMode, authenticateAdmin, csrfProblem } from './auth/admin';
import { AdminRepo } from './db/admin';
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
import { handleAdminApi, login, serveMedia } from './routes/admin';
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
      const repo = new AdminRepo(env.DB, resolveWeddingId(request, env));
      const settings = await repo.settings();
      headerOptions = headerOptionsFor(settings, env, url);

      const response = await route(request, env, ctx, url, repo, settings);
      return applyHeaders(response, securityHeaders(headerOptions));
    } catch (err) {
      // Error boundary: guests get a readable message, details go to the log.
      // Never echo internals (table names, stack traces) back to the browser.
      console.error('Unhandled error', url.pathname, err);
      const configProblem = err instanceof ConfigError;
      const message = configProblem
        ? 'This site is not fully configured yet. If you run it, check the deploy secrets and the logs.'
        : 'Something went wrong at our end. Please try again.';
      const status = configProblem ? 503 : 500;
      const response = isApi
        ? error(message, status)
        : new Response(message, {
            status,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
          });
      return applyHeaders(response, securityHeaders(headerOptions));
    }
  },
} satisfies ExportedHandler<Env>;

function isAdminPath(rawPath: string): boolean {
  // Normalise case and percent-encoding so /Admin or /%61dmin can't slip past
  // the gate to a static file. (Admin HTML holds no data, but be strict.)
  let pathname = rawPath.toLowerCase();
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return true; // malformed encoding: treat as admin, i.e. gated
  }
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/api/admin' ||
    pathname.startsWith('/api/admin/')
  );
}

function headerOptionsFor(s: Settings, env: Env, url: URL): HeaderOptions {
  const admin = isAdminPath(url.pathname);
  return {
    // Admin pages are never indexable, whatever the guest-site setting says.
    noindex: admin || s.privacy.hide_from_search,
    turnstile: !admin && turnstileEnabled(env),
    // Admin pages can never be framed.
    frameAncestors: admin ? [] : s.privacy.embed_origins,
  };
}

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  repo: AdminRepo,
  settings: Settings,
): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (isAdminPath(pathname)) return routeAdmin(request, env, url, repo, settings);

  // --- guest API -----------------------------------------------------------
  const c = { request, env, repo, settings, ctx };
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

  const media = pathname.match(/^\/media\/([^/]+)$/);
  if (media) return serveMedia(repo, media[1]!);

  // The card at "/", "/index.html", and personalised links like "/ABC234".
  if (pathname === '/' || pathname === '/index.html' || CODE_PATH.test(pathname)) {
    return renderCard(request, env, repo, settings);
  }

  return env.ASSETS.fetch(request);
}

// ---------------------------------------------------------------------------
// Admin: one gate for every page and endpoint
// ---------------------------------------------------------------------------

const ADMIN_PAGES: Record<string, string> = {
  '/admin': 'dashboard',
  '/admin/setup': 'setup',
  '/admin/settings': 'settings',
};

async function routeAdmin(
  request: Request,
  env: Env,
  url: URL,
  repo: AdminRepo,
  settings: Settings,
): Promise<Response> {
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\.html$/, '') || '/';
  const isApi = pathname.startsWith('/api/');
  const mode = authMode(env);

  // The only unauthenticated admin routes: the login page and the login call.
  if (pathname === '/admin/login') {
    if (mode !== 'password') return redirect('/admin');
    return adminPage(request, env, 'login');
  }
  if (pathname === '/api/admin/login') {
    return request.method === 'POST' ? login(request, env, repo) : methodNotAllowed('POST');
  }

  const auth = await authenticateAdmin(request, env, repo.weddingId);
  if (!auth.ok) {
    if (isApi) {
      return error(
        mode === 'access' ? 'Sign in through Cloudflare Access.' : 'Please sign in.',
        auth.status,
      );
    }
    if (mode === 'password') return redirect('/admin/login');
    return new Response('Not authorised. Sign in through Cloudflare Access.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (isApi) {
    const csrf = await csrfProblem(request, auth);
    if (csrf) return error('Request blocked (CSRF check failed). Please reload the page.', 403);
    return handleAdminApi({ request, env, url, repo, settings, auth });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');

  const page = ADMIN_PAGES[pathname];
  if (!page) return new Response('Not found.', { status: 404 });

  // Until the couple has finished first-run setup, the dashboard sends them there.
  const wedding = await repo.wedding();
  if (page === 'dashboard' && !wedding?.setup_completed_at) return redirect('/admin/setup');

  return adminPage(request, env, page);
}

async function adminPage(request: Request, env: Env, name: string): Promise<Response> {
  const asset = await env.ASSETS.fetch(new URL(`/admin/${name}.html`, request.url));
  const headers = new Headers(asset.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(asset.body, { status: asset.status, headers });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

function methodNotAllowed(allow: string): Response {
  return error('Method not allowed.', 405, { Allow: allow });
}
