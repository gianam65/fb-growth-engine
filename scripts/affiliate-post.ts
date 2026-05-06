// Daily affiliate post — picks oldest-unused APPROVED affiliate product with
// fetched media, publishes it as either a Reels (if has video) or a single
// photo post (if only images). Caption via Gemini, affiliate link inline.
//
// Run via .github/workflows/affiliate-post.yml (cron 2x/day).

import { d1Query, loadEnv, tgSend, type ScriptEnv } from './lib';

const TEXT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

interface AffRow {
  id: number;
  title: string | null;
  affiliate_url: string;
  product_url: string | null;
  media_urls: string | null;   // JSON array of image URLs (best case)
  video_url: string | null;
  image_url: string | null;    // single thumbnail from listing card (fallback)
  used_count: number;
  last_used_at: number | null;
}

interface CaptionSpec {
  caption: string;
  hashtags: string;
}

const CAPTION_SCHEMA = {
  type: 'object',
  properties: {
    caption: { type: 'string' },
    hashtags: { type: 'string' },
  },
  required: ['caption', 'hashtags'],
};

function captionPrompt(title: string | null, kind: 'reels' | 'photo'): string {
  return `You write a SHORT Vietnamese caption for a Shopee product post on the "Cozy Vibe" page.

Original product title (long, messy):
"${title ?? '(no title — describe as: cozy home decor)'}"

Output kind: ${kind === 'reels' ? 'Reels' : 'photo post'}.

Output JSON:
- caption: extract the actual product NAME from the title (the main noun, e.g. "Giá để tài liệu 4 ngăn", "Bàn làm việc gaming", "Đèn LED cắm hoa", "Pegboard kẹp bàn"), then add a SHORT Vietnamese tail (2-4 words) that's casual + cozy.
  Format: "<product name> <short cozy tail>"
  Examples:
    title "Giá Để Tài Liệu 4 Ngăn M.Y – Kệ Nhựa Đựng Sách Decor"
      → "Giá để tài liệu 4 ngăn xinh quá ạ"
    title "Bàn làm việc bàn gaming thiết kế hiện đại"
      → "Bàn làm việc gaming chill phết"
    title "Tranh Đèn Led Cắm Hoa Theo Ý Treo Phòng Khách"
      → "Tranh đèn LED cắm hoa siêu cute"
    title "Pegboard Kẹp Bàn Decor Để Đồ Bàn Học"
      → "Pegboard kẹp bàn decor mê liền"
  Keep it natural — don't be salesy. Lowercase product description part is fine.
  Total length: 6-10 words.
- hashtags: 5-8 short Vietnamese hashtags single line, including #cozyvibe #nhaxinh.

Return JSON only.`;
}

