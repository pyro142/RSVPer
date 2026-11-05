// Server-side rendering of the guest invite card.
//
// public/index.html is a template. Each element marked data-slot is filled
// from settings with HTMLRewriter's text APIs, which always escape, so nothing
// a couple types can become markup. The only raw HTML ever inserted is the
// fixed Turnstile <script> tag below.

import type { Env } from '../env';
import type { WeddingRepo } from '../db/repo';
import { MAX_CODE_LENGTH, MIN_CODE_LENGTH } from '../lib/codes';
import { turnstileEnabled } from '../lib/turnstile';
import {
  coupleNames,
  fill,
  formatDate,
  formatTime,
  rsvpClosed,
  type ImageRef,
  type Settings,
} from '../settings';

export function imageUrl(ref: ImageRef | null): string | null {
  if (!ref) return null;
  switch (ref.kind) {
    case 'builtin':
      return `/img/${ref.name}.svg`;
    case 'url':
      return ref.url;
    case 'upload':
      return `/media/${encodeURIComponent(ref.id)}`;
  }
}

/** Data the browser script needs. Public by design — no guest data here. */
export function clientConfig(s: Settings, env: Env, ready: boolean) {
  return {
    ready,
    closed: rsvpClosed(s),
    code_length: { min: MIN_CODE_LENGTH, max: MAX_CODE_LENGTH },
    turnstile_site_key: turnstileEnabled(env) ? env.TURNSTILE_SITE_KEY : null,
    times: {
      day: formatTime(s, s.event.ceremony_time),
      evening: formatTime(s, s.event.reception_time),
    },
    hero: { day: imageUrl(s.images.hero), evening: imageUrl(s.images.hero_evening) },
    copy: {
      accepted_title: s.copy.accepted_title,
      accepted_message: s.copy.accepted_message,
      declined_title: s.copy.declined_title,
      declined_message: s.copy.declined_message,
      already_title: s.copy.already_title,
      already_message: s.copy.already_message,
      closed_message: s.copy.closed_message,
    },
  };
}

function encodeConfig(value: unknown): string {
  // Base64 of UTF-8 JSON: survives any attribute context without relying on
  // escaping rules, and the browser decodes it with atob + TextDecoder.
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const TURNSTILE_SCRIPT =
  '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>';

export async function renderCard(
  request: Request,
  env: Env,
  repo: WeddingRepo,
  settings: Settings,
): Promise<Response> {
  const template = await env.ASSETS.fetch(new URL('/index.html', request.url));
  if (!template.ok) return template;

  const wedding = await repo.wedding();
  const ready = Boolean(wedding?.setup_completed_at);
  const s = settings;

  const names = coupleNames(s);
  const date = formatDate(s, s.event.date);
  const dayTime = formatTime(s, s.event.ceremony_time);
  const hero = imageUrl(s.images.hero);

  const text = (value: string) => ({
    element(el: Element) {
      el.setInnerContent(value);
    },
  });
  const removeIf = (condition: boolean) => ({
    element(el: Element) {
      if (condition) el.remove();
    },
  });

  const rewriter = new HTMLRewriter()
    // Template comments are for maintainers, not guests.
    .onDocument({
      comments(comment) {
        comment.remove();
      },
    })
    .on('html', {
      element(el) {
        el.setAttribute('lang', s.event.locale);
      },
    })
    .on('[data-slot="title"]', text(`${names} — RSVP`))
    .on('[data-slot="robots"]', removeIf(!s.privacy.hide_from_search))
    .on('[data-slot="name-one"]', text(s.couple.name_one))
    .on('[data-slot="joiner"]', text(s.couple.joiner))
    .on('[data-slot="name-two"]', text(s.couple.name_two))
    .on('[data-slot="headline"]', text(s.copy.headline))
    .on('[data-slot="date-line"]', removeIf(!date))
    .on('[data-slot="date"]', text(date))
    .on('[data-slot="time"]', text(dayTime ? `· ${dayTime}` : ''))
    .on('[data-slot="venue-line"]', removeIf(!s.venue.name && !s.venue.address))
    .on('[data-slot="venue-link"]', {
      element(el) {
        if (s.venue.map_url) el.setAttribute('href', s.venue.map_url);
        else {
          el.removeAttribute('target');
          el.removeAttribute('rel');
        }
      },
    })
    .on('[data-slot="venue-name"]', text(s.venue.name))
    .on('[data-slot="venue-address"]', text(s.venue.address ? `· ${s.venue.address}` : ''))
    .on('[data-slot="hero-frame"]', removeIf(!hero))
    .on('[data-slot="hero"]', {
      element(el) {
        if (hero) el.setAttribute('src', hero);
        el.setAttribute('alt', s.images.hero_alt);
      },
    })
    .on('[data-slot="code-prompt"]', text(s.copy.code_prompt))
    .on('[data-slot="code-help"]', text(s.copy.code_help))
    .on('[data-slot="intro"]', text(fill(s.copy.intro, { date: date || 'our big day' })))
    .on('[data-slot="accept-label"]', text(s.copy.accept_label))
    .on('[data-slot="decline-label"]', text(s.copy.decline_label))
    .on('[data-slot="decline-note"]', text(s.copy.decline_note))
    .on('[data-slot="day-label"]', text(s.evening.day_label))
    .on('[data-slot="evening-label"]', text(s.evening.evening_label))
    .on(
      '[data-slot="evening-note"]',
      text(fill(s.evening.evening_note, { reception_time: formatTime(s, s.event.reception_time) })),
    )
    .on('[data-slot="contact"]', text(s.rsvp.contact))
    .on('[data-slot="decoration"]', removeIf(s.images.decoration === 'none'))
    .on('[data-slot="body"]', {
      element(el) {
        el.setAttribute('data-config', encodeConfig(clientConfig(s, env, ready)));
      },
    })
    .on('head', {
      element(el) {
        if (turnstileEnabled(env)) el.append(TURNSTILE_SCRIPT, { html: true });
      },
    })
    // Strip the template's own data-slot markers from the output.
    .on('[data-slot]', {
      element(el) {
        el.removeAttribute('data-slot');
      },
    });

  const headers = new Headers(template.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return rewriter.transform(new Response(template.body, { status: 200, headers }));
}

export function robotsTxt(s: Settings): Response {
  const body = s.privacy.hide_from_search
    ? '# This site asks not to be indexed.\nUser-agent: *\nDisallow: /\n'
    : 'User-agent: *\nDisallow: /api/\nDisallow: /admin\n';
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
