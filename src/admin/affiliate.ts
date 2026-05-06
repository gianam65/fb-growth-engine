import type { Env } from '@/lib/env';
import { parseProductUrl, fetchShopeeItem, resolveShortLink } from '@/lib/shopee';
import { renderLayout } from '@/admin/layout';

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

function splitPrice(text: string | null): { price: string; performance: string } {
  if (!text) return { price: '', performance: '' };
  // Examples: "₫207.000 50k+ lượt bán" → ["₫207.000", "50k+ lượt bán"]
  const m = text.match(/^(₫[\d.,]+|\d[\d.,]*\s*₫|[\d.,]+\s*đ)?\s*(.*)$/i);
  if (m && m[1]) return { price: m[1].trim(), performance: (m[2] ?? '').trim() };
  return { price: text, performance: '' };
}

function buildAffiliatePage(key: string, products: ProductRow[], counts: Record<string, number>): string {
  const itemsHtml = products
    .map((p) => {
      const isPosted = p.used_count > 0;
      const badge = isPosted
        ? `<span class="badge posted" title="${p.last_used_at ? new Date(p.last_used_at * 1000).toLocaleString() : ''}">POSTED ${p.used_count}×</span>`
        : `<span class="badge unused">UNUSED</span>`;
      const { price, performance } = splitPrice(p.price);
      const titleEsc = escapeHtml(p.title ?? '(no title)');
      const searchData = `${titleEsc} ${escapeHtml(p.affiliate_url)}`;
      return `
      <div class="aff-row" data-search="${searchData}">
        <img src="${escapeHtml(p.image_url ?? '')}" loading="lazy" alt="">
        <div class="aff-info">
          <div class="aff-title">${titleEsc}</div>
          ${badge}
        </div>
        <div class="col">
          <div class="col-label">PRICE</div>
          <div class="col-val">${escapeHtml(price)}</div>
        </div>
        <div class="col">
          <div class="col-label">PERFORMANCE</div>
          <div class="col-val">${escapeHtml(performance)}</div>
        </div>
        <a class="shopee-btn" href="${escapeHtml(p.affiliate_url)}" target="_blank" rel="noopener">Shopee Link</a>
        <button class="aff-del" data-id="${p.id}" title="Remove">✕</button>
      </div>`;
    })
    .join('');

  // Tabs + filter pills shown inline above the list
  const content = `
  <div class="aff-toolbar">
    <div class="tabs">
      <a class="tab" href="/admin/add?key=${encodeURIComponent(key)}">Photos</a>
      <span class="tab active">Affiliate</span>
    </div>
    <div class="pills">
      <span class="pill active"><span class="dot" style="color:#1ad482"></span>UNUSED (${counts.unused ?? 0})</span>
      <span class="pill"><span class="dot" style="color:#7be88a"></span>APPROVED (${counts.approved ?? 0})</span>
      <span class="pill"><span class="dot" style="color:#7da9ff"></span>POSTED (${counts.used ?? 0})</span>
    </div>
  </div>

  <div class="aff-list">
    ${products.length === 0 ? '<div class="empty-state">No products. Use the Chrome extension on affiliate.shopee.vn to save products.</div>' : itemsHtml}
  </div>
  `;

  const extraStyle = `
  <style>
    .aff-toolbar { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; flex-wrap:wrap; }
    .aff-list { display:flex; flex-direction:column; gap:10px; }
    .aff-row { display:grid; grid-template-columns:80px 1.6fr 1fr 1fr auto auto; gap:14px; align-items:center; background:#0f1115; border:1px solid #1a1c20; border-radius:12px; padding:12px 14px; transition:border-color 0.12s, opacity 0.2s; }
    .aff-row:hover { border-color:#2a2c32; }
    .aff-row.deleting { opacity:0.25; }
    .aff-row > img { width:80px; height:80px; object-fit:cover; border-radius:9px; background:#0a0b0e; }
    .aff-info { min-width:0; display:flex; flex-direction:column; gap:6px; }
    .aff-title { font-size:14px; font-weight:600; line-height:1.35; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
    .col { min-width:0; }
    .col-label { font-size:10px; font-weight:700; color:#888; text-transform:uppercase; letter-spacing:0.06em; }
    .col-val { font-size:14px; font-weight:500; margin-top:2px; }
    .shopee-btn { display:inline-flex; align-items:center; justify-content:center; padding:9px 14px; background:#13151a; border:1px solid #2a2c32; border-radius:9px; color:#9eb8ff; font-size:12.5px; text-decoration:none; transition:background 0.12s, border-color 0.12s; white-space:nowrap; }
    .shopee-btn:hover { background:#191c22; border-color:#2f4170; color:#bcd0ff; }
    .aff-del { width:32px; height:32px; padding:0; border:0; background:transparent; color:#666; border-radius:8px; cursor:pointer; font-size:14px; }
    .aff-del:hover { background:rgba(255,138,138,0.12); color:#ff8a8a; }
    .empty-state { text-align:center; padding:40px 20px; color:#666; font-size:13.5px; background:#0f1115; border:1px dashed #1f2127; border-radius:12px; }
    @media (max-width: 980px) {
      .aff-row { grid-template-columns:64px 1fr auto; }
      .aff-row .col, .aff-row .shopee-btn { display:none; }
      .aff-row > img { width:64px; height:64px; }
    }
  </style>
  `;

  const bodyExtraScript = `
  (() => {
    const KEY = ${JSON.stringify(key)};
    document.querySelectorAll('button.aff-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = btn.dataset.id;
        if (!confirm('Delete product id=' + id + '?')) return;
        const row = btn.closest('.aff-row');
        row.classList.add('deleting');
        try {
          const res = await fetch('/admin/affiliate/' + id + '?key=' + encodeURIComponent(KEY), { method: 'DELETE' });
          if (!res.ok) throw new Error(await res.text());
          row.remove();
        } catch (err) {
          row.classList.remove('deleting');
          alert('Delete failed: ' + err.message);
        }
      });
    });
    document.addEventListener('cv-add', () => {
      alert('Affiliate products: open affiliate.shopee.vn and click 💾 CV in the Chrome extension.');
    });
  })();
  `;

  const pageActions = `
    <div class="stat-tiles">
      <div class="stat-tile active"><div class="stat-tile-label">UNUSED</div><div class="stat-tile-value">${counts.unused ?? 0}</div></div>
      <div class="stat-tile"><div class="stat-tile-label">APPROVED</div><div class="stat-tile-value">${counts.approved ?? 0}</div></div>
      <div class="stat-tile"><div class="stat-tile-label">POSTED</div><div class="stat-tile-value">${counts.used ?? 0}</div></div>
    </div>`;

  return renderLayout({
    key,
    currentPage: 'affiliate',
    pageTitle: 'Affiliate Pool',
    pageSubtitle: 'Shopee products saved via the Chrome extension.',
    pageActions,
    content: extraStyle + content,
    searchPlaceholder: 'Search products...',
    bodyExtraScript,
  });
}

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
      buildAffiliatePage(env.ADMIN_TOKEN, products.results ?? [], {
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
