-- Manually curated photo pool. User reviews PENDING candidates, marks
-- APPROVED. Daily cron picks oldest-unused APPROVED photos for posts.
CREATE TABLE IF NOT EXISTS curated_photos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,                     -- 'pexels' | 'unsplash'
  source_id       TEXT NOT NULL,                     -- Pexels photo id (numeric as string)
  source_url      TEXT,                              -- public page url
  image_url       TEXT NOT NULL,                     -- high-res image URL (FB upload source)
  thumb_url       TEXT,                              -- smaller URL for admin UI
  photographer    TEXT,
  photographer_url TEXT,
  alt             TEXT,
  width           INTEGER,
  height          INTEGER,
  search_keyword  TEXT,                              -- which query surfaced this photo
  status          TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | APPROVED | REJECTED
  decided_at      INTEGER,                           -- when approved/rejected
  used_count      INTEGER NOT NULL DEFAULT 0,
  last_used_at    INTEGER,
  inserted_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_curated_status ON curated_photos(status);
CREATE INDEX IF NOT EXISTS idx_curated_pick ON curated_photos(status, last_used_at);
