// Run from GitHub Actions on cron. Pulls PENDING reels with scheduled_at <= now,
// reads video file from the repo (or from a public URL), and publishes via Reels API.
//
// Reels upload flow (resumable upload):
//   1. POST /{page_id}/video_reels?upload_phase=start  → { video_id, upload_url }
//   2. Upload bytes to upload_url (two modes):
//        a) file_url header: FB pulls from a public URL
//        b) raw bytes body: we POST the file content directly
//   3. POST /{page_id}/video_reels?upload_phase=finish&video_id=...&video_state=PUBLISHED&description=...

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { d1Query, loadEnv, tgSend, type ScriptEnv } from './lib';

interface ReelRow {
  id: number;
  video_path: string;
  caption: string | null;
  hashtags: string | null;
  scheduled_at: number;
  attempts: number;
}

async function startSession(env: ScriptEnv): Promise<{ video_id: string; upload_url: string }> {
  const base = `https://graph.facebook.com/${env.FB_GRAPH_VERSION}`;
  const res = await fetch(`${base}/${env.FB_PAGE_ID}/video_reels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.FB_PAGE_ACCESS_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ upload_phase: 'start' }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Reels start ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function uploadByUrl(env: ScriptEnv, uploadUrl: string, fileUrl: string): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${env.FB_PAGE_ACCESS_TOKEN}`,
      file_url: fileUrl,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Reels upload (url) ${res.status}: ${text}`);
}

async function uploadByBytes(env: ScriptEnv, uploadUrl: string, localPath: string): Promise<void> {
  const fullPath = resolve(process.cwd(), localPath);
  const info = await stat(fullPath);
  const fileBuf = await readFile(fullPath);
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${env.FB_PAGE_ACCESS_TOKEN}`,
      offset: '0',
      file_size: String(info.size),
    },
    body: fileBuf,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Reels upload (bytes) ${res.status}: ${text}`);
}

async function finishPublish(env: ScriptEnv, videoId: string, description: string): Promise<void> {
  const base = `https://graph.facebook.com/${env.FB_GRAPH_VERSION}`;
  const res = await fetch(`${base}/${env.FB_PAGE_ID}/video_reels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.FB_PAGE_ACCESS_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      video_id: videoId,
      upload_phase: 'finish',
      video_state: 'PUBLISHED',
      description,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Reels finish ${res.status}: ${text}`);
}

async function publishReel(env: ScriptEnv, source: string, description: string): Promise<string> {
  const session = await startSession(env);
  if (source.startsWith('http://') || source.startsWith('https://')) {
    await uploadByUrl(env, session.upload_url, source);
  } else {
    await uploadByBytes(env, session.upload_url, source);
  }
  await finishPublish(env, session.video_id, description);
  return session.video_id;
}

async function main() {
  const env = loadEnv();
  const now = Math.floor(Date.now() / 1000);

  const pending = await d1Query<ReelRow>(
    env,
    `SELECT id, video_path, caption, hashtags, scheduled_at, attempts
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

    await d1Query(
      env,
      `UPDATE reels_queue SET status='UPLOADING', attempts = attempts + 1, updated_at = unixepoch() WHERE id = ?`,
      [r.id],
    );

    try {
      const videoId = await publishReel(env, r.video_path, description);
      await d1Query(
        env,
        `UPDATE reels_queue SET status='PUBLISHED', fb_video_id=?, updated_at = unixepoch() WHERE id = ?`,
        [videoId, r.id],
      );
      await tgSend(env, `✅ Reel published: \`${videoId}\``);
      console.log('published', r.id, videoId);
    } catch (err) {
      const msg = String(err);
      await d1Query(
        env,
        `UPDATE reels_queue SET status='FAILED', error_message=?, updated_at = unixepoch() WHERE id = ?`,
        [msg, r.id],
      );
      await tgSend(env, `❌ Reel ${r.id} failed:\n\`${msg.slice(0, 300)}\``);
      console.error('failed', r.id, msg);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
