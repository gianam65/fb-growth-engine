import type { Env } from '@/lib/env';
import { geminiGenerate } from './gemini';

export type Intent = 'PRICE' | 'PRAISE' | 'QUESTION' | 'SPAM' | 'OTHER';

const INTENTS: Intent[] = ['PRICE', 'PRAISE', 'QUESTION', 'SPAM', 'OTHER'];

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    reply_text: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['intent', 'reply_text'],
};

function buildPrompt(message: string, fromName?: string): string {
  const name = fromName?.split(' ').slice(-1)[0] ?? 'bạn';
  return `You are the friendly social media assistant for "Cozy Vibe", a Vietnamese cozy home decor Facebook page.

A user just commented on a post.
First name: "${name}"
Comment: """${message}"""

Classify the comment + generate a SHORT, friendly Vietnamese reply.

Intents:
- PRAISE: compliment / love / "đẹp quá" / "iu" / "thích" / past-tense purchase ("đã mua", "cũng mua") / emojis. Reply: thank them warmly.
- PRICE: explicit purchase intent ("giá bao nhiêu", "mua ở đâu", "muốn mua", "ship", "cod"). Reply: invite to inbox for price.
- QUESTION: real product question (size, material, durability, color options). Reply: defer to inbox tư vấn.
- SPAM: ads / links to other pages / "chéo follow" / suspicious. Reply: empty string.
- OTHER: tag a friend / vague / unclear. Reply: warm acknowledgement.

Reply guidance:
- Address by first name when natural ("${name} ơi", "Dạ ${name}")
- Tone: warm, casual Vietnamese girl shop owner — NOT robotic
- Length: 1 short sentence, max 15 words
- 0-2 emojis allowed
- Do NOT mention specific products, prices, or commitments
- Do NOT echo the comment text
- For SPAM: reply_text MUST be empty string

Output JSON only with intent + reply_text.`;
}

export interface CommentReply {
  intent: Intent;
  reply_text: string;  // empty if SPAM or no reply needed
  confidence?: number;
}

/**
 * Single Gemini call: classify the comment AND generate a personalized reply.
 * Replaces the old regex-based classifyIntent + template-based pickTemplate flow.
 */
export async function classifyAndReply(
  message: string,
  fromName: string | undefined,
  env: Env,
): Promise<CommentReply> {
  const trimmed = message.trim();

  // Edge case: empty / 1-2 char (just emoji) → OTHER, skip API call
  if (trimmed.length === 0) return { intent: 'OTHER', reply_text: '' };
  if (trimmed.length <= 2) {
    const name = fromName?.split(' ').slice(-1)[0] ?? 'bạn';
    return { intent: 'PRAISE', reply_text: `Cảm ơn ${name} nha ❤️` };
  }

  const start = Date.now();
  try {
    const out = await geminiGenerate(env, buildPrompt(trimmed, fromName), {
      temperature: 0.6,
      maxOutputTokens: 200,
      jsonSchema: REPLY_SCHEMA,
    });
    const parsed = JSON.parse(out) as { intent?: string; reply_text?: string; confidence?: number };
    const intent: Intent = (INTENTS as string[]).includes(parsed.intent ?? '')
      ? (parsed.intent as Intent)
      : 'OTHER';
    const reply_text = (parsed.reply_text ?? '').trim();

    // Fire-and-forget log
    try {
      await env.DB.prepare(
        `INSERT INTO intent_logs (input_text, intent, confidence, model, latency_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(trimmed.slice(0, 500), intent, parsed.confidence ?? 0, env.GEMINI_MODEL, Date.now() - start)
        .run();
    } catch { /* ignore log failure */ }

    return { intent, reply_text, confidence: parsed.confidence };
  } catch (err) {
    console.error('classifyAndReply failed', String(err));
    return { intent: 'OTHER', reply_text: '' };
  }
}

// Backward-compatible export for funnel.ts (only needs intent label).
export async function classifyIntent(message: string, env: Env): Promise<Intent> {
  const r = await classifyAndReply(message, undefined, env);
  return r.intent;
}
