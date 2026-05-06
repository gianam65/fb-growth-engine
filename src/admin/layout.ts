// Shared Creator Studio layout: sidebar + topbar + main content area + FAB.

export interface LayoutOpts {
  key: string;
  currentPage: 'photos' | 'affiliate';
  pageTitle: string;
  pageSubtitle?: string;
  pageActions?: string; // HTML for top-right of page header (e.g., stat tiles)
  content: string;
  searchPlaceholder?: string;
  bodyExtraScript?: string;
}

const SHARED_CSS = `
  /* Cozy Vibe palette — terracotta on cream */
  :root {
    --bg: #fbf6ef;
    --surface: #ffffff;
    --surface-2: #f5ede0;
    --surface-3: #efe5d3;
    --border: #e8ddd0;
    --border-strong: #d8c5b0;
    --text: #2a1f18;
    --text-muted: #8a7866;
    --text-subtle: #b0a08c;
    --brand: #c4593b;
    --brand-hover: #a14628;
    --brand-soft: #fbe9e0;
    --leaf: #4a7c2c;
    --leaf-soft: #e6efd8;
    --warning: #d97706;
    --warning-soft: #fef3c7;
    --info: #2563eb;
    --info-soft: #dbeafe;
  }
  * { box-sizing: border-box; }
  html, body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,system-ui,"Inter","Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }

  /* App shell */
  .app { display:grid; grid-template-columns:240px 1fr; min-height:100vh; }

  /* Sidebar */
  .sidebar { background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; padding:18px 14px; gap:6px; position:sticky; top:0; height:100vh; }
  .brand { display:flex; align-items:center; gap:10px; padding:6px 10px 18px; }
  .brand-mark { width:36px; height:36px; border-radius:9px; background:var(--brand-soft); display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:20px; }
  .brand-title { font-weight:700; font-size:16px; color:var(--brand); letter-spacing:-0.01em; }
  .brand-sub { font-size:11px; color:var(--text-muted); margin-top:1px; }
  .nav-item { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:10px; color:var(--text-muted); text-decoration:none; font-size:13.5px; font-weight:500; transition:background 0.12s, color 0.12s; }
  .nav-item:hover { background:var(--surface-2); color:var(--text); }
  .nav-item.active { background:var(--brand-soft); color:var(--brand); }
  .nav-item .ico { width:18px; height:18px; display:flex; align-items:center; justify-content:center; flex-shrink:0; opacity:0.9; }
  .nav-spacer { flex:1; }
  .sidebar-bottom { display:flex; flex-direction:column; gap:4px; }
  .btn-primary { background:var(--brand); color:#fff; border:0; padding:11px 14px; border-radius:10px; font-weight:600; font-size:13.5px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; transition:background 0.12s, transform 0.05s; }
  .btn-primary:hover { background:var(--brand-hover); }
  .btn-primary:active { transform:translateY(1px); }
  .btn-primary:disabled { opacity:0.5; cursor:wait; }

  /* Main */
  main { display:flex; flex-direction:column; min-width:0; }
  .topbar { display:flex; align-items:center; gap:12px; padding:14px 28px; border-bottom:1px solid var(--border); background:rgba(251,246,239,0.85); backdrop-filter: blur(8px); position:sticky; top:0; z-index:10; }
  .search { flex:1; max-width:520px; position:relative; }
  .search input { width:100%; background:var(--surface); border:1px solid var(--border); color:var(--text); padding:9px 12px 9px 34px; border-radius:9px; font-size:13.5px; font-family:inherit; }
  .search input:focus { outline:none; border-color:var(--brand); }
  .search::before { content:"🔍"; position:absolute; left:11px; top:50%; transform:translateY(-50%); font-size:12px; opacity:0.4; }
  .topbar-spacer { flex:1; }
  .icon-btn { width:36px; height:36px; border:0; background:transparent; color:var(--text-muted); border-radius:9px; cursor:pointer; font-size:14px; transition:background 0.12s, color 0.12s; }
  .icon-btn:hover { background:var(--surface-2); color:var(--text); }
  .user { display:flex; align-items:center; gap:10px; padding:4px 10px 4px 4px; }
  .avatar { width:34px; height:34px; border-radius:50%; background:var(--brand); display:flex; align-items:center; justify-content:center; font-weight:700; color:#fff; }
  .user-text { display:flex; flex-direction:column; line-height:1.2; }
  .user-name { font-size:12.5px; font-weight:600; }
  .user-role { font-size:10.5px; color:var(--text-muted); }

  /* Page */
  .page { padding:28px 28px 80px; max-width:1320px; margin:0 auto; width:100%; }
  .page-header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:24px; flex-wrap:wrap; }
  .page-title { font-size:28px; font-weight:700; letter-spacing:-0.02em; margin:0 0 4px; color:var(--text); }
  .page-subtitle { color:var(--text-muted); font-size:13.5px; margin:0; }

  /* Stat tiles */
  .stat-tiles { display:flex; gap:8px; }
  .stat-tile { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:10px 16px; min-width:88px; }
  .stat-tile.active { border-color:var(--brand); background:var(--brand-soft); }
  .stat-tile-label { font-size:10px; color:var(--text-muted); font-weight:700; text-transform:uppercase; letter-spacing:0.06em; }
  .stat-tile-value { font-size:24px; font-weight:700; margin-top:2px; color:var(--text); }
  .stat-tile.active .stat-tile-value { color:var(--brand); }

  /* Card */
  .card { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:20px; }
  .card-title { font-size:14px; font-weight:700; margin:0 0 14px; display:flex; align-items:center; gap:8px; color:var(--text); }

  /* Pills (for filter row) */
  .pills { display:flex; gap:8px; flex-wrap:wrap; }
  .pill { padding:7px 14px; border-radius:999px; background:var(--surface); border:1px solid var(--border); font-size:12px; cursor:pointer; transition:background 0.12s, border-color 0.12s; user-select:none; color:var(--text); font-weight:500; }
  .pill:hover { background:var(--surface-2); }
  .pill.active { background:var(--brand-soft); border-color:var(--brand); color:var(--brand); }
  .pill .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:currentColor; margin-right:6px; vertical-align:middle; }

  /* Form inputs */
  label.field-label { display:block; font-size:10.5px; color:var(--text-muted); font-weight:700; text-transform:uppercase; letter-spacing:0.06em; margin:14px 0 6px; }
  label.field-label:first-child { margin-top:0; }
  .input, textarea.input { width:100%; background:var(--surface); border:1px solid var(--border); color:var(--text); padding:11px 13px; border-radius:9px; font-size:13.5px; font-family:ui-monospace,Menlo,monospace; transition:border-color 0.12s; }
  textarea.input { min-height:120px; resize:vertical; line-height:1.5; }
  input.input { font-family:inherit; }
  .input:focus { outline:none; border-color:var(--brand); }
  .input::placeholder { color:var(--text-subtle); }

  /* Badges — bigger, solid backgrounds for clear classification */
  .badge { display:inline-flex; align-items:center; gap:5px; padding:5px 12px; border-radius:999px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; line-height:1; }
  .badge.unused { background:var(--warning); color:#fff; box-shadow:0 1px 2px rgba(217,119,6,0.25); }
  .badge.unused::before { content:"○"; font-size:13px; line-height:1; }
  .badge.posted { background:var(--leaf); color:#fff; box-shadow:0 1px 2px rgba(74,124,44,0.25); }
  .badge.posted::before { content:"✓"; font-weight:900; font-size:12px; }
  .badge.approved { background:var(--info); color:#fff; }

  /* FAB */
  .fab { position:fixed; right:28px; bottom:28px; width:56px; height:56px; border-radius:50%; border:0; background:var(--brand); color:#fff; font-size:26px; cursor:pointer; box-shadow:0 6px 18px rgba(196,89,59,0.35); z-index:50; transition:background 0.12s, transform 0.12s; }
  .fab:hover { background:var(--brand-hover); transform:scale(1.05); }

  /* Hint info box */
  .hint-box { background:var(--brand-soft); border:1px solid var(--border); border-left:3px solid var(--brand); border-radius:8px; padding:10px 14px; font-size:12.5px; color:var(--text); line-height:1.55; }
  .hint-box b { color:var(--brand); }

  @media (max-width: 880px) {
    .app { grid-template-columns:1fr; }
    .sidebar { position:fixed; left:-260px; transition:left 0.2s; z-index:100; width:240px; }
    .sidebar.open { left:0; }
  }
`;

