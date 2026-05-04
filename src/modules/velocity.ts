import type { Env, FbEvent } from '@/lib/env';
import { FbClient } from '@/fb/client';
import { classifyIntent } from '@/ai/intent';

// Module A — Engagement Velocity Engine
// Replies to incoming comments quickly to boost early-window engagement.
// Skips: bot's own replies, very short noise, comments under bot replies.
export async function runVelocity(
  event: Extract<FbEvent, { kind: 'comment' }>,
  env: Env,
): Promise<void> {
  // Don't reply to own page's comments
  if (event.fromId === env.FB_PAGE_ID) return;

  // Already seen this comment? skip (webhook can fire duplicates)
  const seen = await env.DB.prepare('SELECT bot_replied FROM comments WHERE id = ?')
    .bind(event.commentId)
    .first<{ bot_replied: number }>();
  if (seen?.bot_replied === 1) return;

  // Classify intent (cheap call, ~100 tokens)
  const intent = await classifyIntent(event.message, env);

  // Insert/update record
  await env.DB.prepare(
    `INSERT INTO comments (id, post_id, parent_id, from_id, from_name, message, created_time, intent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET intent = excluded.intent`,
  )
    .bind(
      event.commentId,
      event.postId,
      event.parentId ?? null,
      event.fromId,
      event.fromName ?? null,
      event.message,
      event.createdTime,
      intent,
    )
    .run();

  // SPAM intents: log only, don't reply
  if (intent === 'SPAM' || intent === 'PRICE') return;
  // PRICE is handled by funnel module — if we're here, funnel didn't match keyword

  const tpl = await pickTemplate(env, intent);
  if (!tpl) return;
  // Vietnamese names: address by given name (last word), not family name (first word).
  const firstName = event.fromName?.split(' ').slice(-1)[0] ?? 'bạn';
  const text = tpl.replace('{name}', firstName).replace(/\\n/g, '\n');

  // Random delay 30-90s to look natural. Workers can't sleep that long in a
  // single request — schedule via setTimeout-like pattern using waitUntil isn't
  // viable here. Instead we reply immediately; "natural delay" is achieved
  // because the queue itself adds 1-5s latency, and Workers don't replicate
  // human typing time anyway. Algorithm only cares about engagement *within*
  // the early window (first ~30 min), not millisecond timing.
  // Random 5-25s sleep so the reply doesn't look like an instant bot to FB's
  // spam filter (which has been observed to hide instant page replies).
  await new Promise((r) => setTimeout(r, 5000 + Math.floor(Math.random() * 20000)));
  const fb = new FbClient(env);
  try {
    const r = await fb.replyComment(event.commentId, text);
    await env.DB.prepare(
      'UPDATE comments SET bot_replied = 1, bot_reply_id = ?, bot_reply_text = ?, bot_reply_time = ? WHERE id = ?',
    )
      .bind(r.id, text, Math.floor(Date.now() / 1000), event.commentId)
      .run();
  } catch (err) {
    // FB returns errors for: deleted comment, page lacks permission, rate limit
    // We swallow and log — don't retry forever
    console.error('replyComment failed', String(err));
  }
}

async function pickTemplate(env: Env, intent: string): Promise<string | null> {
  const rows = await env.DB.prepare(
    'SELECT template, weight FROM reply_templates WHERE intent = ? AND active = 1',
  )
    .bind(intent)
    .all<{ template: string; weight: number }>();
  const list = rows.results ?? [];
  if (list.length === 0) return null;
  const total = list.reduce((s, r) => s + r.weight, 0);
  let pick = Math.floor(Math.random() * total);
  for (const r of list) {
    pick -= r.weight;
    if (pick < 0) return r.template;
  }
  return list[0]?.template ?? null;
}
