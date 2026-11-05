// Guest API.
//
//   POST /api/rsvp/lookup — exchange an invite code for the household's details
//   POST /api/rsvp/submit — record a household's reply. One shot, no edits.

import type { Env } from '../env';
import type { InviteGuestRow, NewRsvpGuest, WeddingRepo } from '../db/repo';
import { isValidCode, normaliseCode } from '../lib/codes';
import { LookupGuard } from '../lib/guard';
import { error, json, readJson, clientIp } from '../lib/http';
import { ipHash } from '../lib/identity';
import { hit } from '../lib/ratelimit';
import { cleanBlock, cleanLine, tooLong } from '../lib/text';
import { turnstileEnabled, verifyTurnstile } from '../lib/turnstile';
import { rsvpClosed, type Settings } from '../settings';

export const LIMITS = {
  plusOneName: 80,
  dietary: 300,
  song: 200,
  message: 1000,
};

// One message for "no such code". Never confirms whether a code exists.
const NOT_FOUND =
  "We couldn't find that code. Please check your invitation, or get in touch and we'll help.";
const TOO_MANY = 'Too many attempts. Please wait a while and try again.';
const NOT_OPEN = "This invitation isn't open for replies yet.";
const HUMAN_CHECK = "We couldn't verify that you're human. Please refresh the page and try again.";

interface Context {
  request: Request;
  env: Env;
  repo: WeddingRepo;
  settings: Settings;
  ctx: ExecutionContext;
}

/**
 * Shared front half of lookup and submit: setup check, brute-force guard,
 * optional Turnstile, code validation. Submitting is also a code oracle, so it
 * goes through exactly the same guard as lookup.
 */
async function resolveInvite(
  c: Context,
  body: Record<string, unknown>,
  ipHashValue: string,
  opts: { turnstileAlways: boolean },
) {
  const wedding = await c.repo.wedding();
  if (!wedding?.setup_completed_at) return { response: error(NOT_OPEN, 503) };

  const guard = new LookupGuard(c.repo, c.settings.security, ipHashValue);
  const tripped = await guard.breakerTripped();
  const useTurnstile = turnstileEnabled(c.env) && (opts.turnstileAlways || tripped);

  const verdict = await guard.allow({ strict: tripped && !turnstileEnabled(c.env) });
  if (!verdict.ok) {
    return { response: error(TOO_MANY, 429, { 'Retry-After': String(verdict.retryAfter) }) };
  }

  if (useTurnstile) {
    const check = await verifyTurnstile(c.env, body.turnstile_token, clientIp(c.request));
    if (!check.ok) {
      return {
        response: json(
          {
            error: HUMAN_CHECK,
            turnstile_required: true,
            turnstile_site_key: c.env.TURNSTILE_SITE_KEY,
          },
          403,
        ),
      };
    }
  }

  const code = normaliseCode(body.code);
  const invite = isValidCode(code) ? await c.repo.inviteByCode(code) : null;
  if (!invite) {
    await guard.recordFailure();
    return { response: error(NOT_FOUND, 404) };
  }
  return { invite };
}

export async function lookup(c: Context): Promise<Response> {
  const body = await readJson(c.request, 4 * 1024);
  if (!body) return error('Malformed request.', 400);

  const hash = await ipHash(c.request, c.env);
  const resolved = await resolveInvite(c, body, hash, { turnstileAlways: false });
  if (resolved.response) return resolved.response;
  const invite = resolved.invite;

  c.ctx.waitUntil(c.repo.recordOpen(invite.id));

  const [guests, rsvp] = await Promise.all([
    c.repo.inviteGuests(invite.id),
    c.repo.rsvpForInvite(invite.id),
  ]);

  const evening = c.settings.evening.enabled;

  return json({
    household_name: invite.household_name,
    max_party_size: invite.max_party_size,
    reception_only: evening && Boolean(invite.reception_only),
    turnstile_site_key: turnstileEnabled(c.env) ? c.env.TURNSTILE_SITE_KEY : null,
    closed: rsvpClosed(c.settings),
    features: {
      evening,
      dietary: c.settings.features.dietary,
      song_request: c.settings.features.song_request,
      message: c.settings.features.message,
    },
    guests: guests.map((g) => ({
      id: g.id,
      name: g.name,
      allows_plus_one: Boolean(g.allows_plus_one),
    })),
    already_submitted: Boolean(rsvp),
    previous_rsvp: rsvp
      ? {
          attending: Boolean(rsvp.attending),
          reception_only: evening && Boolean(rsvp.attending_reception_only),
          guest_names: await c.repo.attendingNames(rsvp.id),
        }
      : null,
  });
}

