// Auto-generate a daily Cozy Vibe Facebook photo post (carousel) using AI.
//
// Pipeline:
//   1. Gemini text → JSON { theme, scene_descriptions[5], caption, hashtags }
//   2. Pollinations FLUX → 5 vertical 9:16 images saved to /tmp
//   3. POST each /{page_id}/photos with published=false → media_fbids
//   4. POST /{page_id}/feed with attached_media[] + message
//   5. Log to fb_posts table
//
// Sibling of generate-reel.ts; shares prompt+image gen logic by deliberate copy
// (we want one file = one path; refactor to a shared module if drift becomes pain).

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { d1Query, loadEnv, tgSend, type ScriptEnv } from './lib';

const TEXT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
// flux-realism is specialized for photorealistic photo output → noticeably sharper
// than base flux on FLUX-1 backbone. Falls back to flux if not available.
const POLLINATIONS_MODEL = process.env.POLLINATIONS_MODEL || 'flux-realism';
const NUM_IMAGES = Number(process.env.NUM_IMAGES || 5);
// 4:5 portrait (1440x1800) — FB feed displays full width; high-res = sharper.
const IMG_WIDTH = Number(process.env.IMG_WIDTH || 1440);
const IMG_HEIGHT = Number(process.env.IMG_HEIGHT || 1800);

const STYLE_PRESETS: Record<string, { suffix: string; vibe_hint: string }> = {
  'asian-cozy': {
    // Lighting tokens first — FLUX prioritizes early tokens, so warm tone leads.
    suffix:
      'warm amber tungsten lighting, golden hour sunset glow streaming through a large window, honey-colored ambient light, warm orange and yellow color grading, soft glowing rice paper lantern. Modern asian apartment cozy aesthetic, xiaohongshu home decor style, douyin cozy room interior, warm beige walls, light oak wood floor, white minimalist furniture, rattan chair, lots of indoor plants, monstera fiddle leaf fig snake plant, hanging pothos vines, biophilic lush greenery, lived-in cozy vibe. Ultra sharp focus, high detail, 8k photorealistic, professional interior photography, Sony A7IV 50mm f/1.8, magazine cover quality. No people, no text, no logos.',
    vibe_hint:
      'modern Asian apartment with warm tungsten glow, rice paper lamp, lots of plants (monstera, fiddle leaf), wood floor, warm beige walls, large window, golden hour mood',
  },
  japandi: {
    suffix:
      'japandi aesthetic, japanese scandinavian fusion interior, minimalist, light wood, white walls, indoor plants, soft natural light, neutral palette, wabi-sabi, hygge, 35mm film, photorealistic, magazine quality, no people, no text',
    vibe_hint: 'Japandi: minimal Japanese-Scandinavian, very clean, plants, light wood',
  },
  kinfolk: {
    suffix:
      'kinfolk magazine aesthetic, slow living interior, beige cream white palette, natural linen, ceramic, soft window light, golden hour, film grain, 35mm Kodak Portra 400, photorealistic, magazine quality, no people, no text',
    vibe_hint: 'Kinfolk: minimalist Scandinavian, beige/cream, ceramic and linen, no plants',
  },
  'rainy-cafe': {
    suffix:
      'cozy cafe corner, rain on window, condensation droplets, warm tungsten table lamp, ceramic mug with steam, wooden table, dim warm lighting, moody atmosphere, jazz cafe vibe, 35mm film, photorealistic, no people, no text',
    vibe_hint: 'Rainy cafe corner: rain on window, warm lamp, ceramic mug, moody dim lighting',
  },
  'dark-academia': {
    suffix:
      'dark academia aesthetic, antique library, leather-bound books, brass desk lamp, dark wood furniture, persian rug, vintage globe, deep brown burgundy palette, candlelight, moody warm lighting, 35mm film, photorealistic, no people, no text',
    vibe_hint: 'Dark academia: antique library, dark wood, leather books, brass lamp, moody warm',
  },
};

const STYLE_PRESET = process.env.STYLE_PRESET || 'asian-cozy';
const STYLE = STYLE_PRESETS[STYLE_PRESET] ?? STYLE_PRESETS['asian-cozy']!;

