// Auto-generate a daily Cozy Vibe reel using AI image slideshow + Ken Burns.
//
// Pipeline:
//   1. Gemini text → JSON { theme, image_prompts[5], caption, hashtags }
//   2. Gemini Flash Image → 5 vertical 9:16 images saved to /tmp
//   3. Pick random ambient audio from assets/audio/
//   4. ffmpeg → Ken Burns zoom + xfade crossfade + audio → reels-source/auto-YYYY-MM-DD.mp4
//   5. Insert into reels_queue scheduled +N minutes
//
// Run locally:
//   FB_GRAPH_VERSION=v21.0 CF_ACCOUNT_ID=... CF_API_TOKEN=... D1_DATABASE_ID=... \
//   FB_PAGE_ID=... FB_PAGE_ACCESS_TOKEN=... GEMINI_API_KEY=... \
//   npx tsx scripts/generate-reel.ts --schedule-in=600

import { execSync } from 'node:child_process';
import { mkdtemp, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { d1Query, loadEnv, type ScriptEnv } from './lib';

const TEXT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
// Image-capable model candidates, tried in order until one succeeds.
// Override entirely with GEMINI_IMAGE_MODEL env (single name, no fallback).
const IMAGE_MODEL_CANDIDATES = process.env.GEMINI_IMAGE_MODEL
  ? [process.env.GEMINI_IMAGE_MODEL]
  : [
      'gemini-2.5-flash-image',
      'gemini-2.5-flash-image-preview',
      'gemini-2.0-flash-preview-image-generation',
      'gemini-2.0-flash-exp',
    ];
const NUM_IMAGES = 5;
const SECONDS_PER_IMAGE = 3;
const XFADE_DURATION = 0.6;
const AUDIO_DIR = 'assets/audio';
const OUTPUT_DIR = 'reels-source';

interface GenSpec {
  theme: string;
  image_prompts: string[];
  caption: string;
  hashtags: string;
}

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    theme: { type: 'string' },
    image_prompts: { type: 'array', items: { type: 'string' }, minItems: NUM_IMAGES, maxItems: NUM_IMAGES },
    caption: { type: 'string' },
    hashtags: { type: 'string' },
  },
  required: ['theme', 'image_prompts', 'caption', 'hashtags'],
};

const SPEC_PROMPT = `You curate cozy/lofi/cinematic interior content for a Vietnamese home decor Facebook page named "Cozy Vibe".
Generate one daily reel concept. Output JSON.

Fields:
- theme: short English slug describing today's vibe (e.g., "rainy-cafe-corner", "warm-bookshelf-evening", "minimalist-tea-ritual"). Avoid repetition with these recent themes if any: <NONE>.
- image_prompts: array of EXACTLY ${NUM_IMAGES} distinct image prompts in English for an AI image generator. Each prompt MUST:
  * describe a cozy/calm interior scene (no people unless silhouette)
  * specify portrait 9:16 vertical composition explicitly
  * mention warm lighting, film grain, soft shadows, cinematic shallow depth of field
  * vary the camera angle (wide, close-up, detail shot, over-the-shoulder POV, top-down)
  * be concrete: include specific objects (e.g., ceramic mug, linen curtain, brass lamp, knitted blanket, rain on window, indoor plants)
- caption: 1-2 short sentences in casual Vietnamese (no emojis at start). Soothing, evocative, not salesy.
- hashtags: single line of 6-10 hashtags, mix Vietnamese + English (e.g., #cozyvibe #nhaxinh #decor #aesthetic #lofi #chillvibes).

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

let RESOLVED_IMAGE_MODEL: string | null = null;

function parseRetryDelaySec(text: string): number {
  // Gemini error body has: { error: { details: [{ "@type": ".../RetryInfo", retryDelay: "32s" }] } }
  const m = text.match(/"retryDelay":\s*"(\d+)s"/);
  if (m && m[1]) return Number(m[1]);
  return 30; // default
}

async function tryGeminiImage(
  env: ScriptEnv,
  model: string,
  prompt: string,
  maxRetries = 4,
): Promise<Buffer | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 404 || res.status === 400) return null; // try next candidate (model not found)
    if (res.status === 429) {
      if (attempt === maxRetries) throw new Error(`Gemini image rate-limited after ${maxRetries} retries (${model}): ${text.slice(0, 400)}`);
      const wait = parseRetryDelaySec(text) + 2;
      console.log(`    [429 rate-limited, sleeping ${wait}s, attempt ${attempt + 1}/${maxRetries}]`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini image ${res.status} (${model}): ${text}`);
    const json = JSON.parse(text) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
    };
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      if (p.inlineData?.data) return Buffer.from(p.inlineData.data, 'base64');
    }
    return null;
  }
  return null;
}

