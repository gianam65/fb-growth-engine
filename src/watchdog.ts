import type { Env } from '@/lib/env';

// Cloudflare Worker scheduled handler — runs every hour. Catches missed
// GH Actions cron fires by dispatching the corresponding workflow via API
// when last published_at is too old.

const HOURS = 3600;

interface Pipeline {
  workflowFile: string;
  label: string;
  overdueAfterSec: number;
  lastPostQuery: () => Promise<number | null>;
}

async function runWatchdog(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  const pipelines: Pipeline[] = [
    {
      workflowFile: 'curate-post.yml',
      label: 'Pinterest curate',
      overdueAfterSec: 25 * HOURS,
      lastPostQuery: async () => {
        const r = await env.DB.prepare(
          `SELECT MAX(published_at) AS last FROM fb_posts WHERE source IN ('pexels', 'pinterest', 'manual')`,
        ).first<{ last: number | null }>();
        return r?.last ?? null;
      },
    },
    {
      workflowFile: 'affiliate-post.yml',
      label: 'Affiliate',
      overdueAfterSec: 13 * HOURS,
      lastPostQuery: async () => {
        const r = await env.DB.prepare(
          `SELECT MAX(last_used_at) AS last FROM affiliate_products WHERE last_used_at IS NOT NULL`,
        ).first<{ last: number | null }>();
        return r?.last ?? null;
      },
    },
  ];

  for (const p of pipelines) {
    const last = await p.lastPostQuery();
    const ageSec = last ? now - last : Infinity;
    const ageHours = isFinite(ageSec) ? (ageSec / HOURS).toFixed(1) : '∞';
    console.log(`[watchdog] ${p.label}: age=${ageHours}h, threshold=${(p.overdueAfterSec / HOURS).toFixed(0)}h`);

    if (ageSec >= p.overdueAfterSec) {
      console.log(`  → OVERDUE, dispatching ${p.workflowFile}`);
      await dispatchAndAlert(env, p.workflowFile, p.label, ageHours);
    }
  }
}

async function dispatchAndAlert(env: Env, workflowFile: string, label: string, ageHours: string): Promise<void> {
  if (!env.GH_PAT || !env.GH_REPO) {
    await tgSend(env, `⚠ Worker watchdog: *${label}* overdue (${ageHours}h) but GH_PAT/GH_REPO not configured.`);
    return;
  }
  await tgSend(env, `🔔 Worker watchdog: *${label}* overdue (${ageHours}h) — auto-dispatching…`);

  const url = `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${workflowFile}/dispatches`;
  try {
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
      await tgSend(env, `✅ Dispatched \`${workflowFile}\` (will run shortly)`);
    } else {
      const txt = (await res.text()).slice(0, 200);
      await tgSend(env, `❌ Dispatch failed (${res.status}): ${txt}`);
    }
  } catch (err) {
    await tgSend(env, `❌ Dispatch error: ${String(err).slice(0, 200)}`);
  }
}

async function tgSend(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('tgSend failed', err);
  }
}

export { runWatchdog };