interface GenSpec {
  theme: string;
  scene_descriptions: string[];
  caption: string;
  hashtags: string;
}

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    theme: { type: 'string' },
    scene_descriptions: { type: 'array', items: { type: 'string' }, minItems: NUM_IMAGES, maxItems: NUM_IMAGES },
    caption: { type: 'string' },
    hashtags: { type: 'string' },
  },
  required: ['theme', 'scene_descriptions', 'caption', 'hashtags'],
};

const SPEC_PROMPT = `You curate one daily photo post for a Vietnamese home decor Facebook page named "Cozy Vibe".
The aesthetic is FIXED to: ${STYLE.vibe_hint}.
The output is a 5-photo carousel showing different angles of the same cozy space — like a Xiaohongshu/Douyin home tour.
You do NOT need to mention aesthetic/style/film-stock/lighting words — those are appended automatically. Focus ONLY on what objects appear and where the camera is.

Output JSON with these fields:

- theme: short English slug for today (e.g., "morning-plant-corner", "evening-desk-glow", "rainy-window-monstera"). Be specific.

- scene_descriptions: array of EXACTLY ${NUM_IMAGES} distinct one-line scene descriptions in English. Each line MUST:
  * be a different camera angle (wide room shot, close-up of a corner detail, over-the-shoulder, top-down flatlay, low-angle floor view)
  * name 3-6 specific objects in the frame (e.g., "monstera leaves catching window light, white ceramic mug on side table, linen curtain swaying")
  * stay coherent with the day's theme — same room/space, different angles
  * AVOID style words like "cozy", "cinematic", "film grain", "warm" — those auto-append later
  * AVOID people, faces, hands; silhouettes far away OK only if needed

- caption: 1-3 short sentences in casual Vietnamese, soothing/evocative, not salesy. May start with a soft hook or rhetorical question. No emoji at the very start; sparingly inside is fine.

- hashtags: single line of 8-12 hashtags, mix Vietnamese + English (e.g., #cozyvibe #nhaxinh #decor #aestheticroom #xiaohongshu #douyinstyle #lofi #plantparent #goccay #trangtri).

Return ONLY the JSON, no markdown fence.`;

async function geminiText(env: ScriptEnv, prompt: string, schema: object): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.9,
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
  if (!res.ok) throw new Error(`Gemini text ${res.status}: ${text}`);
  const json = JSON.parse(text) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const out = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!out) throw new Error(`Gemini text returned empty: ${text}`);
  return out;
}

