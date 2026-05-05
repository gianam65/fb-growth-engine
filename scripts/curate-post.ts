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
const NUM_IMAGES = Number(process.env.NUM_IMAGES || 5);

const STYLE_PRESETS: Record<string, { vibe_hint: string; search_seeds: string[] }> = {
  'asian-cozy': {
    vibe_hint:
      'small modern Asian apartment cozy aesthetic at warm golden hour: rice paper lamps, plants, light wood floor, beige walls, balcony with city view, lots of personal decor — like Xiaohongshu/Douyin home tours',
    search_seeds: [
      'cozy bedroom warm lights',
      'small apartment aesthetic',
      'warm reading nook plants',
      'cozy desk setup plants',
      'warm bedroom city window',
      'plant filled apartment',
      'cozy studio apartment evening',
      'asian cozy room',
      'warm interior lighting evening',
      'paper lantern bedroom',
      'cozy corner books candle',
      'rainy window cozy room',
    ],
  },
  japandi: {
    vibe_hint: 'Japandi: Japanese-Scandinavian fusion — minimal, light wood, white, plants, soft daylight',
    search_seeds: ['japandi interior', 'minimalist bedroom plants', 'scandinavian apartment', 'light wood interior'],
  },
  kinfolk: {
    vibe_hint: 'Kinfolk magazine: slow living, beige and cream palette, ceramic, linen, soft window light',
    search_seeds: ['kinfolk interior', 'beige minimalist room', 'slow living kitchen', 'linen ceramic table'],
  },
  'rainy-cafe': {
    vibe_hint: 'Rainy cafe corner: rain on window, warm tungsten lamp, ceramic mug, moody dim lighting',
    search_seeds: ['rainy window cafe', 'cozy cafe corner moody', 'rain on glass warm lamp', 'cafe ceramic mug'],
  },
};

const STYLE_PRESET = process.env.STYLE_PRESET || 'asian-cozy';
const STYLE = STYLE_PRESETS[STYLE_PRESET] ?? STYLE_PRESETS['asian-cozy']!;

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  photographer: string;
  photographer_url: string;
  alt: string;
  src: { original: string; large2x: string; large: string; portrait?: string };
  url?: string;
}

interface KeywordsSpec {
  theme: string;
  search_keywords: string[];
}

const KEYWORDS_SCHEMA = {
  type: 'object',
  properties: {
    theme: { type: 'string' },
    search_keywords: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
  },
  required: ['theme', 'search_keywords'],
};

const KEYWORDS_PROMPT = `Today is one day for a Vietnamese decor Facebook page named "Cozy Vibe".
Vibe target: ${STYLE.vibe_hint}.

Pick a daily theme + 2-3 short English search keywords for stock photo search (Pexels).
The search keywords should be CONCRETE and search-friendly (what a photographer would tag), e.g.:
  "cozy bedroom warm light", "indoor plant apartment", "rainy window cafe", "cozy reading nook".

Avoid abstract words like "vibe", "aesthetic", "feeling".

Examples of good seed terms (do NOT just copy these — adapt to today's mood):
${STYLE.search_seeds.map((s) => `  - "${s}"`).join('\n')}

Output JSON:
- theme: short English slug (e.g., "warm-evening-shelves", "rainy-balcony-monstera")
- search_keywords: array of 2-3 short concrete English keywords

Return ONLY JSON.`;

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

function captionPrompt(theme: string, photos: PexelsPhoto[]): string {
  const items = photos
    .map((p, i) => `  ${i + 1}. ${p.alt?.slice(0, 200) || '(no alt text)'}`)
    .join('\n');
  return `You write Vietnamese captions for a cozy/decor Facebook page "Cozy Vibe".

Today's theme: ${theme}
The carousel has ${photos.length} curated photos:
${items}

Output JSON with:
- caption: 2-3 sentences in casual Vietnamese, evocative, NOT salesy. Open with a hook (a question, a feeling, a small moment). May contain 1-2 emojis sparingly inside the body. Reference the actual photo content gently — don't list it.
  Tone examples:
    "Trời mưa, mở đèn vàng lên là thấy cả căn phòng dịu lại. Tự dưng chỉ muốn pha một ấm trà rồi ngồi yên 🍵"
    "Có những góc nhỏ chỉ cần ánh đèn vàng và vài cuốn sách là đủ thấy mình ở nhà rồi."
    "Cuối ngày về tới phòng, cây cối, đèn vàng và mùi nến — cảm giác này khó tả lắm."
- hashtags: single line of 8-12 hashtags, mix Vietnamese + English. Always include #cozyvibe.
  Suggested pool: #cozyvibe #nhaxinh #goccay #decor #trangtrinoithat #aestheticroom #xiaohongshu #douyinstyle #plantparent #studioapartment #cozyroom #lofi #chillvibes #goclam #songcham.

Return ONLY JSON, no markdown fence.`;
}

async function geminiText(env: ScriptEnv, prompt: string, schema: object): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.85,
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

