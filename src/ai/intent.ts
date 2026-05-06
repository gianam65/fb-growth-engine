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
  const fullName = (fromName ?? '').trim();
  // Vietnamese given name = last word of full name. Single-word names ("Nam")
  // → fullName === firstName.
  const firstName = (fullName.split(' ').filter(Boolean).slice(-1)[0] || '').trim();
  const namePresent = fullName.length > 0;

  return `You are the friendly social media assistant for "Cozy Vibe", a Vietnamese cozy home decor Facebook page.

A user just commented on a post.
${namePresent
  ? `User's full name: "${fullName}"\nUser's first name (Vietnamese given name = last word): "${firstName}"`
  : `User name: not provided`}
Comment: """${message}"""

Classify the comment + generate a SHORT, friendly Vietnamese reply.

Intents:
- PRAISE: compliment / love / "đẹp quá" / "iu" / "thích" / past-tense purchase ("đã mua", "cũng mua") / emojis. Reply: thank them warmly.
- PRICE: explicit purchase intent ("giá bao nhiêu", "mua ở đâu", "muốn mua", "ship", "cod"). Reply: invite to inbox for price.
- QUESTION: real product question (size, material, durability, color options). Reply: defer to inbox tư vấn.
- SPAM: ads / links to other pages / "chéo follow" / suspicious. Reply: empty string.
- OTHER: tag a friend / vague / unclear. Reply: warm acknowledgement.

Reply guidance:
- Tone: warm, casual Vietnamese girl shop owner — NOT robotic
- Length: 1 short sentence, max 15 words
- 0-2 emojis allowed
${namePresent
  ? `- Address the user by their FIRST NAME ("${firstName}"). Examples: "${firstName} ơi, cảm ơn nha", "Dạ ${firstName}, shop inbox bạn nha", "Cảm ơn ${firstName} nhé". You may use the full name "${fullName}" once if it sounds natural; never address with empty/just "ơi".`
  : `- Address the user as "bạn" (no name given). Examples: "Cảm ơn bạn nha", "Dạ bạn ơi, shop inbox riêng nha".`}
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
    const fullName = (fromName ?? '').trim();
    const firstName = (fullName.split(' ').filter(Boolean).slice(-1)[0] || '').trim();
    const addr = firstName || 'bạn';
    return { intent: 'PRAISE', reply_text: `Cảm ơn ${addr} nha ❤️` };
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
