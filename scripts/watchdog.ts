// Watchdog: catches missed scheduled cron runs.
//
// Runs every 3 hours. For each pipeline:
//   1) Find last published_at in fb_posts (filtered by source kind).
//   2) If overdue (longer than expected interval + grace), spawn the post
//      script directly. This works whether the original cron was suspended,
//      runner-shortage'd, or just delayed.
//
// Thresholds (intentionally generous so we don't double-post when a normal
// cron just ran a few hours late):
//   - curate-post  (Pinterest): 1/day → overdue if last > 25h ago
//   - affiliate-post:           2/day → overdue if last > 13h ago
//
// This script doesn't trigger workflow_dispatch; it RUNS the underlying
// scripts directly so it works even if GH Actions runners are saturated for
// our schedule slot.

import { spawn } from 'node:child_process';
import { d1Query, loadEnv, tgSend } from './lib';

interface LastPostRow { last_published_at: number | null }

const HOURS = 3600;

const PIPELINES = [
  {
    name: 'curate-post',
    script: 'scripts/curate-post.ts',
    overdueAfterSeconds: 25 * HOURS,
    sources: ['pexels'],            // curated_photos saves with source='pexels'
    label: 'Pinterest curate',
  },
  {
    name: 'affiliate-post',
    script: 'scripts/affiliate-post.ts',
    overdueAfterSeconds: 13 * HOURS,
    sources: ['shopee', 'pollinations'],
    label: 'Affiliate',
  },
];

async function lastPublished(envSources: string[]): Promise<number | null> {
  // fb_posts.source contains values like 'pexels', 'pollinations'; we also
  // count 'shopee' once we start logging affiliate posts there. For now
  // the simplest approach: take the latest published_at across all sources
  // and rely on per-pipeline thresholds.
  const env = loadEnv();
  const placeholders = envSources.map(() => '?').join(',');
  const rows = await d1Query<LastPostRow>(
    env,
    `SELECT MAX(published_at) AS last_published_at
       FROM fb_posts
      WHERE source IN (${placeholders})`,
    envSources,
  );
  return rows[0]?.last_published_at ?? null;
}

// Affiliate posts log into affiliate_products.last_used_at (per-product)
// AND fb_posts.published_at (per-bài). Use whichever signal is freshest.
async function lastAffiliatePublished(): Promise<number | null> {
  const env = loadEnv();
  const rows = await d1Query<LastPostRow>(
    env,
    `SELECT MAX(last_used_at) AS last_published_at FROM affiliate_products WHERE last_used_at IS NOT NULL`,
  );
  return rows[0]?.last_published_at ?? null;
}

function runScript(scriptPath: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let buf = '';
    proc.stdout.on('data', (d) => { const s = d.toString(); buf += s; process.stdout.write(s); });
    proc.stderr.on('data', (d) => { const s = d.toString(); buf += s; process.stderr.write(s); });
    proc.on('exit', (code) => resolve({ ok: code === 0, output: buf }));
  });
}

async function main() {
  const env = loadEnv();
  const now = Math.floor(Date.now() / 1000);

  for (const p of PIPELINES) {
    let last: number | null = null;
    if (p.name === 'affiliate-post') {
      last = await lastAffiliatePublished();
    } else {
      last = await lastPublished(p.sources);
    }
    const ageSec = last ? now - last : Infinity;
    const ageHours = isFinite(ageSec) ? (ageSec / HOURS).toFixed(1) : '∞';
    console.log(`[${p.label}] last=${last ? new Date(last * 1000).toISOString() : 'never'}  age=${ageHours}h  overdue@${(p.overdueAfterSeconds / HOURS).toFixed(0)}h`);

    if (ageSec >= p.overdueAfterSeconds) {
      console.log(`  → OVERDUE: running ${p.script}…`);
      await tgSend(env, `🔔 Watchdog: *${p.label}* overdue (${ageHours}h) — auto-retrying…`);
      const { ok, output } = await runScript(p.script);
      const tail = output.split('\n').filter(Boolean).slice(-5).join('\n').slice(0, 600);
      if (ok) {
        await tgSend(env, `✅ Watchdog retry success: *${p.label}*\n\`\`\`\n${tail}\n\`\`\``);
      } else {
        await tgSend(env, `❌ Watchdog retry FAILED: *${p.label}*\n\`\`\`\n${tail}\n\`\`\``);
      }
    } else {
      console.log(`  → fresh, no action`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
