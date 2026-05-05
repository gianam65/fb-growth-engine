-- Track AI-generated photo posts published via Graph API.
CREATE TABLE IF NOT EXISTS fb_posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_post_id      TEXT,                       -- post id from /{page_id}/feed
  theme           TEXT,                       -- short slug from generator
  caption         TEXT,
  hashtags        TEXT,
  style_preset    TEXT,                       -- e.g. asian-cozy, japandi
  num_photos      INTEGER NOT NULL,
  photo_fbids     TEXT,                       -- JSON array of media_fbids
  scenes          TEXT,                       -- JSON array of scene_descriptions
  published_at    INTEGER,                    -- unix seconds
  inserted_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_fb_posts_published ON fb_posts(published_at);
