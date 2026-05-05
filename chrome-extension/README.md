# Cozy Vibe Affiliate Extension

Saves Shopee affiliate products to the Cozy Vibe pool with one click while
you browse `affiliate.shopee.vn`.

## Install (unpacked)

1. Open Chrome → `chrome://extensions/`
2. Top-right toggle: **Developer mode** ON
3. Click **Load unpacked**
4. Pick this folder: `chrome-extension/`
5. Pin the extension (puzzle icon → pin "Cozy Vibe")

## First-time setup

1. Click the extension icon → settings form opens
2. Worker URL: `https://fb-growth-engine.namgia-dev.workers.dev`
3. Admin token: paste your `ADMIN_TOKEN`
4. Save

## Daily workflow

1. Browse `https://affiliate.shopee.vn/offer/product_offer` (or `/brand_offer`)
2. Click a product card → Shopee opens detail / "Get Link" modal
3. Copy the affiliate short URL (e.g. `https://s.shopee.vn/XYZ`)
4. Click the extension icon
5. The popup auto-fills:
   - Title (from `<h1>` or `<title>`)
   - Image URL (from `og:image` or biggest visible image)
   - Affiliate link (from clipboard if it looks like a Shopee link)
6. Click **💾 Save to Cozy Vibe pool**

## Verify

- View pool: `<WORKER_URL>/admin/affiliate?key=<ADMIN_TOKEN>`
- Each saved product is APPROVED by default and will be picked by the daily
  `curate-post.yml` cron, posted as a comment on the published FB post.

## When Shopee changes their DOM

If auto-fill stops working (title/image blank), it's not a blocker — just type
them manually. To fix auto-fill, update the selectors in `popup.js`'s
`fetchTabContext()`.
