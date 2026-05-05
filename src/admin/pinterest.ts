import type { Env } from '@/lib/env';

// Pinterest OAuth flow + board picker.
// Routes (all require ?key=ADMIN_TOKEN):
//   GET /admin/pinterest               → status page
//   GET /admin/pinterest/auth          → 302 redirect to Pinterest authorize URL
//   GET /admin/pinterest/callback      → handles `code`, exchanges, stores token in D1
//   GET /admin/pinterest/boards        → JSON: list of user's boards
//   POST /admin/pinterest/select-board → save chosen board_id into oauth_tokens.metadata

const PINTEREST_AUTH_URL = 'https://www.pinterest.com/oauth/';
const PINTEREST_TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token';
const PINTEREST_API_BASE = 'https://api.pinterest.com/v5';
const SCOPES = 'boards:read,pins:read';

function checkAuth(url: URL, env: Env): boolean {
  const key = url.searchParams.get('key');
  return !!key && !!env.ADMIN_TOKEN && key === env.ADMIN_TOKEN;
}

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 });
}

function redirectUri(req: Request): string {
  const u = new URL(req.url);
  return `${u.origin}/admin/pinterest/callback`;
}

async function getStoredToken(env: Env): Promise<{
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  metadata: { selected_board_id?: string; selected_board_name?: string } | null;
} | null> {
  const row = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at, metadata FROM oauth_tokens WHERE provider='pinterest'`,
  ).first<{ access_token: string; refresh_token: string | null; expires_at: number | null; metadata: string | null }>();
  if (!row) return null;
  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expires_at: row.expires_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

async function refreshIfNeeded(env: Env): Promise<string | null> {
  const tok = await getStoredToken(env);
  if (!tok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (tok.expires_at && tok.expires_at - 60 > now) return tok.access_token;
  if (!tok.refresh_token || !env.PINTEREST_APP_ID || !env.PINTEREST_APP_SECRET) return null;

  const basic = btoa(`${env.PINTEREST_APP_ID}:${env.PINTEREST_APP_SECRET}`);
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', tok.refresh_token);
  const res = await fetch(PINTEREST_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: params,
  });
  if (!res.ok) {
    console.error('refresh failed', res.status, await res.text());
    return null;
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  const newExpires = now + json.expires_in;
  await env.DB.prepare(
    `UPDATE oauth_tokens SET access_token=?, expires_at=?, updated_at=unixepoch() WHERE provider='pinterest'`,
  )
    .bind(json.access_token, newExpires)
    .run();
  return json.access_token;
}

const STATUS_HTML = (key: string, hasToken: boolean, boardName?: string | null, appId?: string) => `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pinterest setup</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 30px auto; padding: 0 20px; color:#222; line-height:1.5; }
  h1 { font-size: 22px; }
  .ok { color: #1a7f3a; }
  .err { color: #b32d2d; }
  .step { background:#f6f6f6; padding:12px 16px; border-radius:8px; margin:10px 0; }
  a.btn { display:inline-block; padding:10px 16px; background:#e60023; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; }
  a.btn.gray { background:#444; }
  code { background:#eee; padding:2px 6px; border-radius:4px; font-family:ui-monospace,Menlo,monospace; font-size:13px; }
</style></head><body>
<h1>Pinterest setup</h1>
${
  !appId
    ? '<p class="err">PINTEREST_APP_ID not set in Worker env. Add it via GH secret + sync-worker-secrets.</p>'
    : hasToken
      ? `<p class="ok">✓ Pinterest connected.</p>
        <p>Selected board: <b>${boardName ?? '(none — pick one below)'}</b></p>
        <p>
          <a class="btn" href="/admin/pinterest/boards?key=${encodeURIComponent(key)}">View boards (JSON) →</a>
          <a class="btn gray" href="/admin/pinterest/auth?key=${encodeURIComponent(key)}">Re-authorize</a>
        </p>
        <div class="step">To pick a board, open the boards JSON above, copy the <code>id</code> of the cozy board, then run from your terminal:
        <pre>curl -X POST 'https://YOUR-WORKER.workers.dev/admin/pinterest/select-board?key=KEY' \\
  -H 'Content-Type: application/json' \\
  -d '{"board_id":"BOARD_ID","board_name":"Cozy Vibe"}'</pre></div>
        <div class="step">Once a board is selected, run the GH workflow <code>sync-pinterest</code> to pull pins into the curated pool (auto-approved).</div>`
      : `<p>Not authorized yet.</p>
        <p><a class="btn" href="/admin/pinterest/auth?key=${encodeURIComponent(key)}">Connect Pinterest →</a></p>`
}
</body></html>`;

export async function handleAdminPinterest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!checkAuth(url, env)) return unauthorized();
  const sub = url.pathname.replace(/^\/admin\/pinterest/, '') || '/';

  // Status page
  if (req.method === 'GET' && sub === '/') {
    const tok = await getStoredToken(env);
    return new Response(
      STATUS_HTML(env.ADMIN_TOKEN, !!tok, tok?.metadata?.selected_board_name ?? null, env.PINTEREST_APP_ID),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  // Step 1: redirect to Pinterest authorize URL
  if (req.method === 'GET' && sub === '/auth') {
    if (!env.PINTEREST_APP_ID) return new Response('PINTEREST_APP_ID not set', { status: 500 });
    const authUrl = new URL(PINTEREST_AUTH_URL);
    authUrl.searchParams.set('client_id', env.PINTEREST_APP_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri(req));
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES);
    // state is the admin token so callback can re-auth
    authUrl.searchParams.set('state', env.ADMIN_TOKEN);
    return Response.redirect(authUrl.toString(), 302);
  }

  // Step 2: callback — exchange code for tokens
  if (req.method === 'GET' && sub === '/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (state !== env.ADMIN_TOKEN) return unauthorized();
    if (!code) return new Response('no code', { status: 400 });
    if (!env.PINTEREST_APP_ID || !env.PINTEREST_APP_SECRET) {
      return new Response('PINTEREST_APP_ID/SECRET not set', { status: 500 });
    }
    const basic = btoa(`${env.PINTEREST_APP_ID}:${env.PINTEREST_APP_SECRET}`);
    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('code', code);
    params.set('redirect_uri', redirectUri(req));
    const res = await fetch(PINTEREST_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
      body: params,
    });
    const text = await res.text();
    if (!res.ok) return new Response(`Token exchange failed: ${res.status} ${text}`, { status: 500 });
    const json = JSON.parse(text) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_token_expires_in?: number;
      scope: string;
    };
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, refresh_expires_at, scope, metadata, updated_at)
       VALUES ('pinterest', ?, ?, ?, ?, ?, '{}', unixepoch())
       ON CONFLICT(provider) DO UPDATE SET
         access_token=excluded.access_token,
         refresh_token=excluded.refresh_token,
         expires_at=excluded.expires_at,
         refresh_expires_at=excluded.refresh_expires_at,
         scope=excluded.scope,
         updated_at=unixepoch()`,
    )
      .bind(
        json.access_token,
        json.refresh_token,
        now + json.expires_in,
        json.refresh_token_expires_in ? now + json.refresh_token_expires_in : null,
        json.scope,
      )
      .run();
    return Response.redirect(`${url.origin}/admin/pinterest?key=${encodeURIComponent(env.ADMIN_TOKEN)}`, 302);
  }

  // List boards (JSON)
  if (req.method === 'GET' && sub === '/boards') {
    const access = await refreshIfNeeded(env);
    if (!access) return new Response('Not authorized — visit /admin/pinterest/auth first', { status: 401 });
    const res = await fetch(`${PINTEREST_API_BASE}/boards?page_size=100`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Select board
  if (req.method === 'POST' && sub === '/select-board') {
    const body = await req.json<{ board_id?: string; board_name?: string }>();
    if (!body.board_id) return new Response('board_id required', { status: 400 });
    await env.DB.prepare(
      `UPDATE oauth_tokens
         SET metadata = json_set(COALESCE(metadata,'{}'), '$.selected_board_id', ?, '$.selected_board_name', ?),
             updated_at = unixepoch()
       WHERE provider='pinterest'`,
    )
      .bind(body.board_id, body.board_name ?? null)
      .run();
    return Response.json({ ok: true, board_id: body.board_id, board_name: body.board_name });
  }

  return new Response('not found', { status: 404 });
}
