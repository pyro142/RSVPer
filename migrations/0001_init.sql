-- RSVPer — initial schema.
--
-- TENANCY
-- Every row belongs to a wedding. Today there is exactly one ('default'), but
-- every table carries wedding_id and every child table references its parent
-- through a composite (wedding_id, id) foreign key. That means the database
-- itself refuses a row that points at another wedding's data, on top of the
-- data-access layer always scoping by wedding_id. See docs/architecture.md.
--
-- rate_limits is the one exception: it is infrastructure keyed by hashed
-- client identity, and a limit should hold across weddings, not per wedding.

-- ---------------------------------------------------------------------------
-- weddings
-- ---------------------------------------------------------------------------
CREATE TABLE weddings (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- NULL until the admin finishes the first-run setup wizard.
  setup_completed_at TEXT
);

INSERT INTO weddings (id) VALUES ('default');

-- ---------------------------------------------------------------------------
-- settings — one JSON value per key, per wedding
-- ---------------------------------------------------------------------------
-- Keys and their shapes are defined and validated in src/settings.ts; the
-- database just stores them. Adding a setting never needs a migration.
CREATE TABLE settings (
  wedding_id TEXT NOT NULL REFERENCES weddings (id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wedding_id, key)
);

-- ---------------------------------------------------------------------------
-- admin_credentials — a password set from the admin Settings page. When a row
-- exists it takes precedence over the ADMIN_PASSWORD deploy secret.
-- PBKDF2-SHA-256; the hash string records its own parameters.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_credentials (
  wedding_id    TEXT PRIMARY KEY REFERENCES weddings (id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- admin_sessions — server-side sessions, so logout and password changes can
-- revoke them. The cookie carries only a random id plus an HMAC.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_sessions (
  id          TEXT PRIMARY KEY,
  wedding_id  TEXT NOT NULL REFERENCES weddings (id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,          -- unix seconds
  expires_at  INTEGER NOT NULL,          -- unix seconds
  ip_hash     TEXT
);

CREATE INDEX idx_admin_sessions_expiry ON admin_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- invites — one row per household
-- ---------------------------------------------------------------------------
CREATE TABLE invites (
  id              TEXT NOT NULL,
  wedding_id      TEXT NOT NULL REFERENCES weddings (id) ON DELETE CASCADE,
  -- Unambiguous alphabet only: no 0/O or 1/I/L. Length is a setting (5 or 6),
  -- so the check allows a small range rather than one value.
  code            TEXT NOT NULL
                    CHECK (
                      length(code) BETWEEN 5 AND 8
                      AND code = upper(code)
                      AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'
                    ),
  household_name  TEXT NOT NULL CHECK (length(household_name) BETWEEN 1 AND 120),
  max_party_size  INTEGER NOT NULL CHECK (max_party_size BETWEEN 1 AND 20),
  -- Invited to the reception only (evening guests), when that feature is on.
  reception_only  INTEGER NOT NULL DEFAULT 0 CHECK (reception_only IN (0, 1)),
  -- Private notes for the couple. Never shown to guests.
  admin_notes     TEXT CHECK (admin_notes IS NULL OR length(admin_notes) <= 1000),
  -- Written by the lookup API (a browser actually loaded the card), not by
  -- page views, so link-preview crawlers don't mark invites as opened.
  first_opened_at TEXT,
  last_opened_at  TEXT,
  open_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (id),
  UNIQUE (wedding_id, id),
  UNIQUE (wedding_id, code)
);

-- ---------------------------------------------------------------------------
-- invite_guests — the named people on a household's invite
-- ---------------------------------------------------------------------------
CREATE TABLE invite_guests (
  id               TEXT NOT NULL PRIMARY KEY,
  wedding_id       TEXT NOT NULL,
  invite_id        TEXT NOT NULL,
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  allows_plus_one  INTEGER NOT NULL DEFAULT 0 CHECK (allows_plus_one IN (0, 1)),
  sort_order       INTEGER NOT NULL DEFAULT 0,

  UNIQUE (wedding_id, id),
  FOREIGN KEY (wedding_id, invite_id)
    REFERENCES invites (wedding_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_invite_guests_invite ON invite_guests (wedding_id, invite_id, sort_order);

-- ---------------------------------------------------------------------------
-- rsvps — one row per invite, created on submit. UNIQUE(invite) is the lock
-- that makes a reply one-shot even if two submits race.
-- ---------------------------------------------------------------------------
CREATE TABLE rsvps (
  id                       TEXT NOT NULL PRIMARY KEY,
  wedding_id               TEXT NOT NULL,
  invite_id                TEXT NOT NULL,
  attending                INTEGER NOT NULL CHECK (attending IN (0, 1)),
  -- The household's own choice to come to the evening only, distinct from
  -- invites.reception_only (what they were offered).
  attending_reception_only INTEGER NOT NULL DEFAULT 0
                             CHECK (attending_reception_only IN (0, 1)),
  -- Optional per-household extras (features toggled in settings).
  song_request             TEXT CHECK (song_request IS NULL OR length(song_request) <= 200),
  message                  TEXT CHECK (message IS NULL OR length(message) <= 1000),
  submitted_at             TEXT NOT NULL DEFAULT (datetime('now')),
  submitter_ip_hash        TEXT,

  UNIQUE (wedding_id, id),
  UNIQUE (wedding_id, invite_id),
  FOREIGN KEY (wedding_id, invite_id)
    REFERENCES invites (wedding_id, id) ON DELETE CASCADE,
  CHECK (attending_reception_only = 0 OR attending = 1)
);

-- ---------------------------------------------------------------------------
-- rsvp_guests — one row per PERSON on a reply, named guest or plus one
-- ---------------------------------------------------------------------------
-- Exactly one identity is set:
--   invite_guest_id — a named person from the invite
--   host_guest_id   — a plus one, brought by that named person
CREATE TABLE rsvp_guests (
  id              TEXT NOT NULL PRIMARY KEY,
  wedding_id      TEXT NOT NULL,
  rsvp_id         TEXT NOT NULL,
  invite_guest_id TEXT,
  host_guest_id   TEXT,
  plus_one_name   TEXT CHECK (plus_one_name IS NULL OR length(plus_one_name) BETWEEN 1 AND 80),
  attending       INTEGER NOT NULL CHECK (attending IN (0, 1)),
  dietary_notes   TEXT CHECK (dietary_notes IS NULL OR length(dietary_notes) <= 300),

  UNIQUE (wedding_id, id),
  FOREIGN KEY (wedding_id, rsvp_id)
    REFERENCES rsvps (wedding_id, id) ON DELETE CASCADE,
  FOREIGN KEY (wedding_id, invite_guest_id)
    REFERENCES invite_guests (wedding_id, id) ON DELETE CASCADE,
  FOREIGN KEY (wedding_id, host_guest_id)
    REFERENCES invite_guests (wedding_id, id) ON DELETE CASCADE,

  CHECK (
    (invite_guest_id IS NOT NULL AND host_guest_id IS NULL AND plus_one_name IS NULL)
    OR
    (invite_guest_id IS NULL AND host_guest_id IS NOT NULL AND plus_one_name IS NOT NULL)
  ),
  -- A plus one who isn't coming doesn't get a row at all.
  CHECK (host_guest_id IS NULL OR attending = 1),
  -- NULLs are distinct in UNIQUE, so these don't collide with each other.
  UNIQUE (rsvp_id, invite_guest_id),
  UNIQUE (rsvp_id, host_guest_id)
);

CREATE INDEX idx_rsvp_guests_rsvp ON rsvp_guests (wedding_id, rsvp_id);

-- ---------------------------------------------------------------------------
-- Meals — the menu is data, defined by the couple in settings
-- ---------------------------------------------------------------------------
CREATE TABLE meal_courses (
  id          TEXT NOT NULL PRIMARY KEY,
  wedding_id  TEXT NOT NULL REFERENCES weddings (id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (wedding_id, id)
);

CREATE TABLE meal_options (
  id          TEXT NOT NULL PRIMARY KEY,
  wedding_id  TEXT NOT NULL,
  course_id   TEXT NOT NULL,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description TEXT CHECK (description IS NULL OR length(description) <= 200),
  -- Retire an option without deleting it, so existing choices still resolve.
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (wedding_id, id),
  FOREIGN KEY (wedding_id, course_id)
    REFERENCES meal_courses (wedding_id, id) ON DELETE CASCADE
);

CREATE TABLE rsvp_guest_meals (
  id             TEXT NOT NULL PRIMARY KEY,
  wedding_id     TEXT NOT NULL,
  rsvp_guest_id  TEXT NOT NULL,
  course_id      TEXT NOT NULL,
  meal_option_id TEXT NOT NULL,
  FOREIGN KEY (wedding_id, rsvp_guest_id)
    REFERENCES rsvp_guests (wedding_id, id) ON DELETE CASCADE,
  FOREIGN KEY (wedding_id, course_id)
    REFERENCES meal_courses (wedding_id, id) ON DELETE CASCADE,
  FOREIGN KEY (wedding_id, meal_option_id)
    REFERENCES meal_options (wedding_id, id) ON DELETE CASCADE,
  -- One choice per course per person.
  UNIQUE (rsvp_guest_id, course_id)
);

-- ---------------------------------------------------------------------------
-- images — small uploads (hero/venue photo, decorative art) stored in D1 so
-- nothing extra has to be provisioned. Raster formats only; SVG uploads are
-- refused because they can carry script.
-- ---------------------------------------------------------------------------
CREATE TABLE images (
  id           TEXT NOT NULL PRIMARY KEY,
  wedding_id   TEXT NOT NULL REFERENCES weddings (id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes        BLOB NOT NULL CHECK (length(bytes) <= 1048576),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (wedding_id, id)
);

-- ---------------------------------------------------------------------------
-- security_events — a small audit trail: admin logins, failed code lookups.
-- Feeds the admin "recent activity" panel and the lookup circuit breaker.
-- ---------------------------------------------------------------------------
CREATE TABLE security_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  wedding_id  TEXT NOT NULL REFERENCES weddings (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL           -- unix seconds
);

CREATE INDEX idx_security_events_recent ON security_events (wedding_id, kind, created_at);

-- ---------------------------------------------------------------------------
-- rate_limits — fixed-window counters (free-tier friendly; no WAF rules)
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limits (
  bucket     TEXT PRIMARY KEY,
  hits       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL            -- unix seconds
);

CREATE INDEX idx_rate_limits_expiry ON rate_limits (expires_at);
