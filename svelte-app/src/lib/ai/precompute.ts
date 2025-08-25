import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { getDB } from '$lib/db/indexeddb';
import type { GmailMessage, GmailThread } from '$lib/types';
import { aiSummarizeEmail, aiSummarizeSubject } from '$lib/ai/providers';

// Lightweight non-cryptographic hash for content change detection
function simpleHash(input: string): string {
  try {
    let hash = 2166136261; // FNV-1a 32-bit offset basis
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  } catch (_) {
    return `${input.length}`;
  }
}

async function tryGetLastMessageFull(messageId: string): Promise<GmailMessage | null> {
  try {
    const { fetchTokenInfo } = await import('$lib/gmail/auth');
    const info = await fetchTokenInfo();
    const hasBodyScopes = !!info?.scope && (info.scope.includes('gmail.readonly') || info.scope.includes('gmail.modify'));
    if (!hasBodyScopes) return null;
  } catch (_) {
    return null;
  }
  try {
    const { getMessageFull } = await import('$lib/gmail/api');
    const full = await getMessageFull(messageId);
    return full;
  } catch (_) {
    return null;
  }
}

function getLastMessageId(thread: GmailThread): string | null {
  try {
    const ids = thread.messageIds || [];
    if (!ids.length) return null;
    return ids[ids.length - 1];
  } catch {
    return null;
  }
}

function isUnfilteredInbox(thread: GmailThread): boolean {
  try {
    const labels = thread.labelIds || [];
    // Consider "unfiltered" as user-visible inbox: in INBOX and not SPAM/TRASH
    if (!labels.includes('INBOX')) return false;
    if (labels.includes('SPAM') || labels.includes('TRASH')) return false;
    return true;
  } catch {
    return false;
  }
}

async function summarizeDirect(subject: string, bodyText?: string, bodyHtml?: string): Promise<string> {
  return aiSummarizeEmail(subject || '', bodyText, bodyHtml);
}

async function summarizeBatchRemote(items: Array<{ id: string; text: string }>, apiKey?: string, model?: string, useCache?: boolean): Promise<Record<string, string>> {
  try {
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'summarize_batch', items, model: model || undefined, apiKey: apiKey || undefined, useCache: !!useCache })
    });
    if (!res.ok) throw new Error(`Gemini batch endpoint error ${res.status}`);
    const data = (await res.json()) as { results?: Array<{ id: string; text: string }>; map?: Record<string, string> };
    const map = data?.map || {};
    if (data?.results && Array.isArray(data.results)) {
      for (const r of data.results) map[r.id] = r.text;
    }
    return map;
  } catch (_) {
    return {};
  }
}

async function summarizeSubjectBatchRemote(items: Array<{ id: string; text: string }>, apiKey?: string, model?: string, useCache?: boolean): Promise<Record<string, string>> {
  try {
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'subject_batch', items, model: model || undefined, apiKey: apiKey || undefined, useCache: !!useCache })
    });
    if (!res.ok) throw new Error(`Gemini subject batch endpoint error ${res.status}`);
    const data = (await res.json()) as { results?: Array<{ id: string; text: string }>; map?: Record<string, string> };
    const map = data?.map || {};
    if (data?.results && Array.isArray(data.results)) {
      for (const r of data.results) map[r.id] = r.text;
    }
    return map;
  } catch (_) {
    return {};
  }
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

