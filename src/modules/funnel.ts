import type { Env, FbEvent } from '@/lib/env';
import { FbClient } from '@/fb/client';

// Module B — Comment-to-DM funnel.
// Returns true if the comment matched a keyword trigger and was handled.
// Caller should NOT also run velocity reply.
export async function runFunnel(
  event: Extract<FbEvent, { kind: 'comment' }>,
  env: Env,
): Promise<boolean> {
  if (event.fromId === env.FB_PAGE_ID) return false;
  if (!event.message) return false;

  const lower = event.message.toLowerCase();
  const triggers = await env.DB.prepare(
    'SELECT id, keyword, reply_public, dm_template, dm_attachment_url FROM funnel_triggers WHERE active = 1',
  ).all<{ id: number; keyword: string; reply_public: string | null; dm_template: string; dm_attachment_url: string | null }>();

  const match = (triggers.results ?? []).find((t) => lower.includes(t.keyword.toLowerCase()));
  if (!match) return false;

  // Log the comment first so we have a record even if FB API calls fail.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO comments (id, post_id, parent_id, from_id, from_name, message, created_time, intent)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PRICE')`,
  )
    .bind(
      event.commentId,
      event.postId,
      event.parentId ?? null,
      event.fromId,
      event.fromName ?? null,
      event.message,
      event.createdTime,
    )
    .run();

  const fb = new FbClient(env);
  const firstName = event.fromName?.split(' ').slice(-1)[0] ?? 'bạn';
  // Templates stored in DB use literal '\n' chars (SQL doesn't unescape) — convert to real newlines.
  const dmBody = match.dm_template.replace('{name}', firstName).replace(/\\n/g, '\n');
  const publicText = (match.reply_public ?? '').replace(/\\n/g, '\n');

  // 1. Public reply (creates social proof + tells user to check inbox)
  let publicReplyId: string | undefined;
  if (publicText) {
    try {
      const r = await fb.replyComment(event.commentId, publicText);
      publicReplyId = r.id;
    } catch (err) {
      console.error('funnel public reply failed', String(err));
    }
  }

  // 2. Private reply via Send API (uses comment_id, opens 24h window)
  let messageId: string | undefined;
  try {
    const sent = await fb.sendPrivateReplyToComment(event.commentId, dmBody);
    messageId = sent.message_id;
  } catch (err) {
    // Common failures: page lacks pages_messaging perm in dev mode for non-admins,
    // user has previously blocked the page, comment older than 7 days,
    // fake comment id (test webhook script).
    console.error('funnel private reply failed', String(err));
  }

  // Update comment record with bot_replied flag and reply id
  if (publicReplyId) {
    await env.DB.prepare(
      `UPDATE comments SET bot_replied = 1, bot_reply_id = ?, bot_reply_text = ?, bot_reply_time = ? WHERE id = ?`,
    )
      .bind(publicReplyId, publicText, Math.floor(Date.now() / 1000), event.commentId)
      .run();
  }

  if (messageId) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO messages (id, thread_id, direction, source, comment_id, text, sent_at)
       VALUES (?, ?, 'OUT', 'COMMENT_TO_DM', ?, ?, ?)`,
    )
      .bind(messageId, event.fromId, event.commentId, dmBody, Math.floor(Date.now() / 1000))
      .run();
  }

  // Upsert lead regardless of FB API outcome — we still know they expressed intent.
  await env.DB.prepare(
    `INSERT INTO leads (psid, name, source_post_id, source_comment_id, first_intent)
     VALUES (?, ?, ?, ?, 'PRICE')
     ON CONFLICT(psid) DO UPDATE SET updated_at = unixepoch()`,
  )
    .bind(event.fromId, event.fromName ?? null, event.postId, event.commentId)
    .run();

  return true;
}
