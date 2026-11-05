// Response helpers and security headers.

export interface HeaderOptions {
  /** Add noindex headers (the "Hide from search engines" setting). */
  noindex: boolean;
  /** Load the Turnstile widget script on this page. */
  turnstile: boolean;
  /** Origins allowed to embed the site in an iframe. Empty = nobody. */
  frameAncestors: string[];
  /** Allow this page to embed same-origin frames (the admin's live preview). */
  frameSelf?: boolean;
}

export const DEFAULT_HEADER_OPTIONS: HeaderOptions = {
  noindex: true,
  turnstile: false,
  frameAncestors: [],
};

/**
 * Content Security Policy.
 *
 * Everything is self-hosted (fonts, confetti), so the only third party that
 * can ever appear is Cloudflare Turnstile, and only when it is configured.
 * No 'unsafe-inline' for scripts.
 */
export function contentSecurityPolicy(opts: HeaderOptions): string {
  const turnstile = opts.turnstile ? ' https://challenges.cloudflare.com' : '';
  const ancestors = opts.frameAncestors.length ? opts.frameAncestors.join(' ') : "'none'";
  return [
    "default-src 'self'",
    `script-src 'self'${turnstile}`,
    // Inline style attributes are used for theme variables; no inline script.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    // https: so couples can point at an image they host elsewhere.
    "img-src 'self' data: https:",
    "connect-src 'self'",
    `frame-src${opts.frameSelf ? " 'self'" : ''}${turnstile || (opts.frameSelf ? '' : " 'none'")}`,
    "form-action 'self'",
    `frame-ancestors ${ancestors}`,
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

export function securityHeaders(opts: HeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': contentSecurityPolicy(opts),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  // X-Frame-Options can't express an allowlist; CSP frame-ancestors does the
  // real work, this just covers very old browsers when embedding is off.
  if (!opts.frameAncestors.length) headers['X-Frame-Options'] = 'DENY';
  if (opts.noindex) headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive';
  return headers;
}

/** Headers that may be absent on purpose, depending on settings. */
const OPTIONAL_HEADERS = ['X-Robots-Tag', 'X-Frame-Options', 'Content-Security-Policy'];

/**
 * Set the security headers on a response, and remove any optional header that
 * the settings say should not be there (e.g. a static-file X-Robots-Tag when
 * the couple has allowed indexing).
 */
export function applyHeaders(response: Response, headers: Record<string, string>): Response {
  const out = new Response(response.body, response);
  for (const name of OPTIONAL_HEADERS) out.headers.delete(name);
  for (const [key, value] of Object.entries(headers)) out.headers.set(key, value);
  return out;
}

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

/** Guest-facing error. Keep messages vague for anything security relevant. */
export function error(message: string, status = 400, extra: Record<string, string> = {}): Response {
  return json({ error: message }, status, extra);
}

/**
 * Parse a JSON object body, or null for anything else.
 *
 * Requires Content-Type: application/json. A cross-site HTML form can only
 * send form-encoded or text/plain bodies, so this alone stops form-based CSRF
 * from ever reaching a handler. Bounded in size before parsing.
 */
export async function readJson(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown> | null> {
  const type = (request.headers.get('Content-Type') || '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return null;

  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    const body: unknown = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The client IP. CF-Connecting-IP is set by Cloudflare's edge and can't be
 * spoofed on a real deployment. Locally (wrangler dev / tests) it may be
 * missing, in which case everything shares one "local" identity.
 */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'local';
}
