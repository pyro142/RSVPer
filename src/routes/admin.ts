// Admin API and pages.
//
// Every request reaching handleAdmin() has already been authenticated and
// CSRF-checked by the gate in src/index.ts, except the three routes listed in
// PUBLIC_ADMIN_ROUTES (the login page, login and the session probe).

import type { Env } from '../env';
import { authMode, type AdminAuth } from '../auth/admin';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password';
import {
  clearSessionCookie,
  createSession,
  destroyOtherSessions,
  destroySession,
} from '../auth/session';
import { AdminRepo, mealCounts, summarise, type AdminInvite } from '../db/admin';
import { validateMenu } from '../lib/menu';
import { generateCode } from '../lib/codes';
import { timingSafeEqual } from '../lib/crypto';
import { csvDocument, csvResponse, dateStamp } from '../lib/csv';
import { MAX_NAME_LENGTH, MAX_PARTY_SIZE, seatsError, validateHousehold } from '../lib/households';
import { error, json, readJson } from '../lib/http';
import { ipHash } from '../lib/identity';
import { parseGuestCsv } from '../lib/import';
import { hit, peek } from '../lib/ratelimit';
import { cleanBlock, cleanLine } from '../lib/text';
import { TURNSTILE_KEY, turnstileEnabled } from '../lib/turnstile';
import {
  SECTIONS,
  SettingsError,
  coupleNames,
  validateSection,
  type SectionName,
  type Settings,
} from '../settings';

export interface AdminContext {
  request: Request;
  env: Env;
  url: URL;
  repo: AdminRepo;
  settings: Settings;
  auth: AdminAuth & { ok: true };
  /** The environment as deployed, before admin-saved Turnstile keys are merged in. */
  deployEnv: Env;
}

const LOGIN_LIMITS = {
  perIp15m: { limit: 5, windowSeconds: 900 },
  perIpDay: { limit: 20, windowSeconds: 86400 },
  globalHour: { limit: 50, windowSeconds: 3600 },
};

export const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_IMAGES = 20;

// ---------------------------------------------------------------------------
// Login / logout (password mode)
// ---------------------------------------------------------------------------

export async function login(request: Request, env: Env, repo: AdminRepo): Promise<Response> {
  if (authMode(env) !== 'password') return error('Sign in through Cloudflare Access.', 400);

  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return error('Bad origin.', 403);

  const hash = await ipHash(request, env);
  const keys = {
    ip15: `login:15m:${repo.weddingId}:${hash}`,
    ipDay: `login:d:${repo.weddingId}:${hash}`,
    global: `login:g:${repo.weddingId}`,
  };
  const checks = await Promise.all([
    peek(env.DB, keys.ip15, LOGIN_LIMITS.perIp15m),
    peek(env.DB, keys.ipDay, LOGIN_LIMITS.perIpDay),
    peek(env.DB, keys.global, LOGIN_LIMITS.globalHour),
  ]);
  const blocked = checks.find((c) => !c.ok);
  if (blocked) {
    return error('Too many sign-in attempts. Please wait and try again.', 429, {
      'Retry-After': String(blocked.retryAfter),
    });
  }

  const body = await readJson(request, 4096);
  const password = typeof body?.password === 'string' ? body.password : '';

  const stored = await repo.passwordHash();
  let valid: boolean;
  if (stored) {
    valid = password !== '' && (await verifyPassword(password, stored));
  } else {
    const secret = env.ADMIN_PASSWORD || '';
    if (passwordProblem(secret)) {
      // Safe to say plainly: it tells the operator what to fix and reveals
      // nothing about the password itself.
      return error(
        'Admin sign-in isn’t set up yet: the ADMIN_PASSWORD secret is missing or shorter than 12 characters. Set it in the Cloudflare dashboard (your Worker → Settings → Variables and secrets), then try again.',
        503,
      );
    }
    valid = password !== '' && (await timingSafeEqual(password, secret));
  }

  if (!valid) {
    await Promise.all([
      hit(env.DB, keys.ip15, {
        limit: Infinity,
        windowSeconds: LOGIN_LIMITS.perIp15m.windowSeconds,
      }),
      hit(env.DB, keys.ipDay, {
        limit: Infinity,
        windowSeconds: LOGIN_LIMITS.perIpDay.windowSeconds,
      }),
      hit(env.DB, keys.global, {
        limit: Infinity,
        windowSeconds: LOGIN_LIMITS.globalHour.windowSeconds,
      }),
      repo.recordEvent('login_failed', hash),
    ]);
    return error('That password is not right.', 401);
  }

  const session = await createSession(env.DB, env, repo.weddingId, hash);
  await repo.recordEvent('login', hash);
  return json({ ok: true, csrf: session.csrf }, 200, { 'Set-Cookie': session.cookie });
}

