import { ensureValidToken, fetchTokenInfo } from '$lib/gmail/auth';
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
    // Also emit to console for immediate visibility in dev only
    if (import.meta.env && import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.debug('[GmailAPI]', payload);
    }
  } catch (_) {}
}

export function getAndClearGmailDiagnostics(): any[] {
  const copy = __gmailDiagnostics.slice();
  __gmailDiagnostics.length = 0;
  return copy;
}

export async function copyGmailDiagnosticsToClipboard(extra?: Record<string, unknown>): Promise<boolean> {
  try {
    const entries = getAndClearGmailDiagnostics();
    // Summarize current outbox to aid debugging
    let outbox: any = undefined;
    let tokenInfo: any = undefined;
    try {
      const { getDB } = await import('$lib/db/indexeddb');
      const db = await getDB();
      const ops = await db.getAll('ops');
      outbox = {
        count: ops.length,
        sample: ops.slice(0, 10).map((o: any) => ({
          id: o.id,
          type: o.op?.type,
          attempts: o.attempts,
          nextAttemptAt: o.nextAttemptAt,
          lastError: o.lastError,
          scopeKey: o.scopeKey
        }))
      };
    } catch (_) {}
    try {
      tokenInfo = await fetchTokenInfo();
    } catch (_) {}
    const data = { entries, outbox, tokenInfo, ...(extra || {}) };
    const text = JSON.stringify(data, null, 2);
    // eslint-disable-next-line no-console
    console.log('[GmailAPI] Diagnostics', data);
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  return false;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await ensureValidToken();
  pushDiag({ type: 'api_request', path, method: (init && 'method' in (init as any) && (init as any).method) ? (init as any).method : 'GET' });
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
      const text = await res.text();
      if (text) {
        try {
          const body = JSON.parse(text);
          details = body;
          // Common Google error shape: { error: { code, message, status, errors } }
          const googleMessage = (body as any)?.error?.message || (body as any)?.message;
          if (googleMessage) message = googleMessage as string;
        } catch (_) {
          details = { nonJsonBody: text.slice(0, 256) };
        }
      }
    } catch (_) {
      // ignore parse errors
    }
    pushDiag({ type: 'api_error', path, status: res.status, message, contentType: res.headers.get('content-type') || undefined, details: sanitize(details) });
    throw new GmailApiError(message, res.status, details);
  }
  // Some Gmail endpoints (e.g., batchModify) return 204 No Content.
  // Safely handle empty bodies and non-JSON responses.
  try {
    const text = await res.text();
    pushDiag({ type: 'api_response', path, status: res.status, contentType: res.headers.get('content-type') || undefined, bodyLength: (text || '').length });
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch (_) {
      // If the response isn't JSON, return undefined to avoid throwing
      return undefined as unknown as T;
    }
  } catch (_) {
    return undefined as unknown as T;
  }
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
  let data: GmailMessageApiResponse | undefined;
  try {
    data = await api<GmailMessageApiResponse>(`/messages/${id}?format=full`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isScopeOrPermission = e instanceof GmailApiError && e.status === 403 && typeof msg === 'string' && (msg.toLowerCase().includes('metadata scope') || msg.toLowerCase().includes('insufficient') || msg.toLowerCase().includes('permission'));
    if (isScopeOrPermission) {
      pushDiag({ type: 'scope_upgrade_needed', id, error: msg });
      try {
        const before = await fetchTokenInfo();
        pushDiag({ type: 'tokeninfo_snapshot', id, tokenInfo: before });
      } catch (_) {}
      // Attempt an automatic scope upgrade once, then retry.
      try {
        const { acquireTokenForScopes } = await import('$lib/gmail/auth');
        const scopes = [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.modify'
        ].join(' ');
        const upgraded = await acquireTokenForScopes(scopes, 'consent');
        pushDiag({ type: 'scope_upgrade_attempt', id, upgraded });
        if (upgraded) {
          try {
            data = await api<GmailMessageApiResponse>(`/messages/${id}?format=full`);
          } catch (retryErr) {
            const rmsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            pushDiag({ type: 'scope_upgrade_retry_failed', id, error: rmsg });
            throw retryErr;
          }
        }
      } catch (upgradeErr) {
        const uMsg = upgradeErr instanceof Error ? upgradeErr.message : String(upgradeErr);
        pushDiag({ type: 'scope_upgrade_error', id, error: uMsg });
      }
      if (!data) {
        // Do NOT auto-prompt further. Surface a consistent error that the UI can handle.
        throw new GmailApiError('Additional Gmail permissions are required to read this message body. Please grant access.', 403, { reason: 'scope_upgrade_required', id });
      }
    } else {
      throw e;
    }
  }
  const headers: Record<string, string> = {};
  for (const h of data.payload?.headers || []) headers[h.name] = h.value;
  function decode(b64?: string): string | undefined {
    if (!b64) return undefined;
    try { return decodeURIComponent(escape(atob(b64.replace(/-/g, '+').replace(/_/g, '/')))); } catch { return undefined; }
  }
  async function getAttachmentData(messageId: string, attachmentId: string): Promise<string | undefined> {
    type AttachmentResponse = { data?: string; size?: number };
    try {
      const res = await api<AttachmentResponse>(`/messages/${messageId}/attachments/${attachmentId}`);
      return res?.data;
    } catch (e) {
      pushDiag({ type: 'attachment_fetch_error', fn: 'getMessageFull', id: messageId, attachmentId, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }
  async function extractText(payload: any): Promise<{ text?: string; html?: string; diag: any }> {
    if (!payload) return { diag: { reason: 'no_payload' } } as any;
    const out: { text?: string; html?: string } = {};
    const diagnostics = { rootMimeType: payload?.mimeType, visited: 0, textParts: 0, htmlParts: 0, attachmentFetches: 0, structure: [] as Array<{ mimeType?: string; hasData?: boolean; hasAttachmentId?: boolean; parts?: number; size?: number }> };
    const stack = [payload];
    while (stack.length) {
      const p = stack.pop();
      if (!p) continue;
      diagnostics.visited++;
      diagnostics.structure.push({ mimeType: p.mimeType, hasData: !!p?.body?.data, hasAttachmentId: !!p?.body?.attachmentId, parts: Array.isArray(p.parts) ? p.parts.length : undefined, size: p?.body?.size });
      // Inline data
      if (p.mimeType === 'text/plain') {
        if (p.body?.data) {
          out.text = (out.text || '') + (decode(p.body.data) || '');
          diagnostics.textParts++;
        } else if (p.body?.attachmentId) {
          const adata = await getAttachmentData(id, p.body.attachmentId);
          if (adata) {
            out.text = (out.text || '') + (decode(adata) || '');
            diagnostics.attachmentFetches++;
          }
        }
      }
      if (p.mimeType === 'text/html') {
        if (p.body?.data) {
          out.html = (out.html || '') + (decode(p.body.data) || '');
          diagnostics.htmlParts++;
        } else if (p.body?.attachmentId) {
          const adata = await getAttachmentData(id, p.body.attachmentId);
          if (adata) {
            out.html = (out.html || '') + (decode(adata) || '');
            diagnostics.attachmentFetches++;
          }
        }
      }
      if (Array.isArray(p.parts)) for (const c of p.parts) stack.push(c);
    }
    return { ...out, diag: diagnostics };
  }
  const body = await extractText(data.payload);
  pushDiag({
    type: 'message_full_extracted',
    id: data.id,
    threadId: data.threadId,
    payloadMimeType: data.payload?.mimeType,
    hasText: !!body.text,
    hasHtml: !!body.html,
    textLen: body.text?.length,
    htmlLen: body.html?.length,
    attachmentFetches: (body as any)?.diag?.attachmentFetches,
    visitedParts: (body as any)?.diag?.visited,
    structure: (body as any)?.diag?.structure
  });
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