export function renderLayout(opts: LayoutOpts): string {
  const k = encodeURIComponent(opts.key);
  const item = (page: 'photos' | 'affiliate' | 'settings', icon: string, label: string, href: string) =>
    `<a class="nav-item ${opts.currentPage === page ? 'active' : ''}" href="${href}"><span class="ico">${icon}</span>${label}</a>`;

  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${opts.pageTitle} — Cozy Vibe</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="app">

  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-mark">🪴</div>
      <div>
        <div class="brand-title">Cozy Vibe</div>
        <div class="brand-sub">Creator Studio</div>
      </div>
    </div>
    ${item('photos', '📷', 'Photo Pool', `/admin/add?key=${k}`)}
    ${item('affiliate', '🛒', 'Affiliate Pool', `/admin/affiliate?key=${k}`)}
    <a class="nav-item" href="#" onclick="alert('Settings coming soon');return false;"><span class="ico">⚙</span>Settings</a>
    <div class="nav-spacer"></div>
    <div class="sidebar-bottom">
      <button class="btn-primary" id="sidebarAddBtn">+ Add to pool</button>
      <a class="nav-item" href="#" onclick="window.open('https://github.com/gianam65/fb-growth-engine','_blank');return false;"><span class="ico">？</span>Help</a>
      <a class="nav-item" href="/" style="color:#888"><span class="ico">↩</span>Logout</a>
    </div>
  </aside>

  <main>
    <header class="topbar">
      <div class="search"><input type="search" id="searchInput" placeholder="${opts.searchPlaceholder ?? 'Search pool...'}"></div>
      <div class="topbar-spacer"></div>
      <button class="icon-btn" title="Notifications">🔔</button>
      <div class="user">
        <div class="user-text">
          <span class="user-name">Cozy Vibe</span>
          <span class="user-role">Creator Manager</span>
        </div>
        <div class="avatar">C</div>
      </div>
    </header>

    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="page-title">${opts.pageTitle}</h1>
          ${opts.pageSubtitle ? `<p class="page-subtitle">${opts.pageSubtitle}</p>` : ''}
        </div>
        ${opts.pageActions ?? ''}
      </div>
      ${opts.content}
    </div>

  </main>

  <button class="fab" id="fab" title="Quick add">+</button>
</div>

<script>
(function(){
  const KEY = ${JSON.stringify(opts.key)};

  // Search filter (client-side, hides items where text doesn't match)
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      document.querySelectorAll('[data-search]').forEach((el) => {
        const text = el.getAttribute('data-search') || '';
        el.style.display = !q || text.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }

  // Sidebar Add button + FAB → trigger an event the page can hook
  function fireAdd() {
    document.dispatchEvent(new CustomEvent('cv-add'));
  }
  document.getElementById('sidebarAddBtn')?.addEventListener('click', fireAdd);
  document.getElementById('fab')?.addEventListener('click', fireAdd);
})();
${opts.bodyExtraScript ?? ''}
</script>

</body></html>`;
}