async function pexelsSearch(apiKey: string, query: string, perPage: number): Promise<PexelsPhoto[]> {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&size=large&per_page=${perPage}`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Pexels ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { photos?: PexelsPhoto[] };
  return json.photos ?? [];
}

function pickPhotos(candidates: PexelsPhoto[], n: number): PexelsPhoto[] {
  // Filter: portrait, big enough, has alt
  const portrait = candidates.filter(
    (p) => p.height > p.width && p.width >= 1080 && p.height >= 1280,
  );
  // Dedupe by photographer (one photo per author for diverse credits)
  const byAuthor = new Map<string, PexelsPhoto>();
  for (const p of portrait) {
    if (!byAuthor.has(p.photographer)) byAuthor.set(p.photographer, p);
  }
  // Shuffle for variety
  const arr = [...byAuthor.values()];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, n);
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

async function main() {
  const env = loadEnv();
  const args = parseArgs();
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (!pexelsKey) throw new Error('Missing PEXELS_API_KEY env. Sign up at https://www.pexels.com/api/ (free).');

  console.log(`[1/5] Gemini: pick today's theme + search keywords (style=${STYLE_PRESET})...`);
  const kwRaw = await geminiText(env, KEYWORDS_PROMPT, KEYWORDS_SCHEMA);
  const kwSpec = JSON.parse(kwRaw) as KeywordsSpec;
  console.log(`  theme: ${kwSpec.theme}`);
  console.log(`  keywords: ${kwSpec.search_keywords.join(' | ')}`);

  console.log(`[2/5] Pexels search across ${kwSpec.search_keywords.length} keywords...`);
  const all: PexelsPhoto[] = [];
  for (const kw of kwSpec.search_keywords) {
    const photos = await pexelsSearch(pexelsKey, kw, 20);
    all.push(...photos);
    console.log(`  "${kw}" → ${photos.length} photos`);
  }
  // Dedupe by id
  const dedup = new Map<number, PexelsPhoto>();
  for (const p of all) dedup.set(p.id, p);
  const candidates = [...dedup.values()];
  console.log(`  total unique: ${candidates.length}`);

  const selected = pickPhotos(candidates, args.preview > 0 ? Math.min(args.preview, NUM_IMAGES) : NUM_IMAGES);
  if (selected.length < 1) {
    throw new Error(`No usable photos found for keywords: ${kwSpec.search_keywords.join(', ')}`);
  }
  if (args.preview === 0 && selected.length < NUM_IMAGES) {
    console.warn(`⚠ only ${selected.length}/${NUM_IMAGES} photos passed filter — proceeding with what we have`);
  }
  console.log(`  selected ${selected.length}:`);
  for (const p of selected) {
    console.log(`    📷 ${p.photographer} (id=${p.id}, ${p.width}x${p.height})`);
    console.log(`        alt: ${p.alt?.slice(0, 100) || '(none)'}`);
    console.log(`        url: ${p.src.large2x}`);
  }

  if (args.preview > 0) {
    console.log(`\nPreview mode — image URLs above. (Did not download or call Gemini for caption.)`);
    return;
  }

  console.log(`[3/5] Gemini: generate caption from photo alt-tags...`);
  const captionRaw = await geminiText(env, captionPrompt(kwSpec.theme, selected), CAPTION_SCHEMA);
  const captionSpec = JSON.parse(captionRaw) as CaptionSpec;
  console.log(`  caption: ${captionSpec.caption}`);
  console.log(`  hashtags: ${captionSpec.hashtags}`);

  if (args.skipPublish) {
    console.log(`[4/5] --skip-publish set, exiting before FB upload.`);
    return;
  }

  console.log(`[4/5] Downloading ${selected.length} photos and uploading to FB...`);
  const mediaIds: string[] = [];
  for (let i = 0; i < selected.length; i++) {
    const photo = selected[i]!;
    const buf = await downloadImage(photo.src.large2x || photo.src.large);
    const id = await uploadFbPhoto(env, buf, `pexels-${photo.id}.jpg`);
    mediaIds.push(id);
    console.log(`  ${i + 1}/${selected.length}: ${(buf.length / 1024).toFixed(0)}KB by ${photo.photographer} → ${id}`);
  }

  const photographers = [...new Set(selected.map((p) => p.photographer))];
  const credits = selected.map((p) => ({
    photographer: p.photographer,
    photographer_url: p.photographer_url,
    photo_id: p.id,
    photo_url: p.url,
  }));
  const message = `${captionSpec.caption}\n\n📷 Ảnh: ${photographers.join(', ')} (Pexels)\n\n${captionSpec.hashtags}`;

  console.log(`[5/5] Publishing feed post...`);
  const fbPostId = await publishFeedPost(env, mediaIds, message);
  console.log(`  fb_post_id: ${fbPostId}`);

  await d1Query(
    env,
    `INSERT INTO fb_posts (fb_post_id, theme, caption, hashtags, style_preset, num_photos, photo_fbids, scenes, source, credits, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pexels', ?, ?)`,
    [
      fbPostId,
      kwSpec.theme,
      captionSpec.caption,
      captionSpec.hashtags,
      STYLE_PRESET,
      mediaIds.length,
      JSON.stringify(mediaIds),
      JSON.stringify(selected.map((p) => p.alt)),
      JSON.stringify(credits),
      Math.floor(Date.now() / 1000),
    ],
  );

  await tgSend(
    env,
    `✅ FB post published (curated)\n*${kwSpec.theme}*\n${captionSpec.caption}\n📷 ${photographers.join(', ')}\nhttps://www.facebook.com/${fbPostId}`,
  );
  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
