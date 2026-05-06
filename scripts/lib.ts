// Shared helpers for GitHub Actions scripts.
// Scripts run on Node, NOT in Workers, so they call D1 via the HTTP API
// (using a Cloudflare API token) instead of the binding.

const CF_API = 'https://api.cloudflare.com/client/v4';

export interface ScriptEnv {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  D1_DATABASE_ID: string;
  FB_GRAPH_VERSION: string;
  FB_PAGE_ACCESS_TOKEN: string;
  FB_PAGE_ID: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export function loadEnv(): ScriptEnv {
  const required = [
    'CF_ACCOUNT_ID',
    'CF_API_TOKEN',
    'D1_DATABASE_ID',
    'FB_GRAPH_VERSION',
    'FB_PAGE_ACCESS_TOKEN',
    'FB_PAGE_ID',
    'GEMINI_API_KEY',
  ] as const;
  const out: Record<string, string> = {};
  for (const k of required) {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env: ${k}`);
    out[k] = v;
  }
  // Optional
  for (const k of ['GEMINI_MODEL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out as unknown as ScriptEnv;
}

export async function d1Query<T = unknown>(
  env: ScriptEnv,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const url = `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`D1 ${res.status}: ${text}`);
  const json = JSON.parse(text) as {
    success: boolean;
    result?: Array<{ results?: T[]; success?: boolean; meta?: unknown }>;
    errors?: unknown;
  };
  if (!json.success) throw new Error(`D1 error: ${JSON.stringify(json.errors)}`);
  return json.result?.[0]?.results ?? [];
}

export async function tgSend(env: ScriptEnv, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn('tgSend: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    return;
  }
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  // No parse_mode — plain text. Markdown was silently failing on titles
  // containing (), *, _, etc. URLs still auto-link in Telegram clients.
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`tgSend HTTP ${res.status}: ${body.slice(0, 250)}`);
    }
  } catch (err) {
    console.warn('tgSend error:', String(err).slice(0, 200));
  }
}
