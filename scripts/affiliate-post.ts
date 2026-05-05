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
  media_urls: string | null;   // JSON array
  video_url: string | null;
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
  return `Write a SHORT English caption for a Vietnamese cozy decor Facebook page "Cozy Vibe" promoting this product:
${title ? `"${title}"` : '(no title — guess from context: cozy home decor)'}

Output kind: ${kind === 'reels' ? 'short video Reels' : 'photo post'}.

Output JSON:
- caption: 1 short line in English (max 12 words). Aesthetic, soft sell, NOT pushy. NO clichés like "shop the vibe" / "tag a friend". Mention the product gently. Example tones:
    "warm corners deserve good lighting."
    "every studio needs a quiet bookshelf."
    "found this — couldn't scroll past."
    "small upgrades. big mood shift."
    "the kind of detail that makes a room."
- hashtags: 8-10 English hashtags single line, including #cozyvibe #cozyhome.

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
  return json.post_id ?? json.id ?? 'unknown';
}

// ----------- main -----------

async function main() {
  const env = loadEnv();

  console.log('[1/4] Picking oldest-unused affiliate product with media…');
  const rows = await d1Query<AffRow>(
    env,
    `SELECT id, title, affiliate_url, product_url, media_urls, video_url, used_count, last_used_at
       FROM affiliate_products
      WHERE status = 'APPROVED'
        AND (media_urls IS NOT NULL OR video_url IS NOT NULL)
      ORDER BY COALESCE(last_used_at, 0) ASC, id ASC
      LIMIT 1`,
  );
  const row = rows[0];
  if (!row) {
    console.log('No affiliate products with media available — exiting gracefully.');
    return;
  }
  console.log(`  picked id=${row.id}: ${row.title?.slice(0, 80) || '(no title)'}`);

  const images: string[] = (() => {
    try { return JSON.parse(row.media_urls ?? '[]'); } catch { return []; }
  })();
  const hasVideo = !!row.video_url;
  const hasImages = images.length > 0;
  console.log(`  has_video=${hasVideo}, images=${images.length}`);

  if (!hasVideo && !hasImages) {
    throw new Error(`Product id=${row.id} has neither images nor video`);
  }

  const kind: 'reels' | 'photo' = hasVideo ? 'reels' : 'photo';
  console.log(`  kind: ${kind}`);

  console.log('[2/4] Gemini caption…');
  const captionRaw = await geminiText(env, captionPrompt(row.title, kind), CAPTION_SCHEMA);
  const captionSpec = JSON.parse(captionRaw) as CaptionSpec;
  console.log(`  caption: ${captionSpec.caption}`);
  console.log(`  hashtags: ${captionSpec.hashtags}`);

  // Caption layout:
  //   <caption>
  //
  //   🛍️ <affiliate_url>
  //
  //   <hashtags>
  const message = `${captionSpec.caption}\n\n🛍️ ${row.affiliate_url}\n\n${captionSpec.hashtags}`;

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
      fbPostId = await publishSinglePhotoPost(env, images[0]!, message);
      postedKind = 'photo';
    } else {
      throw err;
    }
  }
  console.log(`  fb_post_id: ${fbPostId} (${postedKind})`);

  console.log('[4/4] Marking used + logging…');
  const now = Math.floor(Date.now() / 1000);
  await d1Query(
    env,
    `UPDATE affiliate_products
        SET used_count = used_count + 1,
            last_used_at = ?,
            posted_kind = ?,
            fb_post_id = ?
      WHERE id = ?`,
    [now, postedKind, fbPostId, row.id],
  );

  await tgSend(
    env,
    `✅ Affiliate ${postedKind} published\n${row.title?.slice(0, 80) ?? row.affiliate_url}\n${captionSpec.caption}\nhttps://www.facebook.com/${fbPostId}`,
  );
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