async function geminiText(env: ScriptEnv, prompt: string, schema: object): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 600,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text}`);
  const json = JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const out = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!out) throw new Error(`Gemini empty: ${text}`);
  return out;
}

// ----------- FB Reels (file_url upload) -----------

async function publishReel(env: ScriptEnv, videoUrl: string, description: string): Promise<string> {
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
  const { video_id, upload_url } = JSON.parse(startText) as { video_id: string; upload_url: string };

  // Phase 2: transfer via file_url (FB pulls from public URL)
  const upRes = await fetch(upload_url, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${env.FB_PAGE_ACCESS_TOKEN}`,
      file_url: videoUrl,
    },
  });
  const upText = await upRes.text();
  if (!upRes.ok) throw new Error(`Reels transfer ${upRes.status}: ${upText.slice(0, 400)}`);

  // Phase 3: finish
  const finRes = await fetch(`${base}/${env.FB_PAGE_ID}/video_reels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.FB_PAGE_ACCESS_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      video_id,
      upload_phase: 'finish',
      video_state: 'PUBLISHED',
      description,
    }),
  });
  const finText = await finRes.text();
  if (!finRes.ok) throw new Error(`Reels finish ${finRes.status}: ${finText.slice(0, 400)}`);
  return video_id;
}

// ----------- FB single-photo post (url-based) -----------

async function publishSinglePhotoPost(env: ScriptEnv, imageUrl: string, caption: string): Promise<string> {
  const base = `https://graph.facebook.com/${env.FB_GRAPH_VERSION}`;
  const params = new URLSearchParams();
  params.set('url', imageUrl);
  params.set('caption', caption);
  params.set('access_token', env.FB_PAGE_ACCESS_TOKEN);
  const res = await fetch(`${base}/${env.FB_PAGE_ID}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Photo post ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text) as { post_id?: string; id?: string };
  // Prefer photo `id` (always supports /comments). The page_post_id
  // (json.post_id) sometimes returns 400 "does not support" when used
  // directly as comments target.
  return json.id ?? json.post_id ?? 'unknown';
}

// ----------- FB comment on own post -----------

async function postFbComment(env: ScriptEnv, postId: string, message: string): Promise<string> {
  const url = `https://graph.facebook.com/${env.FB_GRAPH_VERSION}/${postId}/comments`;
  const params = new URLSearchParams();
  params.set('message', message);
  params.set('access_token', env.FB_PAGE_ACCESS_TOKEN);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FB comment ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text) as { id?: string };
  if (!json.id) throw new Error(`FB comment no id: ${text}`);
  return json.id;
}

// ----------- main -----------

