import type { Env } from '@/lib/env';

// Telegram bot webhook — handles incoming messages from the user's chat.
// Setup: setWebhook to https://<worker>/telegram/webhook (one-time, with secret_token).
// Auth: only respond when chat.id matches TELEGRAM_CHAT_ID (silent ignore otherwise).
//
// Commands:
//   /help, /start         — list commands
//   /status               — pool sizes + last post age
//   /retry-curate         — trigger curate-post.yml (Pinterest)
//   /retry-affiliate      — trigger affiliate-post.yml
//   /retry-watchdog       — trigger watchdog.yml

interface TgUpdate {
  update_id?: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    from?: { id: number; first_name?: string; username?: string };
  };
}

export async function handleTelegramWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('not found', { status: 404 });

  // Optional secret-token guard (Telegram sends X-Telegram-Bot-Api-Secret-Token).
  // We reuse FB_VERIFY_TOKEN as the shared secret to avoid adding another env.
  const expectedSecret = env.FB_VERIFY_TOKEN;
  const hdr = req.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (expectedSecret && hdr !== expectedSecret) {
    // Silent 200 so Telegram doesn't retry; logged for audit.
    console.warn('[tg] webhook secret mismatch');
    return new Response('ok');
  }

  let update: TgUpdate;
  try {
    update = await req.json<TgUpdate>();
  } catch {
    return new Response('bad json', { status: 400 });
  }

  const msg = update.message;
  if (!msg?.text) return new Response('ok');

  // Auth: only respond to our own chat
  if (String(msg.chat.id) !== String(env.TELEGRAM_CHAT_ID)) {
    console.warn('[tg] unauthorized chat:', msg.chat.id);
    return new Response('ok');
  }

  const text = msg.text.trim();
  const cmd = text.split(/\s+/)[0]!.toLowerCase();
  const reply = (t: string) => sendMessage(env, msg.chat.id, t);

  try {
    if (cmd === '/start' || cmd === '/help') {
      await reply([
        '*Cozy Vibe Bot*',
        '',
        '/status — pool sizes + last post age',
        '/retry-curate — re-run Pinterest curate-post',
        '/retry-affiliate — re-run affiliate-post',
        '/retry-watchdog — re-run watchdog',
      ].join('\n'));
    } else if (cmd === '/status') {
      await reply(await buildStatus(env));
    } else if (cmd === '/retry-curate') {
      await reply(await runDispatch(env, 'curate-post.yml'));
    } else if (cmd === '/retry-affiliate') {
      await reply(await runDispatch(env, 'affiliate-post.yml'));
    } else if (cmd === '/retry-watchdog') {
      await reply(await runDispatch(env, 'watchdog.yml'));
    } else if (cmd.startsWith('/')) {
      await reply(`Unknown command: \`${cmd}\`\nTry /help`);
    }
    // non-commands: ignore
  } catch (err) {
    console.error('[tg] handler error:', err);
    try { await reply(`❌ Error: ${String(err).slice(0, 200)}`); } catch {}
  }

  return new Response('ok');
}

async function runDispatch(env: Env, workflowFile: string): Promise<string> {
  if (!env.GH_PAT || !env.GH_REPO) {
    return '❌ GH_PAT/GH_REPO not configured on Worker.\nRun: gh secret set GH_PAT (workflow scope) + GH_REPO=owner/repo, then sync-worker-secrets.';
  }
  const url = `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${workflowFile}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cozy-vibe-bot',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (res.status === 204) {
    return `✅ \`${workflowFile}\` dispatched\nhttps://github.com/${env.GH_REPO}/actions/workflows/${workflowFile}`;
  }
  const txt = (await res.text()).slice(0, 250);
  return `❌ Dispatch failed (${res.status}): ${txt}`;
}

async function buildStatus(env: Env): Promise<string> {
  const last = await env.DB.prepare(
    `SELECT MAX(published_at) AS last_pub FROM fb_posts`,
  ).first<{ last_pub: number | null }>();
  const lastAff = await env.DB.prepare(
    `SELECT MAX(last_used_at) AS last_used FROM affiliate_products`,
  ).first<{ last_used: number | null }>();
  const aff = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN used_count = 0 THEN 1 ELSE 0 END) AS unused
       FROM affiliate_products WHERE status='APPROVED'`,
  ).first<{ total: number | null; unused: number | null }>();
  const photoSets = await env.DB.prepare(
    `SELECT COUNT(DISTINCT set_id) AS sets,
            SUM(CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END) AS unused
       FROM curated_photos WHERE status='APPROVED'`,
  ).first<{ sets: number | null; unused: number | null }>();

  const ageH = (ts: number | null) =>
    ts ? `${((Date.now() / 1000 - ts) / 3600).toFixed(1)}h ago` : 'never';

  return [
    '*Cozy Vibe — Status*',
    `Last post: ${ageH(last?.last_pub ?? null)}`,
    `Last affiliate post: ${ageH(lastAff?.last_used ?? null)}`,
    '',
    `Affiliate: ${aff?.unused ?? 0} unused / ${aff?.total ?? 0} total`,
    `Photos: ${photoSets?.unused ?? 0} unused photos / ${photoSets?.sets ?? 0} sets`,
  ].join('\n');
}

async function sendMessage(env: Env, chatId: number, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
}
