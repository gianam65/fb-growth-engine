// Daily Cozy Vibe FB carousel using REAL stock photos from Pexels (free, no card)
// + AI-generated Vietnamese caption based on photo alt-tags.
//
// Pipeline:
//   1. Gemini text → JSON { theme, search_keywords[2-3] } for the day
//   2. Pexels API search → ~30-45 portrait candidate photos
//   3. Filter (portrait, large enough) + dedupe by photographer + pick 5
//   4. Gemini text (with photo alt-tags as context) → caption + hashtags
//   5. Download photos → upload as unpublished FB photos → /feed carousel
//   6. Log to fb_posts (source='pexels' + credits JSON)

import { d1Query, loadEnv, tgSend, type ScriptEnv } from './lib';

const TEXT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
// NUM_IMAGES is no longer used — set sizes are determined by what user pastes.

const STYLE_PRESET = process.env.STYLE_PRESET || 'asian-cozy';

interface CaptionPhoto {
  alt?: string;
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

function captionPrompt(theme: string, photos: CaptionPhoto[]): string {
  const items = photos
    .map((p, i) => `  ${i + 1}. ${p.alt?.slice(0, 200) || '(no alt text)'}`)
    .join('\n');
  return `You write ULTRA-SHORT English captions for a cozy/aesthetic Facebook page "Cozy Vibe".

Today's theme: ${theme}
Carousel has ${photos.length} photo(s):
${items}

Output JSON with:
- caption: 2-4 words of lowercase English + ONE small emoji at the end.
  Aesthetic, calm. NOT cheesy, NO clichés. Pick a vibe word that fits the photos.
  Examples:
    "quiet room ✨"
    "peace 🌿"
    "warm corners 🍂"
    "slow morning ☕"
    "soft hours 🕯️"
    "home things 🪴"
    "golden hour 🌤️"
    "rainy nights 🌧️"
- hashtags: single line of 8-12 English hashtags only. Always include #cozyvibe.
  Pool: #cozyvibe #cozyhome #cozyaesthetic #aestheticroom #homedecor #interiordesign #cozycorner #warmlight #cozyspace #homeaesthetic #cozyvibesonly #coziness #moodyhome #softaesthetic #lofivibes #plantsofinstagram.

Return ONLY JSON, no markdown fence.`;
}

async function geminiText(env: ScriptEnv, prompt: string, schema: object): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1500,
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

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadFbPhoto(env: ScriptEnv, image: Buffer, filename: string): Promise<string> {
  const url = `https://graph.facebook.com/${env.FB_GRAPH_VERSION}/${env.FB_PAGE_ID}/photos`;
  const fd = new FormData();
  fd.append('source', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), filename);
  fd.append('published', 'false');
  fd.append('access_token', env.FB_PAGE_ACCESS_TOKEN);
  const res = await fetch(url, { method: 'POST', body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(`FB photo upload ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text) as { id?: string };
  if (!json.id) throw new Error(`FB photo no id: ${text}`);
  return json.id;
}

async function publishFeedPost(env: ScriptEnv, mediaIds: string[], message: string): Promise<string> {
  const url = `https://graph.facebook.com/${env.FB_GRAPH_VERSION}/${env.FB_PAGE_ID}/feed`;
  const params = new URLSearchParams();
  params.set('message', message);
  mediaIds.forEach((id, i) => params.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  params.set('access_token', env.FB_PAGE_ACCESS_TOKEN);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FB feed publish ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text) as { id?: string; post_id?: string };
  const id = json.id ?? json.post_id;
  if (!id) throw new Error(`FB feed no id: ${text}`);
  return id;
}

function parseArgs(): { preview: number; skipPublish: boolean } {
  let preview = 0;
  let skipPublish = false;
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'preview') preview = v ? Number(v) : 2;
    else if (k === 'skip-publish') skipPublish = true;
  }
  return { preview, skipPublish };
}

interface PoolRow {
  id: number;
  source: string;
  source_id: string;
  source_url: string | null;
  image_url: string;
  photographer: string;
  photographer_url: string | null;
  alt: string | null;
  width: number;
  height: number;
}

async function main() {
  const env = loadEnv();
  const args = parseArgs();

  console.log(`[1/5] Atomically claiming oldest-unused set from curated pool...`);
  // ATOMIC CLAIM (race-safe): UPDATE used_count+=1 + last_used_at=now on ALL
  // photos in the chosen set in ONE statement. If two crons fire concurrently
  // (e.g., GH cron + Worker watchdog), only one wins the claim — the other
  // sees no rows updated.
  const claimedRows = await d1Query<PoolRow>(
    env,
    `UPDATE curated_photos
        SET used_count = used_count + 1, last_used_at = unixepoch()
      WHERE set_id = (
        SELECT set_id FROM (
          SELECT set_id, MAX(COALESCE(last_used_at, 0)) AS last_used
            FROM curated_photos
           WHERE status = 'APPROVED' AND set_id IS NOT NULL AND used_count = 0
           GROUP BY set_id
           ORDER BY last_used ASC, MIN(id) ASC
           LIMIT 1
        )
      )
   RETURNING id, source, source_id, source_url, image_url, photographer, photographer_url, alt, width, height, set_id, set_order`,
  );
  if (claimedRows.length === 0) {
    console.log('No unused APPROVED sets (or all just claimed by another run) — exiting gracefully.');
    return;
  }
  // Sort by set_order (RETURNING doesn't preserve our ORDER BY)
  const rows = [...claimedRows].sort((a, b) => ((a as PoolRow & { set_order?: number }).set_order ?? 0) - ((b as PoolRow & { set_order?: number }).set_order ?? 0));
  const setId = (claimedRows[0] as PoolRow & { set_id?: string }).set_id ?? '';
  console.log(`  set_id: ${setId} (${rows.length} photo${rows.length === 1 ? '' : 's'})`);
  for (const p of rows) {
    console.log(`  📷 ${p.photographer ?? '(unknown)'} (${p.source}:${p.source_id}, ${p.width}x${p.height})`);
    console.log(`      alt: ${p.alt?.slice(0, 100) || '(none)'}`);
  }

  // Pool runway: count of unused sets
  const remaining = await d1Query<{ c: number }>(
    env,
    `SELECT COUNT(DISTINCT set_id) as c
       FROM curated_photos
      WHERE status='APPROVED' AND (last_used_at IS NULL OR last_used_at < unixepoch() - 7*24*3600)`,
  );
  const remCount = remaining[0]?.c ?? 0;
  if (remCount <= 3) {
    await tgSend(
      env,
      `⚠ Curated pool low: ${remCount} unused APPROVED sets left.\nAdd more sets via /admin/add?key=…`,
    );
  }

  // Pick a theme slug from selected photos' alt for filename/log
  const themeFallback = `curated-${new Date().toISOString().slice(0, 10)}`;

  if (args.preview > 0) {
    console.log(`\nPreview mode — would use the ${rows.length} photos above. No Gemini caption, no FB upload.`);
    return;
  }

  console.log(`[2/5] Gemini: caption from photo alt-tags...`);
  const photosForCaption = rows.map((r) => ({
    id: Number(r.source_id),
    width: r.width,
    height: r.height,
    photographer: r.photographer,
    photographer_url: r.photographer_url ?? '',
    alt: r.alt ?? '',
    src: { original: r.image_url, large2x: r.image_url, large: r.image_url },
    url: r.source_url ?? undefined,
  }));
  const captionRaw = await geminiText(env, captionPrompt(themeFallback, photosForCaption), CAPTION_SCHEMA);
  const captionSpec = JSON.parse(captionRaw) as CaptionSpec;
  console.log(`  caption: ${captionSpec.caption}`);
  console.log(`  hashtags: ${captionSpec.hashtags}`);

  if (args.skipPublish) {
    console.log(`[3/5] --skip-publish set, exiting before FB upload.`);
    return;
  }

  console.log(`[3/5] Downloading ${rows.length} photos and uploading to FB...`);
  const mediaIds: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const photo = rows[i]!;
    const buf = await downloadImage(photo.image_url);
    const id = await uploadFbPhoto(env, buf, `${photo.source}-${photo.source_id}.jpg`);
    mediaIds.push(id);
    console.log(`  ${i + 1}/${rows.length}: ${(buf.length / 1024).toFixed(0)}KB by ${photo.photographer} → ${id}`);
  }

