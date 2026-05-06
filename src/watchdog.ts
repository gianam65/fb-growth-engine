import type { Env } from '@/lib/env';

// Cloudflare Worker scheduled handler — primary scheduler.
// Multiple cron expressions in wrangler.toml; this handler dispatches the
// right GH workflow based on which cron fired. Hourly tick acts as
// watchdog backup that catches any rare GH miss.

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
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
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
    console.error('tgSend failed', err);
  }
}

// Direct dispatch (no overdue check) — used by the per-time crons that fire
// at the exact scheduled minute. CF cron is reliable; we want this to ALWAYS
// trigger the workflow, not gate on overdue threshold.
async function dispatchScheduled(env: Env, workflowFile: string, label: string): Promise<void> {
  if (!env.GH_PAT || !env.GH_REPO) {
    await tgSend(env, `⚠ Worker scheduled: *${label}* due but GH_PAT/GH_REPO not configured.`);
    return;
  }
  console.log(`[scheduled] dispatching ${workflowFile}`);
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
    if (res.status !== 204) {
      const txt = (await res.text()).slice(0, 200);
      await tgSend(env, `❌ ${label} dispatch failed (${res.status}): ${txt}`);
    }
  } catch (err) {
    await tgSend(env, `❌ ${label} dispatch error: ${String(err).slice(0, 200)}`);
  }
}

// Main entry — routes the scheduled event by which cron fired.
async function handleScheduled(env: Env, cron: string): Promise<void> {
  console.log(`[scheduled] cron=${cron}`);
  if (cron === '0 0 * * *') {
    await dispatchScheduled(env, 'curate-post.yml', 'Pinterest curate');
  } else if (cron === '0 4 * * *' || cron === '0 7 * * *' || cron === '0 12 * * *') {
    await dispatchScheduled(env, 'affiliate-post.yml', 'Affiliate');
  } else if (cron === '5 * * * *') {
    await runWatchdog(env);
  } else {
    console.warn(`[scheduled] unknown cron: ${cron}, defaulting to watchdog`);
    await runWatchdog(env);
  }
}

export { runWatchdog, handleScheduled };
