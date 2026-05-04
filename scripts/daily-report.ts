// Daily Telegram report. Runs after pull-insights.

import { d1Query, loadEnv, tgSend } from './lib';

interface DailyRow {
  date: string;
  page_fans: number;
  page_fan_adds: number;
  page_fan_removes: number;
  page_impressions: number;
  page_engaged_users: number;
}

interface TopPost {
  post_id: string;
  reach: number;
  reactions: number;
  engagement_rate: number;
  post_type: string;
}

interface FunnelStat {
  count: number;
  intent: string;
}

async function main() {
  const env = loadEnv();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log('Telegram not configured, skipping');
    return;
  }

  const todayRows = await d1Query<DailyRow>(env, `SELECT * FROM insights_daily ORDER BY date DESC LIMIT 2`);
  const today = todayRows[0];
  const yesterday = todayRows[1];

  const topPosts = await d1Query<TopPost>(
    env,
    `SELECT post_id, reach, reactions, engagement_rate, post_type
     FROM post_insights
     WHERE date = (SELECT MAX(date) FROM post_insights)
     ORDER BY engagement_rate DESC LIMIT 3`,
  );

  const funnelStats = await d1Query<FunnelStat>(
    env,
    `SELECT COUNT(*) as count, intent FROM comments
     WHERE created_time >= unixepoch() - 86400
     GROUP BY intent`,
  );

  const newLeads = await d1Query<{ count: number }>(
    env,
    `SELECT COUNT(*) as count FROM leads WHERE inserted_at >= unixepoch() - 86400`,
  );

  const lines: string[] = [];
  lines.push(`📊 *Daily Report — ${today?.date ?? new Date().toISOString().slice(0, 10)}*`);
  lines.push('');
  if (today) {
    const fanDelta = (today.page_fan_adds ?? 0) - (today.page_fan_removes ?? 0);
    const arrow = fanDelta > 0 ? '📈' : fanDelta < 0 ? '📉' : '➡️';
    lines.push(`*Followers:* ${today.page_fans} (${arrow} ${fanDelta >= 0 ? '+' : ''}${fanDelta} today)`);
    lines.push(`*Reach:* ${today.page_impressions ?? 0}`);
    lines.push(`*Engaged:* ${today.page_engaged_users ?? 0}`);
    if (yesterday) {
      const reachDelta = (today.page_impressions ?? 0) - (yesterday.page_impressions ?? 0);
      lines.push(`_(reach Δ vs yesterday: ${reachDelta >= 0 ? '+' : ''}${reachDelta})_`);
    }
  } else {
    lines.push('_No data yet_');
  }

  lines.push('');
  lines.push(`*Top posts (last pull):*`);
  if (topPosts.length === 0) {
    lines.push('_no posts_');
  } else {
    for (const p of topPosts) {
      const erPct = (p.engagement_rate * 100).toFixed(2);
      lines.push(`• \`${p.post_id.slice(-12)}\` [${p.post_type}] reach=${p.reach} react=${p.reactions} ER=${erPct}%`);
    }
  }

  lines.push('');
  lines.push(`*Comments (24h):*`);
  if (funnelStats.length === 0) {
    lines.push('_none_');
  } else {
    for (const s of funnelStats) lines.push(`• ${s.intent}: ${s.count}`);
  }

  lines.push('');
  lines.push(`*New leads (24h):* ${newLeads[0]?.count ?? 0}`);

  await tgSend(env, lines.join('\n'));
  console.log('report sent');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