  // Track credits in DB metadata (still useful for audit), but DO NOT show on FB.
  const credits = rows.map((r) => ({
    photographer: r.photographer,
    photographer_url: r.photographer_url,
    photo_id: r.source_id,
    source: r.source,
    photo_url: r.source_url,
  }));
  const message = `${captionSpec.caption}\n\n${captionSpec.hashtags}`;

  console.log(`[4/5] Publishing feed post...`);
  const fbPostId = await publishFeedPost(env, mediaIds, message);
  console.log(`  fb_post_id: ${fbPostId}`);

  console.log(`[5/5] Logging fb_posts (used_count already claimed in step 1)...`);
  const now = Math.floor(Date.now() / 1000);
  await d1Query(
    env,
    `INSERT INTO fb_posts (fb_post_id, theme, caption, hashtags, style_preset, num_photos, photo_fbids, scenes, source, credits, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pexels', ?, ?)`,
    [
      fbPostId,
      themeFallback,
      captionSpec.caption,
      captionSpec.hashtags,
      STYLE_PRESET,
      mediaIds.length,
      JSON.stringify(mediaIds),
      JSON.stringify(rows.map((r) => r.alt)),
      JSON.stringify(credits),
      now,
    ],
  );

  await tgSend(
    env,
    `✅ FB post published\n${captionSpec.caption}\nhttps://www.facebook.com/${fbPostId}`,
  );
  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
