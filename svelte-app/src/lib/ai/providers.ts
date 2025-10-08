import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { redactPII, htmlToText } from './redact';
import type { GmailAttachment } from '$lib/types';
import { getDB } from '$lib/db';
import {
  getEmailSummaryPrompt,
  getSubjectImprovementWithSummaryPrompt,
  getSubjectImprovementWithContentPrompt,
  getReplyDraftPrompt,
  getAttachmentSummaryPrompt,
  getUnsubscribeExtractionPrompt,
  getCollegeRecruitingModerationPrompt
} from './prompts';

export type AIResult = {
  text: string;
  provider?: 'openai' | 'anthropic' | 'gemini';
  model?: string;
  requestId?: string | null;
  headers?: Record<string, string | null>;
  raw?: unknown;
  httpStatus?: number;
  durationMs?: number;
  cached?: boolean;
};

export type AttachmentPreview = {
  name: string;
  mimeType?: string;
  hasInlineData: boolean;
  hasText: boolean;
  textPreview?: string;
  truncated?: boolean;
  textLength?: number;
};

export type EmailSummaryRequest = {
  provider: 'openai' | 'anthropic' | 'gemini';
  model: string;
  promptTemplate: string;
  hasBody: boolean;
  redactedInput: string;
  textPrompt: string | null;
  parts: any[] | null;
  attachmentsPreview: AttachmentPreview[];
  hashSource: string;
};

export type SanitizedPart = {
  text?: string;
  inlineData?: { mimeType?: string; bytes?: number };
};

export type AISummaryDiagnostics = {
  flow: 'email_summary';
  runId: string;
  threadId?: string;
  messageId?: string;
  startedAt: string;
  completedAt: string;
  queue: { pendingBefore: number; pendingAfter: number };
  prompt: {
    template: string;
    provider: string;
    model: string;
    hasBody: boolean;
    redactedInput: string;
    textPrompt?: string | null;
    partsPreview?: SanitizedPart[];
    attachments: AttachmentPreview[];
  };
  summary: {
    text?: string;
    metadata?: AIResult;
    error?: SerializedError;
  };
  subject?: {
    text?: string;
    metadata?: AIResult;
    error?: SerializedError;
    prompt?: string;
  };
  hashes: {
    content?: string;
  };
  notes?: string[];
};

type SerializedError = {
  name?: string;
  message: string;
  stack?: string;
  status?: number;
  provider?: string;
  requestId?: string | null;
  retryAfterSeconds?: number | null;
  headers?: Record<string, string | null> | undefined;
  body?: unknown;
};

export function simpleHash(input: string): string {
  try {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  } catch {
    return `${input.length}`;
  }
}

