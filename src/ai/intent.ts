import type { Env } from '@/lib/env';
import { geminiGenerate } from './gemini';

export type Intent = 'PRICE' | 'PRAISE' | 'QUESTION' | 'SPAM' | 'OTHER';

const INTENTS: Intent[] = ['PRICE', 'PRAISE', 'QUESTION', 'SPAM', 'OTHER'];

const SYSTEM = `You classify Facebook page comments for a Vietnamese home decor shop.
Return ONE of: PRICE, PRAISE, QUESTION, SPAM, OTHER.
- PRICE: asking price, cost, how to buy, where to buy, "giá", "bao nhiêu", "mua", "ship", "cod", "inbox shop"
- PRAISE: compliment, love, "đẹp quá", "thích quá", "iu", emojis only
- QUESTION: actual question about product (size, material, durability)
- SPAM: irrelevant ads, links, promoting other shops, suspicious offers
- OTHER: tagging a friend without text, generic, unclear

Reply with only the label, nothing else.`;

const SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    confidence: { type: 'number' },
  },
  required: ['intent'],
};

export async function classifyIntent(message: string, env: Env): Promise<Intent> {
  const trimmed = message.trim();

  // Cheap heuristic shortcut: very short or emoji-only → OTHER, skip API call
  if (trimmed.length === 0) return 'OTHER';
  if (trimmed.length <= 2) return 'OTHER';

  // Quick keyword fast-path (saves API calls on obvious cases)
  const lower = trimmed.toLowerCase();
  if (/giá|bao nhiêu|mua|ship|cod|inbox|báo giá|còn không|còn ko|cách đặt/.test(lower)) {
    return 'PRICE';
  }

  const start = Date.now();
  let intent: Intent = 'OTHER';
  let confidence = 0;
  try {
    const out = await geminiGenerate(env, `${SYSTEM}\n\nComment:\n"""${trimmed}"""`, {
      temperature: 0,
      maxOutputTokens: 40,
      jsonSchema: SCHEMA,
    });
    const parsed = JSON.parse(out) as { intent?: string; confidence?: number };
    if (parsed.intent && (INTENTS as string[]).includes(parsed.intent)) {
      intent = parsed.intent as Intent;
      confidence = parsed.confidence ?? 0;
    }
  } catch (err) {
    console.error('intent classify failed', String(err));
  }

  // Fire-and-forget log
  try {
    await env.DB.prepare(
      `INSERT INTO intent_logs (input_text, intent, confidence, model, latency_ms)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(trimmed.slice(0, 500), intent, confidence, env.GEMINI_MODEL, Date.now() - start)
      .run();
  } catch {
    // ignore log failure
  }

  return intent;
}
