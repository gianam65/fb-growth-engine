-- Track product URL + media fetched from Shopee item API.
-- Each affiliate product can have multiple images and optionally a video.
-- Worker fetches these async after the extension saves the product.
ALTER TABLE affiliate_products ADD COLUMN product_url TEXT;
ALTER TABLE affiliate_products ADD COLUMN shopee_shopid TEXT;
ALTER TABLE affiliate_products ADD COLUMN shopee_itemid TEXT;
ALTER TABLE affiliate_products ADD COLUMN media_urls TEXT;          -- JSON array of image URLs
ALTER TABLE affiliate_products ADD COLUMN video_url TEXT;           -- direct mp4 URL if available
ALTER TABLE affiliate_products ADD COLUMN media_fetched_at INTEGER;
ALTER TABLE affiliate_products ADD COLUMN media_fetch_error TEXT;
ALTER TABLE affiliate_products ADD COLUMN posted_kind TEXT;          -- 'reels' | 'photo' | NULL
ALTER TABLE affiliate_products ADD COLUMN fb_post_id TEXT;
