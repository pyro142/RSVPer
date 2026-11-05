-- Demo sandboxes (only used when the Worker runs with DEMO_MODE=true).
--
-- Each demo visitor gets their own wedding row with an expiry time. Deleting
-- the row removes everything belonging to it (every table cascades from
-- weddings). Real weddings leave this NULL and never expire.
ALTER TABLE weddings ADD COLUMN demo_expires_at INTEGER;

CREATE INDEX idx_weddings_demo_expiry ON weddings (demo_expires_at)
  WHERE demo_expires_at IS NOT NULL;
