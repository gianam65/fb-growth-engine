import type { Env } from '@/lib/env';

// Manually add image URLs from any source (Pinterest, IG, Xiaohongshu, etc.)
// to the curated pool with status='APPROVED'.
//
// Routes (require ?key=ADMIN_TOKEN):
//   GET /admin/add        — HTML form
//   POST /admin/add/url   — JSON { url, source?, alt? } → validate + insert

function checkAuth(url: URL, env: Env): boolean {
  const key = url.searchParams.get('key');
  return !!key && !!env.ADMIN_TOKEN && key === env.ADMIN_TOKEN;
}

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 });
}

const ADD_HTML = (key: string) => `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Add photo URL</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin:0; background:#111; color:#eee; font-family:system-ui,-apple-system,sans-serif; }
  body { min-height:100vh; padding:14px; padding-bottom:env(safe-area-inset-bottom); max-width:560px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 8px; }
  .nav a { color:#79b8ff; font-size:13px; margin-right:14px; }
  .stats { display:flex; gap:10px; font-size:13px; margin:10px 0 14px; opacity:.85; flex-wrap:wrap; }
  .stats span { padding:4px 10px; border-radius:6px; background:#222; }
  textarea, input { width:100%; background:#1c1c1c; border:1px solid #333; color:#eee; padding:12px; border-radius:8px; font-size:15px; font-family:ui-monospace,Menlo,monospace; }
  textarea { min-height:120px; resize:vertical; }
  input { font-family:inherit; }
  .label { font-size:13px; color:#aaa; margin:14px 0 6px; }
  button { width:100%; padding:14px; border:0; border-radius:8px; font-size:15px; font-weight:600; background:#3ae07f; color:#000; cursor:pointer; margin-top:10px; }
  button:disabled { opacity:.5; cursor:wait; }
  .result { margin-top:14px; padding:10px 12px; border-radius:8px; font-size:14px; word-break:break-all; }
  .ok { background:#1f3a26; border:1px solid #2a5a36; }
  .err { background:#3a1f1f; border:1px solid #5a2a2a; }
  .preview { margin-top:10px; max-width:100%; border-radius:8px; max-height:240px; object-fit:cover; }
  .hint { font-size:12px; color:#888; margin-top:8px; line-height:1.5; }
  kbd { background:#333; padding:1px 5px; border-radius:3px; font-family:ui-monospace,Menlo,monospace; font-size:11px; }
</style>
</head><body>
<h1>Add photo URL</h1>
<div class="nav">
  <a href="/admin/curate?key=${encodeURIComponent(key)}">← Review pending</a>
</div>
<div class="stats" id="stats">…</div>

<div class="label">Image URLs — one per line. <b>Each submit = 1 SET = 1 FB post.</b></div>
<textarea id="urls" placeholder="https://i.pinimg.com/photo-of-room-wide-shot.jpg&#10;https://i.pinimg.com/photo-of-same-room-close-up.jpg&#10;https://i.pinimg.com/photo-of-same-room-detail.jpg"></textarea>
<div class="hint" style="margin-top:6px">Pin 2-3 ảnh CÙNG 1 phòng (góc khác nhau) → paste cả 3 cùng lần để chúng được nhóm vào 1 set. Daily cron sẽ pick từng set → mỗi post là 1 set coherent.</div>

<div class="label">Source label <span style="opacity:.5">(optional, e.g. pinterest, instagram, xhs)</span></div>
<input id="source" type="text" placeholder="pinterest" value="pinterest">

<div class="label">Alt text <span style="opacity:.5">(optional, used by Gemini for caption)</span></div>
<input id="alt" type="text" placeholder="cozy bedroom warm light plants">

<button id="submit">Add to pool (APPROVED)</button>

<div id="result"></div>

<div class="hint">
  <b>Pinterest</b>: open pin → right-click image → Copy Image Address. URL like <kbd>https://i.pinimg.com/...jpg</kbd><br>
  <b>Instagram</b>: open post in browser → right-click image → Copy Image Address.<br>
  <b>Xiaohongshu (xiaohongshu.com)</b>: open note → right-click → Copy Image Address.<br>
  Multiple URLs: paste one per line, all added in one click.
</div>

<script>
(() => {
  const KEY = ${JSON.stringify(key)};
  const $ = (id) => document.getElementById(id);
  const $stats = $('stats'), $result = $('result'), $btn = $('submit');

  async function refreshStats() {
    try {
      const res = await fetch('/admin/curate/next?key=' + encodeURIComponent(KEY));
      const data = await res.json();
      $stats.innerHTML = ''
        + '<span>PENDING: <b>' + data.counts.pending + '</b></span>'
        + '<span style="color:#7be88a">APPROVED: <b>' + data.counts.approved + '</b></span>'
        + '<span style="color:#ff8a8a">REJECTED: <b>' + data.counts.rejected + '</b></span>';
    } catch {}
  }

  async function add() {
    const urls = $('urls').value.split(/\\s+/).map(s => s.trim()).filter(Boolean);
    if (urls.length === 0) { alert('Paste at least one URL'); return; }
    const source = $('source').value.trim() || 'manual';
    const alt = $('alt').value.trim();
    // All URLs in this submit share one set_id = one FB carousel post
    const setId = 'set-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    $btn.disabled = true;
    $result.innerHTML = '';
    const lines = [];
    let ok = 0, fail = 0;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const res = await fetch('/admin/add/url?key=' + encodeURIComponent(KEY), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, source, alt, set_id: setId, set_order: i }),
        });
        const data = await res.json();
        if (res.ok) {
          ok++;
          lines.push('<div class="result ok">✓ ' + (data.duplicate ? 'already in pool: ' : 'added id=' + data.id + ': ') + url + '</div>');
        } else {
          fail++;
          lines.push('<div class="result err">✗ ' + (data.error || res.status) + ': ' + url + '</div>');
        }
      } catch (err) {
        fail++;
        lines.push('<div class="result err">✗ ' + err.message + ': ' + url + '</div>');
      }
    }
    const setSummary = ok > 0 ? ' as 1 set (' + ok + ' photos = 1 FB post)' : '';
    $result.innerHTML = lines.join('') + '<div class="hint" style="margin-top:14px">Done: ' + ok + ' added' + setSummary + ', ' + fail + ' failed.</div>';
    if (ok > 0) {
      $('urls').value = '';
      $('alt').value = '';
    }
    $btn.disabled = false;
    refreshStats();
  }

  $btn.addEventListener('click', add);
  refreshStats();
})();
</script>
</body></html>`;

export async function handleAdminAdd(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!checkAuth(url, env)) return unauthorized();
  const sub = url.pathname.replace(/^\/admin\/add/, '') || '/';

  if (req.method === 'GET' && sub === '/') {
    return new Response(ADD_HTML(env.ADMIN_TOKEN), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if (req.method === 'POST' && sub === '/url') {
    const body = await req.json<{ url?: string; source?: string; alt?: string; set_id?: string; set_order?: number }>();
    const photoUrl = body.url?.trim();
    if (!photoUrl || !/^https?:\/\//i.test(photoUrl)) {
      return Response.json({ error: 'invalid url' }, { status: 400 });
    }
    // Probe URL to ensure it's an image and reachable
    let contentType = '';
    let contentLength = 0;
    try {
      const headRes = await fetch(photoUrl, { method: 'HEAD' });
      if (!headRes.ok) {
        // Some CDNs (Pinterest's i.pinimg) block HEAD; fall back to ranged GET
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

  return new Response('not found', { status: 404 });
}
