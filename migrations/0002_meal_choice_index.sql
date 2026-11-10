-- Meal choices are read per wedding (dashboard, exports, menu edits). Without
-- this index those reads scan every row in the table.
CREATE INDEX IF NOT EXISTS idx_rsvp_guest_meals_wedding ON rsvp_guest_meals (wedding_id);
