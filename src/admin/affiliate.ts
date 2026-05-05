import type { Env } from '@/lib/env';

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
    .map(
      (p) => `
      <tr>
        <td><img src="${p.image_url ?? ''}" alt=""></td>
        <td>
          <div class="title">${escapeHtml(p.title ?? '(no title)')}</div>
          <div class="meta">${escapeHtml(p.price ?? '')} ${p.status !== 'APPROVED' ? '· ' + p.status : ''} · used: ${p.used_count}${p.last_used_at ? ' · last: ' + new Date(p.last_used_at * 1000).toLocaleDateString() : ''}</div>
          <div class="link"><a href="${p.affiliate_url}" target="_blank" rel="noopener">${p.affiliate_url}</a></div>
        </td>
      </tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Affiliate pool</title>
<style>
  body { font-family: system-ui,-apple-system,sans-serif; max-width:780px; margin:30px auto; padding:0 16px; color:#222; }
  h1 { font-size:22px; margin:0 0 8px; }
  .stats { display:flex; gap:10px; margin:14px 0; flex-wrap:wrap; }
  .stats span { padding:5px 10px; border-radius:6px; background:#eee; font-size:13px; }
  table { width:100%; border-collapse:collapse; }
  td { vertical-align:top; padding:10px 6px; border-bottom:1px solid #eee; font-size:13px; }
  td:first-child { width:80px; }
  img { width:72px; height:72px; object-fit:cover; border-radius:6px; background:#f0f0f0; }
  .title { font-weight:600; font-size:14px; margin-bottom:4px; }
  .meta { color:#888; font-size:12px; margin-bottom:4px; }
  .link a { color:#79b8ff; word-break:break-all; }
  .nav a { color:#79b8ff; margin-right:14px; font-size:13px; }
</style></head><body>
<h1>Affiliate pool</h1>
<div class="nav">
  <a href="/admin/curate?key=${encodeURIComponent(key)}">Curate photos</a>
  <a href="/admin/add?key=${encodeURIComponent(key)}">Add photo URL</a>
</div>
<div class="stats">
  <span>APPROVED unused: <b>${counts.unused}</b></span>
  <span>APPROVED total: <b>${counts.approved}</b></span>
  <span>USED: <b>${counts.used}</b></span>
  <span>OTHER: <b>${counts.other}</b></span>
</div>
${products.length === 0 ? '<p>No products yet. Use the Chrome extension to save products from affiliate.shopee.vn.</p>' : '<table>' + rows + '</table>'}
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
      source_id?: string;
      category?: string;
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
    const result = await env.DB.prepare(
      `INSERT INTO affiliate_products
         (source, source_id, title, price, image_url, affiliate_url, source_url, category, status)
       VALUES ('shopee', ?, ?, ?, ?, ?, ?, ?, 'APPROVED')
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
      )
      .first<{ id: number }>();
    return Response.json({ ok: true, id: result?.id }, { headers: CORS_HEADERS });
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
