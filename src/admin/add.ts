import type { Env } from '@/lib/env';
import { renderLayout } from '@/admin/layout';

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

function buildPageHtml(key: string, photos: PhotoRow[], counts: Record<string, number>): string {
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
        ? `<span class="badge posted" title="${lastUsed ? new Date(lastUsed * 1000).toLocaleString() : ''}">POSTED</span>`
        : `<span class="badge unused">UNUSED</span>`;
      const sortedItems = [...items].sort((a, b) => (a.set_order ?? 0) - (b.set_order ?? 0));
      const firstImg = sortedItems[0]?.thumb_url ?? sortedItems[0]?.image_url ?? '';
      const dateLabel = items[0]?.inserted_at
        ? new Date(items[0].inserted_at * 1000).toLocaleDateString('en-GB')
        : '';
      const titleHint = items[0]?.alt || `Set of ${items.length}`;
      const searchData = escapeHtml(`${titleHint} ${items[0]?.source ?? ''}`);
      const tiles = sortedItems
        .map(
          (p) => `
        <div class="set-tile" data-id="${p.id}">
          <img src="${escapeHtml(p.thumb_url ?? p.image_url)}" loading="lazy" alt="">
          <button class="tile-del" data-id="${p.id}" title="Remove">✕</button>
        </div>`,
        )
        .join('');
      return `
      <div class="asset-card" data-search="${searchData}">
        <div class="asset-thumb">
          <img src="${escapeHtml(firstImg)}" loading="lazy" alt="">
        </div>
        <div class="asset-info">
          <div class="asset-row">${badge}<span class="asset-date">${dateLabel}</span></div>
          <div class="asset-title">${escapeHtml(titleHint)}</div>
          <div class="asset-meta"><span class="src-pill">↗ ${escapeHtml(items[0]?.source ?? '')}</span> <span class="muted">▦ ${items.length} Asset${items.length > 1 ? 's' : ''}</span></div>
          <div class="set-tiles">${tiles}</div>
        </div>
      </div>`;
    })
    .join('');

  const pageActions = `
    <div class="stat-tiles">
      <div class="stat-tile"><div class="stat-tile-label">UNUSED</div><div class="stat-tile-value">${counts.unusedSets}</div></div>
      <div class="stat-tile active"><div class="stat-tile-label">APPROVED</div><div class="stat-tile-value">${counts.approved}</div></div>
      <div class="stat-tile"><div class="stat-tile-label">POSTED</div><div class="stat-tile-value">${counts.posted}</div></div>
    </div>`;

  const content = `
  <div class="grid-2">
    <div class="card" id="addCard">
      <div class="card-title">📤 Add New Assets</div>
      <label class="field-label">Image URLs</label>
      <textarea id="urls" class="input" placeholder="Paste image links here (one per line)..."></textarea>

      <div class="row-2">
        <div>
          <label class="field-label">Source ↗</label>
          <input id="source" class="input" type="text" value="pinterest">
        </div>
        <div>
          <label class="field-label">Alt text</label>
          <input id="alt" class="input" type="text" placeholder="Interior design, living room…">
        </div>
      </div>

      <div class="hint-box" style="margin-top:14px">
        <b>1 set = 1 carousel post.</b> Paste 2-3 ảnh CÙNG 1 phòng cùng lần để chúng vào chung 1 set, FB sẽ đăng 1 post nhiều ảnh.
      </div>

      <button id="submit" class="btn-primary" style="margin-top:14px;width:100%">⤴ Add to pool</button>
      <div id="result"></div>
    </div>

    <div>
      <div class="section-header">
        <div class="card-title" style="margin:0">▦ Active Pool Assets</div>
        <div style="display:flex;gap:6px">
          <button class="icon-btn" title="Filter">⛌</button>
          <button class="icon-btn" title="Sort">⇅</button>
        </div>
      </div>
      <div id="assetList">
        ${photos.length === 0 ? '<div class="empty-state">Pool is empty. Paste image URLs to start.</div>' : setsHtml}
      </div>
    </div>
  </div>
  `;

  const extraStyle = `
  <style>
    .grid-2 { display:grid; grid-template-columns:1fr 1.15fr; gap:18px; }
    @media (max-width:980px) { .grid-2 { grid-template-columns:1fr; } }
    .row-2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .section-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding:0 2px; }
    .empty-state { text-align:center; padding:40px 20px; color:var(--text-muted); font-size:13.5px; background:var(--surface); border:1px dashed var(--border-strong); border-radius:12px; }

    .asset-card { display:flex; gap:14px; background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px; margin-bottom:10px; transition:border-color 0.12s, box-shadow 0.12s; }
    .asset-card:hover { border-color:var(--border-strong); box-shadow:0 2px 8px rgba(42,31,24,0.05); }
    .asset-thumb { width:100px; height:100px; flex-shrink:0; border-radius:10px; overflow:hidden; background:var(--surface-2); }
    .asset-thumb img { width:100%; height:100%; object-fit:cover; }
    .asset-info { flex:1; min-width:0; }
    .asset-row { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px; }
    .asset-date { font-size:11px; color:var(--text-muted); }
    .asset-title { font-size:15px; font-weight:600; margin-bottom:6px; line-height:1.3; color:var(--text); overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; }
    .asset-meta { display:flex; gap:10px; align-items:center; font-size:11.5px; margin-bottom:10px; }
    .src-pill { color:var(--brand); font-weight:500; }
    .muted { color:var(--text-muted); }

    .set-tiles { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
    .set-tile { position:relative; width:64px; height:64px; border-radius:8px; overflow:hidden; background:var(--surface-2); border:1px solid var(--border); }
    .set-tile img { width:100%; height:100%; object-fit:cover; }
    .set-tile .tile-del { position:absolute; top:3px; right:3px; width:20px; height:20px; padding:0; border:0; border-radius:50%; background:rgba(0,0,0,0.6); color:#fff; cursor:pointer; font-size:11px; line-height:20px; opacity:0; transition:opacity 0.12s; }
    .set-tile:hover .tile-del { opacity:1; }
    .set-tile .tile-del:hover { background:#b94a35; }
    .set-tile.deleting { opacity:0.3; }

    .result { margin-top:10px; padding:9px 12px; border-radius:8px; font-size:13px; word-break:break-all; line-height:1.5; }
    .result.ok { background:var(--leaf-soft); border:1px solid #c5d6a8; color:var(--leaf); }
    .result.err { background:#fbe4dd; border:1px solid #e8b9aa; color:#b94a35; }
  </style>
  `;

  const bodyExtraScript = `
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
          if (res.ok) { ok++; lines.push('<div class="result ok">✓ ' + (data.duplicate ? 'already in pool' : 'added id=' + data.id) + ': ' + urls[i] + '</div>'); }
          else { fail++; lines.push('<div class="result err">✗ ' + (data.error || res.status) + ': ' + urls[i] + '</div>'); }
        } catch (err) {
          fail++; lines.push('<div class="result err">✗ ' + err.message + ': ' + urls[i] + '</div>');
        }
      }
      $result.innerHTML = lines.join('');
      if (ok > 0) {
        $('urls').value = '';
        $('alt').value = '';
        setTimeout(() => location.reload(), 700);
      }
      $btn.disabled = false;
    }
    $('submit')?.addEventListener('click', add);

    // FAB / sidebar Add to pool → focus textarea
    document.addEventListener('cv-add', () => {
      $('urls')?.focus();
      $('addCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    document.querySelectorAll('button.tile-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = btn.dataset.id;
        if (!confirm('Delete photo id=' + id + '?')) return;
        const tile = btn.closest('.set-tile');
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
  `;

  return renderLayout({
    key,
    currentPage: 'photos',
    pageTitle: 'Photo Pool',
    pageSubtitle: 'Manage and curate your high-velocity visual assets.',
    pageActions,
    content: extraStyle + content,
    searchPlaceholder: 'Search pool...',
    bodyExtraScript,
  });
}

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
      buildPageHtml(env.ADMIN_TOKEN, photosResult.results ?? [], {
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
