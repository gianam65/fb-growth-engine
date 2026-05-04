import type { Env, FbEvent } from '@/lib/env';
import { verifySignature } from './verify';

// Parse FB webhook payload into typed events.
// Docs: https://developers.facebook.com/docs/graph-api/webhooks/reference/page
export function parseEvents(payload: unknown): FbEvent[] {
  const out: FbEvent[] = [];
  const root = payload as { object?: string; entry?: unknown[] };
  if (!root || root.object !== 'page' || !Array.isArray(root.entry)) return out;

  for (const entry of root.entry) {
    const e = entry as {
      id?: string;
      changes?: Array<{ field?: string; value?: unknown }>;
      messaging?: Array<unknown>;
    };

    // Page feed events (comments, posts, reactions)
    if (Array.isArray(e.changes)) {
      for (const ch of e.changes) {
        if (ch.field !== 'feed') continue;
        const v = ch.value as {
          item?: string;
          verb?: string;
          comment_id?: string;
          post_id?: string;
          parent_id?: string;
          from?: { id?: string; name?: string };
          message?: string;
          created_time?: number;
        };
        if (v.item === 'comment' && v.verb === 'add' && v.comment_id && v.post_id && v.from?.id) {
          out.push({
            kind: 'comment',
            postId: v.post_id,
            commentId: v.comment_id,
            fromId: v.from.id,
            fromName: v.from.name,
            message: v.message ?? '',
            createdTime: v.created_time ?? Math.floor(Date.now() / 1000),
            parentId: v.parent_id,
          });
        } else {
          out.push({ kind: 'feed_other', raw: ch });
        }
      }
    }

    // Messenger events
    if (Array.isArray(e.messaging)) {
      for (const m of e.messaging) {
        const mm = m as {
          sender?: { id?: string };
          recipient?: { id?: string };
          timestamp?: number;
          message?: { mid?: string; text?: string };
        };
        if (mm.message?.mid && mm.sender?.id && mm.recipient?.id) {
          out.push({
            kind: 'message',
            senderId: mm.sender.id,
            recipientId: mm.recipient.id,
            mid: mm.message.mid,
            text: mm.message.text,
            timestamp: mm.timestamp ?? Date.now(),
          });
        }
      }
    }
  }
  return out;
}

export async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  // Verification handshake (FB calls GET once when subscribing)
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === env.FB_VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('forbidden', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const rawBody = await req.text();
  const ok = await verifySignature(rawBody, req.headers.get('x-hub-signature-256'), env.FB_APP_SECRET);
  if (!ok) return new Response('bad signature', { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('bad json', { status: 400 });
  }

  const events = parseEvents(payload);
  if (events.length > 0) {
    // Push each event to the queue. Workers can sendBatch up to 100 messages.
    await env.EVENTS.sendBatch(events.map((e) => ({ body: e })));
  }

  // Always return 200 quickly so FB doesn't retry.
  return new Response('ok', { status: 200 });
}