export async function submit(c: Context): Promise<Response> {
  const hash = await ipHash(c.request, c.env);

  const limit = await hit(c.env.DB, `submit:${c.repo.weddingId}:${hash}`, {
    limit: c.settings.security.submits_per_hour,
    windowSeconds: 3600,
  });
  if (!limit.ok) return error(TOO_MANY, 429, { 'Retry-After': String(limit.retryAfter) });

  const body = await readJson(c.request, 32 * 1024);
  if (!body) return error('Malformed request.', 400);

  // Turnstile, when configured, is always required to submit.
  const resolved = await resolveInvite(c, body, hash, { turnstileAlways: true });
  if (resolved.response) return resolved.response;
  const invite = resolved.invite;

  if (rsvpClosed(c.settings)) {
    return error(c.settings.copy.closed_message, 403);
  }

  if (typeof body.attending !== 'boolean') {
    return error('Please choose whether you can join us.', 400);
  }

  if (await c.repo.rsvpForInvite(invite.id)) {
    return error(alreadySubmitted(c.settings), 409);
  }

  const inviteGuests = await c.repo.inviteGuests(invite.id);
  const plan = buildGuestRows(body, inviteGuests, invite.max_party_size, c.settings);
  if ('error' in plan) return error(plan.error, 400);

  const extras = householdExtras(body, c.settings);
  if ('error' in extras) return error(extras.error, 400);

  // Records the household's own choice. Effective evening status is
  // (invites.reception_only OR this), so a crafted value can never promote a
  // reception-only household onto the day guest list.
  const choseEvening =
    c.settings.evening.enabled &&
    body.attending &&
    !invite.reception_only &&
    body.reception_only === true;

  try {
    await c.repo.insertRsvp({
      inviteId: invite.id,
      attending: body.attending,
      receptionOnly: choseEvening,
      songRequest: body.attending ? extras.songRequest : null,
      message: extras.message,
      ipHash: hash,
      guests: plan.rows,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'ALREADY_SUBMITTED') {
      return error(alreadySubmitted(c.settings), 409);
    }
    throw err;
  }

  return json({ success: true });
}

function alreadySubmitted(s: Settings): string {
  return `${s.copy.already_title} ${s.copy.already_message}`.trim();
}

/**
 * Turn the submitted guest list into one row per person, or an error.
 *
 * Exported for tests. Never trusts the client: every id must belong to this
 * invite, the party cap is re-checked here, and a decline ignores whatever
 * guest detail came with it.
 */
export function buildGuestRows(
  body: Record<string, unknown>,
  inviteGuests: InviteGuestRow[],
  maxPartySize: number,
  settings: Settings,
): { rows: NewRsvpGuest[] } | { error: string } {
  const named = (id: string, attending: boolean, dietary: string | null = null): NewRsvpGuest => ({
    inviteGuestId: id,
    hostGuestId: null,
    plusOneName: null,
    attending,
    dietaryNotes: dietary,
  });

  if (!body.attending) {
    return { rows: inviteGuests.map((g) => named(g.id, false)) };
  }

  if (!Array.isArray(body.guests)) return { error: 'Please tell us who can make it.' };
  // Bound before iterating: a reply can never list more people than the invite.
  if (body.guests.length > inviteGuests.length) return { error: 'Malformed guest list.' };

  const byId = new Map(inviteGuests.map((g) => [g.id, g]));
  const submitted = new Map<
    string,
    {
      attending: boolean;
      plusOne: string | null;
      dietary: string | null;
      plusOneDietary: string | null;
    }
  >();
  const dietaryOn = settings.features.dietary;

  for (const entry of body.guests as unknown[]) {
    if (!entry || typeof entry !== 'object') return { error: 'Malformed guest list.' };
    const e = entry as Record<string, unknown>;

    // Ids from another household are rejected outright.
    const guest = typeof e.invite_guest_id === 'string' ? byId.get(e.invite_guest_id) : undefined;
    if (!guest) return { error: 'Malformed guest list.' };
    if (submitted.has(guest.id)) return { error: 'Duplicate guest in submission.' };

    const attending = e.attending !== false;

    let plusOne: string | null = null;
    const wantsPlusOne =
      e.plus_one === true || (typeof e.plus_one_name === 'string' && e.plus_one_name.trim() !== '');
    if (attending && wantsPlusOne) {
      if (!guest.allows_plus_one) return { error: 'Malformed guest list.' };
      if (tooLong(e.plus_one_name, LIMITS.plusOneName)) {
        return { error: `Plus one names need to be under ${LIMITS.plusOneName} characters.` };
      }
      plusOne = cleanLine(e.plus_one_name, LIMITS.plusOneName);
      if (!plusOne) {
        return { error: `Please add ${guest.name}'s plus one's name.` };
      }
    }

    let dietary: string | null = null;
    let plusOneDietary: string | null = null;
    if (dietaryOn && attending) {
      if (
        tooLong(e.dietary_notes, LIMITS.dietary) ||
        tooLong(e.plus_one_dietary_notes, LIMITS.dietary)
      ) {
        return { error: `Dietary notes need to be under ${LIMITS.dietary} characters.` };
      }
      dietary = cleanBlock(e.dietary_notes, LIMITS.dietary);
      plusOneDietary = plusOne ? cleanBlock(e.plus_one_dietary_notes, LIMITS.dietary) : null;
    }

    submitted.set(guest.id, { attending, plusOne, dietary, plusOneDietary });
  }

  const rows: NewRsvpGuest[] = [];
  for (const guest of inviteGuests) {
    const choice = submitted.get(guest.id);
    // Anyone the client left out is treated as not attending.
    if (!choice) {
      rows.push(named(guest.id, false));
      continue;
    }
    rows.push(named(guest.id, choice.attending, choice.dietary));
    if (choice.plusOne) {
      rows.push({
        inviteGuestId: null,
        hostGuestId: guest.id,
        plusOneName: choice.plusOne,
        attending: true,
        dietaryNotes: choice.plusOneDietary,
      });
    }
  }

  const heads = rows.filter((r) => r.attending).length;
  if (heads === 0) {
    return { error: "Please select at least one guest, or let us know you can't make it." };
  }
  // The cap decides catering numbers, so it's enforced here, not just in the UI.
  if (heads > maxPartySize) {
    return {
      error: `This invite is for up to ${maxPartySize} guest${maxPartySize === 1 ? '' : 's'}. Please contact us if you need to make changes.`,
    };
  }
  return { rows };
}

function householdExtras(
  body: Record<string, unknown>,
  settings: Settings,
): { songRequest: string | null; message: string | null } | { error: string } {
  let songRequest: string | null = null;
  let message: string | null = null;
  if (settings.features.song_request) {
    if (tooLong(body.song_request, LIMITS.song)) {
      return { error: `Song requests need to be under ${LIMITS.song} characters.` };
    }
    songRequest = cleanLine(body.song_request, LIMITS.song);
  }
  if (settings.features.message) {
    if (tooLong(body.message, LIMITS.message)) {
      return { error: `Messages need to be under ${LIMITS.message} characters.` };
    }
    message = cleanBlock(body.message, LIMITS.message);
  }
  return { songRequest, message };
}