async function listAvailableImageModels(env: ScriptEnv): Promise<string[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}&pageSize=200`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[]; description?: string }> };
  const out: string[] = [];
  for (const m of json.models ?? []) {
    if (!m.name) continue;
    const desc = (m.description ?? '').toLowerCase();
    if (m.supportedGenerationMethods?.includes('generateContent') && (desc.includes('image') || m.name.includes('image'))) {
      out.push(m.name.replace(/^models\//, ''));
    }
  }
  return out;
}

async function geminiImage(env: ScriptEnv, prompt: string): Promise<Buffer> {
  if (RESOLVED_IMAGE_MODEL) {
    const buf = await tryGeminiImage(env, RESOLVED_IMAGE_MODEL, prompt);
    if (buf) return buf;
    throw new Error(`Resolved model ${RESOLVED_IMAGE_MODEL} failed mid-run.`);
  }
  for (const m of IMAGE_MODEL_CANDIDATES) {
    const buf = await tryGeminiImage(env, m, prompt);
    if (buf) {
      console.log(`  (resolved image model: ${m})`);
      RESOLVED_IMAGE_MODEL = m;
      return buf;
    }
  }
  const available = await listAvailableImageModels(env);
  throw new Error(
    `No candidate image model worked: ${IMAGE_MODEL_CANDIDATES.join(', ')}\n` +
      `Available image-capable models for this API key:\n  ${available.join('\n  ') || '(none found)'}`,
  );
}

async function pickAudio(): Promise<string> {
  const dir = resolve(process.cwd(), AUDIO_DIR);
  if (!existsSync(dir)) {
    throw new Error(
      `${AUDIO_DIR}/ not found. Add 1+ ambient audio files (mp3/m4a/wav). See ${AUDIO_DIR}/README.md.`,
    );
  }
  const files = (await readdir(dir)).filter((f) => /\.(mp3|m4a|wav|ogg)$/i.test(f));
  if (files.length === 0) {
    throw new Error(
      `${AUDIO_DIR}/ is empty. Drop FB-safe ambient tracks (rain/fire/cafe). See ${AUDIO_DIR}/README.md.`,
    );
  }
  const pick = files[Math.floor(Math.random() * files.length)];
  return resolve(dir, pick!);
}

function buildFfmpegFilter(numImages: number): string {
  const total = numImages * SECONDS_PER_IMAGE - (numImages - 1) * XFADE_DURATION;
  const fps = 25;
  const segFrames = SECONDS_PER_IMAGE * fps;

  // Each image: scale to fill 9:16 with cover crop + zoompan Ken Burns
  // Alternating zoom-in / zoom-out for variety.
  const vChains: string[] = [];
  for (let i = 0; i < numImages; i++) {
    const zoomIn = i % 2 === 0;
    const zExpr = zoomIn ? `min(zoom+0.0009,1.25)` : `max(1.25-on*0.0009,1.0)`;
    const xExpr = `iw/2-(iw/zoom/2)`;
    const yExpr = `ih/2-(ih/zoom/2)`;
    vChains.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
        `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${segFrames}:s=1080x1920:fps=${fps},` +
        `setpts=PTS-STARTPTS[v${i}]`,
    );
  }

  // Crossfade chain
  const xfade: string[] = [];
  let prevLabel = `v0`;
  for (let i = 1; i < numImages; i++) {
    const offset = i * SECONDS_PER_IMAGE - (i - 1) * XFADE_DURATION - XFADE_DURATION;
    const outLabel = i === numImages - 1 ? 'vout' : `xf${i}`;
    xfade.push(
      `[${prevLabel}][v${i}]xfade=transition=fade:duration=${XFADE_DURATION}:offset=${offset.toFixed(2)}[${outLabel}]`,
    );
    prevLabel = outLabel;
  }

  // Audio: trim to total length, fade in 0.5s, fade out 1s before end
  const audioIdx = numImages;
  const fadeOutStart = (total - 1).toFixed(2);
  const aChain = `[${audioIdx}:a]aformat=channel_layouts=stereo:sample_rates=44100,atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,afade=t=in:d=0.5,afade=t=out:st=${fadeOutStart}:d=1[aout]`;

  return [...vChains, ...xfade, aChain].join(';');
}

function buildFfmpegCmd(images: string[], audio: string, out: string): string[] {
  const inputs: string[] = [];
  for (const img of images) inputs.push('-loop', '1', '-t', String(SECONDS_PER_IMAGE), '-i', img);
  inputs.push('-i', audio);

  const total = images.length * SECONDS_PER_IMAGE - (images.length - 1) * XFADE_DURATION;
  return [
    'ffmpeg',
    '-y',
    ...inputs,
    '-filter_complex',
    buildFfmpegFilter(images.length),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-t',
    total.toFixed(2),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '25',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    out,
  ];
}

function shellEscape(args: string[]): string {
  return args.map((a) => (/[^A-Za-z0-9_\-./=:,@+]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(' ');
}

function parseArgs(): { scheduleIn: number; skipPublish: boolean } {
  let scheduleIn = 600;
  let skipPublish = false;
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'schedule-in' && v) scheduleIn = Number(v);
    else if (k === 'skip-publish') skipPublish = true;
  }
  return { scheduleIn, skipPublish };
}

async function main() {
  const env = loadEnv();
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);

  console.log(`[1/5] Gemini text (${TEXT_MODEL}): generating reel spec...`);
  const raw = await geminiText(env, SPEC_PROMPT, SPEC_SCHEMA);
  const spec = JSON.parse(raw) as GenSpec;
  if (!Array.isArray(spec.image_prompts) || spec.image_prompts.length !== NUM_IMAGES) {
    throw new Error(`Spec has wrong image_prompts length: ${spec.image_prompts?.length}`);
  }
  console.log(`  theme: ${spec.theme}`);
  console.log(`  caption: ${spec.caption}`);

  console.log(`[2/5] Gemini image (candidates: ${IMAGE_MODEL_CANDIDATES.join(', ')}): generating ${NUM_IMAGES} images...`);
  const tmp = await mkdtemp(join(tmpdir(), 'reel-'));
  const imagePaths: string[] = [];
  // Free-tier image gen has tight RPM. Sleep between calls to spread load.
  const interImageSleep = Number(process.env.IMAGE_INTER_SLEEP_SEC || 8);
  for (let i = 0; i < spec.image_prompts.length; i++) {
    const prompt = spec.image_prompts[i]!;
    process.stdout.write(`  img ${i + 1}/${NUM_IMAGES}... `);
    const buf = await geminiImage(env, prompt);
    const path = join(tmp, `img-${i}.png`);
    await writeFile(path, buf);
    imagePaths.push(path);
    console.log(`${(buf.length / 1024).toFixed(0)}KB`);
    if (i < spec.image_prompts.length - 1 && interImageSleep > 0) {
      await new Promise((r) => setTimeout(r, interImageSleep * 1000));
    }
  }

  console.log(`[3/5] picking ambient audio...`);
  const audio = await pickAudio();
  console.log(`  audio: ${audio}`);

  if (!existsSync(OUTPUT_DIR)) await mkdir(OUTPUT_DIR, { recursive: true });
  const slug = spec.theme
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'cozy';
  const outPath = `${OUTPUT_DIR}/auto-${today}-${slug}.mp4`;

  console.log(`[4/5] ffmpeg compose → ${outPath}`);
  const cmd = buildFfmpegCmd(imagePaths, audio, outPath);
  execSync(shellEscape(cmd), { stdio: 'inherit' });

  if (args.skipPublish) {
    console.log(`[5/5] --skip-publish set, not enqueuing.`);
    console.log(`Done. MP4 at ${outPath}`);
    return;
  }

  console.log(`[5/5] enqueue reels_queue scheduled in ${args.scheduleIn}s...`);
  const description = `${spec.caption}\n\n${spec.hashtags}`;
  const scheduledAt = Math.floor(Date.now() / 1000) + args.scheduleIn;
  await d1Query(
    env,
    `INSERT INTO reels_queue (video_path, caption, hashtags, scheduled_at)
     VALUES (?, ?, ?, ?)`,
    [outPath, spec.caption, spec.hashtags, scheduledAt],
  );
  console.log(`Done. Caption preview:\n---\n${description}\n---`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