// ---------------------------------------------------------------------------
// Authenticated API
// ---------------------------------------------------------------------------

export async function handleAdminApi(c: AdminContext): Promise<Response> {
  const { request, url } = c;
  const path = url.pathname.slice('/api/admin'.length) || '/';
  const method = request.method;

  if (path === '/session' && method === 'GET') return session(c);
  if (path === '/logout' && method === 'POST') return logout(c);
  if (path === '/password' && method === 'POST') return changePassword(c);

  if (path === '/settings' && method === 'GET') return getSettings(c);
  const settingsMatch = path.match(/^\/settings\/([a-z_]+)$/);
  if (settingsMatch && method === 'PUT') return putSettings(c, settingsMatch[1]!);
  if (path === '/setup/complete' && method === 'POST') return completeSetup(c);

  if (path === '/stats' && method === 'GET') {
    const invites = await c.repo.loadInvites();
    const stats = summarise(invites);
    if (!c.settings.features.meals) return json(stats);
    const menu = await c.repo.menu({ includeRetired: true });
    return json({ ...stats, meals: mealCounts(invites, menu) });
  }
  if (path === '/menu' && method === 'GET') {
    return json({
      courses: await c.repo.menu(),
      usage: Object.fromEntries(await c.repo.optionUsage()),
    });
  }
  if (path === '/menu' && method === 'PUT') return saveMenu(c);
  if (path === '/turnstile' && method === 'GET') return getTurnstile(c);
  if (path === '/turnstile' && method === 'PUT') return putTurnstile(c);
  if (path === '/turnstile' && method === 'DELETE') {
    await c.repo.saveTurnstileKeys(null);
    return getTurnstile(c);
  }
  if (path === '/invites' && method === 'GET') return json({ invites: await c.repo.loadInvites() });
  if (path === '/invites' && method === 'POST') return createInvite(c);
  if (path === '/import' && method === 'POST') return importGuests(c);

  const inviteMatch = path.match(/^\/invites\/([A-Za-z0-9-]{1,64})(\/reset-reply)?$/);
  if (inviteMatch) {
    const id = inviteMatch[1]!;
    if (inviteMatch[2] && method === 'POST') return resetReply(c, id);
    if (!inviteMatch[2] && method === 'PATCH') return updateInvite(c, id);
    if (!inviteMatch[2] && method === 'DELETE') return deleteInvite(c, id);
  }

  if (path === '/export.csv' && method === 'GET') return exportReplies(c);
  if (path === '/links.csv' && method === 'GET') return exportLinks(c);

  if (path === '/images' && method === 'GET') return json({ images: await c.repo.listImages() });
  if (path === '/images' && method === 'POST') return uploadImage(c);
  const imageMatch = path.match(/^\/images\/([a-f0-9]{32})$/);
  if (imageMatch && method === 'DELETE') {
    return (await c.repo.deleteImage(imageMatch[1]!))
      ? json({ deleted: true })
      : error('Image not found.', 404);
  }

  return error('Not found.', 404);
}

