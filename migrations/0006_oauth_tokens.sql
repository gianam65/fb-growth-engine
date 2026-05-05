-- OAuth tokens for external providers (Pinterest, etc.).
-- Tokens are refreshable, so stored in D1 (not as Worker secrets).
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider             TEXT PRIMARY KEY,        -- 'pinterest'
  access_token         TEXT NOT NULL,
  refresh_token        TEXT,
  expires_at           INTEGER,                 -- unix seconds when access_token expires
  refresh_expires_at   INTEGER,                 -- unix seconds when refresh_token expires
  scope                TEXT,
  metadata             TEXT,                    -- JSON: { selected_board_id, selected_board_name, ... }
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);