async function main() {
  const env = loadEnv();

  console.log('[1/4] Atomically claiming oldest-unused product (race-safe)…');
  // ATOMIC CLAIM: increment used_count = 1 BEFORE publishing. If two crons
  // (e.g., GH cron + Worker watchdog) fire concurrently, only one gets the
  // RETURNING row; the other's UPDATE matches 0 rows. Trades retry-on-fail
  // for zero-duplicate guarantee — if FB publish fails, product is "used"
  // and won't be picked again. User can manually reset used_count=0 to retry.
  const claimed = await d1Query<AffRow>(
    env,
    `UPDATE affiliate_products
        SET used_count = used_count + 1, last_used_at = unixepoch()
      WHERE id = (
        SELECT id FROM affiliate_products
         WHERE status = 'APPROVED'
           AND used_count = 0
           AND (media_urls IS NOT NULL OR video_url IS NOT NULL OR image_url IS NOT NULL)
         ORDER BY COALESCE(last_used_at, 0) ASC, id ASC
         LIMIT 1
      )
   RETURNING id, title, affiliate_url, product_url, media_urls, video_url, image_url, used_count, last_used_at`,
  );
  const row = claimed[0];
  if (!row) {
    console.log('No affiliate products available (or all just claimed by another run) — exiting gracefully.');
    return;
  }
  console.log(`  claimed id=${row.id}: ${row.title?.slice(0, 80) || '(no title)'}`);

  // Image sources in priority order: media_urls > image_url thumbnail
  const images: string[] = (() => {
    try {
      const fromMedia = JSON.parse(row.media_urls ?? '[]');
      if (Array.isArray(fromMedia) && fromMedia.length > 0) return fromMedia;
    } catch {}
    if (row.image_url) return [row.image_url];
    return [];
  })();
  const hasVideo = !!row.video_url;
  const hasImages = images.length > 0;
  console.log(`  has_video=${hasVideo}, images=${images.length}`);

  if (!hasVideo && !hasImages) {
    throw new Error(`Product id=${row.id} has no media`);
  }

  const kind: 'reels' | 'photo' = hasVideo ? 'reels' : 'photo';
  console.log(`  kind: ${kind}`);

  console.log('[2/4] Gemini caption…');
  const captionRaw = await geminiText(env, captionPrompt(row.title, kind), CAPTION_SCHEMA);
  const captionSpec = JSON.parse(captionRaw) as CaptionSpec;
  console.log(`  caption: ${captionSpec.caption}`);
  console.log(`  hashtags: ${captionSpec.hashtags}`);

  // Caption layout: clean — NO link in caption (FB algorithm downranks
  // posts with external URLs by 30-50%). Affiliate link goes in the
  // first comment ~2.5 min after publish (algorithm has "seen" the post
  // by then and assigned baseline reach).
  const message = `✨ ${captionSpec.caption}\n\n${captionSpec.hashtags}`;

  console.log(`[3/4] Publishing ${kind}…`);
  let fbPostId: string;
  let postedKind: 'reels' | 'photo' = kind;
  try {
    if (kind === 'reels') {
      fbPostId = await publishReel(env, row.video_url!, message);
    } else {
      fbPostId = await publishSinglePhotoPost(env, images[0]!, message);
    }
  } catch (err) {
    // If Reels failed (video format issue, FB limit, etc.) and we have images, fall back.
    if (kind === 'reels' && hasImages) {
      console.warn(`  Reels failed: ${String(err).slice(0, 200)}`);
      console.log('  Falling back to single-photo post…');
      try {
        fbPostId = await publishSinglePhotoPost(env, images[0]!, message);
        postedKind = 'photo';
      } catch (err2) {
        // Both attempts failed. Product already marked used (claim above) so
        // won't retry automatically. Telegram alert + record error.
        await d1Query(env,
          `UPDATE affiliate_products SET media_fetch_error = ? WHERE id = ?`,
          [`publish failed: reels=${String(err).slice(0, 100)} | photo=${String(err2).slice(0, 100)}`, row.id]);
        await tgSend(env, `❌ Affiliate post FAILED (id=${row.id}, won't auto-retry)\n${row.title?.slice(0, 80) ?? row.affiliate_url}\nReels: ${String(err).slice(0, 100)}\nPhoto: ${String(err2).slice(0, 100)}\n\nManual retry: \`UPDATE affiliate_products SET used_count=0 WHERE id=${row.id};\``);
        throw err2;
      }
    } else {
      await d1Query(env,
        `UPDATE affiliate_products SET media_fetch_error = ? WHERE id = ?`,
        [`publish failed: ${String(err).slice(0, 200)}`, row.id]);
      await tgSend(env, `❌ Affiliate post FAILED (id=${row.id}, won't auto-retry)\n${row.title?.slice(0, 80) ?? row.affiliate_url}\nError: ${String(err).slice(0, 200)}\n\nManual retry: \`UPDATE affiliate_products SET used_count=0 WHERE id=${row.id};\``);
      throw err;
    }
  }
  console.log(`  fb_post_id: ${fbPostId} (${postedKind})`);

  console.log('[4/5] Recording fb_post_id + posted_kind (used_count already claimed)…');
  await d1Query(
    env,
    `UPDATE affiliate_products
        SET posted_kind = ?,
            fb_post_id = ?
      WHERE id = ?`,
    [postedKind, fbPostId, row.id],
  );

  await tgSend(
    env,
    `✅ Affiliate ${postedKind} published\n${row.title?.slice(0, 80) ?? row.affiliate_url}\n${captionSpec.caption}\nhttps://www.facebook.com/${fbPostId}`,
  );

  console.log('[5/5] Waiting 2.5 min, then posting affiliate link as first comment…');
  // Give FB algorithm time to "see" the link-free post and assign baseline
  // reach. Then add the link in a comment — FB doesn't penalize comments
  // with external URLs the way it does captions.
  await new Promise((r) => setTimeout(r, 150_000));

  const commentMsg = `🛍 Mua tại đây nha: ${row.affiliate_url}`;
  try {
    const commentId = await postFbComment(env, fbPostId, commentMsg);
    console.log(`  comment_id: ${commentId}`);
  } catch (err) {
    // Comment is optional — post itself already succeeded. Just alert.
    console.warn('  link comment failed:', String(err).slice(0, 200));
    await tgSend(
      env,
      `⚠ Affiliate post ${fbPostId} published OK but link-comment failed:\n${String(err).slice(0, 200)}\n\nManual: comment "${commentMsg}" on the post.`,
    );
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
