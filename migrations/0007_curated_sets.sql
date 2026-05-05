-- Group photos into "sets" — one post = one set (typically 2-3 same-room photos).
ALTER TABLE curated_photos ADD COLUMN set_id TEXT;
ALTER TABLE curated_photos ADD COLUMN set_order INTEGER NOT NULL DEFAULT 0;

-- Backfill: existing photos each become their own singleton set
UPDATE curated_photos
   SET set_id = 'legacy-' || id
 WHERE set_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_curated_set_pick
  ON curated_photos(status, set_id, last_used_at);
