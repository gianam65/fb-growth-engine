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

  // Gemini returns transient 503 (UNAVAILABLE) / 429 (rate limit) under load.
  // Retry these with exponential backoff so one blip doesn't fail the job.
  const MAX_ATTEMPTS = 5;
  let lastErr = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();

    if (res.ok) {
      const json = JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const out = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!out) throw new Error(`Gemini empty: ${text}`);
      return out;
    }

    lastErr = `Gemini ${res.status}: ${text}`;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) throw new Error(lastErr);

    const delayMs = 2000 * 2 ** (attempt - 1); // 2s, 4s, 8s, 16s
    console.log(`  Gemini ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delayMs}ms`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(lastErr);
}

// Last-resort caption when Gemini is fully unavailable (sustained free-tier
// 503). Builds a short caption from the product title so the post still goes
// out and the claimed product isn't wasted. Lower quality than Gemini, but a
// published post beats a stuck product.
function fallbackCaption(title: string | null): CaptionSpec {
  // Shopee titles are long/messy — cut at the first separator and trim to a
  // reasonable length to approximate the product name.
  const raw = (title ?? 'Đồ decor nhà xinh').split(/[–\-|,]/)[0]!.trim();
  const name = raw.length > 50 ? raw.slice(0, 50).trim() : raw;
  return {
    caption: `${name} xinh quá ạ`,
    hashtags: '#cozyvibe #nhaxinh #decor #shopeefinds #dohomedecor',
  };
}

// We publish to FB and capture TWO ids:
//   mediaId    = photo_id / video_id — used to attach the affiliate URL as
//                the first comment via /{mediaId}/comments (photos return
//                400 if you call /comments on the page_post_id format).
//   wallPostId = pageId_postId — what the comment webhook gives us when a
//                user comments on the feed post. Used to look up which
//                product the comment is on.
interface PublishResult {
  mediaId: string;
  wallPostId: string | null;
}

// Always store wall_post_id in "pageId_postId" form. FB sometimes returns
// the post_id field with the page prefix already, sometimes just the suffix.
// Webhook events always use the full form, so we normalize at write time.
function normalizeWallPostId(raw: string, pageId: string): string {
  if (raw.includes('_')) return raw;
  return `${pageId}_${raw}`;
}

// Resolve the wall post_id for a given media id (photo_id or video_id).
// /{media_id}?fields=post_id returns the wall post id that surfaces the
// media in feed (with format inconsistency — see normalizeWallPostId).
async function lookupWallPostId(env: ScriptEnv, mediaId: string): Promise<string | null> {
  try {
    const url = `https://graph.facebook.com/${env.FB_GRAPH_VERSION}/${mediaId}?fields=post_id&access_token=${env.FB_PAGE_ACCESS_TOKEN}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  lookupWallPostId ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const json = JSON.parse(await res.text()) as { post_id?: string };
    return json.post_id ? normalizeWallPostId(json.post_id, env.FB_PAGE_ID) : null;
  } catch (err) {
    console.warn('  lookupWallPostId failed:', String(err).slice(0, 200));
    return null;
  }
}

// ----------- FB Reels (file_url upload) -----------

async function publishReel(env: ScriptEnv, videoUrl: string, description: string): Promise<PublishResult> {
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

  // FB needs a moment to associate the video with a wall post after finish.
  // Brief poll: try every 2s for up to 12s.
  let wallPostId: string | null = null;
  for (let i = 0; i < 6 && !wallPostId; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    wallPostId = await lookupWallPostId(env, video_id);
  }
  return { mediaId: video_id, wallPostId };
}

// ----------- FB single-photo post (url-based) -----------

async function publishSinglePhotoPost(env: ScriptEnv, imageUrl: string, caption: string): Promise<PublishResult> {
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
  const mediaId = json.id ?? json.post_id ?? 'unknown';
  // /photos returns BOTH ids on the same response — capture wall post id
  // directly, no extra Graph call needed. Normalize to full pageId_postId.
  const wallPostId = json.post_id ? normalizeWallPostId(json.post_id, env.FB_PAGE_ID) : null;
  return { mediaId, wallPostId };
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
  let captionSpec: CaptionSpec;
  try {
    const captionRaw = await geminiText(env, captionPrompt(row.title, kind), CAPTION_SCHEMA);
    captionSpec = JSON.parse(captionRaw) as CaptionSpec;
  } catch (err) {
    // Gemini fully unavailable even after retries (sustained free-tier 503).
    // Don't fail the job — the product is already claimed. Fall back to a
    // template caption so the post still publishes; alert so we can review.
    captionSpec = fallbackCaption(row.title);
    console.warn(`  Gemini failed — using fallback caption: ${String(err).slice(0, 160)}`);
    await tgSend(env, `⚠️ Gemini down — đăng với fallback caption (id=${row.id})\n${row.title?.slice(0, 80) ?? row.affiliate_url}\n${captionSpec.caption}`);
  }
  console.log(`  caption: ${captionSpec.caption}`);
  console.log(`  hashtags: ${captionSpec.hashtags}`);

  // Caption layout: clean — NO link in caption (FB algorithm downranks
  // posts with external URLs by 30-50%). Affiliate link goes in the
  // first comment ~2.5 min after publish (algorithm has "seen" the post
  // by then and assigned baseline reach).
  const message = `✨ ${captionSpec.caption}\n\n${captionSpec.hashtags}`;

  console.log(`[3/4] Publishing ${kind}…`);
  let publishResult: PublishResult;
  let postedKind: 'reels' | 'photo' = kind;
  try {
    if (kind === 'reels') {
      publishResult = await publishReel(env, row.video_url!, message);
    } else {
      publishResult = await publishSinglePhotoPost(env, images[0]!, message);
    }
  } catch (err) {
    // If Reels failed (video format issue, FB limit, etc.) and we have images, fall back.
    if (kind === 'reels' && hasImages) {
      console.warn(`  Reels failed: ${String(err).slice(0, 200)}`);
      console.log('  Falling back to single-photo post…');
      try {
        publishResult = await publishSinglePhotoPost(env, images[0]!, message);
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
  const fbPostId = publishResult.mediaId;
  const wallPostId = publishResult.wallPostId;
  console.log(`  fb_post_id: ${fbPostId} (${postedKind}), wall_post_id: ${wallPostId ?? 'null'}`);

  console.log('[4/5] Recording fb_post_id + fb_wall_post_id + posted_kind…');
  await d1Query(
    env,
    `UPDATE affiliate_products
        SET posted_kind = ?,
            fb_post_id = ?,
            fb_wall_post_id = ?
      WHERE id = ?`,
    [postedKind, fbPostId, wallPostId, row.id],
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
