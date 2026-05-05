import type { Env } from '@/lib/env';

// Single-page admin UI to review PENDING curated_photos and mark
// APPROVED / REJECTED. Auth: ?key=<ADMIN_TOKEN> in URL.

interface CuratedRow {
  id: number;
  source: string;
  source_id: string;
  source_url: string | null;
  image_url: string;
  thumb_url: string | null;
  photographer: string | null;
  photographer_url: string | null;
  alt: string | null;
  search_keyword: string | null;
  width: number;
  height: number;
}

interface Counts {
  pending: number;
  approved: number;
  rejected: number;
}

async function counts(env: Env): Promise<Counts> {
  const r = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status='APPROVED' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN status='REJECTED' THEN 1 ELSE 0 END) AS rejected
     FROM curated_photos`,
  ).first<{ pending: number | null; approved: number | null; rejected: number | null }>();
  return {
    pending: r?.pending ?? 0,
    approved: r?.approved ?? 0,
    rejected: r?.rejected ?? 0,
  };
}

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 });
}

function checkAuth(url: URL, env: Env): boolean {
  const key = url.searchParams.get('key');
  return !!key && !!env.ADMIN_TOKEN && key === env.ADMIN_TOKEN;
}

const HTML = (key: string) => `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Curate photos</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #111; color: #eee; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { min-height: 100vh; padding: 12px; padding-bottom: env(safe-area-inset-bottom); }
  .stats { display:flex; gap:12px; font-size:14px; margin-bottom:12px; opacity:.85; }
  .stats span { padding:4px 10px; border-radius:6px; background:#222; }
  .stats .a { color:#7be88a; }
  .stats .r { color:#ff8a8a; }
  .card { background:#1c1c1c; border-radius:12px; overflow:hidden; max-width:480px; margin:0 auto; }
  .img-wrap { aspect-ratio: 4/5; background:#000; display:flex; align-items:center; justify-content:center; }
  .img-wrap img { width:100%; height:100%; object-fit:cover; display:block; }
  .meta { padding: 12px 14px; font-size:13px; line-height:1.45; }
  .meta .alt { font-size:14px; color:#fff; margin-bottom:6px; }
  .meta .by { color:#aaa; font-size:12px; }
  .meta a { color:#79b8ff; }
  .actions { display:flex; gap:8px; padding: 0 12px 12px; }
  button { flex:1; padding:14px 0; border:0; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; color:#000; }
  .reject { background:#ff5e5e; color:#fff; }
  .skip { background:#444; color:#eee; }
  .approve { background:#3ae07f; }
  .empty { text-align:center; padding: 60px 20px; opacity:.7; }
  .ham { font-size:11px; color:#666; margin-top:8px; }
  kbd { background:#333; padding:1px 5px; border-radius:3px; font-family:ui-monospace,Menlo,monospace; font-size:11px; }
</style>
</head>
<body>
<div class="stats" id="stats">…</div>
<div id="content" class="empty">Loading…</div>
<script>
(() => {
  const KEY = ${JSON.stringify(key)};
  const $stats = document.getElementById('stats');
  const $content = document.getElementById('content');
  let current = null;

  async function api(path, opts) {
    const url = path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY);
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(res.status + ' ' + (await res.text()));
    return res.json();
  }

  function renderStats(c) {
    $stats.innerHTML = ''
      + '<span>PENDING: <b>' + c.pending + '</b></span>'
      + '<span class="a">APPROVED: <b>' + c.approved + '</b></span>'
      + '<span class="r">REJECTED: <b>' + c.rejected + '</b></span>';
  }

  function renderPhoto(p) {
    if (!p) {
      $content.className = 'empty';
      $content.innerHTML = 'No more PENDING photos.<div class="ham">Run <kbd>npm run script:populate-pool</kbd> to fetch more candidates.</div>';
      return;
    }
    $content.className = 'card';
    const alt = p.alt || '<i>(no alt)</i>';
    const by = p.photographer
      ? '📷 ' + (p.photographer_url ? '<a href="'+p.photographer_url+'" target="_blank" rel="noopener">' + p.photographer + '</a>' : p.photographer) + ' (' + p.source + ')'
      : '';
    const kw = p.search_keyword ? '<span style="opacity:.6">via "' + p.search_keyword + '"</span>' : '';
    const dim = p.width + '×' + p.height;
    $content.innerHTML = ''
      + '<div class="img-wrap"><img loading="eager" src="' + p.image_url + '" alt=""></div>'
      + '<div class="meta">'
      +   '<div class="alt">' + alt + '</div>'
      +   '<div class="by">' + by + ' · ' + dim + ' · ' + kw + '</div>'
      + '</div>'
      + '<div class="actions">'
      +   '<button class="reject" data-d="REJECTED">Reject</button>'
      +   '<button class="skip" data-d="SKIP">Skip</button>'
      +   '<button class="approve" data-d="APPROVED">Approve</button>'
      + '</div>'
      + '<div class="ham" style="text-align:center;padding-bottom:10px">A=approve · R=reject · S=skip</div>';
    for (const b of $content.querySelectorAll('button')) {
      b.addEventListener('click', () => decide(p.id, b.dataset.d));
    }
  }

  async function decide(id, decision) {
    if (decision === 'SKIP') {
      next();
      return;
    }
    try {
      await api('/admin/curate/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: decision }),
      });
      next();
    } catch (err) {
      alert('Decide failed: ' + err.message);
    }
  }

  async function next() {
    try {
      const data = await api('/admin/curate/next');
      renderStats(data.counts);
      current = data.photo;
      renderPhoto(data.photo);
    } catch (err) {
      $content.innerHTML = '<div class="empty">Error: ' + err.message + '</div>';
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!current) return;
    if (e.key === 'a' || e.key === 'A') decide(current.id, 'APPROVED');
    else if (e.key === 'r' || e.key === 'R') decide(current.id, 'REJECTED');
    else if (e.key === 's' || e.key === 'S') decide(current.id, 'SKIP');
  });

  next();
})();
</script>
</body>
</html>
`;

export async function handleAdminCurate(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!checkAuth(url, env)) return unauthorized();
  const sub = url.pathname.replace(/^\/admin\/curate/, '') || '/';

  if (req.method === 'GET' && sub === '/') {
    return new Response(HTML(env.ADMIN_TOKEN), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if (req.method === 'GET' && sub === '/next') {
    const photo = await env.DB.prepare(
      `SELECT id, source, source_id, source_url, image_url, thumb_url, photographer,
              photographer_url, alt, search_keyword, width, height
         FROM curated_photos
         WHERE status = 'PENDING'
         ORDER BY id ASC
         LIMIT 1`,
    ).first<CuratedRow>();
    return Response.json({ photo: photo ?? null, counts: await counts(env) });
  }

  if (req.method === 'POST' && sub === '/decide') {
    const body = await req.json<{ id?: number; status?: string }>();
    if (!body.id || (body.status !== 'APPROVED' && body.status !== 'REJECTED')) {
      return new Response('bad payload', { status: 400 });
    }
    await env.DB.prepare(
      `UPDATE curated_photos
         SET status = ?, decided_at = unixepoch()
         WHERE id = ?`,
    )
      .bind(body.status, body.id)
      .run();
    return Response.json({ ok: true, counts: await counts(env) });
  }

  return new Response('not found', { status: 404 });
}
