# fb-growth-engine

Free-tier organic growth automation for a Facebook Page. TypeScript, runs on
Cloudflare Workers + D1 + R2 + Queues + GitHub Actions. No paid services.

## Modules

- **A. Velocity engine** — auto-replies comments fast (boosts early-window engagement → reach lift)
- **B. Comment-to-DM funnel** — keyword in comment → public reply + private DM with catalog → lead capture
- **C. Reels publisher** — schedule + auto-publish FB Reels via cron, AI-generated captions

Cross-cutting: daily insights pull → Telegram report; intent classification via Gemini Flash.

## Architecture

```
[Facebook]
   ↓ webhook
[CF Worker: webhook handler] ── verify HMAC ──> [CF Queue]
                                                   ↓
                                       [CF Worker: consumer]
                                          ├─ Gemini (intent)
                                          ├─ FB Graph API
                                          └─ D1 (logs/state)

[GH Actions cron]
   ├─ */5min  → upload-reel (drains reels_queue)
   └─ daily   → pull-insights → daily-report (Telegram)
```

## Prerequisites (do these in order — none cost money)

### 1. Cloudflare account
- Sign up at https://dash.cloudflare.com (no card required)
- Workers, D1, R2, Queues are all free tier

### 2. Facebook App + Page Access Token
- https://developers.facebook.com → My Apps → Create App → **Business** type
- Add products: **Webhooks**, **Messenger**, **Pages API**
- Note `App ID` and `App Secret`
- Get a **long-lived Page Access Token**:
  1. Graph API Explorer → select your app → request token with scopes:
     `pages_show_list, pages_read_engagement, pages_manage_engagement,
      pages_manage_posts, pages_messaging, pages_read_user_content`
  2. Use Access Token Debugger to convert short-lived → long-lived (60 days)
  3. Then GET `/me/accounts` with that token → returns a never-expiring page token
- Apply for App Review for `pages_messaging` and `pages_manage_engagement`
  (~3-7 days). In Dev Mode you can test as page admin only.

### 3. Subscribe page to webhook
After deploy, configure in Facebook App dashboard:
- Webhook URL: `https://<your-worker>.workers.dev/webhook`
- Verify Token: same string you set as `FB_VERIFY_TOKEN`
- Subscribe fields: `feed`, `messages`, `messaging_postbacks`
- Then in Messenger settings → Add subscribed page → select your page

### 4. Google Gemini API key
- https://aistudio.google.com → Get API Key (free, no card)
- Free tier: 1M tokens/day, 15 RPM. Plenty for our volume.

### 5. Telegram bot (for daily reports)
- Chat with `@BotFather` → `/newbot` → save token
- Send any message to your bot, then visit
  `https://api.telegram.org/bot<TOKEN>/getUpdates` → copy your chat id

### 6. Tools
```bash
npm install
npx wrangler login
```

## First-time setup

```bash
# 1. Create D1 database, copy the database_id printed
npx wrangler d1 create fb-growth
# → paste the id into wrangler.toml under [[d1_databases]] database_id

# 2. Create R2 bucket
npx wrangler r2 bucket create fb-growth-media
# Optional: enable public access for the bucket so FB can fetch reel videos
# (Cloudflare dashboard → R2 → bucket → Settings → Public access → Allow)

# 3. Create the queue + DLQ
npx wrangler queues create fb-growth-events
npx wrangler queues create fb-growth-events-dlq

# 4. Apply migrations to remote D1
npm run db:migrate:remote

# 5. Set Worker secrets
npx wrangler secret put FB_APP_SECRET
npx wrangler secret put FB_VERIFY_TOKEN          # any random string, save it
npx wrangler secret put FB_PAGE_ACCESS_TOKEN
npx wrangler secret put FB_PAGE_ID
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID

# 6. Deploy
npm run deploy
# → outputs your https://<name>.<sub>.workers.dev URL

# 7. Health check
curl https://<your-url>/health
# → "ok"
```

## GitHub Actions setup

Push the repo to GitHub (public — for unlimited Actions minutes), then add
**Repository Secrets** (Settings → Secrets and variables → Actions):

| Secret | Where to get |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare dashboard → right sidebar |
| `CF_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create with `Edit Workers` + `D1: Edit` perms |
| `D1_DATABASE_ID` | Same id as in `wrangler.toml` |
| `FB_PAGE_ACCESS_TOKEN` | (same as Worker secret) |
| `FB_PAGE_ID` | (same) |
| `GEMINI_API_KEY` | (same) |
| `R2_ACCOUNT_ID` | Cloudflare → R2 → public bucket id (the part before `.r2.dev`) |
| `TELEGRAM_BOT_TOKEN` | (same) |
| `TELEGRAM_CHAT_ID` | (same) |

The `Deploy Worker` workflow will run on push to `main`. The cron workflows
trigger on schedule.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in values
npm run db:migrate:local
npm run dev
# Worker runs at http://localhost:8787
```

To test the webhook locally without exposing it, you can use Cloudflare's
`wrangler dev --remote` (runs on Cloudflare edge with your live config), then
point the FB webhook to a temporary URL via `cloudflared tunnel` (free).

## Operating it

### Add Reels to the publish queue
Insert manually for now — automate later:
```bash
npx wrangler d1 execute fb-growth --remote --command "
  INSERT INTO reels_queue (r2_key, caption, hashtags, scheduled_at)
  VALUES ('https://your-public-url/video.mp4',
          'caption text here',
          '#decor #nhaxinh',
          unixepoch() + 3600);
"
```

### Tune funnel keywords
```bash
npx wrangler d1 execute fb-growth --remote --command "
  INSERT INTO funnel_triggers (keyword, reply_public, dm_template)
  VALUES ('order', 'Inbox bạn rồi nha 💌', 'Chào {name}!...');
"
```

### Tune reply templates
```bash
npx wrangler d1 execute fb-growth --remote --command "
  SELECT * FROM reply_templates;
"
```

## What's missing intentionally

- **TikTok cross-post**: TikTok Content Posting API requires partner approval,
  not feasible for solo dev free tier. Upload manually.
- **Instagram Reels cross-post**: doable (IG Business Graph API) but adds setup
  complexity; deferred to phase 2.
- **Reels generation from raw video**: caption AI is wired up; trimming/captions
  burned-in still manual.

## Limits to know

- Cloudflare Workers free: **100K req/day**, 10ms CPU/request (50ms paid).
  Heavy work (Gemini call, FB API call) goes through Queues, where each
  invocation gets fresh 30s wall-clock budget.
- Cloudflare D1 free: **5GB storage, 5M reads/day, 100K writes/day**.
- GitHub Actions free for **public** repos: unlimited minutes. Private repos
  get 2000 min/month — enough for `*/5 *` cron = ~8.6K runs/month at <1min each.
- Gemini 1.5 Flash free: **1M tokens/day, 15 RPM**.
- Facebook Graph API: standard rate limits per page (~200 calls/hour/user).
