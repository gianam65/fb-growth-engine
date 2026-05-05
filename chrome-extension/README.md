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

## Daily workflow (recommended — per-card button)

1. Browse `https://affiliate.shopee.vn/offer/product_offer` (or `/brand_offer`)
2. On each product card you'll see a small green **💾 CV** button (top-right).
3. Click "Get Link" / "Tạo link" on Shopee → copy the short URL
4. Click the **💾 CV** button on that card → reads clipboard for affiliate URL
   automatically, saves with the card's title + image
5. Toast confirms ✓ saved (id=N)

If `💾 CV` doesn't appear on a card (Shopee changed DOM), use the floating
**💾 CV (page)** button bottom-right or open the popup for manual entry.

## Fallback: popup (no per-card button)

1. Click extension icon
2. Popup auto-fills title / image from active tab
3. Paste affiliate link (or it auto-pastes from clipboard)
4. Click **💾 Save to Cozy Vibe pool**

## Verify

- View pool: `<WORKER_URL>/admin/affiliate?key=<ADMIN_TOKEN>`
- Each saved product is APPROVED by default and will be picked by the daily
  `curate-post.yml` cron, posted as a comment on the published FB post.

## When Shopee changes their DOM

If auto-fill stops working (title/image blank), it's not a blocker — just type
them manually. To fix auto-fill, update the selectors in `popup.js`'s
`fetchTabContext()`.