async function session(c: AdminContext): Promise<Response> {
  const wedding = await c.repo.wedding();
  const warnings: { level: 'info' | 'warn'; message: string }[] = [];

  if (!turnstileEnabled(c.env)) {
    warnings.push({
      level: 'info',
      message:
        'Bot protection (Cloudflare Turnstile) is off. Replies are still rate limited, but Turnstile is free and recommended: add it in Settings → Bot protection.',
    });
  }
  if (c.settings.features.meals) {
    const menu = await c.repo.menu();
    if (!menu.some((course) => course.options.length > 0)) {
      warnings.push({
        level: 'warn',
        message:
          'Meal choices are on, but there is no menu yet. Add one in Settings → Menu, or guests won’t be asked.',
      });
    }
  }
  const events = await c.repo.recentEvents(86400);
  const failed = events.find((e) => e.kind === 'lookup_failed')?.count ?? 0;
  if (failed >= 50) {
    warnings.push({
      level: 'warn',
      message: `${failed} failed invite-code guesses in the last 24 hours. Someone may be trying to guess codes. Consider turning on Turnstile.`,
    });
  }
  const loginFailed = events.find((e) => e.kind === 'login_failed')?.count ?? 0;
  if (loginFailed >= 10) {
    warnings.push({
      level: 'warn',
      message: `${loginFailed} failed admin sign-in attempts in the last 24 hours.`,
    });
  }

  return json({
    mode: c.auth.mode,
    identity: c.auth.identity,
    csrf: c.auth.mode === 'password' ? c.auth.session.csrf_token : null,
    setup_complete: Boolean(wedding?.setup_completed_at),
    couple: coupleNames(c.settings),
    origin: c.url.origin,
    evening_enabled: c.settings.evening.enabled,
    features: c.settings.features,
    times: { ceremony: c.settings.event.ceremony_time, reception: c.settings.event.reception_time },
    turnstile_configured: turnstileEnabled(c.env),
    password_from_settings:
      c.auth.mode === 'password' ? Boolean(await c.repo.passwordHash()) : false,
    warnings,
  });
}

