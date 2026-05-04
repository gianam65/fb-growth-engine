// Run from GitHub Actions on cron. Pulls PENDING reels with scheduled_at <= now,
// downloads from R2 (or expects a public URL), and publishes via Reels API.
//
// Reels upload flow (resumable upload):
//   1. POST /{page_id}/video_reels?upload_phase=start  → { video_id, upload_url }
//   2. POST upload_url with file bytes (Authorization: OAuth <token>, file_url=... or raw bytes)
//   3. POST /{page_id}/video_reels?upload_phase=finish&video_id=...&video_state=PUBLISHED&description=...
//
// This script uses the file_url variant (FB pulls the video from a public URL).
// We expose R2 objects via a Worker route or use signed URLs. Simplest free path:
// store videos in the GitHub repo under /reels-source/, get raw.githubusercontent.com URL.

import { d1Query, loadEnv, tgSend, type ScriptEnv } from './lib';

interface ReelRow {
  id: number;
  r2_key: string;
  caption: string | null;
  hashtags: string | null;
  scheduled_at: number;
  attempts: number;
}

async function publishReel(env: ScriptEnv, fileUrl: string, description: string): Promise<string> {
  const base = `https://graph.facebook.com/${env.FB_GRAPH_VERSION}`;

  // Phase 1: start
  const startRes = await fetch(`${base}/${env.FB_PAGE_ID}/video_reels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.FB_PAGE_ACCESS_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ upload_phase: 'start' }),
  });
  const startText = await startRes.text();
  if (!startRes.ok) throw new Error(`Reels start ${startRes.status}: ${startText}`);
  const start = JSON.parse(startText) as { video_id: string; upload_url: string };

  // Phase 2: upload via file_url
  const upRes = await fetch(start.upload_url, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${env.FB_PAGE_ACCESS_TOKEN}`,
      file_url: fileUrl,
    },
  });
  const upText = await upRes.text();
  if (!upRes.ok) throw new Error(`Reels upload ${upRes.status}: ${upText}`);

  // Phase 3: finish + publish
  const finRes = await fetch(`${base}/${env.FB_PAGE_ID}/video_reels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.FB_PAGE_ACCESS_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      video_id: start.video_id,
      upload_phase: 'finish',
      video_state: 'PUBLISHED',
      description,
    }),
  });
  const finText = await finRes.text();
  if (!finRes.ok) throw new Error(`Reels finish ${finRes.status}: ${finText}`);

  return start.video_id;
}

async function main() {
  const env = loadEnv();
  const now = Math.floor(Date.now() / 1000);

  const pending = await d1Query<ReelRow>(
    env,
    `SELECT id, r2_key, caption, hashtags, scheduled_at, attempts
     FROM reels_queue
     WHERE status = 'PENDING' AND scheduled_at <= ? AND attempts < 3
     ORDER BY scheduled_at ASC
     LIMIT 5`,
    [now],
  );

  if (pending.length === 0) {
    console.log('no reels due');
    return;
  }

  for (const r of pending) {
    const description = [r.caption ?? '', r.hashtags ?? ''].filter(Boolean).join('\n\n');

    // Mark UPLOADING
    await d1Query(env, `UPDATE reels_queue SET status='UPLOADING', attempts = attempts + 1, updated_at = unixepoch() WHERE id = ?`, [r.id]);

    try {
      // r2_key is expected to be a publicly accessible URL for now.
      // (If using R2 with public bucket: https://pub-<id>.r2.dev/<key>)
      const fileUrl = r.r2_key.startsWith('http') ? r.r2_key : `https://pub-${env.R2_ACCOUNT_ID}.r2.dev/${r.r2_key}`;
      const videoId = await publishReel(env, fileUrl, description);
      await d1Query(env, `UPDATE reels_queue SET status='PUBLISHED', fb_video_id=?, updated_at = unixepoch() WHERE id = ?`, [videoId, r.id]);
      await tgSend(env, `✅ Reel published: \`${videoId}\``);
      console.log('published', r.id, videoId);
    } catch (err) {
      const msg = String(err);
      await d1Query(env, `UPDATE reels_queue SET status='FAILED', error_message=?, updated_at = unixepoch() WHERE id = ?`, [msg, r.id]);
      await tgSend(env, `❌ Reel ${r.id} failed:\n\`${msg.slice(0, 300)}\``);
      console.error('failed', r.id, msg);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