async function pollinationsImage(prompt: string, seed: number): Promise<Buffer> {
  const params = new URLSearchParams({
    width: String(IMG_WIDTH),
    height: String(IMG_HEIGHT),
    model: POLLINATIONS_MODEL,
    seed: String(seed),
    nologo: 'true',
    enhance: 'false',
  });
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 90_000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        const wait = 5 + attempt * 5;
        console.log(`    [pollinations ${res.status}, sleeping ${wait}s, retry ${attempt + 1}/4]`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`Pollinations ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5_000) throw new Error(`Pollinations returned tiny image (${buf.length} bytes)`);
      return buf;
    } catch (err) {
      clearTimeout(t);
      if (attempt === 3) throw err;
      const wait = 5 + attempt * 5;
      console.log(`    [pollinations error: ${String(err).slice(0, 80)}, retry ${attempt + 1}/4 in ${wait}s]`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  throw new Error('pollinations exhausted retries');
}

async function uploadFbPhoto(env: ScriptEnv, image: Buffer, filename: string): Promise<string> {
  // Upload as unpublished photo to obtain a media_fbid for the carousel.
  const url = `https://graph.facebook.com/${env.FB_GRAPH_VERSION}/${env.FB_PAGE_ID}/photos`;
  const fd = new FormData();
  fd.append('source', new Blob([new Uint8Array(image)], { type: 'image/png' }), filename);
  fd.append('published', 'false');
  fd.append('access_token', env.FB_PAGE_ACCESS_TOKEN);
  const res = await fetch(url, { method: 'POST', body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(`FB photo upload ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text) as { id?: string };
  if (!json.id) throw new Error(`FB photo upload no id: ${text}`);
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
  if (!id) throw new Error(`FB feed publish no id: ${text}`);
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

  console.log(`[1/4] Gemini text (${TEXT_MODEL}, style=${STYLE_PRESET}): generating post spec...`);
  const raw = await geminiText(env, SPEC_PROMPT, SPEC_SCHEMA);
  const spec = JSON.parse(raw) as GenSpec;
  if (!Array.isArray(spec.scene_descriptions) || spec.scene_descriptions.length !== NUM_IMAGES) {
    throw new Error(`Spec has wrong scene_descriptions length: ${spec.scene_descriptions?.length}`);
  }
  console.log(`  theme: ${spec.theme}`);
  console.log(`  caption: ${spec.caption}`);
  console.log(`  scenes:`);
  for (const s of spec.scene_descriptions) console.log(`    - ${s}`);

  const numToGen = args.preview > 0 ? Math.min(args.preview, NUM_IMAGES) : NUM_IMAGES;
  console.log(`[2/4] Pollinations FLUX: generating ${numToGen} image(s)...`);
  const tmp = await mkdtemp(join(tmpdir(), 'post-'));
  const imageBuffers: Buffer[] = [];
  const imagePaths: string[] = [];
  const interImageSleep = Number(process.env.IMAGE_INTER_SLEEP_SEC || 2);
  const seedBase = Math.floor(Date.now() / 1000) % 1_000_000;
  for (let i = 0; i < numToGen; i++) {
    const scene = spec.scene_descriptions[i]!;
    const prompt = `${scene}, ${STYLE.suffix}`;
    process.stdout.write(`  img ${i + 1}/${numToGen}... `);
    const t0 = Date.now();
    const buf = await pollinationsImage(prompt, seedBase + i);
    const path = join(tmp, `img-${i}.png`);
    await writeFile(path, buf);
    imageBuffers.push(buf);
    imagePaths.push(path);
    console.log(`${(buf.length / 1024).toFixed(0)}KB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (i < numToGen - 1 && interImageSleep > 0) {
      await new Promise((r) => setTimeout(r, interImageSleep * 1000));
    }
  }

  if (args.preview > 0) {
    console.log(`\nPreview mode — ${numToGen} image(s) saved to:`);
    for (const p of imagePaths) console.log(`  ${p}`);
    if (process.platform === 'darwin') {
      try {
        execSync(`open ${imagePaths.map((p) => `'${p}'`).join(' ')}`);
      } catch { /* ignore */ }
    }
    return;
  }

  if (args.skipPublish) {
    console.log(`[3/4] --skip-publish set, not uploading. Images at:`);
    for (const p of imagePaths) console.log(`  ${p}`);
    return;
  }

  console.log(`[3/4] Uploading ${numToGen} photos to FB (unpublished)...`);
  const mediaIds: string[] = [];
  for (let i = 0; i < imageBuffers.length; i++) {
    process.stdout.write(`  upload ${i + 1}/${imageBuffers.length}... `);
    const id = await uploadFbPhoto(env, imageBuffers[i]!, `cozy-${spec.theme}-${i}.png`);
    mediaIds.push(id);
    console.log(id);
  }

  const message = `${spec.caption}\n\n${spec.hashtags}`;
  console.log(`[4/4] Publishing feed post with ${mediaIds.length} photos...`);
  const fbPostId = await publishFeedPost(env, mediaIds, message);
  console.log(`  fb_post_id: ${fbPostId}`);

  await d1Query(
    env,
    `INSERT INTO fb_posts (fb_post_id, theme, caption, hashtags, style_preset, num_photos, photo_fbids, scenes, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fbPostId,
      spec.theme,
      spec.caption,
      spec.hashtags,
      STYLE_PRESET,
      mediaIds.length,
      JSON.stringify(mediaIds),
      JSON.stringify(spec.scene_descriptions),
      Math.floor(Date.now() / 1000),
    ],
  );

  await tgSend(env, `✅ FB post published\n*${spec.theme}*\n${spec.caption}\nhttps://www.facebook.com/${fbPostId}`);
  console.log(`\nDone. ${message}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
