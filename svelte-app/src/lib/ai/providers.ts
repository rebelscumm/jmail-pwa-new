import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { redactPII, htmlToText } from './redact';
import type { GmailAttachment } from '$lib/types';
import { getDB } from '$lib/db';

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

// Persist providerState across reloads using indexeddb 'settings' store under key 'aiQuotaState'
async function loadProviderState(): Promise<void> {
  try {
    const db = await getDB();
    const saved = await db.get('settings', 'aiQuotaState');
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(saved as any)) {
        try { providerState[k] = (saved as any)[k]; } catch {}
      }
    }
  } catch (e) { /* ignore */ }
}

async function saveProviderState(): Promise<void> {
  try {
    const db = await getDB();
    // only persist shallow serializable state
    await db.put('settings', { ...(await (async () => { try { const copy: any = {}; for (const k of Object.keys(providerState)) copy[k] = providerState[k]; return copy; } catch { return {}; } })()) }, 'aiQuotaState');
  } catch (e) { /* ignore */ }
}

// Hydrate provider state at module load (non-blocking)
(async () => { try { await loadProviderState(); } catch (_) {} })();

// Simple in-memory quota tracking/backoff per provider
const providerState: Record<string, { last429At?: number; backoffMs?: number; failCount?: number }> = {};

async function withQuotaGuard<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  try {
    const state = providerState[provider] || (providerState[provider] = { last429At: undefined, backoffMs: 0, failCount: 0 });
    // If we previously saw rate limits, enforce a backoff delay
    if (state.backoffMs && state.last429At) {
      const since = Date.now() - state.last429At;
      if (since < state.backoffMs) {
        // Wait remaining time
        const wait = state.backoffMs - since;
        await new Promise((res) => setTimeout(res, wait));
      }
    }
    const res = await fn();
    // success -> reset state
    state.failCount = 0;
    state.backoffMs = 0;
    state.last429At = undefined;
    return res;
  } catch (e: any) {
    // If it's a rate-limit error, increase backoff
    if (e instanceof AIProviderError && e.status === 429) {
      const state = providerState[provider] || (providerState[provider] = { last429At: undefined, backoffMs: 0, failCount: 0 });
      state.failCount = (state.failCount || 0) + 1;
      state.last429At = Date.now();
      // exponential backoff with cap (e.g., 1s, 2s, 4s, 8s, ... up to 60s)
      const next = Math.min(60000, Math.pow(2, Math.min(10, state.failCount)) * 1000);
      state.backoffMs = next;
      // Persist updated state (fire-and-forget)
      try { saveProviderState(); } catch (_) {}
      throw e;
    }
    throw e;
  }
}

async function callOpenAI(prompt: string, modelOverride?: string): Promise<AIResult> {
  return await withQuotaGuard('openai', async () => {
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
      const errorMessageFromBody =
        typeof body?.error === 'string'
          ? body.error
          : (typeof body?.error?.message === 'string' ? body.error.message : undefined);

      let baseMsg = `OpenAI error ${res.status}`;
      if (res.status === 429 && errorCode === 'insufficient_quota') {
        baseMsg = 'OpenAI insufficient quota';
      } else if (res.status === 401 || errorCode === 'invalid_api_key') {
        baseMsg = 'OpenAI invalid API key';
      } else if (res.status === 429) {
        baseMsg = 'OpenAI rate limit exceeded';
      } else if (errorMessageFromBody) {
        // Normalize common server error strings
        if (/api key not set/i.test(errorMessageFromBody)) {
          baseMsg = 'OpenAI API key not set';
        } else {
          baseMsg = `OpenAI error ${res.status}: ${errorMessageFromBody}`;
        }
      }

      throw new AIProviderError({ provider: 'openai', message: baseMsg, status: res.status, headers, body: body ?? textFallback });
    }
    const data = await safeParseJson(res);
    const text = data?.choices?.[0]?.message?.content?.trim?.() || '';
    return { text };
  });
}

async function callAnthropic(prompt: string, modelOverride?: string): Promise<AIResult> {
  return await withQuotaGuard('anthropic', async () => {
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
  });
}

async function callGemini(prompt: string, modelOverride?: string): Promise<AIResult> {
  return await withQuotaGuard('gemini', async () => {
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
  });
}

async function callGeminiWithParts(parts: any[], modelOverride?: string): Promise<AIResult> {
  return await withQuotaGuard('gemini', async () => {
    const s = get(settings);
    const key = s.aiApiKey || '';
    const model = modelOverride || s.aiModel || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }] })
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
  });
}