export async function tickPrecompute(limit = 10): Promise<void> {
  try {
    const s = get(settings);
    if (!s?.precomputeSummaries) return;
    const db = await getDB();
    const allThreads = await db.getAll('threads');
    const candidates = allThreads.filter((t) => isUnfilteredInbox(t));
    if (!candidates.length) return;

    const nowVersion = Number(s.aiSummaryVersion || 1);
    const pending: Array<GmailThread> = [];
    for (const t of candidates) {
      const summaryVersionMismatch = (t.summaryVersion || 0) !== nowVersion;
      const needsSummary = !t.summary || t.summaryStatus === 'none' || t.summaryStatus === 'error' || summaryVersionMismatch;
      const subjectVersionMismatch = (t.subjectVersion || 0) !== nowVersion;
      const needsSubject = !t.aiSubject || t.aiSubjectStatus === 'none' || t.aiSubjectStatus === 'error' || subjectVersionMismatch;
      if (needsSummary || needsSubject) pending.push(t);
    }
    if (!pending.length) return;

    const batch = pending.slice(0, Math.max(1, limit));

    // Prepare texts
    const prepared = await mapWithConcurrency(batch, 3, async (t) => {
      const lastId = getLastMessageId(t);
      let bodyText: string | undefined;
      let bodyHtml: string | undefined;
      if (lastId) {
        const full = await tryGetLastMessageFull(lastId);
        if (full) { bodyText = full.bodyText; bodyHtml = full.bodyHtml; }
      }
      const subject = t.lastMsgMeta?.subject || '';
      const text = `${subject}\n\n${bodyText || ''}${!bodyText && bodyHtml ? bodyHtml : ''}`.trim();
      const bodyHash = simpleHash(text || subject || t.threadId);
      return { thread: t, subject, bodyText, bodyHtml, text, bodyHash };
    });

    // Update status to pending (only for fields that need work)
    try {
      const tx = db.transaction('threads', 'readwrite');
      for (const p of prepared) {
        const t = p.thread;
        const summaryVersionMismatch = (t.summaryVersion || 0) !== nowVersion;
        const needsSummary = !t.summary || t.summaryStatus === 'none' || t.summaryStatus === 'error' || summaryVersionMismatch;
        const subjectVersionMismatch = (t.subjectVersion || 0) !== nowVersion;
        const needsSubject = !t.aiSubject || t.aiSubjectStatus === 'none' || t.aiSubjectStatus === 'error' || subjectVersionMismatch;
        const next: GmailThread = {
          ...t,
          summaryStatus: needsSummary ? 'pending' : t.summaryStatus,
          summaryUpdatedAt: needsSummary ? Date.now() : t.summaryUpdatedAt,
          aiSubjectStatus: needsSubject ? 'pending' : t.aiSubjectStatus,
          aiSubjectUpdatedAt: needsSubject ? Date.now() : t.aiSubjectUpdatedAt
        };
        await tx.store.put(next);
      }
      await tx.done;
    } catch (_) {}

    // If batch is preferred, try server batch; else direct
    // Decide which items need which computations
    const wantsSummary = prepared.filter((p) => {
      const t = p.thread;
      const mismatch = (t.summaryVersion || 0) !== nowVersion;
      return !t.summary || t.summaryStatus === 'none' || t.summaryStatus === 'error' || mismatch;
    });
    const wantsSubject = prepared.filter((p) => {
      const t = p.thread;
      const mismatch = (t.subjectVersion || 0) !== nowVersion;
      return !t.aiSubject || t.aiSubjectStatus === 'none' || t.aiSubjectStatus === 'error' || mismatch;
    });

    let summaryResults: Record<string, string> = {};
    if (wantsSummary.length) {
      if (s.precomputeUseBatch) {
        const items = wantsSummary.map((p) => ({ id: p.thread.threadId, text: p.text || p.subject || '' }));
        const map = await summarizeBatchRemote(items, s.aiApiKey, s.aiSummaryModel || s.aiModel, s.precomputeUseContextCache);
        if (map && Object.keys(map).length) summaryResults = map;
      }
      if (!Object.keys(summaryResults).length) {
        const out = await mapWithConcurrency(wantsSummary, 2, async (p) => {
          const text = await summarizeDirect(p.subject, p.bodyText, p.bodyHtml);
          return { id: p.thread.threadId, text };
        });
        summaryResults = Object.fromEntries(out.map((o) => [o.id, o.text]));
      }
    }

    let subjectResults: Record<string, string> = {};
    if (wantsSubject.length) {
      if (s.precomputeUseBatch) {
        const items = wantsSubject.map((p) => ({ id: p.thread.threadId, text: p.text || p.subject || '' }));
        const map = await summarizeSubjectBatchRemote(items, s.aiApiKey, s.aiSummaryModel || s.aiModel, s.precomputeUseContextCache);
        if (map && Object.keys(map).length) subjectResults = map;
      }
      if (!Object.keys(subjectResults).length) {
        const out = await mapWithConcurrency(wantsSubject, 2, async (p) => {
          const text = await aiSummarizeSubject(p.subject, p.bodyText, p.bodyHtml);
          return { id: p.thread.threadId, text };
        });
        subjectResults = Object.fromEntries(out.map((o) => [o.id, o.text]));
      }
    }

    // Persist results
    try {
      const tx = db.transaction('threads', 'readwrite');
      const nowMs = Date.now();
      for (const p of prepared) {
        const t = p.thread;
        const sumText = (summaryResults && summaryResults[t.threadId]) || '';
        const sumOk = !!(sumText && sumText.trim());
        const subjText = (subjectResults && subjectResults[t.threadId]) || '';
        const subjOk = !!(subjText && subjText.trim());
        const needsSum = !!wantsSummary.find((x) => x.thread.threadId === t.threadId);
        const needsSubj = !!wantsSubject.find((x) => x.thread.threadId === t.threadId);
        const next: GmailThread = {
          ...t,
          summary: sumOk ? sumText.trim() : t.summary,
          summaryStatus: needsSum ? (sumOk ? 'ready' : (t.summaryStatus || 'error')) : t.summaryStatus,
          summaryVersion: needsSum ? nowVersion : t.summaryVersion,
          summaryUpdatedAt: needsSum ? nowMs : t.summaryUpdatedAt,
          bodyHash: p.bodyHash
        };
        if (needsSubj) {
          if (subjOk) {
            (next as any).aiSubject = subjText.trim();
            (next as any).aiSubjectStatus = 'ready';
          } else {
            (next as any).aiSubjectStatus = (t as any).aiSubjectStatus || 'error';
          }
          (next as any).subjectVersion = nowVersion;
          (next as any).aiSubjectUpdatedAt = nowMs;
        }
        await tx.store.put(next);
      }
      await tx.done;
    } catch (_) {}
  } catch (e) {
    // eslint-disable-next-line no-console
    try { console.error('[Precompute] tick error', e); } catch {}
  }
}

export async function precomputeNow(limit = 25): Promise<void> {
  await tickPrecompute(limit);
}


