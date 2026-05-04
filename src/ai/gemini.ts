import type { Env } from '@/lib/env';

// Minimal Gemini client over REST (no SDK to keep Workers bundle small).
// Docs: https://ai.google.dev/api/generate-content
export async function geminiGenerate(
  env: Env,
  prompt: string,
  opts: { temperature?: number; jsonSchema?: object; maxOutputTokens?: number } = {},
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 256,
      ...(opts.jsonSchema
        ? { responseMimeType: 'application/json', responseSchema: opts.jsonSchema }
        : {}),
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text}`);
  const json = JSON.parse(text) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}
