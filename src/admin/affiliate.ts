import type { Env } from '@/lib/env';
import { parseProductUrl, fetchShopeeItem, resolveShortLink } from '@/lib/shopee';

// Affiliate product pool — populated by the Chrome extension and consumed by
// curate-post.ts (one product per FB post, posted as a comment).
//
// Routes:
//   GET    /admin/affiliate           — HTML status (?key=ADMIN_TOKEN)
//   POST   /admin/affiliate/url       — JSON, Authorization: Bearer ADMIN_TOKEN
//                                        used by extension; CORS-permissive.
//   OPTIONS /admin/affiliate/url      — CORS preflight

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

interface ProductRow {
  id: number;
  title: string | null;
  price: string | null;
  image_url: string | null;
  affiliate_url: string;
  source_url: string | null;
  status: string;
  used_count: number;
  last_used_at: number | null;
  inserted_at: number;
}

function checkAdminQuery(url: URL, env: Env): boolean {
  const key = url.searchParams.get('key');
  return !!key && !!env.ADMIN_TOKEN && key === env.ADMIN_TOKEN;
}

function checkAdminBearer(req: Request, env: Env): boolean {
  const auth = req.headers.get('Authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  return !!m && !!env.ADMIN_TOKEN && m[1] === env.ADMIN_TOKEN;
}

const STATUS_HTML = (key: string, products: ProductRow[], counts: Record<string, number>) => {
  const rows = products
    .map((p) => {
      const usedBadge = p.used_count > 0
        ? `<span class="badge ok" title="${p.last_used_at ? new Date(p.last_used_at * 1000).toLocaleString() : ''}">✅ Posted ${p.used_count}×</span>`
        : `<span class="badge gray">○ Unused</span>`;
      const statusBadge = p.status !== 'APPROVED' ? `<span class="badge red">${p.status}</span>` : '';
      return `
      <div class="item" data-id="${p.id}">
        <img src="${escapeHtml(p.image_url ?? '')}" loading="lazy" alt="">
        <div class="item-body">
          <div class="title">${escapeHtml(p.title ?? '(no title)')}</div>
          <div class="meta">${usedBadge} ${statusBadge} ${p.price ? `<span class="muted">${escapeHtml(p.price)}</span>` : ''}</div>
          <a class="link" href="${escapeHtml(p.affiliate_url)}" target="_blank" rel="noopener">${escapeHtml(p.affiliate_url)}</a>
        </div>
        <button class="del-btn" data-id="${p.id}" title="Remove">✕</button>
      </div>`;
    })
    .join('');
  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Affiliate pool</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin:0; background:#0e0e10; color:#eaeaea; font-family:-apple-system,system-ui,"Segoe UI",sans-serif; }
  body { min-height:100vh; padding:20px 16px 60px; max-width:880px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; font-weight:700; letter-spacing:-0.01em; }
  .nav { display:flex; gap:6px; margin:8px 0 18px; flex-wrap:wrap; }
  .nav a { color:#9eb8ff; text-decoration:none; font-size:13px; padding:6px 12px; border-radius:8px; background:#1c1c20; border:1px solid #2a2a30; }
  .nav a.active { background:#2d2d35; color:#fff; border-color:#3a3a44; }
  .nav a:hover { background:#26262c; }
  .stats { display:flex; gap:8px; margin:14px 0 22px; flex-wrap:wrap; }
  .stats span { padding:6px 12px; border-radius:999px; background:#1c1c20; font-size:12px; border:1px solid #2a2a30; }
  .stats b { color:#fff; font-weight:600; }
  .stats .a { color:#7be88a; }
  h2 { font-size:15px; margin:24px 0 12px; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; }
  .item { display:flex; gap:12px; align-items:center; background:#1a1a1f; border:1px solid #2a2a30; border-radius:12px; padding:10px 12px; margin-bottom:8px; position:relative; transition:opacity 0.2s; }
  .item img { width:64px; height:64px; object-fit:cover; border-radius:8px; background:#0a0a0c; flex-shrink:0; }
  .item-body { flex:1; min-width:0; }
  .title { font-weight:600; font-size:14px; margin-bottom:4px; line-height:1.35; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; }
  .meta { font-size:12px; margin:4px 0; display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .muted { color:#888; }
  .link { color:#9eb8ff; font-size:11px; text-decoration:none; word-break:break-all; opacity:0.7; }
  .link:hover { opacity:1; }
  .badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11px; font-weight:600; }
  .badge.ok { background:rgba(58,224,127,0.15); color:#7be88a; }
  .badge.gray { background:#26262c; color:#aaa; }
  .badge.red { background:rgba(255,138,138,0.15); color:#ff8a8a; }
  button.del-btn { position:absolute; top:10px; right:10px; width:28px; height:28px; padding:0; border:0; border-radius:50%; background:transparent; color:#666; cursor:pointer; font-size:14px; transition:background 0.15s, color 0.15s; flex-shrink:0; }
  button.del-btn:hover { background:rgba(255,138,138,0.1); color:#ff8a8a; }
  .item.deleting { opacity:0.3; }
  .empty { text-align:center; padding:40px 20px; color:#666; font-size:14px; background:#1a1a1f; border:1px dashed #2a2a30; border-radius:12px; }
</style></head><body>

<h1>Affiliate pool</h1>
<div class="nav">
  <a href="/admin/add?key=${encodeURIComponent(key)}">🖼 Photos</a>
  <a class="active" href="/admin/affiliate?key=${encodeURIComponent(key)}">🛍 Affiliate</a>
</div>

<div class="stats">
  <span class="a">UNUSED <b>${counts.unused}</b></span>
  <span>APPROVED <b>${counts.approved}</b></span>
  <span>POSTED <b>${counts.used}</b></span>
  ${(counts.other ?? 0) > 0 ? `<span>OTHER <b>${counts.other}</b></span>` : ''}
</div>

<h2>Pool (${products.length} products)</h2>
${products.length === 0 ? '<div class="empty">No products yet. Use the Chrome extension on affiliate.shopee.vn to save products.</div>' : rows}

<script>
const KEY = ${JSON.stringify(key)};
document.querySelectorAll('button.del-btn').forEach((btn) => {
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.id;
    if (!confirm('Delete product id=' + id + '?')) return;
    const item = btn.closest('.item');
    item.classList.add('deleting');
    try {
      const res = await fetch('/admin/affiliate/' + id + '?key=' + encodeURIComponent(KEY), { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      item.remove();
    } catch (err) {
      item.classList.remove('deleting');
      alert('Delete failed: ' + err.message);
    }
  });
});
</script>
</body></html>`;
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export async function handleAdminAffiliate(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const sub = url.pathname.replace(/^\/admin\/affiliate/, '') || '/';

  // CORS preflight for extension
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // POST /url — extension push (Bearer auth)
  if (req.method === 'POST' && sub === '/url') {
    if (!checkAdminBearer(req, env)) {
      return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
    }
    const body = await req.json<{
      affiliate_url?: string;
      title?: string;
      price?: string;
      image_url?: string;
      source_url?: string;
      product_url?: string;
      source_id?: string;
      category?: string;
      // From extension's pre-fetch (when it has Shopee session cookies):
      media_urls?: string[];
      video_url?: string | null;
      shopee_shopid?: string;
      shopee_itemid?: string;
      media_fetch_error?: string;
    }>();
    const aff = body.affiliate_url?.trim();
    if (!aff || !/^https?:\/\//i.test(aff)) {
      return Response.json({ error: 'invalid affiliate_url' }, { status: 400, headers: CORS_HEADERS });
    }
    const existing = await env.DB.prepare(
      `SELECT id FROM affiliate_products WHERE affiliate_url = ?`,
    )
      .bind(aff)
      .first<{ id: number }>();
    if (existing) {
      return Response.json({ ok: true, duplicate: true, id: existing.id }, { headers: CORS_HEADERS });
    }

    // Resolve product URL: prefer explicit product_url from extension; else
    // try to derive from source_url; else resolve s.shopee.vn short link.
    const debug: Record<string, unknown> = {};
    let productUrl: string | null = body.product_url ?? null;
    let parsed = productUrl ? parseProductUrl(productUrl) : null;
    if (!parsed && body.source_url) {
      // Don't use listing-page source_url as product URL — only if it has shop/item ids.
      const sourceParsed = parseProductUrl(body.source_url);
      if (sourceParsed) { productUrl = body.source_url; parsed = sourceParsed; }
    }
    if (!parsed && /s\.shopee\.vn|shope\.ee/i.test(aff)) {
      debug.attempted_resolve = aff;
      const resolved = await resolveShortLink(aff);
      debug.resolved = resolved;
      if (resolved) {
        productUrl = resolved;
        parsed = parseProductUrl(resolved);
      }
    }
    debug.parsed = parsed;

    // Use media from extension (if it pre-fetched with user's Shopee session)
    const extensionMedia = Array.isArray(body.media_urls) && body.media_urls.length > 0;
    const mediaUrlsJson = extensionMedia ? JSON.stringify(body.media_urls) : null;
    const finalShopid = body.shopee_shopid ?? parsed?.shopid ?? null;
    const finalItemid = body.shopee_itemid ?? parsed?.itemid ?? null;

    const result = await env.DB.prepare(
      `INSERT INTO affiliate_products
         (source, source_id, title, price, image_url, affiliate_url, source_url, category, status,
          product_url, shopee_shopid, shopee_itemid, media_urls, video_url, media_fetched_at, media_fetch_error)
       VALUES ('shopee', ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
      .bind(
        body.source_id ?? null,
        body.title ?? null,
        body.price ?? null,
        body.image_url ?? null,
        aff,
        body.source_url ?? null,
        body.category ?? null,
        productUrl,
        finalShopid,
        finalItemid,
        mediaUrlsJson,
        body.video_url ?? null,
        extensionMedia ? Math.floor(Date.now() / 1000) : null,
        body.media_fetch_error ?? null,
      )
      .first<{ id: number }>();

    // If extension didn't provide media (or only partial), and we have shopid+itemid,
    // fall back to server-side fetch (works only if Shopee doesn't gate on cookies).
    let mediaResult: { images: number; has_video: boolean; source: string } | null = extensionMedia
      ? { images: body.media_urls!.length, has_video: !!body.video_url, source: 'extension' }
      : null;
    if (!mediaResult && parsed) {
      try {
        const media = await fetchShopeeItem(parsed.shopid, parsed.itemid);
        if (media && media.image_urls.length > 0) {
          await env.DB.prepare(
            `UPDATE affiliate_products
               SET title = COALESCE(NULLIF(title, ''), ?),
                   media_urls = ?,
                   video_url = ?,
                   media_fetched_at = unixepoch(),
                   media_fetch_error = NULL
             WHERE id = ?`,
          )
            .bind(media.title, JSON.stringify(media.image_urls), media.video_url, result?.id)
            .run();
          mediaResult = { images: media.image_urls.length, has_video: !!media.video_url, source: 'worker' };
        } else {
          await env.DB.prepare(
            `UPDATE affiliate_products SET media_fetch_error = 'item API returned null/empty' WHERE id = ?`,
          ).bind(result?.id).run();
        }
      } catch (err) {
        await env.DB.prepare(
          `UPDATE affiliate_products SET media_fetch_error = ? WHERE id = ?`,
        ).bind(String(err).slice(0, 300), result?.id).run();
      }
    }

    return Response.json(
      { ok: true, id: result?.id, product_url: productUrl, parsed, media: mediaResult, debug },
      { headers: CORS_HEADERS },
    );
  }

  // DELETE /:id — remove a product (query auth)
  const deleteMatch = sub.match(/^\/(\d+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    if (!checkAdminQuery(url, env)) return new Response('Unauthorized', { status: 401 });
    const id = Number(deleteMatch[1]);
    const r = await env.DB.prepare(`DELETE FROM affiliate_products WHERE id = ?`).bind(id).run();
    return Response.json({ ok: true, changes: r.meta.changes ?? 0 });
  }

  // GET / — status page (query auth)
  if (req.method === 'GET' && sub === '/') {
    if (!checkAdminQuery(url, env)) return new Response('Unauthorized', { status: 401 });

    const counts = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status='APPROVED' AND used_count = 0 THEN 1 ELSE 0 END) AS unused,
         SUM(CASE WHEN status='APPROVED' THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN used_count > 0 THEN 1 ELSE 0 END) AS used,
         SUM(CASE WHEN status NOT IN ('APPROVED') THEN 1 ELSE 0 END) AS other
       FROM affiliate_products`,
    ).first<{ unused: number | null; approved: number | null; used: number | null; other: number | null }>();
    const products = await env.DB.prepare(
      `SELECT id, title, price, image_url, affiliate_url, source_url, status, used_count, last_used_at, inserted_at
         FROM affiliate_products
         ORDER BY inserted_at DESC
         LIMIT 50`,
    ).all<ProductRow>();
    return new Response(
      STATUS_HTML(env.ADMIN_TOKEN, products.results ?? [], {
        unused: counts?.unused ?? 0,
        approved: counts?.approved ?? 0,
        used: counts?.used ?? 0,
        other: counts?.other ?? 0,
      }),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  return new Response('not found', { status: 404 });
}
