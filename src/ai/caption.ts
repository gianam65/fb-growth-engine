import type { Env } from '@/lib/env';
import { geminiGenerate } from './gemini';

const SYSTEM = `You write Facebook Reels captions for a Vietnamese home decor shop.
Voice: warm, friendly, lowercase Vietnamese, lots of natural emoji, NO exclamation overload.
Goals:
1. Hook in first line (<60 chars) — make user stop scroll
2. Mention the product type or vibe
3. Soft CTA at end: "comment GIÁ để nhận bảng giá" or "lưu lại nha"
4. 5-8 hashtags at the end, mix Vietnamese + English

Generate 3 distinct caption variants (A/B/C). Different hooks. Output JSON only.`;

const SCHEMA = {
  type: 'object',
  properties: {
    variants: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          caption: { type: 'string' },
          hashtags: { type: 'string' },
        },
        required: ['caption', 'hashtags'],
      },
    },
  },
  required: ['variants'],
};

export interface CaptionVariant {
  caption: string;
  hashtags: string;
}

export async function generateCaptions(
  env: Env,
  videoBrief: string,
): Promise<CaptionVariant[]> {
  const out = await geminiGenerate(
    env,
    `${SYSTEM}\n\nVideo brief:\n"""${videoBrief}"""`,
    { temperature: 0.8, maxOutputTokens: 1024, jsonSchema: SCHEMA },
  );
  const parsed = JSON.parse(out) as { variants: CaptionVariant[] };
  return parsed.variants;
}