import { enqueueGemini, getPendingCount } from '$lib/ai/geminiClient';

export async function aiSummarizeEmail(subject: string, bodyText?: string, bodyHtml?: string, attachments?: GmailAttachment[]): Promise<string> {
  const s = get(settings);
  const hasBody = !!(bodyText || bodyHtml);
  const text = bodyText || htmlToText(bodyHtml) || '';
  const attLines: string[] = [];
  const attInline: Array<{ name: string; mimeType?: string; dataBase64?: string; text?: string }> = [];
  if (Array.isArray(attachments) && attachments.length) {
    for (const a of attachments) {
      const name = (a.filename || a.mimeType || 'attachment').slice(0, 200);
      const preface = name ? `Attachment: ${name}` : 'Attachment';
      const content = (a.textContent || '').trim();
      // Limit per-attachment content to avoid blowing prompt size
      const clipped = content ? (content.length > 2000 ? content.slice(0, 2000) : content) : '';
      if (clipped) attLines.push(`${preface}\n${clipped}`); else attLines.push(`${preface}`);
      if (a.dataBase64) attInline.push({ name, mimeType: a.mimeType, dataBase64: a.dataBase64 });
      else if (clipped) attInline.push({ name, text: clipped, mimeType: a.mimeType });
    }
  }
  const redacted = redactPII(text ? `${subject}\n\n${text}` : `${subject}`);
  const attBlock = attLines.length ? `\n\nAttachments (summarize each):\n${attLines.join('\n\n')}` : '';
  const prompt = hasBody
    ? `You are a concise assistant. Provide a short bullet list of the most important points in this email, most important first. If there are attachments, include 1-2 bullets for each attachment summarizing its key content. Keep it under 8 bullets total. Return ONLY the list as plain text with '-' bullets, no preamble or closing sentences, no code blocks, and no additional commentary.`
    : `You are a concise assistant. Write a single-line subject summary of this email thread using 15 words or fewer. Return ONLY the summary as plain text on one line, with no bullets, no quotes, no preamble, and no code blocks.`;
  const provider = s.aiProvider || 'gemini';
  // Prefer a multimodal Gemini for attachments; otherwise fallback
  const defaultGemini = attInline.length ? 'gemini-1.5-flash' : 'gemini-2.5-flash-lite';
  let model = s.aiSummaryModel || s.aiModel || (provider === 'gemini' ? defaultGemini : provider === 'anthropic' ? 'claude-3-haiku-20240307' : 'gpt-4o-mini');
  if (provider === 'gemini' && attInline.length && !/^gemini-1\.5/i.test(model)) {
    model = 'gemini-1.5-flash';
  }
  let out: AIResult;
  if (provider === 'gemini' && attInline.length) {
    // Build multimodal parts so Gemini can read PDFs/DOCX via inlineData
    const parts: any[] = [];
    parts.push({ text: prompt });
    const segments = (redacted || '').split(/\r?\n\r?\n/);
    const subjectLine = (segments[0] || '').trim();
    const bodySegment = segments.slice(1).join('\n\n').trim();
    if (hasBody) {
      if (subjectLine) parts.push({ text: `\n\nSubject: ${subjectLine}` });
      parts.push({ text: `\n\nEmail:\n${hasBody ? (bodySegment || redacted) : redacted}` });
    } else {
      parts.push({ text: `\n\nSubject:\n${redacted}` });
    }
    for (const a of attInline) {
      const label = a.name ? `Attachment: ${a.name}` : 'Attachment';
      parts.push({ text: `\n\n${label}` });
      if (a.dataBase64 && a.mimeType) parts.push({ inlineData: { mimeType: a.mimeType, data: a.dataBase64 } });
      else if (a.text) parts.push({ text: `\n${a.text}` });
      else parts.push({ text: `\n(No attachment content available; summarize by filename/type only.)` });
    }
    // Use gemini client batching for non-streaming multimodal requests
    try {
      const resp = await enqueueGemini({ id: `summ:${Math.random().toString(36).slice(2,9)}`, model, parts, streaming: false, priority: 'interactive' });
      out = { text: resp.text || '' } as any;
    } catch (e) {
      // fallback to direct call
      out = await callGeminiWithParts(parts, model);
    }
  } else {
    const fullPrompt = hasBody
      ? `${prompt}\n\nEmail:\n${redacted}${attBlock}`
      : `${prompt}\n\nSubject:\n${redacted}${attBlock}`;
    if (provider === 'gemini') {
      // For interactive summarization prefer enqueueGemini but allow fallback
      try {
        const resp = await enqueueGemini({ id: `summ:${Math.random().toString(36).slice(2,9)}`, model, prompt: fullPrompt, streaming: false, priority: 'interactive' });
        out = { text: resp.text || '' } as any;
      } catch (e) {
        out = await callGemini(fullPrompt, model);
      }
    } else {
      out = provider === 'anthropic' ? await callAnthropic(fullPrompt, model) : await callOpenAI(fullPrompt, model);
    }
  }
  let result = out.text || '';
  if (!hasBody) {
    // Normalize and hard-cap at 15 words as a safety net
    result = result.replace(/^[\s\-•]+/, '').replace(/\s+/g, ' ').trim();
    const words = result.split(/\s+/).filter(Boolean);
    if (words.length > 15) result = words.slice(0, 15).join(' ');
  }
  return result;
}

