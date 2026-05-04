import type { Env, FbEvent } from '@/lib/env';
import { runVelocity } from '@/modules/velocity';
import { runFunnel } from '@/modules/funnel';
import { recordIncomingMessage } from '@/modules/messages';

export async function handleEvent(event: FbEvent, env: Env): Promise<void> {
  switch (event.kind) {
    case 'comment': {
      // Funnel runs first — if a keyword matches, it owns the comment
      // (replies + sends DM). Velocity is the fallback for everything else.
      const handled = await runFunnel(event, env);
      if (!handled) await runVelocity(event, env);
      return;
    }
    case 'message': {
      await recordIncomingMessage(event, env);
      return;
    }
    case 'feed_other':
      // Reactions, post edits, etc — log and ignore for now
      return;
  }
}
