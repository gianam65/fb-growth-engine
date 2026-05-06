import type { Env, FbEvent } from '@/lib/env';
import { handleWebhook } from '@/fb/webhook';
import { handleEvent } from '@/consumer';
import { makeLogger } from '@/lib/logger';
import { handleAdminCurate } from '@/admin/curate';
import { handleAdminPinterest } from '@/admin/pinterest';
import { handleAdminAdd } from '@/admin/add';
import { handleAdminAffiliate } from '@/admin/affiliate';
import { handleTelegramWebhook } from '@/telegram/webhook';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/webhook') return handleWebhook(req, env);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname.startsWith('/admin/curate')) return handleAdminCurate(req, env);
    if (url.pathname.startsWith('/admin/pinterest')) return handleAdminPinterest(req, env);
    if (url.pathname.startsWith('/admin/add')) return handleAdminAdd(req, env);
    if (url.pathname.startsWith('/admin/affiliate')) return handleAdminAffiliate(req, env);
    if (url.pathname === '/telegram/webhook') return handleTelegramWebhook(req, env);
    return new Response('not found', { status: 404 });
  },

  async queue(batch: MessageBatch<FbEvent>, env: Env): Promise<void> {
    const log = makeLogger(env.LOG_LEVEL);
    for (const msg of batch.messages) {
      try {
        await handleEvent(msg.body, env);
        msg.ack();
      } catch (err) {
        log.error('event handler failed', { err: String(err), event: msg.body });
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, FbEvent>;
