import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { redactPII, htmlToText } from './redact';

export type AIResult = { text: string };

export class AIProviderError extends Error {
  provider: 'openai' | 'anthropic' | 'gemini' | 'unknown';
  status: number;
  headers?: Record<string, string | null>;
  body?: unknown;
  requestId?: string | null;
  retryAfterSeconds?: number | null;
  constructor(opts: {
    provider: 'openai' | 'anthropic' | 'gemini' | 'unknown';
    message: string;
    status: number;
    headers?: Record<string, string | null>;
    body?: unknown;
  }) {
    super(opts.message);
    this.name = 'AIProviderError';
    this.provider = opts.provider;
    this.status = opts.status;
    this.headers = opts.headers;
    this.body = opts.body;
    this.requestId = (opts.headers && (opts.headers['x-request-id'] || null)) || null;
    const ra = opts.headers && opts.headers['retry-after'];
    const n = typeof ra === 'string' ? Number(ra) : null;
    this.retryAfterSeconds = Number.isFinite(n as number) ? (n as number) : null;
  }
}

export function getFriendlyAIErrorMessage(e: unknown, actionLabel?: string): { message: string; retryAfterSeconds?: number | null } {
  const action = actionLabel ? `${actionLabel}: ` : '';
  try {
    if (e instanceof AIProviderError) {
      if (e.status === 429) {
        const wait = e.retryAfterSeconds;
        const waitMsg = Number.isFinite(wait as number) && (wait as number)! > 0 ? ` Wait ~${wait}s and try again.` : '';
        return { message: `${action}AI is rate limited. Please try again shortly.${waitMsg}`, retryAfterSeconds: wait };
      }
      if (e.status >= 500 && e.status <= 599) {
        return { message: `${action}The AI service is temporarily unavailable. Please try again.` };
      }
      return { message: `${action}${e.message || 'AI request failed.'}` };
    }
    if (e instanceof Error) return { message: `${action}${e.message}` };
    return { message: `${action}${String(e)}` };
  } catch (_) {
    return { message: `${action}Something went wrong with the AI request.` };
  }
}

async function safeParseJson(res: Response): Promise<any> {
  try {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      return {};
    }
  } catch (_) {
    return {};
  }
}

function getOpenAIRateLimitHeaders(res: Response): Record<string, string | null> {
  const h = res.headers;
  return {
    'x-ratelimit-limit-requests': h.get('x-ratelimit-limit-requests'),
    'x-ratelimit-remaining-requests': h.get('x-ratelimit-remaining-requests'),
    'x-ratelimit-limit-tokens': h.get('x-ratelimit-limit-tokens'),
    'x-ratelimit-remaining-tokens': h.get('x-ratelimit-remaining-tokens'),
    'retry-after': h.get('retry-after'),
    'x-request-id': h.get('x-request-id') || h.get('openai-request-id')
  };
}

async function callOpenAI(prompt: string, modelOverride?: string): Promise<AIResult> {
  const s = get(settings);
  const model = modelOverride || s.aiModel || 'gpt-4o-mini';
  const url = '/api/openai';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2, apiKey: s.aiApiKey || undefined })
  });
  if (!res.ok) {
    const headers = getOpenAIRateLimitHeaders(res);
    let body: any = undefined;
    let textFallback: string | undefined = undefined;
    try {
      body = await res.clone().json();
    } catch (_) {
      try { textFallback = await res.clone().text(); } catch (_) { /* ignore */ }
    }

    const errorCode = typeof body?.error?.code === 'string' ? body.error.code : undefined;
    const errorMessageFromBody = typeof body?.error?.message === 'string' ? body.error.message : undefined;

    let baseMsg = `OpenAI error ${res.status}`;
    if (res.status === 429 && errorCode === 'insufficient_quota') {
      baseMsg = 'OpenAI insufficient quota';
    } else if (res.status === 401 || errorCode === 'invalid_api_key') {
      baseMsg = 'OpenAI invalid API key';
    } else if (res.status === 429) {
      baseMsg = 'OpenAI rate limit exceeded';
    } else if (errorMessageFromBody) {
      baseMsg = `OpenAI error ${res.status}: ${errorMessageFromBody}`;
    }

    throw new AIProviderError({ provider: 'openai', message: baseMsg, status: res.status, headers, body: body ?? textFallback });
  }
  const data = await safeParseJson(res);
  const text = data?.choices?.[0]?.message?.content?.trim?.() || '';
  return { text };
}

