import { ensureValidToken } from '$lib/gmail/auth';
import type { GmailLabel, GmailMessage } from '$lib/types';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

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
  if (!res.ok) throw new Error(`Gmail API error ${res.status}`);
  return (await res.json()) as T;
}

export async function listLabels(): Promise<GmailLabel[]> {
  const data = await api<{ labels: GmailLabel[] }>(`/labels`);
  return data.labels || [];
}

export async function listInboxMessageIds(maxResults = 25, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }>{
  const q = new URLSearchParams({ q: 'in:inbox', maxResults: String(maxResults) });
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

