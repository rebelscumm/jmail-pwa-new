import { ensureValidToken } from '$lib/gmail/auth';
import type { GmailLabel, GmailMessage } from '$lib/types';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'GmailApiError';
    this.status = status;
    this.details = details;
  }
}

// Lightweight diagnostics buffer for debugging API behavior in the browser.
// Avoids storing secrets; logs only paths, statuses, and sanitized payload summaries.
const __gmailDiagnostics: any[] = [];
function pushDiag(entry: Record<string, unknown>) {
  try {
    const payload = { time: new Date().toISOString(), ...entry };
    __gmailDiagnostics.push(payload);
    // Also emit to console for immediate visibility
    // eslint-disable-next-line no-console
    console.debug('[GmailAPI]', payload);
  } catch (_) {}
}

export function getAndClearGmailDiagnostics(): any[] {
  const copy = __gmailDiagnostics.slice();
  __gmailDiagnostics.length = 0;
  return copy;
}

export async function copyGmailDiagnosticsToClipboard(extra?: Record<string, unknown>): Promise<boolean> {
  try {
    const data = { entries: getAndClearGmailDiagnostics(), ...(extra || {}) };
    const text = JSON.stringify(data, null, 2);
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  return false;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await ensureValidToken();
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });
  if (!res.ok) {
    let message = `Gmail API error ${res.status}`;
    let details: unknown;
    try {
      const body = await res.json().catch(() => undefined);
      if (body) {
        details = body;
        // Common Google error shape: { error: { code, message, status, errors } }
        const googleMessage = (body as any)?.error?.message || (body as any)?.message;
        if (googleMessage) message = googleMessage as string;
      }
    } catch (_) {
      // ignore parse errors
    }
    pushDiag({ type: 'api_error', path, status: res.status, message, details: sanitize(details) });
    throw new GmailApiError(message, res.status, details);
  }
  const data = (await res.json()) as T;
  return data;
}

export async function listLabels(): Promise<GmailLabel[]> {
  const data = await api<{ labels: GmailLabel[] }>(`/labels`);
  return data.labels || [];
}

export async function listInboxMessageIds(maxResults = 25, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }> {
  const q = new URLSearchParams({ maxResults: String(maxResults) });
  q.append('labelIds', 'INBOX');
  if (pageToken) q.set('pageToken', pageToken);
  const data = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
    `/messages?${q.toString()}`
  );
  const ids = (data.messages || []).map((m) => m.id);
  if (!ids.length) {
    pushDiag({ type: 'inbox_empty', fn: 'listInboxMessageIds', params: { maxResults, pageToken, labelIds: 'INBOX' }, data: summarizeListData(data) });
  } else {
    pushDiag({ type: 'inbox_page', fn: 'listInboxMessageIds', params: { maxResults, pageToken, labelIds: 'INBOX' }, count: ids.length, nextPageToken: data.nextPageToken });
  }
  return { ids, nextPageToken: data.nextPageToken };
}

export async function listMessageIdsByLabelId(labelId: string, maxResults = 25, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }> {
  const q = new URLSearchParams({ maxResults: String(maxResults) });
  q.append('labelIds', labelId);
  if (pageToken) q.set('pageToken', pageToken);
  const data = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
    `/messages?${q.toString()}`
  );
  return { ids: (data.messages || []).map((m) => m.id), nextPageToken: data.nextPageToken };
}

export async function getMessageMetadata(id: string): Promise<GmailMessage> {
  type GmailMessageApiResponse = {
    id: string;
    threadId: string;
    snippet?: string;
    internalDate?: string | number;
    labelIds?: string[];
    payload?: { headers?: { name: string; value: string }[] };
  };
  const data = await api<GmailMessageApiResponse>(
    `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
  );
  const headers: Record<string, string> = {};
  for (const h of data.payload?.headers || []) headers[h.name] = h.value;
  const message: GmailMessage = {
    id: data.id,
    threadId: data.threadId,
    snippet: data.snippet,
    headers,
    labelIds: data.labelIds || [],
    internalDate: data.internalDate ? Number(data.internalDate) : undefined
  };
  return message;
}

export async function batchModify(ids: string[], addLabelIds: string[], removeLabelIds: string[]) {
  await api<unknown>(`/messages/batchModify`, {
    method: 'POST',
    body: JSON.stringify({ ids, addLabelIds, removeLabelIds })
  });
}

export async function getMessageFull(id: string): Promise<GmailMessage> {
  type GmailMessageApiResponse = {
    id: string;
    threadId: string;
    snippet?: string;
    internalDate?: string | number;
    labelIds?: string[];
    payload?: { mimeType?: string; body?: { data?: string; size?: number }; parts?: any[]; headers?: { name: string; value: string }[] };
  };
  const data = await api<GmailMessageApiResponse>(`/messages/${id}?format=full`);
  const headers: Record<string, string> = {};
  for (const h of data.payload?.headers || []) headers[h.name] = h.value;
  function decode(b64?: string): string | undefined {
    if (!b64) return undefined;
    try { return decodeURIComponent(escape(atob(b64.replace(/-/g, '+').replace(/_/g, '/')))); } catch { return undefined; }
  }
  function extractText(payload: any): { text?: string; html?: string } {
    if (!payload) return {};
    const out: { text?: string; html?: string } = {};
    const stack = [payload];
    while (stack.length) {
      const p = stack.pop();
      if (!p) continue;
      if (p.mimeType === 'text/plain' && p.body?.data) out.text = (out.text || '') + (decode(p.body.data) || '');
      if (p.mimeType === 'text/html' && p.body?.data) out.html = (out.html || '') + (decode(p.body.data) || '');
      if (Array.isArray(p.parts)) for (const c of p.parts) stack.push(c);
    }
    return out;
  }
  const body = extractText(data.payload);
  const message: GmailMessage = {
    id: data.id,
    threadId: data.threadId,
    snippet: data.snippet,
    headers,
    labelIds: data.labelIds || [],
    internalDate: data.internalDate ? Number(data.internalDate) : undefined,
    bodyText: body.text,
    bodyHtml: body.html
  };
  return message;
}

export async function sendMessageRaw(raw: string, threadId?: string): Promise<{ id: string; threadId: string }> {
  type SendResponse = { id: string; threadId: string };
  const body: Record<string, unknown> = { raw };
  if (threadId) body.threadId = threadId;
  return await api<SendResponse>(`/messages/send`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

// Quick profile ping to gauge account message/thread totals for diagnostics
export async function getProfile(): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string }> {
  const data = await api<{ emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string }>(`/profile`);
  pushDiag({ type: 'profile', emailAddress: data.emailAddress, messagesTotal: data.messagesTotal, threadsTotal: data.threadsTotal });
  return data;
}

function summarizeListData(data: unknown) {
  try {
    const d: any = data || {};
    return { messagesLen: Array.isArray(d.messages) ? d.messages.length : undefined, nextPageToken: d.nextPageToken };
  } catch (_) {
    return undefined;
  }
}

function sanitize(value: unknown) {
  try {
    if (!value) return value;
    const v: any = value;
    // Best-effort sanitization: drop headers/tokens if present
    if (v && typeof v === 'object') {
      if ('Authorization' in v) delete v.Authorization;
      if ('access_token' in v) delete v.access_token;
    }
    return v;
  } catch (_) {
    return undefined;
  }
}

