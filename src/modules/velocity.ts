import type { Env, FbEvent } from '@/lib/env';
import { FbClient } from '@/fb/client';
import { classifyAndReply } from '@/ai/intent';

// Module A — Engagement Velocity Engine
// Replies to incoming comments quickly to boost early-window engagement.
// Single Gemini call per comment: classifies intent + generates a personalized
// Vietnamese reply (no static templates — every reply is unique).
// Skips: bot's own replies, duplicates (already replied), SPAM intents.
export async function runVelocity(
  event: Extract<FbEvent, { kind: 'comment' }>,
  env: Env,
): Promise<void> {
  // Don't reply to own page's comments
  if (event.fromId === env.FB_PAGE_ID) return;

  // Already seen this comment? skip (webhook can fire duplicates / funnel
  // module may have already replied → bot_replied = 1)
  const seen = await env.DB.prepare('SELECT bot_replied FROM comments WHERE id = ?')
    .bind(event.commentId)
    .first<{ bot_replied: number }>();
  if (seen?.bot_replied === 1) return;

  // AI classifies + generates reply in one call
  const ai = await classifyAndReply(event.message, event.fromName, env);

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
      ai.intent,
    )
    .run();

  // SPAM or empty AI reply → log only
  if (ai.intent === 'SPAM' || !ai.reply_text) return;

  const text = ai.reply_text;

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