async function logout(c: AdminContext): Promise<Response> {
  if (c.auth.mode === 'password') await destroySession(c.env.DB, c.auth.session);
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

async function changePassword(c: AdminContext): Promise<Response> {
  if (c.auth.mode !== 'password') return error('Passwords are managed by Cloudflare Access.', 400);
  const body = await readJson(c.request, 4096);
  if (!body) return error('Malformed request.', 400);

  const current = typeof body.current === 'string' ? body.current : '';
  const stored = await c.repo.passwordHash();
  const currentOk = stored
    ? await verifyPassword(current, stored)
    : await timingSafeEqual(current, c.env.ADMIN_PASSWORD || '');
  if (!current || !currentOk) {
    await c.repo.recordEvent('password_change_failed', null);
    return error('Your current password is not right.', 403);
  }

  const problem = passwordProblem(body.new);
  if (problem) return error(problem, 400);

  await c.repo.setPasswordHash(await hashPassword(body.new as string));
  // Sign out everywhere else.
  await destroyOtherSessions(c.env.DB, c.repo.weddingId, c.auth.session.id);
  await c.repo.recordEvent('password_changed', null);
  return json({ ok: true });
}

// --- settings -----------------------------------------------------------------

async function getSettings(c: AdminContext): Promise<Response> {
  return json({
    settings: c.settings,
    meta: {
      auth_mode: c.auth.mode,
      turnstile_configured: turnstileEnabled(c.env),
      setup_complete: Boolean((await c.repo.wedding())?.setup_completed_at),
    },
  });
}

async function putSettings(c: AdminContext, section: string): Promise<Response> {
  if (!(SECTIONS as string[]).includes(section)) return error('Unknown settings section.', 404);
  const name = section as SectionName;
  const body = await readJson(c.request, 32 * 1024);
  if (!body) return error('Malformed request.', 400);

  try {
    const value = validateSection(name, c.settings[name], body);
    await c.repo.saveSection(name, value);
    return json({ section: name, value });
  } catch (err) {
    if (err instanceof SettingsError) return json({ error: err.message, field: err.field }, 400);
    throw err;
  }
}

async function completeSetup(c: AdminContext): Promise<Response> {
  const s = c.settings;
  const missing: string[] = [];
  if (!s.event.date) missing.push('the wedding date');
  if (!(await c.repo.hasStoredSection('couple'))) missing.push('your names');
  if (missing.length) return error(`Please add ${missing.join(' and ')} first.`, 400);
  await c.repo.markSetupComplete();
  return json({ ok: true });
}

// --- Turnstile ----------------------------------------------------------------

async function getTurnstile(c: AdminContext): Promise<Response> {
  const fromDeploy = turnstileEnabled(c.deployEnv);
  const stored = await c.repo.turnstileKeys();
  return json({
    // Where the active keys come from: deploy secrets win over saved keys.
    source: fromDeploy ? 'deploy' : stored ? 'settings' : null,
    // The site key is public by design (it ships in the page). The secret is
    // never returned.
    site_key: fromDeploy ? c.deployEnv.TURNSTILE_SITE_KEY : (stored?.site_key ?? null),
    secret_set: fromDeploy || Boolean(stored),
  });
}

async function putTurnstile(c: AdminContext): Promise<Response> {
  const body = await readJson(c.request, 4096);
  if (!body) return error('Malformed request.', 400);
  const site = typeof body.site_key === 'string' ? body.site_key.trim() : '';
  let secret = typeof body.secret_key === 'string' ? body.secret_key.trim() : '';
  const stored = await c.repo.turnstileKeys();
  // Leaving the secret blank keeps the one already saved.
  if (!secret && stored) secret = stored.secret_key;
  if (!TURNSTILE_KEY.test(site)) {
    return json({ error: 'That doesn’t look like a Turnstile site key.', field: 'site_key' }, 400);
  }
  if (!TURNSTILE_KEY.test(secret)) {
    return json(
      { error: 'That doesn’t look like a Turnstile secret key.', field: 'secret_key' },
      400,
    );
  }
  if (site === secret) return error('The site key and secret key must be different.', 400);
  await c.repo.saveTurnstileKeys({ site_key: site, secret_key: secret });
  await c.repo.recordEvent('turnstile_updated', null);
  return getTurnstile(c);
}

// --- menu ---------------------------------------------------------------------

async function saveMenu(c: AdminContext): Promise<Response> {
  const body = await readJson(c.request, 64 * 1024);
  const result = validateMenu(body);
  if ('error' in result) return error(result.error, 400);
  const saved = await c.repo.saveMenu(result.value);
  if (saved.error) return error(saved.error, 409);
  return json({ courses: await c.repo.menu() });
}

// --- invites ------------------------------------------------------------------

async function createInvite(c: AdminContext): Promise<Response> {
  const body = await readJson(c.request);
  if (!body) return error('Malformed request.', 400);
  const result = validateHousehold(body);
  if ('error' in result) return error(result.error, 400);
  if (result.value.reception_only && !c.settings.evening.enabled) {
    return error('Evening invites are turned off in Settings.', 400);
  }
  const created = await c.repo.createInvites([result.value], c.settings.security.code_length);
  return json({ created }, 201);
}

async function importGuests(c: AdminContext): Promise<Response> {
  const body = await readJson(c.request, 512 * 1024);
  if (!body || typeof body.csv !== 'string') return error('Malformed request.', 400);
  const parsed = parseGuestCsv(body.csv, { eveningEnabled: c.settings.evening.enabled });

  const preview = {
    households: parsed.households.map((h) => ({
      household_name: h.household_name,
      max_party_size: h.max_party_size,
      reception_only: h.reception_only,
      guests: h.guests,
      lines: h.lines,
    })),
    errors: parsed.errors,
  };

  if (body.dry_run !== false || parsed.errors.length || !parsed.households.length) {
    return json({ ...preview, imported: false }, parsed.errors.length ? 422 : 200);
  }

  const created = await c.repo.createInvites(parsed.households, c.settings.security.code_length);
  return json({ ...preview, imported: true, created }, 201);
}

async function updateInvite(c: AdminContext, id: string): Promise<Response> {
  const body = await readJson(c.request);
  if (!body) return error('Malformed request.', 400);
  const invite = await c.repo.inviteById(id);
  if (!invite) return error('Invite not found.', 404);
  const replied = Boolean(await c.repo.rsvpForInvite(id));

  const patch: Parameters<AdminRepo['updateInvite']>[1] = {};

  if (body.household_name !== undefined) {
    const name = cleanLine(body.household_name, MAX_NAME_LENGTH);
    if (!name) return error(`Household name must be 1–${MAX_NAME_LENGTH} characters.`, 400);
    patch.household_name = name;
  }

  let max = invite.max_party_size;
  if (body.max_party_size !== undefined) {
    max = Number(body.max_party_size);
    if (!Number.isInteger(max) || max < 1 || max > MAX_PARTY_SIZE) {
      return error(`Max party size must be a whole number between 1 and ${MAX_PARTY_SIZE}.`, 400);
    }
    patch.max_party_size = max;
  }

  if (body.reception_only !== undefined) {
    if (body.reception_only === true && !c.settings.evening.enabled) {
      return error('Evening invites are turned off in Settings.', 400);
    }
    patch.reception_only = body.reception_only === true;
  }

  if (body.admin_notes !== undefined) {
    patch.admin_notes = cleanBlock(body.admin_notes, 1000);
  }

  if (body.guests !== undefined) {
    // Rewriting the guest list would cascade into a reply already given.
    if (replied) {
      return error(
        'This household has already replied, so their guest list is locked. Reset their reply first if it really needs to change.',
        409,
      );
    }
    const v = validateHousehold({
      household_name: patch.household_name ?? invite.household_name,
      max_party_size: max,
      guests: body.guests,
    });
    if ('error' in v) return error(v.error, 400);
    patch.guests = v.value.guests;
  } else if (patch.max_party_size !== undefined) {
    const seats = await c.repo.guestSeats(id);
    if (max < seats.count + seats.plus_ones) {
      return error(seatsError(max, seats.count, seats.plus_ones), 400);
    }
  }

  if (body.regenerate_code === true) {
    const taken = await c.repo.existingCodes();
    let code = generateCode(c.settings.security.code_length);
    while (taken.has(code)) code = generateCode(c.settings.security.code_length);
    patch.code = code;
  }

  if (Object.keys(patch).length === 0) return error('Nothing to update.', 400);
  await c.repo.updateInvite(id, patch);
  return json({ updated: true, code: patch.code ?? invite.code });
}

async function deleteInvite(c: AdminContext, id: string): Promise<Response> {
  return (await c.repo.deleteInvite(id))
    ? json({ deleted: true })
    : error('Invite not found.', 404);
}

async function resetReply(c: AdminContext, id: string): Promise<Response> {
  if (!(await c.repo.inviteById(id))) return error('Invite not found.', 404);
  const reset = await c.repo.resetReply(id);
  if (reset) await c.repo.recordEvent('reply_reset', null);
  return json({ reset });
}

// --- exports ------------------------------------------------------------------

function attendanceLabel(invite: AdminInvite, attending: boolean | null): string {
  if (invite.status === 'outstanding') return 'no reply';
  return attending ? 'yes' : 'no';
}

async function exportReplies(c: AdminContext): Promise<Response> {
  const s = c.settings;
  const invites = await c.repo.loadInvites();
  const evening = s.evening.enabled;
  // Include retired options so earlier choices still resolve to a name.
  const menu = s.features.meals ? await c.repo.menu({ includeRetired: true }) : [];
  const optionName = new Map(menu.flatMap((course) => course.options.map((o) => [o.id, o.name])));

  const header = ['household', 'code', 'link'];
  if (evening) header.push('invited_to');
  header.push('guest_name', 'is_plus_one', 'attending');
  if (evening) header.push('attending_as');
  for (const course of menu) header.push(`meal: ${course.name}`);
  if (s.features.dietary) header.push('dietary_notes');
  if (s.features.song_request) header.push('song_request');
  if (s.features.message) header.push('message');
  header.push('submitted_at');

  const rows: unknown[][] = [];
  for (const invite of invites) {
    for (const guest of invite.guests) {
      const people: {
        name: string;
        plusOne: boolean;
        attending: boolean | null;
        dietary: string | null;
        meals: Record<string, string>;
      }[] = [
        {
          name: guest.name,
          plusOne: false,
          attending: guest.attending,
          dietary: guest.dietary_notes,
          meals: guest.meals,
        },
      ];
      if (guest.plus_one_name) {
        people.push({
          name: guest.plus_one_name,
          plusOne: true,
          attending: true,
          dietary: guest.plus_one_dietary_notes,
          meals: guest.plus_one_meals,
        });
      }
      for (const p of people) {
        const row: unknown[] = [
          invite.household_name,
          invite.code,
          `${c.url.origin}/${invite.code}`,
        ];
        if (evening) row.push(invite.reception_only ? 'evening' : 'full day');
        row.push(p.name, p.plusOne ? 'yes' : 'no', attendanceLabel(invite, p.attending));
        if (evening) {
          row.push(
            invite.status === 'accepted' && p.attending
              ? invite.evening_only
                ? 'evening'
                : 'full day'
              : '',
          );
        }
        for (const course of menu) {
          const chosen = p.meals[course.id];
          row.push(chosen ? (optionName.get(chosen) ?? '') : '');
        }
        if (s.features.dietary) row.push(p.dietary ?? '');
        if (s.features.song_request) row.push(p.plusOne ? '' : (invite.song_request ?? ''));
        if (s.features.message) row.push(p.plusOne ? '' : (invite.message ?? ''));
        row.push(invite.submitted_at ?? '');
        rows.push(row);
      }
    }
  }
  return csvResponse(csvDocument(header, rows), `rsvps-${dateStamp()}.csv`);
}

async function exportLinks(c: AdminContext): Promise<Response> {
  const invites = await c.repo.loadInvites();
  const rows = invites.map((i) => [i.household_name, i.code, `${c.url.origin}/${i.code}`]);
  return csvResponse(
    csvDocument(['household', 'code', 'link'], rows),
    `invite-links-${dateStamp()}.csv`,
  );
}

// --- images -------------------------------------------------------------------

function sniffImage(bytes: Uint8Array): string | null {
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length > 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

async function uploadImage(c: AdminContext): Promise<Response> {
  const declared = Number(c.request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    return error('Images must be 1 MB or smaller.', 413);
  }
  const buffer = await c.request.arrayBuffer();
  if (buffer.byteLength === 0) return error('No image received.', 400);
  if (buffer.byteLength > MAX_IMAGE_BYTES) return error('Images must be 1 MB or smaller.', 413);

  // Trust the bytes, not the header: only real PNG / JPEG / WebP files.
  // SVG is never accepted because it can carry script.
  const type = sniffImage(new Uint8Array(buffer));
  if (!type) return error('Please upload a PNG, JPEG or WebP image.', 415);

  if ((await c.repo.listImages()).length >= MAX_IMAGES) {
    return error(`You can keep up to ${MAX_IMAGES} images. Delete one first.`, 400);
  }
  const id = await c.repo.insertImage(type, buffer);
  return json({ id, url: `/media/${id}` }, 201);
}

/** Public: serve an uploaded image. */
export async function serveMedia(repo: AdminRepo, id: string): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response('Not found.', { status: 404 });
  const image = await repo.image(id);
  if (!image) return new Response('Not found.', { status: 404 });
  return new Response(image.bytes, {
    headers: {
      'Content-Type': image.content_type,
      'Cache-Control': 'public, max-age=86400',
      'Content-Disposition': 'inline',
    },
  });
}
