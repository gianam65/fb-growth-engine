import type { Env, FbEvent } from '@/lib/env';

// Records incoming Messenger DMs. Promotes lead status when user replies
// after we sent them a DM via the funnel.
export async function recordIncomingMessage(
  event: Extract<FbEvent, { kind: 'message' }>,
  env: Env,
): Promise<void> {
  // Page-sent messages also fire webhook; sender = page id means it's our outbound echo, ignore
  if (event.senderId === env.FB_PAGE_ID) return;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, thread_id, direction, source, text, sent_at)
     VALUES (?, ?, 'IN', 'DIRECT_INBOX', ?, ?)`,
  )
    .bind(event.mid, event.senderId, event.text ?? null, event.timestamp)
    .run();

  // Promote lead status if exists
  await env.DB.prepare(
    `UPDATE leads SET status = 'ENGAGED', updated_at = unixepoch() WHERE psid = ? AND status = 'NEW'`,
  )
    .bind(event.senderId)
    .run();
}
