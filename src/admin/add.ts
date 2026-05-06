import type { Env } from '@/lib/env';

// Photos pool admin — paste image URLs from any source (Pinterest, IG, etc.)
// + view all approved photos with posted/unused status + delete.
//
// Routes (require ?key=ADMIN_TOKEN):
//   GET    /admin/add        — HTML page (form + list)
//   POST   /admin/add/url    — JSON, add image to pool
//   DELETE /admin/add/:id    — remove a photo

interface PhotoRow {
  id: number;
  source: string;
  image_url: string;
  thumb_url: string | null;
  alt: string | null;
  set_id: string | null;
  set_order: number;
  used_count: number;
  last_used_at: number | null;
  inserted_at: number;
}

function checkAuth(url: URL, env: Env): boolean {
  const key = url.searchParams.get('key');
  return !!key && !!env.ADMIN_TOKEN && key === env.ADMIN_TOKEN;
}

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const PAGE_HTML = (key: string, photos: PhotoRow[], counts: Record<string, number>) => {
  const groups = new Map<string, PhotoRow[]>();
  for (const p of photos) {
    const k = p.set_id || `singleton-${p.id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }

  const setsHtml = [...groups.entries()]
    .map(([, items]) => {
      const used = items.some((i) => i.used_count > 0);
      const lastUsed = items.find((i) => i.last_used_at)?.last_used_at;
      const badge = used
        ? `<span class="badge ok" title="${lastUsed ? new Date(lastUsed * 1000).toLocaleString() : ''}">✅ Posted</span>`
        : `<span class="badge gray">○ Unused</span>`;
      const sortedItems = [...items].sort((a, b) => (a.set_order ?? 0) - (b.set_order ?? 0));
      const tiles = sortedItems
        .map(
          (p) => `
        <div class="tile" data-id="${p.id}">
          <img src="${escapeHtml(p.thumb_url ?? p.image_url)}" loading="lazy" alt="">
          <button class="del-btn" data-id="${p.id}" title="Remove from pool">✕</button>
        </div>`,
        )
        .join('');
      const setLabel = items.length > 1 ? `Set of ${items.length} · ` : '';
      const dateLabel = items[0]?.inserted_at
        ? new Date(items[0].inserted_at * 1000).toLocaleDateString('vi-VN')
        : '';
      return `
      <div class="set">
        <div class="set-header">
          <div class="set-meta">${badge} <span class="muted">${setLabel}${escapeHtml(items[0]?.source ?? '')} · ${dateLabel}</span></div>
        </div>
        <div class="tiles">${tiles}</div>
      </div>`;
    })
    .join('');

  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Photos pool</title>
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
  .stats .r { color:#ff8a8a; }

  /* form card */
  .card { background:#1a1a1f; border:1px solid #2a2a30; border-radius:14px; padding:18px; margin-bottom:24px; }
  .label { font-size:12px; color:#999; text-transform:uppercase; letter-spacing:0.05em; margin:14px 0 6px; font-weight:600; }
  .label:first-child { margin-top:0; }
  textarea, input { width:100%; background:#101013; border:1px solid #2a2a30; color:#eaeaea; padding:11px 13px; border-radius:9px; font-size:14px; font-family:ui-monospace,Menlo,monospace; transition:border-color 0.15s; }
  textarea { min-height:110px; resize:vertical; }
  input { font-family:inherit; }
  textarea:focus, input:focus { outline:none; border-color:#5a8dff; }
  button.primary { width:100%; padding:13px; border:0; border-radius:9px; font-size:14px; font-weight:600; background:linear-gradient(180deg,#3ae07f,#2ec968); color:#001a0a; cursor:pointer; margin-top:14px; transition:transform 0.05s; }
  button.primary:hover { transform:translateY(-1px); }
  button.primary:disabled { opacity:.5; cursor:wait; transform:none; }
  .hint { font-size:12px; color:#888; margin-top:8px; line-height:1.55; }
  kbd { background:#26262c; padding:1px 6px; border-radius:4px; font-family:ui-monospace,Menlo,monospace; font-size:11px; color:#bbb; }

  .result { margin-top:12px; padding:9px 12px; border-radius:8px; font-size:13px; word-break:break-all; line-height:1.5; }
  .ok { background:rgba(58,224,127,0.1); border:1px solid rgba(58,224,127,0.3); color:#7be88a; }
  .err { background:rgba(255,138,138,0.1); border:1px solid rgba(255,138,138,0.3); color:#ff8a8a; }

  /* sets list */
  h2 { font-size:15px; margin:24px 0 12px; color:#aaa; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; }
  .set { background:#1a1a1f; border:1px solid #2a2a30; border-radius:12px; padding:12px; margin-bottom:10px; }
  .set-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding:0 2px; }
  .set-meta { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px; }
  .muted { color:#888; }
  .badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11px; font-weight:600; }
  .badge.ok { background:rgba(58,224,127,0.15); color:#7be88a; }
  .badge.gray { background:#26262c; color:#aaa; }
  .badge.red { background:rgba(255,138,138,0.15); color:#ff8a8a; }

  .tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); gap:8px; }
  .tile { position:relative; aspect-ratio:1/1; border-radius:8px; overflow:hidden; background:#0a0a0c; }
  .tile img { width:100%; height:100%; object-fit:cover; display:block; }
  .tile .del-btn { position:absolute; top:6px; right:6px; width:24px; height:24px; padding:0; border:0; border-radius:50%; background:rgba(0,0,0,0.7); color:#ff8a8a; cursor:pointer; font-size:13px; line-height:24px; opacity:0; transition:opacity 0.15s, background 0.15s; }
  .tile:hover .del-btn { opacity:1; }
  .tile .del-btn:hover { background:rgba(255,138,138,0.2); }
  .tile.deleting { opacity:0.3; transform:scale(0.95); transition:opacity 0.2s, transform 0.2s; }

  .empty { text-align:center; padding:40px 20px; color:#666; font-size:14px; background:#1a1a1f; border:1px dashed #2a2a30; border-radius:12px; }
</style>
</head><body>

<h1>Photos pool</h1>
<div class="nav">
  <a class="active" href="/admin/add?key=${encodeURIComponent(key)}">🖼 Photos</a>
  <a href="/admin/affiliate?key=${encodeURIComponent(key)}">🛍 Affiliate</a>
</div>

<div class="stats">
  <span class="a">UNUSED <b>${counts.unusedSets}</b> sets</span>
  <span>APPROVED <b>${counts.approved}</b> photos</span>
  <span>POSTED <b>${counts.posted}</b> photos</span>
</div>

<div class="card">
  <div class="label">Image URLs — one per line. <b style="color:#fff">Each submit = 1 SET = 1 FB post</b></div>
  <textarea id="urls" placeholder="https://i.pinimg.com/photo-of-room.jpg&#10;https://i.pinimg.com/same-room-detail.jpg"></textarea>
  <div class="hint">Pin 2-3 ảnh CÙNG 1 phòng → paste cùng lần để thành 1 set. Cron sẽ pick từng set → mỗi post là 1 carousel coherent.</div>

  <div class="label">Source <span class="muted">(optional)</span></div>
  <input id="source" type="text" placeholder="pinterest" value="pinterest">

  <div class="label">Alt text <span class="muted">(optional, used by Gemini for caption)</span></div>
  <input id="alt" type="text" placeholder="cozy bedroom warm light plants">

  <button id="submit" class="primary">Add to pool</button>
  <div id="result"></div>
</div>

<h2>Pool (${photos.length} photos)</h2>
${photos.length === 0 ? '<div class="empty">Pool is empty. Paste image URLs above to start.</div>' : setsHtml}

<script>
(() => {
  const KEY = ${JSON.stringify(key)};
  const $ = (id) => document.getElementById(id);

  async function add() {
    const $btn = $('submit'), $result = $('result');
    const urls = $('urls').value.split(/\\s+/).map(s => s.trim()).filter(Boolean);
    if (urls.length === 0) { alert('Paste at least one URL'); return; }
    const source = $('source').value.trim() || 'manual';
    const alt = $('alt').value.trim();
    const setId = 'set-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    $btn.disabled = true;
    $result.innerHTML = '';
    let ok = 0, fail = 0;
    const lines = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        const res = await fetch('/admin/add/url?key=' + encodeURIComponent(KEY), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urls[i], source, alt, set_id: setId, set_order: i }),
        });
        const data = await res.json();
        if (res.ok) { ok++; lines.push('<div class="result ok">✓ ' + (data.duplicate ? 'already in pool: ' : 'added id=' + data.id + ': ') + urls[i] + '</div>'); }
        else { fail++; lines.push('<div class="result err">✗ ' + (data.error || res.status) + ': ' + urls[i] + '</div>'); }
      } catch (err) {
        fail++; lines.push('<div class="result err">✗ ' + err.message + ': ' + urls[i] + '</div>');
      }
    }
    $result.innerHTML = lines.join('') + '<div class="hint" style="margin-top:10px">Done: ' + ok + ' added' + (ok > 1 ? ' as 1 set of ' + ok : '') + ', ' + fail + ' failed.</div>';
    if (ok > 0) {
      $('urls').value = '';
      $('alt').value = '';
      setTimeout(() => location.reload(), 800);
    }
    $btn.disabled = false;
  }
  $('submit').addEventListener('click', add);

  document.querySelectorAll('button.del-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm('Delete photo id=' + id + '?')) return;
      const tile = btn.closest('.tile');
      tile.classList.add('deleting');
      try {
        const res = await fetch('/admin/add/' + id + '?key=' + encodeURIComponent(KEY), { method: 'DELETE' });
        if (!res.ok) throw new Error(await res.text());
        tile.remove();
      } catch (err) {
        tile.classList.remove('deleting');
        alert('Delete failed: ' + err.message);
      }
    });
  });
})();
</script>
</body></html>`;
};

export async function handleAdminAdd(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!checkAuth(url, env)) return unauthorized();
  const sub = url.pathname.replace(/^\/admin\/add/, '') || '/';

  // GET / — list page with form
  if (req.method === 'GET' && sub === '/') {
    const photosResult = await env.DB.prepare(
      `SELECT id, source, image_url, thumb_url, alt, set_id, set_order, used_count, last_used_at, inserted_at
         FROM curated_photos
        WHERE status = 'APPROVED'
        ORDER BY inserted_at DESC, set_id, set_order ASC
        LIMIT 200`,
    ).all<PhotoRow>();

    const counts = await env.DB.prepare(
      `SELECT
         COUNT(*) AS approved,
         SUM(CASE WHEN used_count > 0 THEN 1 ELSE 0 END) AS posted,
         COUNT(DISTINCT CASE WHEN last_used_at IS NULL THEN set_id END) AS unused_sets
       FROM curated_photos WHERE status='APPROVED'`,
    ).first<{ approved: number | null; posted: number | null; unused_sets: number | null }>();

    return new Response(
      PAGE_HTML(env.ADMIN_TOKEN, photosResult.results ?? [], {
        approved: counts?.approved ?? 0,
        posted: counts?.posted ?? 0,
        unusedSets: counts?.unused_sets ?? 0,
      }),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  // POST /url — add image
  if (req.method === 'POST' && sub === '/url') {
    const body = await req.json<{ url?: string; source?: string; alt?: string; set_id?: string; set_order?: number }>();
    const photoUrl = body.url?.trim();
    if (!photoUrl || !/^https?:\/\//i.test(photoUrl)) {
      return Response.json({ error: 'invalid url' }, { status: 400 });
    }
    let contentType = '';
    let contentLength = 0;
    try {
      const headRes = await fetch(photoUrl, { method: 'HEAD' });
      if (!headRes.ok) {
        const rangeRes = await fetch(photoUrl, { headers: { Range: 'bytes=0-1023' } });
        if (!rangeRes.ok) return Response.json({ error: `unreachable (${rangeRes.status})` }, { status: 400 });
        contentType = rangeRes.headers.get('content-type') ?? '';
        contentLength = Number(rangeRes.headers.get('content-range')?.split('/')[1] ?? 0);
      } else {
        contentType = headRes.headers.get('content-type') ?? '';
        contentLength = Number(headRes.headers.get('content-length') ?? 0);
      }
    } catch (err) {
      return Response.json({ error: `fetch failed: ${String(err).slice(0, 100)}` }, { status: 400 });
    }
    if (!contentType.startsWith('image/')) {
      return Response.json({ error: `not an image (content-type: ${contentType || 'unknown'})` }, { status: 400 });
    }
    if (contentLength && contentLength < 5_000) {
      return Response.json({ error: `image too small (${contentLength} bytes)` }, { status: 400 });
    }

    const source = (body.source || 'manual').slice(0, 30);
    const sourceId = photoUrl.length > 64 ? photoUrl.slice(-64) : photoUrl;
    const setId = body.set_id || `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const setOrder = body.set_order ?? 0;

    const existing = await env.DB.prepare(
      `SELECT id FROM curated_photos WHERE source = ? AND source_id = ?`,
    )
      .bind(source, sourceId)
      .first<{ id: number }>();
    if (existing) {
      return Response.json({ ok: true, duplicate: true, id: existing.id });
    }

    const result = await env.DB.prepare(
      `INSERT INTO curated_photos
         (source, source_id, source_url, image_url, thumb_url, photographer, alt,
          width, height, search_keyword, status, decided_at, set_id, set_order)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 'manual-paste', 'APPROVED', unixepoch(), ?, ?)
       RETURNING id`,
    )
      .bind(source, sourceId, photoUrl, photoUrl, photoUrl, body.alt ?? null, setId, setOrder)
      .first<{ id: number }>();

    return Response.json({ ok: true, id: result?.id, set_id: setId, set_order: setOrder, source, content_type: contentType });
  }

  // DELETE /:id
  const deleteMatch = sub.match(/^\/(\d+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const id = Number(deleteMatch[1]);
    const r = await env.DB.prepare(`DELETE FROM curated_photos WHERE id = ?`).bind(id).run();
    return Response.json({ ok: true, changes: r.meta.changes ?? 0 });
  }

  return new Response('not found', { status: 404 });
}
