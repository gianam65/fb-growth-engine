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
// Image gen via Pollinations.ai — fully free, no key, FLUX backend.
// Gemini Flash Image is paid-only on free tier accounts (limit=0).
const IMAGE_PROVIDER = process.env.IMAGE_PROVIDER || 'pollinations';
const POLLINATIONS_MODEL = process.env.POLLINATIONS_MODEL || 'flux';
const NUM_IMAGES = 5;
const SECONDS_PER_IMAGE = 3;
const XFADE_DURATION = 0.6;
const AUDIO_DIR = 'assets/audio';
const OUTPUT_DIR = 'reels-source';

// Style presets — these get appended to every Gemini-generated scene description
// before sending to FLUX. Locks aesthetic; only the scene varies day to day.
const STYLE_PRESETS: Record<string, { suffix: string; vibe_hint: string }> = {
  'asian-cozy': {
    suffix:
      'modern asian apartment cozy aesthetic, xiaohongshu home decor style, douyin cozy room, lots of indoor plants, monstera fiddle leaf snake plant, hanging vines, light oak wood floor, beige neutral walls, white minimalist furniture, rattan chair, rice paper pendant lamp, paper lantern, warm tungsten lighting, golden hour soft natural light from large window, biophilic interior, lush greenery, lived-in cozy vibe, 35mm film, Kodak Portra 400, photorealistic, sharp focus, magazine quality, no people, no text, no logos',
    vibe_hint:
      'modern Asian apartment with rice paper lamps, lots of plants (monstera, fiddle leaf), wood floor, beige walls, large window, white desk',
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

const SPEC_PROMPT = `You curate one daily Reel concept for a Vietnamese home decor Facebook page named "Cozy Vibe".
The aesthetic is FIXED to: ${STYLE.vibe_hint}.
You do NOT need to mention aesthetic/style/film-stock/lighting words — those are appended automatically. Focus ONLY on what objects appear and where the camera is.

Output JSON with these fields:

- theme: short English slug for today (e.g., "morning-plant-corner", "evening-desk-glow", "rainy-window-monstera"). Be specific.

- scene_descriptions: array of EXACTLY ${NUM_IMAGES} distinct one-line scene descriptions in English. Each line MUST:
  * be a different camera angle (e.g., wide room shot, close-up of a corner detail, over-the-shoulder, top-down flatlay, low-angle floor view)
  * name 3-6 specific objects in the frame (e.g., "monstera leaves catching window light, white ceramic mug on side table, linen curtain swaying")
  * stay coherent with the day's theme — same room/space, different angles
  * AVOID style words like "cozy", "cinematic", "film grain", "warm" — those auto-append later
  * AVOID people, faces, hands; silhouettes far away OK only if needed

- caption: 1-2 short sentences in casual Vietnamese, soothing/evocative, not salesy. No emoji at the start.

- hashtags: single line of 8-10 hashtags, mix Vietnamese + English (e.g., #cozyvibe #nhaxinh #decor #aestheticroom #xiaohongshu #lofi #plantparent).

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
  // Free, no API key. Docs: https://github.com/pollinations/pollinations
  // GET https://image.pollinations.ai/prompt/<text>?width=1080&height=1920&model=flux&seed=<n>&nologo=true
  const params = new URLSearchParams({
    width: '1080',
    height: '1920',
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

async function genImage(_env: ScriptEnv, prompt: string, seed: number): Promise<Buffer> {
  if (IMAGE_PROVIDER === 'pollinations') return pollinationsImage(prompt, seed);
  throw new Error(`Unknown IMAGE_PROVIDER=${IMAGE_PROVIDER}`);
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

function parseArgs(): { scheduleIn: number; skipPublish: boolean; preview: number } {
  let scheduleIn = 600;
  let skipPublish = false;
  let preview = 0;
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'schedule-in' && v) scheduleIn = Number(v);
    else if (k === 'skip-publish') skipPublish = true;
    else if (k === 'preview') preview = v ? Number(v) : 2;
  }
  return { scheduleIn, skipPublish, preview };
}

async function main() {
  const env = loadEnv();
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);

  console.log(`[1/5] Gemini text (${TEXT_MODEL}, style=${STYLE_PRESET}): generating reel spec...`);
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
  console.log(`[2/5] Image gen (${IMAGE_PROVIDER}/${POLLINATIONS_MODEL}): generating ${numToGen} image(s)...`);
  const tmp = await mkdtemp(join(tmpdir(), 'reel-'));
  const imagePaths: string[] = [];
  const interImageSleep = Number(process.env.IMAGE_INTER_SLEEP_SEC || 2);
  const seedBase = Math.floor(Date.now() / 1000) % 1_000_000;
  for (let i = 0; i < numToGen; i++) {
    const scene = spec.scene_descriptions[i]!;
    const prompt = `${scene}, ${STYLE.suffix}`;
    process.stdout.write(`  img ${i + 1}/${numToGen}... `);
    const t0 = Date.now();
    const buf = await genImage(env, prompt, seedBase + i);
    const path = join(tmp, `img-${i}.png`);
    await writeFile(path, buf);
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
