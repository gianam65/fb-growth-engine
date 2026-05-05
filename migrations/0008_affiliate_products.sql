-- Affiliate products pool. Populated via Chrome extension that scrapes
-- affiliate.shopee.vn product/brand offer pages while user is logged in.
-- Each FB post auto-comments one unused product link.
CREATE TABLE IF NOT EXISTS affiliate_products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL DEFAULT 'shopee',
  source_id       TEXT,                              -- Shopee item id (if known)
  title           TEXT,
  price           TEXT,
  image_url       TEXT,
  affiliate_url   TEXT NOT NULL UNIQUE,              -- Shopee short link, e.g. https://s.shopee.vn/XYZ
  source_url      TEXT,                              -- Page on Shopee where it was saved
  category        TEXT,
  status          TEXT NOT NULL DEFAULT 'APPROVED',  -- APPROVED | REJECTED | EXPIRED
  used_count      INTEGER NOT NULL DEFAULT 0,
  last_used_at    INTEGER,
  inserted_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_affiliate_pick ON affiliate_products(status, last_used_at);