async function callAnthropic(prompt: string, modelOverride?: string): Promise<AIResult> {
  const s = get(settings);
  const key = s.aiApiKey || '';
  const model = modelOverride || s.aiModel || 'claude-3-haiku-20240307';
  const url = 'https://api.anthropic.com/v1/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) {
    let body: any = undefined;
    try { body = await res.clone().json(); } catch (_) { try { body = await res.clone().text(); } catch (_) { body = undefined; } }
    const message = res.status === 429 ? 'Anthropic rate limit exceeded' : `Anthropic error ${res.status}`;
    throw new AIProviderError({ provider: 'anthropic', message, status: res.status, headers: {}, body });
  }
  const data = await safeParseJson(res);
  const text = data?.content?.[0]?.text?.trim?.() || '';
  return { text };
}

async function callGemini(prompt: string, modelOverride?: string): Promise<AIResult> {
  const s = get(settings);
  const key = s.aiApiKey || '';
  const model = modelOverride || s.aiModel || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!res.ok) {
    let body: any = undefined;
    try { body = await res.clone().json(); } catch (_) { try { body = await res.clone().text(); } catch (_) { body = undefined; } }
    const message = res.status === 429 ? 'Gemini rate limit exceeded' : `Gemini error ${res.status}`;
    throw new AIProviderError({ provider: 'gemini', message, status: res.status, headers: {}, body });
  }
  const data = await safeParseJson(res);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim?.() || '';
  return { text };
}

export async function aiSummarizeEmail(subject: string, bodyText?: string, bodyHtml?: string): Promise<string> {
  const s = get(settings);
  const hasBody = !!(bodyText || bodyHtml);
  const text = bodyText || htmlToText(bodyHtml) || '';
  const redacted = redactPII(text ? `${subject}\n\n${text}` : `${subject}`);
  const prompt = hasBody
    ? `You are a concise assistant. Provide a short bullet list of the most important points in this email, most important first. Keep it under 6 bullets. Return ONLY the list as plain text with '-' bullets, no preamble or closing sentences, no code blocks, and no additional commentary.\n\nEmail:\n${redacted}`
    : `You are a concise assistant. Write a single-line subject summary of this email thread using 15 words or fewer. Return ONLY the summary as plain text on one line, with no bullets, no quotes, no preamble, and no code blocks.\n\nSubject:\n${redacted}`;
  const provider = s.aiProvider || 'gemini';
  const model = s.aiSummaryModel || s.aiModel || (provider === 'gemini' ? 'gemini-2.5-flash-lite' : provider === 'anthropic' ? 'claude-3-haiku-20240307' : 'gpt-4o-mini');
  const out = provider === 'anthropic' ? await callAnthropic(prompt, model) : provider === 'gemini' ? await callGemini(prompt, model) : await callOpenAI(prompt, model);
  let result = out.text || '';
  if (!hasBody) {
    // Normalize and hard-cap at 15 words as a safety net
    result = result.replace(/^[\s\-•]+/, '').replace(/\s+/g, ' ').trim();
    const words = result.split(/\s+/).filter(Boolean);
    if (words.length > 15) result = words.slice(0, 15).join(' ');
  }
  return result;
}

