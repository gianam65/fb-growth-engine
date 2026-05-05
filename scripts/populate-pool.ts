// Populate curated_photos table with PENDING candidates from Pexels.
// Run manually whenever the pool of APPROVED photos runs low.
//
// Curated keyword list targets Asian-cozy/Xiaohongshu-Douyin aesthetic.
// Hard filter rejects obvious non-fits (exterior, faces, etc.) before insert.
//
// Usage:
//   PEXELS_API_KEY=... CF_*=... npx tsx scripts/populate-pool.ts

import { d1Query, loadEnv } from './lib';

const KEYWORDS = [
  'korean apartment cozy',
  'japanese small apartment interior',
  'muji style bedroom',
  'small studio apartment plants',
  'minimalist apartment desk plants',
  'study desk warm lamp',
  'cozy bedroom plants warm light',
  'asian apartment aesthetic',
  'minimalist desk monitor warm',
  'rice paper lamp room',
  'cozy reading corner books warm',
  'bedroom warm lamp night',
  'workspace plants laptop warm',
  'small bedroom city window',
  'living room plants warm light',
];

const PER_PAGE = 30;

// Reject if alt-text contains any of these (likely non-fits).
const REJECT_PATTERNS = [
  /\bfacade\b/i,
  /\bexterior\b/i,
  /\b(person|woman|man|girl|boy|model|portrait|silhouette|face)\b/i,
  /\b(ferry|terminal|station|airport|metro|subway|bus)\b/i,
  /\b(restaurant|cafe|hotel|lobby)\b/i,
  /\b(beach|forest|mountain|landscape|nature)\b/i,
  /\b(food|dish|meal|recipe|drink|coffee cup close)\b/i,
  /\bskyscraper|building from outside\b/i,
  /\bproduct shot\b/i,
];

// At least one of these should appear (or alt is null/empty — let user judge).
const POSITIVE_HINTS = [
  /\b(interior|room|bedroom|living|study|workspace|desk|apartment|cozy|cozy home)\b/i,
  /\b(plant|monstera|fiddle|pothos|indoor)\b/i,
  /\b(lamp|light|warm|tungsten|golden|sunset)\b/i,
  /\b(decor|aesthetic|minimalist|scandinavian|japandi|muji)\b/i,
  /\bshelf|bookshelf|book stack|reading\b/i,
];

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  photographer: string;
  photographer_url: string;
  alt: string;
  url?: string;
  src: { large2x?: string; large?: string; original?: string; medium?: string; small?: string };
}

async function pexelsSearch(apiKey: string, query: string): Promise<PexelsPhoto[]> {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&size=large&per_page=${PER_PAGE}`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Pexels ${res.status} (${query}): ${await res.text()}`);
  const json = (await res.json()) as { photos?: PexelsPhoto[] };
  return json.photos ?? [];
}

function passFilter(p: PexelsPhoto): { keep: boolean; reason: string } {
  if (p.height <= p.width) return { keep: false, reason: 'landscape' };
  if (p.width < 1080 || p.height < 1280) return { keep: false, reason: 'too small' };
  const alt = p.alt ?? '';
  for (const re of REJECT_PATTERNS) {
    if (re.test(alt)) return { keep: false, reason: `reject: ${re}` };
  }
  // If alt is empty, keep — let user decide visually
  if (!alt.trim()) return { keep: true, reason: 'no alt — user judges' };
  // If alt has any positive hint, keep
  for (const re of POSITIVE_HINTS) {
    if (re.test(alt)) return { keep: true, reason: `match: ${re}` };
  }
  return { keep: false, reason: 'no positive hint' };
}

async function main() {
  const env = loadEnv();
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (!pexelsKey) throw new Error('Missing PEXELS_API_KEY');

  console.log(`Searching ${KEYWORDS.length} keywords on Pexels (${PER_PAGE}/query)...`);
  const all = new Map<string, { photo: PexelsPhoto; keyword: string }>();
  for (const kw of KEYWORDS) {
    process.stdout.write(`  "${kw}"... `);
    try {
      const photos = await pexelsSearch(pexelsKey, kw);
      let added = 0;
      for (const p of photos) {
        const key = `pexels:${p.id}`;
        if (!all.has(key)) {
          all.set(key, { photo: p, keyword: kw });
          added++;
        }
      }
      console.log(`${photos.length} (+${added} new)`);
    } catch (err) {
      console.log(`ERROR: ${String(err).slice(0, 100)}`);
    }
    // tiny gap to be polite
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`\nTotal unique candidates: ${all.size}`);

  let kept = 0;
  let rejected = 0;
  let inserted = 0;
  let skipped = 0;
  for (const { photo, keyword } of all.values()) {
    const f = passFilter(photo);
    if (!f.keep) {
      rejected++;
      continue;
    }
    kept++;
    const imageUrl = photo.src.large2x || photo.src.large || photo.src.original;
    if (!imageUrl) continue;
    try {
      const result = await d1Query<{ id: number }>(
        env,
        `INSERT INTO curated_photos
          (source, source_id, source_url, image_url, thumb_url, photographer, photographer_url, alt, width, height, search_keyword)
         VALUES ('pexels', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, source_id) DO NOTHING
         RETURNING id`,
        [
          String(photo.id),
          photo.url ?? null,
          imageUrl,
          photo.src.medium ?? photo.src.small ?? imageUrl,
          photo.photographer,
          photo.photographer_url,
          photo.alt ?? null,
          photo.width,
          photo.height,
          keyword,
        ],
      );
      if (result.length > 0) inserted++;
      else skipped++;
    } catch (err) {
      console.error(`  insert failed for ${photo.id}: ${String(err).slice(0, 100)}`);
    }
  }

  console.log(`\nFiltered:    ${kept} kept, ${rejected} rejected`);
  console.log(`Inserted:    ${inserted} new, ${skipped} already in pool`);

  const pending = await d1Query<{ c: number }>(env, `SELECT COUNT(*) as c FROM curated_photos WHERE status='PENDING'`);
  const approved = await d1Query<{ c: number }>(env, `SELECT COUNT(*) as c FROM curated_photos WHERE status='APPROVED'`);
  console.log(`Pool now:    ${pending[0]?.c ?? 0} PENDING, ${approved[0]?.c ?? 0} APPROVED`);
  console.log(`\nNext: open the admin UI to review PENDING photos.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
