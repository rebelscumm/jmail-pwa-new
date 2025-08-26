import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { getDB } from '$lib/db/indexeddb';
import type { GmailMessage, GmailThread } from '$lib/types';
import { aiSummarizeEmail, aiSummarizeSubject } from '$lib/ai/providers';
import { precomputeStatus } from '$lib/stores/precompute';

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

async function summarizeDirect(subject: string, bodyText?: string, bodyHtml?: string, attachments?: import('$lib/types').GmailAttachment[]): Promise<string> {
  return aiSummarizeEmail(subject || '', bodyText, bodyHtml, attachments);
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

export async function tickPrecompute(limit = 10): Promise<{ processed: number; total: number }> {
  try {
    const s = get(settings);
    console.log('[Precompute] Settings:', { 
      precomputeSummaries: s?.precomputeSummaries, 
      aiProvider: s?.aiProvider, 
      aiApiKey: s?.aiApiKey ? '***' : 'missing',
      aiModel: s?.aiModel,
      aiSummaryModel: s?.aiSummaryModel
    });
    
    if (!s?.precomputeSummaries) {
      console.log('[Precompute] Precompute summaries disabled in settings');
      precomputeStatus.complete();
      return { processed: 0, total: 0 };
    }
    
    const db = await getDB();
    const allThreads = await db.getAll('threads');
    console.log('[Precompute] Total threads in DB:', allThreads.length);
    
    const candidates = allThreads.filter((t) => isUnfilteredInbox(t));
    console.log('[Precompute] Inbox candidates:', candidates.length);
    
    if (!candidates.length) {
      console.log('[Precompute] No inbox candidates found');
      // Check if this is because all threads are filtered out
      const inboxThreads = allThreads.filter(t => t.labelIds?.includes('INBOX'));
      const spamTrashThreads = allThreads.filter(t => t.labelIds?.includes('SPAM') || t.labelIds?.includes('TRASH'));
      
      if (inboxThreads.length === 0) {
        console.log('[Precompute] No threads with INBOX label found');
      } else if (inboxThreads.length > 0 && candidates.length === 0) {
        console.log('[Precompute] All inbox threads are filtered out (SPAM/TRASH)');
      }
      
      precomputeStatus.complete();
      return { processed: 0, total: allThreads.length };
    }
    
    // Start progress tracking
    precomputeStatus.start(candidates.length);

    const nowVersion = Number(s.aiSummaryVersion || 1);
    console.log('[Precompute] AI Summary Version:', nowVersion);
    
    const pending: Array<GmailThread> = [];
    for (const t of candidates) {
      const summaryVersionMismatch = (t.summaryVersion || 0) !== nowVersion;
      const needsSummary = !t.summary || t.summaryStatus === 'none' || t.summaryStatus === 'error' || summaryVersionMismatch;
      const subjectVersionMismatch = (t.subjectVersion || 0) !== nowVersion;
      const needsSubject = !t.aiSubject || t.aiSubjectStatus === 'none' || t.aiSubjectStatus === 'error' || subjectVersionMismatch;
      if (needsSummary || needsSubject) pending.push(t);
    }
    
    console.log('[Precompute] Pending items:', pending.length);
    if (pending.length > 0) {
      console.log('[Precompute] Sample pending item:', {
        threadId: pending[0].threadId,
        summary: pending[0].summary,
        summaryStatus: pending[0].summaryStatus,
        summaryVersion: pending[0].summaryVersion,
        aiSubject: pending[0].aiSubject,
        aiSubjectStatus: pending[0].aiSubjectStatus,
        subjectVersion: pending[0].subjectVersion
      });
    }
    
    if (!pending.length) {
      console.log('[Precompute] No pending items found');
      // Check if this is because all items already have summaries
      const allHaveSummaries = candidates.every(t => {
        const summaryVersionMismatch = (t.summaryVersion || 0) !== nowVersion;
        const needsSummary = !t.summary || t.summaryStatus === 'none' || t.summaryStatus === 'error' || summaryVersionMismatch;
        const subjectVersionMismatch = (t.subjectVersion || 0) !== nowVersion;
        const needsSubject = !t.aiSubject || t.aiSubjectStatus === 'none' || t.aiSubjectStatus === 'error' || subjectVersionMismatch;
        return !needsSummary && !needsSubject;
      });
      
      if (allHaveSummaries) {
        console.log('[Precompute] All items already have up-to-date summaries and subjects');
      } else {
        console.log('[Precompute] Items exist but none need processing (possible version mismatch)');
      }
      
      precomputeStatus.complete();
      return { processed: 0, total: candidates.length };
    }

    const batch = pending.slice(0, Math.max(1, limit));
    console.log('[Precompute] Processing batch of:', batch.length);
    
    // Update progress - preparing texts
    precomputeStatus.updateProgress(0, 'Preparing email content...');

    // Prepare texts
    const prepared = await mapWithConcurrency(batch, 3, async (t) => {
      const lastId = getLastMessageId(t);
      let bodyText: string | undefined;
      let bodyHtml: string | undefined;
      let attachments: import('$lib/types').GmailAttachment[] | undefined;
      if (lastId) {
        const full = await tryGetLastMessageFull(lastId);
        if (full) { bodyText = full.bodyText; bodyHtml = full.bodyHtml; attachments = full.attachments; }
      }
      const subject = t.lastMsgMeta?.subject || '';
      const attText = (attachments || []).map((a) => `${a.filename || a.mimeType || 'attachment'}\n${(a.textContent || '').slice(0, 500)}`).join('\n\n');
      const text = `${subject}\n\n${bodyText || ''}${!bodyText && bodyHtml ? bodyHtml : ''}${attText ? `\n\n${attText}` : ''}`.trim();
      const bodyHash = simpleHash(text || subject || t.threadId);
      return { thread: t, subject, bodyText, bodyHtml, attachments, text, bodyHash } as any;
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
    // Ensure we have message summaries available for any subject work
    const needsSummaryForSubject = prepared.filter((p) => {
      const t = p.thread;
      return (!!t && (!t.summary || t.summaryStatus !== 'ready')) && wantsSubject.some((x) => x.thread.threadId === t.threadId);
    });
    const summaryEntries: Array<[string, any]> = [
      ...wantsSummary.map((p: any) => [p.thread.threadId as string, p] as [string, any]),
      ...needsSummaryForSubject.map((p: any) => [p.thread.threadId as string, p] as [string, any])
    ];
    const summaryTargets = Array.from(new Map(summaryEntries).values()) as any[];

    let summaryResults: Record<string, string> = {};
    if (summaryTargets.length) {
      console.log('[Precompute] Processing', summaryTargets.length, 'summary targets');
      
      // Update progress - processing summaries
      precomputeStatus.updateProgress(0, `Processing ${summaryTargets.length} summaries...`);
      
      if (s.precomputeUseBatch) {
        console.log('[Precompute] Using batch mode for summaries');
        const items = summaryTargets.map((p) => ({ id: p.thread.threadId, text: p.text || p.subject || '' }));
        const map = await summarizeBatchRemote(items, s.aiApiKey, s.aiSummaryModel || s.aiModel, s.precomputeUseContextCache);
        if (map && Object.keys(map).length) {
          summaryResults = map;
          console.log('[Precompute] Batch summary results:', Object.keys(map).length);
        } else {
          console.log('[Precompute] Batch summary failed, falling back to direct');
        }
      }
      if (!Object.keys(summaryResults).length) {
        console.log('[Precompute] Using direct mode for summaries');
        let successCount = 0;
        let errorCount = 0;
        const out = await mapWithConcurrency(summaryTargets, 2, async (p: any) => {
          try {
            const text = await summarizeDirect(p.subject, p.bodyText, p.bodyHtml, p.attachments);
            if (text && text.trim()) {
              console.log('[Precompute] Direct summary success for', p.thread.threadId);
              successCount++;
              return { id: p.thread.threadId, text };
            } else {
              console.log('[Precompute] Direct summary returned empty text for', p.thread.threadId);
              errorCount++;
              return { id: p.thread.threadId, text: '' };
            }
          } catch (e) {
            console.error('[Precompute] Direct summary failed for', p.thread.threadId, e);
            errorCount++;
            return { id: p.thread.threadId, text: '' };
          }
        });
        summaryResults = Object.fromEntries(out.map((o) => [o.id, o.text]));
        console.log('[Precompute] Direct summary results:', Object.keys(summaryResults).length, 'success:', successCount, 'errors:', errorCount);
      }
    }

    let subjectResults: Record<string, string> = {};
    if (wantsSubject.length) {
      console.log('[Precompute] Processing', wantsSubject.length, 'subject targets');
      
      // Update progress - processing subjects
      precomputeStatus.updateProgress(
        summaryTargets.length, 
        `Processing ${wantsSubject.length} AI subjects...`
      );
      
      if (s.precomputeUseBatch) {
        console.log('[Precompute] Using batch mode for subjects');
        const items = wantsSubject.map((p) => {
          const t = p.thread as GmailThread;
          const readySummary = (t.summaryStatus === 'ready' && t.summary) ? t.summary : (summaryResults[t.threadId] || '');
          const text = readySummary && readySummary.trim()
            ? `Subject: ${p.subject}\n\nAI Summary:\n${readySummary}`
            : (p.text || p.subject || '');
        return { id: p.thread.threadId, text };
        });
        const map = await summarizeSubjectBatchRemote(items, s.aiApiKey, s.aiSummaryModel || s.aiModel, s.precomputeUseContextCache);
        if (map && Object.keys(map).length) {
          subjectResults = map;
          console.log('[Precompute] Batch subject results:', Object.keys(map).length);
        } else {
          console.log('[Precompute] Batch subject failed, falling back to direct');
        }
      }
      if (!Object.keys(subjectResults).length) {
        console.log('[Precompute] Using direct mode for subjects');
        let successCount = 0;
        let errorCount = 0;
        const out = await mapWithConcurrency(wantsSubject, 2, async (p) => {
          try {
            const t = p.thread as GmailThread;
            const readySummary = (t.summaryStatus === 'ready' && t.summary) ? t.summary : (summaryResults[t.threadId] || '');
            let text: string;
            if (readySummary && readySummary.trim()) {
              text = await aiSummarizeSubject(p.subject, undefined, undefined, readySummary);
            } else {
              text = await aiSummarizeSubject(p.subject, p.bodyText, p.bodyHtml);
            }
            if (text && text.trim()) {
              console.log('[Precompute] Direct subject success for', p.thread.threadId);
              successCount++;
              return { id: p.thread.threadId, text };
            } else {
              console.log('[Precompute] Direct subject returned empty text for', p.thread.threadId);
              errorCount++;
              return { id: p.thread.threadId, text: '' };
            }
          } catch (e) {
            console.error('[Precompute] Direct subject failed for', p.thread.threadId, e);
            errorCount++;
            return { id: p.thread.threadId, text: '' };
          }
        });
        subjectResults = Object.fromEntries(out.map((o) => [o.id, o.text]));
        console.log('[Precompute] Direct subject results:', Object.keys(subjectResults).length, 'success:', successCount, 'errors:', errorCount);
      }
    }

    // Update progress - persisting results
    precomputeStatus.updateProgress(
      summaryTargets.length + wantsSubject.length, 
      'Saving AI summaries and subjects...'
    );
    
    // Persist results
    console.log('[Precompute] Persisting results...');
    try {
      const tx = db.transaction('threads', 'readwrite');
      const nowMs = Date.now();
      let updatedCount = 0;
      for (const p of prepared) {
        const t = p.thread;
        const sumText = (summaryResults && summaryResults[t.threadId]) || '';
        const sumOk = !!(sumText && sumText.trim());
        const subjText = (subjectResults && subjectResults[t.threadId]) || '';
        const subjOk = !!(subjText && subjText.trim());
        const needsSum = !!wantsSummary.find((x) => x.thread.threadId === t.threadId);
        const needsSubj = !!wantsSubject.find((x) => x.thread.threadId === t.threadId);
        const hadReadySummary = t.summaryStatus === 'ready' && !!t.summary;
        const computedButWasntRequested = !needsSum && sumOk && !hadReadySummary;
        const setSummaryFields = needsSum || computedButWasntRequested;
        
        console.log('[Precompute] Thread', t.threadId, ':', {
          needsSummary: needsSum,
          needsSubject: needsSubj,
          summaryOk: sumOk,
          subjectOk: subjOk,
          summaryText: sumText ? `${sumText.slice(0, 50)}...` : 'none',
          subjectText: subjText ? `${subjText.slice(0, 50)}...` : 'none'
        });
        
        const next: GmailThread = {
          ...t,
          summary: setSummaryFields && sumOk ? sumText.trim() : t.summary,
          summaryStatus: setSummaryFields ? (sumOk ? 'ready' : (t.summaryStatus || 'error')) : t.summaryStatus,
          summaryVersion: setSummaryFields ? nowVersion : t.summaryVersion,
          summaryUpdatedAt: setSummaryFields ? nowMs : t.summaryUpdatedAt,
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
        updatedCount++;
      }
      await tx.done;
      console.log('[Precompute] Updated', updatedCount, 'threads in database');
    } catch (e) {
      console.error('[Precompute] Error persisting results:', e);
    }
    
    // Update progress - completed
    precomputeStatus.updateProgress(prepared.length, 'Precompute completed successfully!');
    
    // Return processing information
    const result = { processed: prepared.length, total: candidates.length };
    console.log('[Precompute] Completed successfully:', result);
    
    // Complete progress tracking
    precomputeStatus.complete();
    
    return result;
  } catch (e) {
    // eslint-disable-next-line no-console
    try { console.error('[Precompute] tick error', e); } catch {}
    
    // Complete progress tracking on error
    precomputeStatus.complete();
    
    // Return processing information
    console.log('[Precompute] Completed with error, returning 0 processed');
    return { processed: 0, total: 0 };
  }
}

export async function precomputeNow(limit = 25): Promise<{ processed: number; total: number }> {
  const result = await tickPrecompute(limit);
  return result;
}