export async function aiSummarizeSubject(subject: string, bodyText?: string, bodyHtml?: string): Promise<string> {
  const s = get(settings);
  const text = bodyText || htmlToText(bodyHtml) || '';
  const redacted = redactPII(text ? `Subject: ${subject}\n\nEmail:\n${text}` : `Subject: ${subject}`);
  const prompt = `You improve email subjects using the actual email content. Write a single-line subject that better summarizes the most important point(s). Use 15 words or fewer. Avoid prefixes like "Re:" or "Fwd:", avoid quotes, emojis, sender names, or dates. Return ONLY the subject text as plain text on one line.\n\n${redacted}`;
  const provider = s.aiProvider || 'gemini';
  const model = s.aiSummaryModel || s.aiModel || (provider === 'gemini' ? 'gemini-2.5-flash-lite' : provider === 'anthropic' ? 'claude-3-haiku-20240307' : 'gpt-4o-mini');
  const out = provider === 'anthropic' ? await callAnthropic(prompt, model) : provider === 'gemini' ? await callGemini(prompt, model) : await callOpenAI(prompt, model);
  let result = out.text || '';
  // Normalize and hard-cap at 15 words
  result = result.replace(/^[\s\-•]+/, '').replace(/\s+/g, ' ').trim();
  const words = result.split(/\s+/).filter(Boolean);
  if (words.length > 15) result = words.slice(0, 15).join(' ');
  return result || subject || '';
}

export async function aiDraftReply(subject: string, bodyText?: string, bodyHtml?: string): Promise<string> {
  const s = get(settings);
  const text = bodyText || htmlToText(bodyHtml) || '';
  const redacted = redactPII(`${subject}\n\n${text}`);
  const prompt = `Write a brief, polite email reply in plain text. Include a short greeting and a concise closing. Keep it under 120 words. Do not include the original message, disclaimers, markdown, or code blocks. Return ONLY the reply body.\nSubject: ${subject}\nEmail:\n${redacted}`;
  const provider = s.aiProvider || 'gemini';
  const model = s.aiDraftModel || s.aiModel || (provider === 'gemini' ? 'gemini-2.5-pro' : provider === 'anthropic' ? 'claude-3-haiku-20240307' : 'gpt-4o-mini');
  const out = provider === 'anthropic' ? await callAnthropic(prompt, model) : provider === 'gemini' ? await callGemini(prompt, model) : await callOpenAI(prompt, model);
  return out.text;
}

export function findUnsubscribeTarget(headers?: Record<string,string>, html?: string): string | null {
  const listUnsub = headers?.['List-Unsubscribe'] || headers?.['List-Unsubscribe-Post'];
  if (listUnsub) {
    const matches = listUnsub.match(/<([^>]+)>/g) || [];
    for (const m of matches) {
      const url = m.slice(1,-1);
      if (url.startsWith('http')) return url;
      if (url.startsWith('mailto:')) return url;
    }
  }
  if (html) {
    const m = html.match(/href\s*=\s*"(https?:[^"']*unsubscribe[^"']*)"/i);
    if (m) return m[1];
  }
  return null;
}

export async function aiExtractUnsubscribeUrl(subject: string, bodyText?: string, bodyHtml?: string): Promise<string | null> {
  const s = get(settings);
  const text = bodyText || htmlToText(bodyHtml) || '';
  const redacted = redactPII(`${subject}\n\n${text}`);
  const prompt = `From the following email content, extract a single unsubscribe URL or mailto link if present. Respond with ONLY the URL, nothing else. If none is present, respond with "NONE".\n\n${redacted}`;
  const provider = s.aiProvider || 'gemini';
  const out = provider === 'anthropic' ? await callAnthropic(prompt) : provider === 'gemini' ? await callGemini(prompt) : await callOpenAI(prompt);
  const line = (out.text || '').trim();
  if (!line || /^none$/i.test(line)) return null;
  if (/^(https?:|mailto:)/i.test(line)) return line;
  const match = line.match(/(https?:[^\s]+|mailto:[^\s]+)/i);
  return match ? match[1] : null;
}


