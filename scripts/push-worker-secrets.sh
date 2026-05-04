#!/usr/bin/env bash
# Bulk-push secrets from .env.vault to Cloudflare Worker.
# Usage: bash scripts/push-worker-secrets.sh
set -euo pipefail

if [ ! -f .env.vault ]; then
  echo "❌ .env.vault not found. Copy from .env.vault.example and fill in values."
  exit 1
fi

# Only these names are pushed to Worker (others are GitHub-only)
WORKER_SECRETS=(
  FB_APP_SECRET
  FB_VERIFY_TOKEN
  FB_PAGE_ACCESS_TOKEN
  FB_PAGE_ID
  GEMINI_API_KEY
  TELEGRAM_BOT_TOKEN
  TELEGRAM_CHAT_ID
)

for name in "${WORKER_SECRETS[@]}"; do
  value=$(grep -E "^${name}=" .env.vault | cut -d= -f2- | sed 's/^ *//;s/ *$//')
  if [ -z "$value" ]; then
    echo "⚠️  $name is empty in .env.vault, skipping"
    continue
  fi
  echo "⬆️  $name"
  echo -n "$value" | npx wrangler secret put "$name"
done

echo ""
echo "✅ Done. Verify with: npx wrangler secret list"
