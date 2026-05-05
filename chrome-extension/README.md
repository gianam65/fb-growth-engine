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

## Daily workflow (one-click on each card)

1. Browse `https://affiliate.shopee.vn/offer/product_offer` (or `/brand_offer`)
2. Each product card has a small green **💾 CV** button (top-right)
3. **Click 💾 CV → done.** The extension:
   - Auto-clicks Shopee's "Get Link" / "Tạo link" button on the card
   - Watches the DOM for the `s.shopee.vn` URL to appear
   - Reads it + scrapes title/image from the card
   - Sends to Worker → toast "✓ Saved"
4. No manual copy/paste needed.

## Batch save

Bottom-right floating button **💾 Save all on page** processes every card on
the current page. Confirms first; takes ~1.5s per card.

## View pool

In the extension popup → **📋 Affiliate pool** or **🖼 Photo pool** opens the
admin status page in a new tab.

## Persistence

Settings (Worker URL + admin token) are stored in `chrome.storage.sync` (synced
to your Chrome account if signed in) **and** `chrome.storage.local` as fallback.
They survive 🔄 reloads. They're lost only if you fully **Remove + Load
unpacked** the extension (which assigns a new extension ID = fresh storage).

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
