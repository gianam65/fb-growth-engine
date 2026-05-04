-- Comments seen via webhook (for velocity engine + analytics)
CREATE TABLE IF NOT EXISTS comments (
  id              TEXT PRIMARY KEY,           -- FB comment id
  post_id         TEXT NOT NULL,
  parent_id       TEXT,                       -- if reply to another comment
  from_id         TEXT NOT NULL,              -- commenter user/page id
  from_name       TEXT,
  message         TEXT,
  created_time    INTEGER NOT NULL,           -- epoch seconds
  intent          TEXT,                       -- classified by Gemini: PRICE | PRAISE | QUESTION | SPAM | OTHER
  bot_replied     INTEGER NOT NULL DEFAULT 0,
  bot_reply_id    TEXT,
  bot_reply_text  TEXT,
  bot_reply_time  INTEGER,
  inserted_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_intent ON comments(intent);
CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_time);

-- Messenger DMs (for funnel tracking)
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,           -- FB mid
  thread_id       TEXT NOT NULL,              -- PSID of user
  direction       TEXT NOT NULL,              -- IN | OUT
  source          TEXT,                       -- COMMENT_TO_DM | DIRECT_INBOX | BROADCAST
  comment_id      TEXT,                       -- if triggered by comment
  text            TEXT,
  attachments     TEXT,                       -- JSON
  sent_at         INTEGER NOT NULL,
  inserted_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

-- Leads captured via funnel (user inbox-ed back after bot DM)
CREATE TABLE IF NOT EXISTS leads (
  psid            TEXT PRIMARY KEY,
  name            TEXT,
  source_post_id  TEXT,
  source_comment_id TEXT,
  first_intent    TEXT,
  status          TEXT NOT NULL DEFAULT 'NEW', -- NEW | ENGAGED | QUALIFIED | CLOSED_WON | CLOSED_LOST
  notes           TEXT,
  inserted_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

-- Reels publish queue (filled manually or by upload script, drained by GH Action cron)
CREATE TABLE IF NOT EXISTS reels_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key          TEXT NOT NULL,              -- key in R2 bucket
  caption         TEXT,
  hashtags        TEXT,
  scheduled_at    INTEGER NOT NULL,           -- epoch seconds
  status          TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | UPLOADING | PUBLISHED | FAILED
  fb_video_id     TEXT,
  ig_media_id     TEXT,
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  inserted_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_reels_status_sched ON reels_queue(status, scheduled_at);

-- Daily insights snapshot (for trends + Telegram report)
CREATE TABLE IF NOT EXISTS insights_daily (
  date            TEXT PRIMARY KEY,           -- YYYY-MM-DD
  page_fans       INTEGER,
  page_fan_adds   INTEGER,
  page_fan_removes INTEGER,
  page_impressions INTEGER,
  page_engaged_users INTEGER,
  posts_count     INTEGER,
  raw             TEXT,                       -- JSON dump for debugging
  inserted_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Per-post insights (for finding top performers to recycle)
CREATE TABLE IF NOT EXISTS post_insights (
  post_id         TEXT NOT NULL,
  date            TEXT NOT NULL,
  reach           INTEGER,
  impressions     INTEGER,
  reactions       INTEGER,
  comments_count  INTEGER,
  shares          INTEGER,
  engagement_rate REAL,
  post_type       TEXT,                       -- photo | video | reel | link | status
  created_time    INTEGER,
  PRIMARY KEY (post_id, date)
);

-- Intent classification log (for cost tracking + improving prompts)
CREATE TABLE IF NOT EXISTS intent_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id      TEXT,
  input_text      TEXT NOT NULL,
  intent          TEXT NOT NULL,
  confidence      REAL,
  model           TEXT,
  latency_ms      INTEGER,
  inserted_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Keyword triggers for Comment-to-DM funnel (configurable without redeploy)
CREATE TABLE IF NOT EXISTS funnel_triggers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword         TEXT NOT NULL,              -- case-insensitive contains match
  reply_public    TEXT,                       -- what bot replies under the comment
  dm_template     TEXT NOT NULL,              -- DM body sent to user
  dm_attachment_url TEXT,                     -- optional image/file
  active          INTEGER NOT NULL DEFAULT 1,
  inserted_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_funnel_active ON funnel_triggers(active);

-- Reply templates for velocity engine (auto-reply by intent)
CREATE TABLE IF NOT EXISTS reply_templates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  intent          TEXT NOT NULL,              -- PRAISE | QUESTION | OTHER
  template        TEXT NOT NULL,              -- supports {name} placeholder
  weight          INTEGER NOT NULL DEFAULT 1, -- weighted random pick
  active          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_replies_intent ON reply_templates(intent, active);