export async function aiSummarizeSubject(subject: string, bodyText?: string, bodyHtml?: string, messageSummary?: string): Promise<string> {
  const s = get(settings);
  const hasSummary = !!(messageSummary && messageSummary.trim());
  const text = bodyText || htmlToText(bodyHtml) || '';
  const base = hasSummary
    ? `Subject: ${subject}\n\nAI Summary:\n${messageSummary}`
    : (text ? `Subject: ${subject}\n\nEmail:\n${text}` : `Subject: ${subject}`);
  const redacted = redactPII(base);
  const prompt = hasSummary
    ? `You improve email subjects using an AI message summary of the content below. Write a single-line subject that better summarizes the most important point(s). Use 15 words or fewer. Avoid prefixes like "Re:" or "Fwd:", avoid quotes, emojis, sender names, or dates. Return ONLY the subject text as plain text on one line.\n\n${redacted}`
    : `You improve email subjects using the actual email content. Write a single-line subject that better summarizes the most important point(s). Use 15 words or fewer. Avoid prefixes like "Re:" or "Fwd:", avoid quotes, emojis, sender names, or dates. Return ONLY the subject text as plain text on one line.\n\n${redacted}`;
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

export async function aiSummarizeAttachment(subject: string | undefined, attachment: GmailAttachment): Promise<string> {
  const s = get(settings);
  const provider = s.aiProvider || 'gemini';
  // Prefer multimodal for attachments that include bytes
  let model = s.aiSummaryModel || s.aiModel || (provider === 'gemini' ? 'gemini-1.5-flash' : provider === 'anthropic' ? 'claude-3-haiku-20240307' : 'gpt-4o-mini');
  if (provider === 'gemini') {
    // Ensure a 1.5 model for inline files when possible
    if (!/^gemini-1\.5/i.test(model)) model = 'gemini-1.5-flash';
  }

  const name = (attachment.filename || attachment.mimeType || 'attachment').slice(0, 200);
  const preface = name ? `Attachment: ${name}` : 'Attachment';
  const prompt = `You are a concise assistant. Summarize this attachment with 3-6 short bullets (most important first). If the file content is not provided, summarize based on filename/type without inventing specifics. Return ONLY '-' bullets, no preamble, no code blocks.`;

  // Gemini multimodal path when we have bytes
  if (provider === 'gemini' && attachment.dataBase64 && attachment.mimeType) {
    const parts: any[] = [];
    parts.push({ text: prompt });
    if (subject && subject.trim()) parts.push({ text: `\n\nSubject: ${subject.trim()}` });
    parts.push({ text: `\n\n${preface}` });
    parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.dataBase64 } });
    const out = await callGeminiWithParts(parts, model);
    return out.text || '';
  }

  // Text-only path when we have extracted text content
  const content = (attachment.textContent || '').trim();
  if (content) {
    const clipped = content.length > 4000 ? content.slice(0, 4000) : content;
    const redacted = redactPII(clipped);
    const textPrompt = `${prompt}\n\n${preface}\n\n${redacted}`;
    const out = provider === 'anthropic' ? await callAnthropic(textPrompt, model) : provider === 'gemini' ? await callGemini(textPrompt, model) : await callOpenAI(textPrompt, model);
    return out.text || '';
  }

  // Fallback: no content available; ask model to summarize based on name/type only
  const fallbackPrompt = `${prompt}\n\n${preface}`;
  const out = provider === 'anthropic' ? await callAnthropic(fallbackPrompt, model) : provider === 'gemini' ? await callGemini(fallbackPrompt, model) : await callOpenAI(fallbackPrompt, model);
  return out.text || '';
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


