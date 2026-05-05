// Pull pins from the selected Pinterest board into curated_photos as APPROVED.
// Token refresh handled in-script (D1 stores access + refresh + expiry).
//
// Run via GH Actions: workflow_dispatch on .github/workflows/sync-pinterest.yml.

import { d1Query, loadEnv, type ScriptEnv } from './lib';

const PINTEREST_TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token';
const PINTEREST_API_BASE = 'https://api.pinterest.com/v5';

interface OauthRow {
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  metadata: string | null;
}

interface PinMedia {
  media_type?: string;
  images?: Record<string, { url?: string; width?: number; height?: number }>;
}
interface Pin {
  id: string;
  description?: string;
  alt_text?: string;
  link?: string;
  board_id?: string;
  media?: PinMedia;
}

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const appId = process.env.PINTEREST_APP_ID;
  const appSecret = process.env.PINTEREST_APP_SECRET;
  if (!appId || !appSecret) throw new Error('Missing PINTEREST_APP_ID/SECRET');
  const basic = Buffer.from(`${appId}:${appSecret}`).toString('base64');
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', refreshToken);
  const res = await fetch(PINTEREST_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: params,
  });
  if (!res.ok) throw new Error(`Pinterest refresh ${res.status}: ${await res.text()}`);
  return (await res.json()) as { access_token: string; expires_in: number };
}

async function getValidAccessToken(env: ScriptEnv): Promise<{ token: string; boardId: string }> {
  const rows = await d1Query<OauthRow>(env, `SELECT access_token, refresh_token, expires_at, metadata FROM oauth_tokens WHERE provider='pinterest'`);
  const row = rows[0];
  if (!row) throw new Error('No Pinterest token in oauth_tokens. Visit /admin/pinterest/auth first.');
  const meta = row.metadata ? (JSON.parse(row.metadata) as { selected_board_id?: string }) : {};
  if (!meta.selected_board_id) throw new Error('No board selected. Pick one via /admin/pinterest first.');

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at && row.expires_at - 60 > now) {
    return { token: row.access_token, boardId: meta.selected_board_id };
  }
  if (!row.refresh_token) throw new Error('Token expired and no refresh_token. Re-authorize at /admin/pinterest/auth.');
  console.log(`Access token expired, refreshing...`);
  const fresh = await refreshAccessToken(row.refresh_token);
  await d1Query(
    env,
    `UPDATE oauth_tokens SET access_token=?, expires_at=?, updated_at=unixepoch() WHERE provider='pinterest'`,
    [fresh.access_token, now + fresh.expires_in],
  );
  return { token: fresh.access_token, boardId: meta.selected_board_id };
}

async function fetchAllPins(token: string, boardId: string): Promise<Pin[]> {
  const out: Pin[] = [];
  let bookmark: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${PINTEREST_API_BASE}/boards/${boardId}/pins`);
    url.searchParams.set('page_size', '100');
    if (bookmark) url.searchParams.set('bookmark', bookmark);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Pinterest pins ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { items?: Pin[]; bookmark?: string };
    out.push(...(json.items ?? []));
    if (!json.bookmark) break;
    bookmark = json.bookmark;
  }
  return out;
}

function pickBestImage(media?: PinMedia): { url: string; width: number; height: number } | null {
  if (!media || media.media_type === 'video' || !media.images) return null;
  // Prefer originals → 1200x → 600x → 400x → 150x150
  const order = ['originals', '1200x', '600x', '400x', '150x150', '750x'];
  for (const key of order) {
    const img = media.images[key];
    if (img?.url) return { url: img.url, width: img.width ?? 0, height: img.height ?? 0 };
  }
  // Fallback: first available
  for (const k of Object.keys(media.images)) {
    const img = media.images[k];
    if (img?.url) return { url: img.url, width: img.width ?? 0, height: img.height ?? 0 };
  }
  return null;
}

async function main() {
  const env = loadEnv();
  const { token, boardId } = await getValidAccessToken(env);
  console.log(`Fetching pins from board ${boardId}...`);
  const pins = await fetchAllPins(token, boardId);
  console.log(`Got ${pins.length} pins`);

  let inserted = 0;
  let skipped = 0;
  let unsuitable = 0;
  for (const pin of pins) {
    const img = pickBestImage(pin.media);
    if (!img) {
      unsuitable++;
      continue;
    }
    if (img.width && img.height && img.height < img.width) {
      // landscape — skip; we want portrait for FB carousel
      unsuitable++;
      continue;
    }
    const alt = pin.alt_text || pin.description || '';
    const result = await d1Query<{ id: number }>(
      env,
      `INSERT INTO curated_photos
         (source, source_id, source_url, image_url, thumb_url, photographer, alt, width, height, search_keyword, status, decided_at)
       VALUES ('pinterest', ?, ?, ?, ?, NULL, ?, ?, ?, 'pinterest-board', 'APPROVED', unixepoch())
       ON CONFLICT(source, source_id) DO NOTHING
       RETURNING id`,
      [pin.id, pin.link ?? null, img.url, img.url, alt, img.width || 0, img.height || 0],
    );
    if (result.length > 0) inserted++;
    else skipped++;
  }

  console.log(`\nInserted:    ${inserted} new APPROVED pins`);
  console.log(`Skipped:     ${skipped} already in pool`);
  console.log(`Unsuitable:  ${unsuitable} (video / landscape / no image)`);

  const counts = await d1Query<{ pending: number; approved: number; rejected: number }>(
    env,
    `SELECT
       SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status='APPROVED' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN status='REJECTED' THEN 1 ELSE 0 END) AS rejected
     FROM curated_photos`,
  );
  const c = counts[0];
  console.log(`\nPool now: ${c?.pending ?? 0} PENDING, ${c?.approved ?? 0} APPROVED, ${c?.rejected ?? 0} REJECTED`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
