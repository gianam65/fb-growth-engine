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

  // Quick keyword fast-path (saves API calls on obvious cases).
  // PRAISE check first — "đã mua / cũng mua" should beat the "mua" PRICE
  // signal (people who already bought are praising, not asking price).
  const lower = trimmed.toLowerCase();
  if (/đẹp|xinh|iu|yêu|thích|like|tim|chill|cute|ưng|mê|ghiền|ngầu|đỉnh|tuyệt|wow|ưa|❤️|💕|🥰|😍/.test(lower)) {
    return 'PRAISE';
  }
  // PRICE: only explicit purchase intent (not standalone "mua" which catches
  // past-tense "đã mua / cũng mua").
  if (/giá|bao nhiêu|báo giá|inbox shop|inbox riêng|còn không|còn ko|cách đặt|muốn mua|mua ở đâu|mua như nào|mua sao|mua thế nào|order|đặt hàng|cod\b|ship\b/.test(lower)) {
    return 'PRICE';
  }
  if (/\?|kích thước|size|chất liệu|material|làm bằng|dùng được|có sẵn|còn hàng|màu khác|loại khác/.test(lower)) {
    return 'QUESTION';
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
