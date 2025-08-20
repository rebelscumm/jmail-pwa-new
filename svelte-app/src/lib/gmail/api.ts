import { ensureValidToken, getAuthState } from '$lib/gmail/auth';
import type { GmailLabel, GmailMessage, GmailThread } from '$lib/types';

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

export async function listInboxMessageIds(maxResults = 25): Promise<string[]> {
  const data = await api<{ messages?: { id: string }[] }>(
    `/messages?q=${encodeURIComponent('in:inbox')}&maxResults=${maxResults}`
  );
  return (data.messages || []).map((m) => m.id);
}

export async function getMessageMetadata(id: string): Promise<GmailMessage> {
  const data = await api<any>(
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

