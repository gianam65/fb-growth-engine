// Daily cron: pull /{page-id}/insights and recent posts → write to D1.

import { d1Query, loadEnv, type ScriptEnv } from './lib';

interface InsightItem {
  name: string;
  values: Array<{ value: number | Record<string, number>; end_time?: string }>;
}

async function fbGet<T>(env: ScriptEnv, path: string): Promise<T> {
  const url = `https://graph.facebook.com/${env.FB_GRAPH_VERSION}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}access_token=${env.FB_PAGE_ACCESS_TOKEN}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`FB ${res.status} ${path}: ${text}`);
  return JSON.parse(text) as T;
}

async function pullPageInsights(env: ScriptEnv) {
  const metrics = [
    'page_fans',
    'page_fan_adds',
    'page_fan_removes',
    'page_impressions',
    'page_post_engagements',
  ].join(',');

  const data = await fbGet<{ data: InsightItem[] }>(
    env,
    `/${env.FB_PAGE_ID}/insights?metric=${metrics}&period=day`,
  );

  const get = (name: string): number => {
    const item = data.data.find((d) => d.name === name);
    const v = item?.values?.[item.values.length - 1]?.value;
    return typeof v === 'number' ? v : 0;
  };

  const today = new Date().toISOString().slice(0, 10);
  await d1Query(
    env,
    `INSERT INTO insights_daily (date, page_fans, page_fan_adds, page_fan_removes, page_impressions, page_engaged_users, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       page_fans = excluded.page_fans,
       page_fan_adds = excluded.page_fan_adds,
       page_fan_removes = excluded.page_fan_removes,
       page_impressions = excluded.page_impressions,
       page_engaged_users = excluded.page_engaged_users,
       raw = excluded.raw`,
    [
      today,
      get('page_fans'),
      get('page_fan_adds'),
      get('page_fan_removes'),
      get('page_impressions'),
      get('page_post_engagements'),
      JSON.stringify(data),
    ],
  );
  console.log('page insights saved', today);
}

async function pullPostInsights(env: ScriptEnv) {
  // Last 7 days of posts
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const posts = await fbGet<{
    data: Array<{ id: string; created_time: string; message?: string; attachments?: { data: Array<{ media_type?: string }> } }>;
  }>(env, `/${env.FB_PAGE_ID}/posts?fields=id,created_time,message,attachments{media_type}&since=${since}&limit=50`);

  const today = new Date().toISOString().slice(0, 10);

  for (const post of posts.data ?? []) {
    try {
      const ins = await fbGet<{ data: InsightItem[] }>(
        env,
        `/${post.id}/insights?metric=post_impressions,post_reactions_by_type_total,post_engaged_users`,
      );
      const get = (name: string): number => {
        const item = ins.data.find((d) => d.name === name);
        const v = item?.values?.[0]?.value;
        if (typeof v === 'number') return v;
        if (typeof v === 'object' && v !== null) {
          return Object.values(v).reduce((s, n) => s + (typeof n === 'number' ? n : 0), 0);
        }
        return 0;
      };

      const impressions = get('post_impressions');
      const reactions = get('post_reactions_by_type_total');
      const engaged = get('post_engaged_users');
      const postType = post.attachments?.data?.[0]?.media_type ?? 'status';

      await d1Query(
        env,
        `INSERT INTO post_insights (post_id, date, reach, impressions, reactions, engagement_rate, post_type, created_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_id, date) DO UPDATE SET
           reach = excluded.reach,
           impressions = excluded.impressions,
           reactions = excluded.reactions,
           engagement_rate = excluded.engagement_rate`,
        [
          post.id,
          today,
          engaged,
          impressions,
          reactions,
          impressions > 0 ? engaged / impressions : 0,
          postType,
          Math.floor(new Date(post.created_time).getTime() / 1000),
        ],
      );
    } catch (err) {
      console.error('post insight failed', post.id, String(err));
    }
  }
  console.log(`post insights saved for ${posts.data?.length ?? 0} posts`);
}

async function main() {
  const env = loadEnv();
  await pullPageInsights(env);
  await pullPostInsights(env);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
