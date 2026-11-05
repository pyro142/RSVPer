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
import { turnstileEnabled, withStoredTurnstile } from './lib/turnstile';
import { handleAdminApi, login, serveMedia } from './routes/admin';
import { renderCard, robotsTxt } from './routes/card';
import { lookup, submit } from './routes/rsvp';
import type { Settings } from './settings';
import { themeCss, validHex } from './theme';
import { resolveWeddingId } from './tenant';
import { demoBanner as demoBannerHtml, DEMO_STYLES } from './demo-banner';
import { DemoBusyError, demoCookie, isDemo, resetSandbox, resolveSandbox } from './demo';

/**
 * Demo-only routes that must not create a sandbox: robots.txt (crawlers) and
 * the "Reset demo" form, which deletes the visitor's sandbox.
 */
async function demoEarlyResponse(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  if (url.pathname === '/demo/reset' && request.method === 'POST') {
    // No origin check here on purpose: with our no-referrer policy, browsers
    // send "Origin: null" for form posts, and the worst a cross-site post could
    // do is reset the visitor's own throwaway sandbox.
    await resetSandbox(request, env);
    // Pages say where to return to (Referer is never sent: no-referrer policy).
    const target = url.searchParams.get('to') === 'admin' ? '/admin' : '/';
    const res = new Response(null, { status: 303, headers: { Location: target } });
    res.headers.append('Set-Cookie', demoCookie('', 0));
    return res;
  }
  return null;
}

export default {
  async fetch(request: Request, deployEnv: Env, ctx: ExecutionContext): Promise<Response> {
    let env = deployEnv;
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    let headerOptions: HeaderOptions = DEFAULT_HEADER_OPTIONS;

    try {
      let weddingId = resolveWeddingId(request, env);
      let sandboxCookie: string | null = null;
      if (isDemo(deployEnv)) {
        const early = await demoEarlyResponse(request, deployEnv, url);
        if (early) return applyHeaders(early, securityHeaders(headerOptions));
        try {
          const sandbox = await resolveSandbox(request, deployEnv);
          weddingId = sandbox.weddingId;
          sandboxCookie = sandbox.setCookie;
        } catch (err) {
          if (!(err instanceof DemoBusyError)) throw err;
          return applyHeaders(
            new Response('The demo is busy right now. Please try again in a little while.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '600' },
            }),
            securityHeaders(headerOptions),
          );
        }
      }
      const repo = new AdminRepo(env.DB, weddingId);
      const [settings, turnstileKeys] = await Promise.all([repo.settings(), repo.turnstileKeys()]);
      env = withStoredTurnstile(deployEnv, turnstileKeys);
      headerOptions = headerOptionsFor(settings, env, url);

      const response = await route(request, env, ctx, url, repo, settings, deployEnv);
      const out = applyHeaders(response, securityHeaders(headerOptions));
      if (sandboxCookie) out.headers.append('Set-Cookie', sandboxCookie);
      return out;
    } catch (err) {
      // Error boundary: guests get a readable message, details go to the log.
      // Never echo internals (table names, stack traces) back to the browser.
      console.error('Unhandled error', url.pathname, err);
      const configProblem = err instanceof ConfigError;
      // On admin routes, name the misconfiguration so the couple can fix it.
      // Guests only ever see a generic message.
      const message = configProblem
        ? isAdminPath(url.pathname)
          ? `Setup problem: ${(err as Error).message} Fix it in the Cloudflare dashboard (your Worker → Settings → Variables and secrets).`
          : 'This site is not fully configured yet. Please try again later.'
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
    // Admin pages can never be framed, except the live preview, which only
    // the admin itself (same origin) may embed.
    frameAncestors:
      url.pathname === '/admin/preview' ? ["'self'"] : admin ? [] : s.privacy.embed_origins,
    // Admin pages may embed the same-origin live preview; guest pages can't.
    frameSelf: admin,
  };
}

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  repo: AdminRepo,
  settings: Settings,
  deployEnv: Env,
): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (isAdminPath(pathname)) return routeAdmin(request, env, url, repo, settings, deployEnv);

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
  deployEnv: Env,
): Promise<Response> {
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\.html$/, '') || '/';
  const isApi = pathname.startsWith('/api/');
  const mode = authMode(env);

  // The only unauthenticated admin routes: the login page and the login call.
  if (pathname === '/admin/login') {
    if (mode !== 'password') return redirect('/admin');
    return adminPage(request, env, 'login', settings);
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
    return handleAdminApi({ request, env, deployEnv, url, repo, settings, auth });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');

  // Theme CSS for unsaved colours, so the live preview can show them without
  // repeating the colour maths in the browser.
  if (pathname === '/admin/theme.css') {
    const css = themeCss({
      background: validHex(url.searchParams.get('background')),
      brand: validHex(url.searchParams.get('brand')),
      font: url.searchParams.get('font'),
    });
    return new Response(css, {
      headers: {
        'Content-Type': 'text/css; charset=utf-8',
        // Never cached: it must always reflect the current colour rules.
        'Cache-Control': 'no-store',
      },
    });
  }

  if (pathname === '/admin/preview') {
    const menu = (await repo.menu()).filter((course) => course.options.length > 0);
    return renderCard(request, env, repo, settings, { menu });
  }

  const page = ADMIN_PAGES[pathname];
  if (!page) return new Response('Not found.', { status: 404 });

  // Until the couple has finished first-run setup, the dashboard sends them there.
  const wedding = await repo.wedding();
  if (page === 'dashboard' && !wedding?.setup_completed_at) return redirect('/admin/setup');

  return adminPage(request, env, page, settings);
}

async function adminPage(
  request: Request,
  env: Env,
  name: string,
  settings: Settings,
): Promise<Response> {
  const asset = await env.ASSETS.fetch(new URL(`/admin/${name}.html`, request.url));
  const headers = new Headers(asset.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  const page = new Response(asset.body, { status: asset.status, headers });
  const css = themeCss(settings.theme);
  if (!css) return demoBanner(env, new HTMLRewriter()).transform(page);
  // The couple's colours, as validated hex only (see src/theme.ts).
  return demoBanner(env, new HTMLRewriter())
    .on('html', {
      element(el) {
        // A chosen background decides light/dark, so the admin's own
        // dark-mode toggle is hidden (see admin.css).
        if (settings.theme.background) el.setAttribute('data-fixed-theme', '');
      },
    })
    .on('head', {
      element(el) {
        el.append(`<style id="rsvper-theme">${css}</style>`, { html: true });
      },
    })
    .transform(page);
}

/** Adds the demo banner to a page when running as the public demo. */
function demoBanner(env: Env, rewriter: HTMLRewriter): HTMLRewriter {
  if (!isDemo(env)) return rewriter;
  return rewriter
    .on('head', {
      element(el) {
        el.append(DEMO_STYLES, { html: true });
      },
    })
    .on('body', {
      element(el) {
        el.prepend(demoBannerHtml('admin'), { html: true });
      },
    });
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
