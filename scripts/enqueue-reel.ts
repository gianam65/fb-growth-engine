// Enqueue a reel into reels_queue via D1 HTTP API.
//
// Usage (run locally):
//   FB_GRAPH_VERSION=v21.0 \
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... D1_DATABASE_ID=... \
//   FB_PAGE_ID=... FB_PAGE_ACCESS_TOKEN=... GEMINI_API_KEY=... \
//   npx tsx scripts/enqueue-reel.ts \
//     --video=reels-source/2026-05-set01.mp4 \
//     --caption="Set decor mới về 🌿" \
//     --hashtags="#decor #nhaxinh #cozyvibe" \
//     --in=60
//
// --video accepts a repo-relative path OR a public https URL.
// --in is seconds from now; default 60.

import { d1Query, loadEnv } from './lib';

interface Args {
  video: string;
  caption?: string;
  hashtags?: string;
  inSeconds: number;
}

function parseArgs(): Args {
  const out: Partial<Args> & { inSeconds?: number } = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'video') out.video = v;
    else if (k === 'caption') out.caption = v;
    else if (k === 'hashtags') out.hashtags = v;
    else if (k === 'in') out.inSeconds = Number(v);
  }
  if (!out.video) {
    console.error('Missing --video=<path|url>');
    process.exit(1);
  }
  return {
    video: out.video,
    caption: out.caption,
    hashtags: out.hashtags,
    inSeconds: Number.isFinite(out.inSeconds) ? out.inSeconds! : 60,
  };
}

async function main() {
  const env = loadEnv();
  const args = parseArgs();
  const scheduledAt = Math.floor(Date.now() / 1000) + args.inSeconds;

  await d1Query(
    env,
    `INSERT INTO reels_queue (video_path, caption, hashtags, scheduled_at)
     VALUES (?, ?, ?, ?)`,
    [args.video, args.caption ?? null, args.hashtags ?? null, scheduledAt],
  );

  const rows = await d1Query<{ id: number; scheduled_at: number; status: string }>(
    env,
    `SELECT id, scheduled_at, status FROM reels_queue ORDER BY id DESC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) throw new Error('insert succeeded but row not found');
  const when = new Date(r.scheduled_at * 1000).toISOString();
  console.log(`enqueued #${r.id} status=${r.status} scheduled_at=${when}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
