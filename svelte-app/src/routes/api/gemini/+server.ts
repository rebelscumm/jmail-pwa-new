export const prerender = false;

import type { RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

type BatchItem = { id: string; text: string };

// In-memory cache for cachedContents IDs (best-effort only; Functions may recycle)
const cachedMap = new Map<string, { name: string; expiresAt: number }>();

async function ensureCachedContent(displayName: string, text: string, apiKey: string, model: string, ttlSeconds = 7 * 24 * 60 * 60): Promise<string | null> {
  try {
    const key = `${displayName}:${model}:${text.length}:${hash(text)}`;
    const existing = cachedMap.get(key);
    const now = Math.floor(Date.now() / 1000);
    if (existing && existing.expiresAt > now + 60) return existing.name;
    const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${encodeURIComponent(apiKey)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName,
        model: `models/${model}`.includes('models/') ? model : `models/${model}`,
        contents: [{ role: 'user', parts: [{ text }] }],
        ttl: { seconds: ttlSeconds }
      })
    });
    if (!r.ok) {
      // best-effort: ignore caching failures
      return null;
    }
    const data = await r.json().catch(() => ({} as any));
    const name: string | undefined = data?.name; // e.g., "cachedContents/xxx"
    if (name) {
      cachedMap.set(key, { name, expiresAt: now + ttlSeconds });
      return name;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

async function callGeminiGenerate(text: string, apiKey: string, model: string, useCache: boolean, mode: 'summary' | 'subject' = 'summary'): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const style = mode === 'summary'
    ? `You are a concise assistant. Provide a short bullet list of the most important points in this email, most important first. If attachments are included in the text, include 1-2 bullets for each attachment summarizing its key content. If an attachment's content is not provided, mention the attachment name/type without inventing details. Keep it under 8 bullets total. Return ONLY the list as plain text with '-' bullets, no preamble or closing sentences, no code blocks, and no additional commentary.`
    : `You improve email subjects using the actual email content. Write a single-line subject that better summarizes the most important point(s). Use 15 words or fewer. Avoid prefixes like "Re:" or "Fwd:", avoid quotes, emojis, sender names, or dates. Return ONLY the subject text as plain text on one line.`;
  const cacheKey = mode === 'summary' ? 'jmail:summary-style' : 'jmail:subject-style';
  const cachedName = useCache ? await ensureCachedContent(cacheKey, style, apiKey, model, 14 * 24 * 60 * 60) : null;
  const parts: any[] = [];
  if (cachedName) parts.push({ cachedContent: cachedName }); else parts.push({ text: style });
  if (mode === 'summary') {
    parts.push({ text: `\n\nEmail:\n${text}` });
  } else {
    // Subject mode supports either full email or an AI summary block
    // If the provided text contains an "AI Summary:" block, prefer that to save tokens
    if (/AI Summary:/i.test(text)) {
      parts.push({ text: `\n\n${text}` });
    } else {
      const segments = (text || '').split(/\r?\n\r?\n/);
      const subjectLine = (segments[0] || '').trim();
      const body = segments.slice(1).join('\n\n').trim();
      if (subjectLine) parts.push({ text: `\n\nSubject: ${subjectLine}` });
      if (body) parts.push({ text: `\n\nEmail:\n${body}` }); else if (!subjectLine) parts.push({ text: `\n\nEmail:\n${text}` });
    }
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2 } })
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => '');
    throw new Error(`Gemini error ${r.status}: ${msg.slice(0, 200)}`);
  }
  const data = await r.json().catch(() => ({} as any));
  const textOut = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  return textOut || '';
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(Math.max(1, limit), Math.max(1, items.length))).fill(0).map(async () => {
    while (true) {
      const current = idx++;
      if (current >= items.length) break;
      results[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const action = String(body?.action || 'summarize_batch');
  const items = (Array.isArray(body?.items) ? body.items : []) as BatchItem[];
  const model = (body?.model as string) || 'gemini-1.5-flash';
  const useCache = !!body?.useCache;
  const inlineKey = (body?.apiKey as string | undefined) || undefined;
  const apiKey = env.GOOGLE_API_KEY || (inlineKey ? String(inlineKey) : '');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'GOOGLE_API_KEY not set' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  if (!items.length) {
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Best-effort parallel online generation (fallback when Batch Mode isn't available)
  try {
    if (action === 'summarize_batch') {
      const out = await mapWithConcurrency(items, 4, async (it) => {
        const text = await callGeminiGenerate(it.text || '', apiKey, model, useCache, 'summary');
        return { id: it.id, text };
      });
      return new Response(JSON.stringify({ results: out, map: Object.fromEntries(out.map((r) => [r.id, r.text])) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } else if (action === 'subject_batch') {
      const out = await mapWithConcurrency(items, 4, async (it) => {
        const text = await callGeminiGenerate(it.text || '', apiKey, model, useCache, 'subject');
        return { id: it.id, text };
      });
      return new Response(JSON.stringify({ results: out, map: Object.fromEntries(out.map((r) => [r.id, r.text])) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};


