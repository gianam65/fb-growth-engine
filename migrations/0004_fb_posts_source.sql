-- Distinguish AI-generated posts (pollinations) from curated stock photos (pexels).
ALTER TABLE fb_posts ADD COLUMN source TEXT DEFAULT 'pollinations';
ALTER TABLE fb_posts ADD COLUMN credits TEXT;  -- JSON: [{ photographer, photographer_url, photo_id }]