function serializeError(error: unknown): SerializedError {
  try {
    if (error instanceof AIProviderError) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        status: error.status,
        provider: error.provider,
        requestId: error.requestId,
        retryAfterSeconds: error.retryAfterSeconds ?? undefined,
        headers: error.headers,
        body: error.body
      };
    }
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }
    return {
      message: typeof error === 'string' ? error : JSON.stringify(error)
    };
  } catch (e) {
    return {
      message: `Failed to serialize error: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}

function finalizeSubjectText(text: string, fallback: string): string {
  let result = (text || '').replace(/^[\s\-•]+/, '').replace(/\s+/g, ' ').trim();
  if (!result) return fallback || '';
  const words = result.split(/\s+/).filter(Boolean);
  if (words.length > 15) {
    result = words.slice(0, 15).join(' ');
  }
  return result;
}

function sanitizeParts(parts?: any[] | null): SanitizedPart[] | undefined {
  if (!parts || !Array.isArray(parts)) return undefined;
  return parts.map((part) => {
    if (typeof part?.text === 'string') {
      const text = part.text;
      const truncated = text.length > 400;
      return {
        text: truncated ? `${text.slice(0, 400)}…` : text
      };
    }
    if (part?.inlineData) {
      const data = part.inlineData.data;
      const bytes = typeof data === 'string' ? Math.floor((data.length * 3) / 4) : undefined;
      return {
        inlineData: {
          mimeType: part.inlineData.mimeType,
          bytes
        }
      };
    }
    return {};
  });
}

export type PreparedEmailSummaryContext = {
  hasBody: boolean;
  redacted: string;
  textPromptBase: string;
  attBlock: string;
  attInline: Array<{ name: string; mimeType?: string; dataBase64?: string; text?: string }>;
  attachmentsPreview: AttachmentPreview[];
  defaultGeminiModel: string;
  combinedForHash: string;
  partsForGemini?: any[];
  sanitizedParts?: SanitizedPart[];
};

type PerformEmailSummaryInput = {
  subject: string;
  threadId?: string;
  messageId?: string;
  hasBody: boolean;
  redacted: string;
  textPromptBase: string;
  attBlock: string;
  attachments: GmailAttachment[];
  attInline: Array<{ name: string; mimeType?: string; dataBase64?: string; text?: string }>;
  attachmentsPreview: AttachmentPreview[];
  defaultGeminiModel: string;
  combinedForHash: string;
  partsForGemini?: any[];
  sanitizedParts?: SanitizedPart[];
  runId?: string;
  includeDiagnostics?: boolean;
};

async function performEmailSummary(input: PerformEmailSummaryInput): Promise<{
  summary: { text?: string; metadata?: AIResult; error?: SerializedError };
  contextModel: string;
  queueBefore: number;
  queueAfter: number;
  runId: string;
  textPrompt?: string | null;
  partsPreview?: SanitizedPart[];
  provider: 'openai' | 'anthropic' | 'gemini';
  template: string;
}> {
  const s = get(settings);
  const provider = s.aiProvider || 'gemini';
  const prompt = getEmailSummaryPrompt();
  let model = s.aiSummaryModel || s.aiModel || (provider === 'gemini' ? input.defaultGeminiModel : provider === 'anthropic' ? 'claude-3-haiku-20240307' : 'gpt-4o-mini');
  if (provider === 'gemini' && input.attInline.length && !/^gemini-1\.5/i.test(model)) {
    model = 'gemini-1.5-flash';
  }

  let out: AIResult | null = null;
  let error: SerializedError | undefined;
  const runId = input.runId || `summ:${Math.random().toString(36).slice(2, 9)}`;
  const queueBefore = getPendingCount();
  let queueAfter = queueBefore;

  let textPrompt: string | null = null;
  let partsPreview: SanitizedPart[] | undefined = input.sanitizedParts;

  if (provider === 'gemini' && input.attInline.length && input.partsForGemini) {
    try {
      try {
        const resp = await enqueueGemini({ id: runId, model, parts: input.partsForGemini, streaming: false, priority: 'interactive' });
        out = { text: resp.text || '', provider: 'gemini', model, cached: true } as AIResult;
      } catch (e) {
        out = await callGeminiWithParts(input.partsForGemini, model);
      } finally {
        queueAfter = getPendingCount();
      }
    } catch (e) {
      out = null;
      error = serializeError(e);
    }
  } else {
    const fullPrompt = input.hasBody
      ? `${prompt}\n\nEmail:\n${input.redacted}${input.attBlock}`
      : `${prompt}\n\nSubject:\n${input.redacted}${input.attBlock}`;
    textPrompt = fullPrompt;
    try {
      if (provider === 'gemini') {
        try {
          const resp = await enqueueGemini({ id: runId, model, prompt: fullPrompt, streaming: false, priority: 'interactive' });
          out = { text: resp.text || '', provider: 'gemini', model, cached: true } as AIResult;
        } catch (e) {
          out = await callGemini(fullPrompt, model);
        } finally {
          queueAfter = getPendingCount();
        }
      } else {
        out = provider === 'anthropic' ? await callAnthropic(fullPrompt, model) : await callOpenAI(fullPrompt, model);
      }
    } catch (e) {
      out = null;
      error = serializeError(e);
    }
  }

  const result = {
    summary: {
      text: out?.text || undefined,
      metadata: out
        ? {
            ...out,
            provider,
            model,
            requestId: out.requestId || (out.headers && (out.headers['x-request-id'] || out.headers['openai-request-id'])),
            headers: out.headers
          }
        : undefined,
      error
    },
    queueBefore,
    queueAfter,
    contextModel: model,
    runId,
    textPrompt,
    partsPreview,
    provider,
    template: prompt
  };
  return result;
}

export function prepareEmailSummaryContext(
  subject: string,
  bodyText?: string,
  bodyHtml?: string,
  attachments?: GmailAttachment[]
): PreparedEmailSummaryContext {
  const text = bodyText || htmlToText(bodyHtml) || '';
  const hasBody = !!(bodyText || bodyHtml);
  const redacted = redactPII(text ? `${subject}\n\n${text}` : `${subject}`);
  const attLines: string[] = [];
  const attInline: Array<{ name: string; mimeType?: string; dataBase64?: string; text?: string }> = [];
  const attachmentsPreview: AttachmentPreview[] = [];

  if (Array.isArray(attachments) && attachments.length) {
    for (const a of attachments) {
      const name = (a.filename || a.mimeType || 'attachment').slice(0, 200);
      const preface = name ? `Attachment: ${name}` : 'Attachment';
      const content = (a.textContent || '').trim();
      const clipped = content ? (content.length > 2000 ? content.slice(0, 2000) : content) : '';
      if (clipped) attLines.push(`${preface}\n${clipped}`);
      else attLines.push(`${preface}`);
      if (a.dataBase64) attInline.push({ name, mimeType: a.mimeType, dataBase64: a.dataBase64 });
      else if (clipped) attInline.push({ name, text: clipped, mimeType: a.mimeType });
      attachmentsPreview.push({
        name,
        mimeType: a.mimeType,
        hasInlineData: !!a.dataBase64,
        hasText: !!content,
        textPreview: content ? (content.length > 160 ? `${content.slice(0, 160)}…` : content) : undefined,
        truncated: content ? content.length > 160 : false,
        textLength: content ? content.length : undefined
      });
    }
  }

  const attBlock = attLines.length ? `\n\nAttachments (summarize each):\n${attLines.join('\n\n')}` : '';
  const defaultGemini = attInline.length ? 'gemini-1.5-flash' : 'gemini-2.5-flash-lite';

  const attText = attachmentsPreview
    .map((a) => `${a.name || a.mimeType || 'attachment'}\n${a.hasText && a.textPreview ? a.textPreview : ''}`)
    .join('\n\n');
  const combinedForHash = `${subject}\n\n${bodyText || ''}${!bodyText && bodyHtml ? bodyHtml : ''}${attText ? `\n\n${attText}` : ''}`.trim();

  let partsForGemini: any[] | undefined;
  if (attInline.length) {
    partsForGemini = [];
    partsForGemini.push({ text: getEmailSummaryPrompt() });
    const segments = (redacted || '').split(/\r?\n\r?\n/);
    const subjectLine = (segments[0] || '').trim();
    const bodySegment = segments.slice(1).join('\n\n').trim();
    if (hasBody) {
      if (subjectLine) partsForGemini.push({ text: `\n\nSubject: ${subjectLine}` });
      partsForGemini.push({ text: `\n\nEmail:\n${bodySegment || redacted}` });
    } else {
      partsForGemini.push({ text: `\n\nSubject:\n${redacted}` });
    }
    for (const a of attInline) {
      const label = a.name ? `Attachment: ${a.name}` : 'Attachment';
      partsForGemini.push({ text: `\n\n${label}` });
      if (a.dataBase64 && a.mimeType) partsForGemini.push({ inlineData: { mimeType: a.mimeType, data: a.dataBase64 } });
      else if (a.text) partsForGemini.push({ text: `\n${a.text}` });
      else partsForGemini.push({ text: `\n(No attachment content available; summarize by filename/type only.)` });
    }
  }

  return {
    hasBody,
    redacted,
    textPromptBase: redacted,
    attBlock,
    attInline,
    attachmentsPreview,
    defaultGeminiModel: defaultGemini,
    combinedForHash,
    partsForGemini,
    sanitizedParts: sanitizeParts(partsForGemini)
  };
}

async function loadCachedThreadSummary(threadId?: string): Promise<string | null> {
  if (!threadId) return null;
  try {
    const db = await getDB();
    const t = await db.get('threads', threadId);
    if (t && t.summary && t.summaryStatus === 'ready') {
      return String(t.summary || '') || '';
    }
  } catch (_) {
    return null;
  }
  return null;
}

export class AIProviderError extends Error {
  provider: 'openai' | 'anthropic' | 'gemini' | 'unknown';
  status: number;
  headers?: Record<string, string | null>;
  body?: unknown;
  requestId?: string | null;
  retryAfterSeconds?: number | null;
  durationMs?: number;
  constructor(opts: {
    provider: 'openai' | 'anthropic' | 'gemini' | 'unknown';
    message: string;
    status: number;
    headers?: Record<string, string | null>;
    body?: unknown;
    durationMs?: number;
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
    this.durationMs = opts.durationMs;
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

async function readBodySafely(res: Response): Promise<{ json?: any; text?: string }> {
  try {
    const clone = res.clone();
    const json = await clone.json();
    return { json };
  } catch (_) {
    try {
      const text = await res.clone().text();
      return { text };
  } catch (_) {
    return {};
    }
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
    const startedAt = performance.now?.() ?? Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2, apiKey: s.aiApiKey || undefined })
    });
    const durationMs = (performance.now?.() ?? Date.now()) - startedAt;
    if (!res.ok) {
      const headers = getOpenAIRateLimitHeaders(res);
      const { json, text } = await readBodySafely(res);
      const body = json ?? text;
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
      } else if (typeof errorMessageFromBody === 'string' && errorMessageFromBody) {
        if (/api key not set/i.test(errorMessageFromBody)) {
          baseMsg = 'OpenAI API key not set';
        } else {
          baseMsg = `OpenAI error ${res.status}: ${errorMessageFromBody}`;
        }
      }

      throw new AIProviderError({ provider: 'openai', message: baseMsg, status: res.status, headers, body, durationMs });
    }
    const data = await res.json().catch(() => ({}));
    const text = data?.choices?.[0]?.message?.content?.trim?.() || '';
    return {
      text,
      provider: 'openai',
      model,
      requestId: res.headers.get('x-request-id') || res.headers.get('openai-request-id'),
      headers: getOpenAIRateLimitHeaders(res),
      raw: data,
      httpStatus: res.status,
      durationMs,
      cached: res.headers.get('x-cache') === 'HIT'
    };
  });
}

async function callAnthropic(prompt: string, modelOverride?: string): Promise<AIResult> {
  return await withQuotaGuard('anthropic', async () => {
    const s = get(settings);
    const key = s.aiApiKey || '';
    const model = modelOverride || s.aiModel || 'claude-3-haiku-20240307';
    const url = 'https://api.anthropic.com/v1/messages';
    const startedAt = performance.now?.() ?? Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const durationMs = (performance.now?.() ?? Date.now()) - startedAt;
    const { json, text } = await readBodySafely(res);
    if (!res.ok) {
      const message = res.status === 429 ? 'Anthropic rate limit exceeded' : `Anthropic error ${res.status}`;
      throw new AIProviderError({ provider: 'anthropic', message, status: res.status, headers: {}, body: json ?? text, durationMs });
    }
    const data = json ?? {};
    const textOut = data?.content?.[0]?.text?.trim?.() || '';
    return {
      text: textOut,
      provider: 'anthropic',
      model,
      requestId: res.headers.get('x-request-id'),
      headers: {},
      raw: data,
      httpStatus: res.status,
      durationMs,
      cached: res.headers.get('x-cache') === 'HIT'
    };
  });
}

async function callGemini(prompt: string, modelOverride?: string): Promise<AIResult> {
  return await withQuotaGuard('gemini', async () => {
    const s = get(settings);
    const key = s.aiApiKey || '';
    const model = modelOverride || s.aiModel || 'gemini-1.5-flash';
    
    // Validate API key before making request
    if (!key || key.trim() === '') {
      throw new AIProviderError({ 
        provider: 'gemini', 
        message: 'Gemini API key not set', 
        status: 401, 
        headers: {}, 
        body: 'API key is required', 
        durationMs: 0 
      });
    }
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const startedAt = performance.now?.() ?? Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const durationMs = (performance.now?.() ?? Date.now()) - startedAt;
    const { json, text } = await readBodySafely(res);
    if (!res.ok) {
      let message = `Gemini error ${res.status}`;
      
      // Handle specific Gemini error cases
      if (res.status === 401) {
        message = 'Gemini invalid API key';
      } else if (res.status === 404) {
        const errorBody = json || text;
        if (typeof errorBody === 'string' && errorBody.includes('API key')) {
          message = 'Gemini API key not found or invalid';
        } else if (typeof errorBody === 'object' && errorBody?.error?.message) {
          message = `Gemini model not found: ${errorBody.error.message}`;
        } else {
          message = 'Gemini API endpoint not found - check API key and model name';
        }
      } else if (res.status === 429) {
        message = 'Gemini rate limit exceeded';
      } else if (res.status === 400) {
        const errorBody = json || text;
        if (typeof errorBody === 'object' && errorBody?.error?.message) {
          message = `Gemini request error: ${errorBody.error.message}`;
        } else {
          message = 'Gemini bad request - check prompt content';
        }
      }
      
      throw new AIProviderError({ provider: 'gemini', message, status: res.status, headers: {}, body: json ?? text, durationMs });
    }
    const data = json ?? {};
    const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim?.() || '';
    return {
      text: textOut,
      provider: 'gemini',
      model,
      requestId: res.headers.get('x-request-id'),
      headers: {},
      raw: data,
      httpStatus: res.status,
      durationMs,
      cached: res.headers.get('x-cache') === 'HIT'
    };
  });
}

async function callGeminiWithParts(parts: any[], modelOverride?: string): Promise<AIResult> {
  return await withQuotaGuard('gemini', async () => {
    const s = get(settings);
    const key = s.aiApiKey || '';
    const model = modelOverride || s.aiModel || 'gemini-1.5-flash';
    
    // Validate API key before making request
    if (!key || key.trim() === '') {
      throw new AIProviderError({ 
        provider: 'gemini', 
        message: 'Gemini API key not set', 
        status: 401, 
        headers: {}, 
        body: 'API key is required', 
        durationMs: 0 
      });
    }
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const startedAt = performance.now?.() ?? Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }] })
    });
    const durationMs = (performance.now?.() ?? Date.now()) - startedAt;
    const { json, text } = await readBodySafely(res);
    if (!res.ok) {
      let message = `Gemini error ${res.status}`;
      
      // Handle specific Gemini error cases
      if (res.status === 401) {
        message = 'Gemini invalid API key';
      } else if (res.status === 404) {
        const errorBody = json || text;
        if (typeof errorBody === 'string' && errorBody.includes('API key')) {
          message = 'Gemini API key not found or invalid';
        } else if (typeof errorBody === 'object' && errorBody?.error?.message) {
          message = `Gemini model not found: ${errorBody.error.message}`;
        } else {
          message = 'Gemini API endpoint not found - check API key and model name';
        }
      } else if (res.status === 429) {
        message = 'Gemini rate limit exceeded';
      } else if (res.status === 400) {
        const errorBody = json || text;
        if (typeof errorBody === 'object' && errorBody?.error?.message) {
          message = `Gemini request error: ${errorBody.error.message}`;
        } else {
          message = 'Gemini bad request - check prompt content';
        }
      }
      
      throw new AIProviderError({ provider: 'gemini', message, status: res.status, headers: {}, body: json ?? text, durationMs });
    }
    const data = json ?? {};
    const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim?.() || '';
    return {
      text: textOut,
      provider: 'gemini',
      model,
      requestId: res.headers.get('x-request-id'),
      headers: {},
      raw: data,
      httpStatus: res.status,
      durationMs,
      cached: res.headers.get('x-cache') === 'HIT'
    };
  });
}

import { enqueueGemini, getPendingCount } from '$lib/ai/geminiClient';

export type AISummaryResult = {
  summary: {
    text?: string;
    metadata?: AIResult;
    error?: SerializedError;
  };
  diagnostics: AISummaryDiagnostics;
};

export async function aiSummarizeEmailWithDiagnostics(
  subject: string,
  bodyText?: string,
  bodyHtml?: string,
  attachments?: GmailAttachment[],
  threadId?: string,
  messageId?: string,
  options?: { force?: boolean }
): Promise<AISummaryResult> {
  const cached = await loadCachedThreadSummary(threadId);
  if (cached && !options?.force) {
    return {
      summary: { text: cached },
      diagnostics: {
        flow: 'email_summary',
        runId: 'cached',
        threadId,
        messageId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        queue: { pendingBefore: 0, pendingAfter: 0 },
        prompt: {
          template: 'cached',
          provider: 'gemini',
          model: 'cached',
          hasBody: !!(bodyText || bodyHtml),
          redactedInput: '',
          attachments: []
        },
        summary: { text: cached },
        hashes: {},
        notes: ['Used cached summary']
      }
    };
  }
  const context = prepareEmailSummaryContext(subject, bodyText, bodyHtml, attachments);
  const { summary, queueBefore, queueAfter, runId, textPrompt, partsPreview, provider, contextModel, template } = await performEmailSummary({
    subject,
    threadId,
    messageId,
    hasBody: context.hasBody,
    redacted: context.redacted,
    textPromptBase: context.textPromptBase,
    attBlock: context.attBlock,
    attachments: attachments || [],
    attInline: context.attInline,
    attachmentsPreview: context.attachmentsPreview,
    defaultGeminiModel: context.defaultGeminiModel,
    combinedForHash: context.combinedForHash,
    partsForGemini: context.partsForGemini,
    sanitizedParts: context.sanitizedParts
  });
  const now = new Date().toISOString();
  const diagnostics: AISummaryDiagnostics = {
    flow: 'email_summary',
    runId,
    threadId,
    messageId,
    startedAt: now,
    completedAt: now,
    queue: { pendingBefore: queueBefore, pendingAfter: queueAfter },
    prompt: {
      template,
      provider,
      model: contextModel,
      hasBody: context.hasBody,
      redactedInput: context.textPromptBase,
      textPrompt,
      partsPreview,
      attachments: context.attachmentsPreview
    },
    summary: {
      text: summary.text,
      metadata: summary.metadata,
      error: summary.error
    },
    hashes: {
      content: simpleHash(context.combinedForHash || subject || threadId || '')
    }
  };
  return { summary, diagnostics };
}

export async function aiSummarizeEmail(
  subject: string,
  bodyText?: string,
  bodyHtml?: string,
  attachments?: GmailAttachment[],
  threadId?: string
): Promise<string> {
  const { summary } = await aiSummarizeEmailWithDiagnostics(subject, bodyText, bodyHtml, attachments, threadId);
  return summary.text || '';
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
    ? `${getSubjectImprovementWithSummaryPrompt()}\n\n${redacted}`
    : `${getSubjectImprovementWithContentPrompt()}\n\n${redacted}`;
  const provider = s.aiProvider || 'gemini';
  const model = s.aiSummaryModel || s.aiModel || (provider === 'gemini' ? 'gemini-2.5-flash-lite' : provider === 'anthropic' ? 'claude-3-haiku-20240307' : 'gpt-4o-mini');
  const out = provider === 'anthropic' ? await callAnthropic(prompt, model) : provider === 'gemini' ? await callGemini(prompt, model) : await callOpenAI(prompt, model);
  const result = finalizeSubjectText(out.text || '', subject);
  return result || subject || '';
}

export async function aiDraftReply(subject: string, bodyText?: string, bodyHtml?: string): Promise<string> {
  const s = get(settings);
  const text = bodyText || htmlToText(bodyHtml) || '';
  const redacted = redactPII(`${subject}\n\n${text}`);
  const prompt = `${getReplyDraftPrompt()}\nSubject: ${subject}\nEmail:\n${redacted}`;
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
  const prompt = getAttachmentSummaryPrompt();

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
  const prompt = `${getUnsubscribeExtractionPrompt()}\n\n${redacted}`;
  const provider = s.aiProvider || 'gemini';
  const out = provider === 'anthropic' ? await callAnthropic(prompt) : provider === 'gemini' ? await callGemini(prompt) : await callOpenAI(prompt);
  const line = (out.text || '').trim();
  if (!line || /^none$/i.test(line)) return null;
  if (/^(https?:|mailto:)/i.test(line)) return line;
  const match = line.match(/(https?:[^\s]+|mailto:[^\s]+)/i);
  return match ? match[1] : null;
}

export async function aiDetectCollegeRecruiting(
  subject: string,
  bodyText?: string,
  bodyHtml?: string,
  from?: string
): Promise<{ verdict: 'match' | 'not_match' | 'unknown'; raw: string }> {
  const s = get(settings);
  const provider = s.aiProvider || 'gemini';
  const baseText = bodyText || htmlToText(bodyHtml) || '';
  const segments: string[] = [];
  segments.push(`Subject: ${subject || '(no subject)'}`);
  if (from && from.trim()) segments.push(`From: ${from.trim()}`);
  if (baseText.trim()) segments.push(`Body:\n${baseText.trim()}`);
  const redacted = redactPII(segments.join('\n\n'));
  const prompt = `${getCollegeRecruitingModerationPrompt()}\n\n${redacted}`;
  const model = s.aiModel || 'gemini-1.5-flash';
  let out: AIResult;
  if (provider === 'anthropic') {
    out = await callAnthropic(prompt, s.aiModel || 'claude-3-haiku-20240307');
  } else if (provider === 'gemini') {
    out = await callGemini(prompt, model);
  } else {
    out = await callOpenAI(prompt, s.aiModel || 'gpt-4o-mini');
  }
  const raw = (out.text || '').trim();
  const normalized = raw.toUpperCase();
  if (normalized.startsWith('MATCH')) return { verdict: 'match', raw };
  if (normalized.startsWith('NOT') || normalized.startsWith('DO NOT MATCH') || normalized.includes('NOT_MATCH') || normalized.includes('NOT MATCH')) {
    return { verdict: 'not_match', raw };
  }
  if (normalized.startsWith('UNKNOWN')) return { verdict: 'unknown', raw };
  // Fallback: check first token
  const firstToken = normalized.split(/\s+/)[0] || '';
  if (firstToken === 'MATCH') return { verdict: 'match', raw };
  if (firstToken === 'NOT_MATCH' || firstToken === 'NOT') return { verdict: 'not_match', raw };
  return { verdict: 'unknown', raw };
}


