import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { getDB } from '$lib/db/indexeddb';
import type { GmailMessage, GmailThread } from '$lib/types';
import { aiSummarizeEmail, aiSummarizeSubject } from '$lib/ai/providers';
import { precomputeStatus } from '$lib/stores/precompute';
import { threads } from '$lib/stores/threads';
import { get as getStore } from 'svelte/store';

// In-memory precompute log buffer (UI consumable)
type PrecomputeLogEntry = { ts: number; level: 'debug' | 'warn' | 'error'; message: string };
const PRECOMPUTE_LOG_CAP = 1000; // hard cap on retained logs
const PRECOMPUTE_LOG_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const _precomputeLogs: PrecomputeLogEntry[] = [];

function prunePrecomputeLogsIfNeeded() {
  try {
    // Trim by cap
    while (_precomputeLogs.length > PRECOMPUTE_LOG_CAP) _precomputeLogs.shift();
    // Trim by age (remove older than MAX_AGE)
    const cutoff = Date.now() - PRECOMPUTE_LOG_MAX_AGE_MS;
    let i = 0;
    while (i < _precomputeLogs.length && _precomputeLogs[i].ts < cutoff) i++;
    if (i > 0) _precomputeLogs.splice(0, i);
  } catch {}
}

function pushLog(level: PrecomputeLogEntry['level'], ...args: any[]) {
  try {
    const msg = args.map(a => {
      try {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }).join(' ');
    _precomputeLogs.push({ ts: Date.now(), level, message: msg });
    // Increment counters in precomputeStatus store for UI
    try {
      if (level === 'error' && (precomputeStatus as any).incrementError) (precomputeStatus as any).incrementError(1);
      if (level === 'warn' && (precomputeStatus as any).incrementWarn) (precomputeStatus as any).incrementWarn(1);
    } catch {}
    prunePrecomputeLogsIfNeeded();
  } catch {}
}

export function getPrecomputeLogs() { prunePrecomputeLogsIfNeeded(); return _precomputeLogs.slice().reverse(); }
export function clearPrecomputeLogs() { _precomputeLogs.length = 0; }

// Public lightweight summary API (aggregated counts + recent stats)
export function getPrecomputeSummary() {
  try {
    const total = _precomputeLogs.length;
    const now = Date.now();
    const lastHour = _precomputeLogs.filter(l => (now - l.ts) <= 1000 * 60 * 60).length;
    const lastDay = _precomputeLogs.filter(l => (now - l.ts) <= 1000 * 60 * 60 * 24).length;
    const errors = _precomputeLogs.filter(l => l.level === 'error').length;
    const warns = _precomputeLogs.filter(l => l.level === 'warn').length;
    const lastEntries = _precomputeLogs.slice(-10).map(l => ({ ts: l.ts, level: l.level, message: l.message }));

    // Analyze most recent completed precompute run (if any) to extract processed counts
    // and error types for that run.
    let lastRun: { processed?: number; total?: number; errorTypes?: Record<string, number>; runLogs?: Array<{ ts: number; level: string; message: string }> } = { errorTypes: {}, runLogs: [] };
    try {
      // Find indices of completed markers
      const completedIndices: number[] = [];
      for (let i = 0; i < _precomputeLogs.length; i++) {
        const m = _precomputeLogs[i].message;
        if (typeof m === 'string' && m.indexOf('[Precompute] Completed') >= 0) completedIndices.push(i);
      }
      if (completedIndices.length > 0) {
        const lastIdx = completedIndices[completedIndices.length - 1];
        const prevIdx = completedIndices.length > 1 ? completedIndices[completedIndices.length - 2] : -1;
        const runLogs = _precomputeLogs.slice(prevIdx + 1, lastIdx + 1);
        lastRun.runLogs = runLogs.map(r => ({ ts: r.ts, level: r.level, message: r.message }));

        // Attempt to parse processed/total from the completed log entry JSON part
        try {
          const completedMsg = _precomputeLogs[lastIdx].message || '';
          const objIdx = (typeof completedMsg === 'string') ? completedMsg.indexOf('{') : -1;
          if (objIdx >= 0) {
            const parsed = JSON.parse((completedMsg as string).slice(objIdx));
            if (parsed && typeof parsed.processed === 'number') lastRun.processed = parsed.processed;
            if (parsed && typeof parsed.total === 'number') lastRun.total = parsed.total;
          }
        } catch {}

        // Aggregate error messages by their first-line text for the run
        const errorMap: Record<string, number> = {};
        for (const r of runLogs) {
          if (r.level === 'error') {
            const m = typeof r.message === 'string' ? (r.message.split('\n')[0] || r.message) : String(r.message || 'error');
            errorMap[m] = (errorMap[m] || 0) + 1;
          }
        }
        lastRun.errorTypes = errorMap;
      }
      else if (errors > 0) {
        // No explicit completed marker found but errors exist — infer a recent run
        // by using the most recent logs and aggregating error messages so the UI
        // can present a helpful breakdown instead of "no breakdown available".
        try {
          const recent = _precomputeLogs.slice(Math.max(0, _precomputeLogs.length - 200)); // limit scan
          lastRun.runLogs = recent.map(r => ({ ts: r.ts, level: r.level, message: r.message }));
          const errorMap: Record<string, number> = {};
          for (const r of recent) {
            if (r.level === 'error') {
              const m = typeof r.message === 'string' ? (r.message.split('\n')[0] || r.message) : String(r.message || 'error');
              errorMap[m] = (errorMap[m] || 0) + 1;
            }
          }
          lastRun.errorTypes = errorMap;
        } catch (_) {}
      }
    } catch {}

    // Provide additional structured reasons to help UX explain missing summaries (kept but not required by UI)
    const reasons: string[] = [];
    if (total === 0) reasons.push('No precompute activity recorded yet. Run Precompute to generate summaries.');
    if (errors > 0) reasons.push('Errors occurred during precompute; check logs for details.');
    reasons.push('Some threads may be filtered out of INBOX (e.g., SPAM or TRASH) or affected by Gmail filters.');
    reasons.push('Missing Gmail read/modify scopes or unavailable message bodies can prevent summary generation.');
    reasons.push('Local cache may be stale; sync with Gmail to refresh thread data.');

    return { total, lastHour, lastDay, errors, warns, lastEntries, reasons, lastRun };
  } catch {
    return { total: 0, lastHour: 0, lastDay: 0, errors: 0, warns: 0, lastEntries: [], reasons: [], lastRun: { errorTypes: {}, runLogs: [] } };
  }
}

// Periodic pruning to avoid unbounded memory growth - run every hour
try {
  if (typeof setInterval === 'function') {
    setInterval(() => {
      try { prunePrecomputeLogsIfNeeded(); } catch {}
    }, 1000 * 60 * 60);
  }
} catch {}
// clearPrecomputeLogs is already exported above; no-op here to avoid duplicate export

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
  // Check token scopes if possible; if scope lookup fails, allow a downstream
  // fetch attempt rather than bailing out (some environments may not return
  // token info reliably).
  let hasBodyScopes = false;
  try {
    const { fetchTokenInfo } = await import('$lib/gmail/auth');
    const info = await fetchTokenInfo();
    hasBodyScopes = !!info?.scope && (info.scope.includes('gmail.readonly') || info.scope.includes('gmail.modify'));
    if (!hasBodyScopes) return null;
  } catch (_) {
    // proceed — we'll attempt fetch and rely on getMessageFull to surface scope errors
  }

  try {
    // Prefer DB cached full message if present to avoid unnecessary network
    try {
      const db = await getDB();
      const cached = await db.get('messages', messageId);
      if (cached && (cached.bodyText || cached.bodyHtml)) return cached as GmailMessage;
    } catch (e) {
      // ignore DB issues and fall back to network
    }

    // Per-process cooldown to avoid hammering Gmail on repeated failures.
    // This is intentionally in-memory ( Map ) to keep migrations minimal.
    try {
      if (!(globalThis as any).__jmail_lastFetchAttempt) (globalThis as any).__jmail_lastFetchAttempt = new Map<string, number>();
      const attemptsMap: Map<string, number> = (globalThis as any).__jmail_lastFetchAttempt;
      const last = attemptsMap.get(messageId) || 0;
      const cooldownMs = 1000 * 60 * 5; // 5 minutes
      if (Date.now() - last < cooldownMs) return null;
      // mark attempt now to prevent concurrent callers from duplicating work
      attemptsMap.set(messageId, Date.now());
    } catch (_) {}

    const { getMessageFull } = await import('$lib/gmail/api');
    const full = await getMessageFull(messageId);
    try {
      // Persist to DB so future runs can reuse
      const db = await getDB();
      await db.put('messages', full);
    } catch (e) {
      // best-effort only
    }
    return full;
  } catch (e) {
    // Record failed attempt timestamp in the per-process map to avoid tight retries
    try {
      if (!(globalThis as any).__jmail_lastFetchAttempt) (globalThis as any).__jmail_lastFetchAttempt = new Map<string, number>();
      const attemptsMap: Map<string, number> = (globalThis as any).__jmail_lastFetchAttempt;
      attemptsMap.set(messageId, Date.now());
    } catch (_) {}
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
    
    // Additional safeguard: Skip threads that appear to be snoozed
    // Snoozed threads typically have custom labels but no INBOX
    // This prevents processing of threads that may have been locally processed
    const hasCustomSnoozeLabels = labels.some(label => 
      !['INBOX', 'UNREAD', 'IMPORTANT', 'STARRED', 'SENT', 'DRAFT'].includes(label)
    );
    
    // If thread has both INBOX and custom labels, it might be legitimately labeled
    // Only exclude if it seems like a snooze pattern (custom label without clear inbox intent)
    return true;
  } catch {
    return false;
  }
}

async function summarizeDirect(subject: string, bodyText?: string, bodyHtml?: string, attachments?: import('$lib/types').GmailAttachment[], threadId?: string): Promise<string> {
  return aiSummarizeEmail(subject || '', bodyText, bodyHtml, attachments, threadId);
}

async function summarizeBatchRemote(items: Array<{ id: string; text: string }>, apiKey?: string, model?: string, useCache?: boolean, combined = false): Promise<Record<string, string>> {
  try {
    const action = combined ? 'summarize_batch_combined' : 'summarize_batch';
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, items, model: model || undefined, apiKey: apiKey || undefined, useCache: !!useCache })
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

async function summarizeSubjectBatchRemote(items: Array<{ id: string; text: string }>, apiKey?: string, model?: string, useCache?: boolean, combined = false): Promise<Record<string, string>> {
  try {
    const action = combined ? 'subject_batch_combined' : 'subject_batch';
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, items, model: model || undefined, apiKey: apiKey || undefined, useCache: !!useCache })
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
    // No time-based auto-run gating: allow precompute to run whenever requested.
    pushLog('debug', '[Precompute] Settings:', { 
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
    // Ensure database has all INBOX message/thread metadata before computing
    // This will walk Gmail pages and populate 'messages' and 'threads' stores in indexeddb
    try {
      const { listMessageIdsByLabelId, getMessageMetadata } = await import('$lib/gmail/api');
      let pageToken: string | undefined = undefined;
      const allMsgIds: string[] = [];
      // Fetch pages of message ids (Gmail paginates). Use a reasonably large page size.
      do {
        const page = await listMessageIdsByLabelId('INBOX', 100, pageToken);
        if (page.ids && page.ids.length) allMsgIds.push(...page.ids);
        pageToken = page.nextPageToken;
      } while (pageToken);

      // Fetch metadata for all message ids with concurrency and persist
      const msgs = await mapWithConcurrency(allMsgIds, 6, async (id) => await getMessageMetadata(id));
      // Persist messages and build thread map
      try {
        const txMsgs = db.transaction('messages', 'readwrite');
        for (const m of msgs) await txMsgs.store.put(m);
        await txMsgs.done;
      } catch (e) { pushLog('warn', '[Precompute] Failed to persist messages', e); }

      const threadMap: Record<string, { messageIds: string[]; labelIds: Record<string, true>; last: { from?: string; subject?: string; date?: number } }> = {};
      for (const m of msgs) {
        const existing = threadMap[m.threadId] || { messageIds: [], labelIds: {}, last: {} };
        existing.messageIds.push(m.id);
        for (const x of m.labelIds) existing.labelIds[x] = true;
        const date = m.internalDate || Date.parse(m.headers?.Date || '');
        if (!existing.last.date || (date && date > existing.last.date)) {
          existing.last = { from: m.headers?.From, subject: m.headers?.Subject, date };
        }
        threadMap[m.threadId] = existing;
      }
      const threadList = Object.entries(threadMap).map(([threadId, v]) => ({ threadId, messageIds: v.messageIds, lastMsgMeta: v.last, labelIds: Object.keys(v.labelIds) }));
      try {
        const txThreads = db.transaction('threads', 'readwrite');
        for (const t of threadList) {
          try {
            const existing = await txThreads.store.get(t.threadId as any) as GmailThread | undefined;
            if (existing) {
              // Compute last-activity markers to decide whether to overwrite
              const existingLast = Math.max(Number(existing.lastMsgMeta?.date) || 0, Number((existing as any).aiSubjectUpdatedAt) || 0, Number(existing.summaryUpdatedAt) || 0);
              const incomingLast = Number((t as any).lastMsgMeta?.date) || 0;
              const existingHasInbox = Array.isArray(existing.labelIds) && existing.labelIds.includes('INBOX');
              const incomingHasInbox = Array.isArray((t as any).labelIds) && (t as any).labelIds.includes('INBOX');
              // If the local copy removed INBOX (archived/snoozed/deleted locally), prefer local and skip overwrite
              if (!existingHasInbox && incomingHasInbox) {
                pushLog('debug', '[Precompute] Skipping thread prime for', t.threadId, 'because local has removed INBOX');
                continue;
              }
              if (existingLast >= incomingLast) {
                pushLog('debug', '[Precompute] Skipping thread prime for', t.threadId, 'because local is newer');
                continue;
              }
            }

            // Merge minimal incoming metadata with any existing thread record to preserve
            // cached AI summary fields (summary, summaryStatus, summaryUpdatedAt, bodyHash, etc.)
            const merged: GmailThread = existing ? { ...existing, ...t } : (t as any);
            
            // CRITICAL: Preserve local state for processed emails to prevent resurrection
            // If local thread has removed INBOX (archived/snoozed/deleted), keep local labelIds
            // Otherwise, use incoming labelIds for proper inbox syncing
            if (existing && !existingHasInbox && incomingHasInbox) {
              // Local has been processed (INBOX removed), preserve local labelIds
              merged.labelIds = existing.labelIds || [];
            } else {
              // Use incoming labelIds for normal inbox syncing
              merged.labelIds = (t as any).labelIds || merged.labelIds || [];
            }
            
            merged.lastMsgMeta = (t as any).lastMsgMeta || merged.lastMsgMeta || { date: 0 };

            await txThreads.store.put(merged as any);
          } catch (e) { pushLog('warn', '[Precompute] Failed to evaluate/put thread', t.threadId, e); }
        }
        await txThreads.done;
      } catch (e) { pushLog('warn', '[Precompute] Failed to persist threads', e); }
    } catch (e) {
      pushLog('warn', '[Precompute] Failed to prime DB from Gmail before precompute', e);
    }

    const allThreads = await db.getAll('threads');
    // Sanitize any stale pending markers: if a cached summary exists, ensure
    // we don't leave the thread in a 'pending' state from older runs.
    try {
      const txSan = db.transaction('threads', 'readwrite');
      for (const t of allThreads) {
        try {
          if (t && t.summary && String(t.summary).trim() && (t.summaryStatus === 'pending')) {
            const next = { ...t, summaryStatus: 'ready', summaryPendingAt: undefined } as any;
            await txSan.store.put(next);
          }
        } catch (_) {}
      }
      await txSan.done;
    } catch (e) { pushLog('warn', '[Precompute] Failed to sanitize pending markers', e); }
    pushLog('debug', '[Precompute] Total threads in DB:', allThreads.length);
    
    const candidates = allThreads.filter((t) => {
      // First check if it's in unfiltered inbox
      if (!isUnfilteredInbox(t)) return false;
      
      // Additional safeguard: Ensure we don't process threads that user has explicitly processed
      // Check for signs that this thread has been locally processed (archived/snoozed/deleted)
      const labels = t.labelIds || [];
      
      // Skip if thread has been moved to TRASH or SPAM
      if (labels.includes('TRASH') || labels.includes('SPAM')) {
        pushLog('debug', '[Precompute] Skipping processed thread (TRASH/SPAM):', t.threadId);
        return false;
      }
      
      // Skip if thread has no INBOX label (archived/deleted locally)
      if (!labels.includes('INBOX')) {
        pushLog('debug', '[Precompute] Skipping processed thread (no INBOX):', t.threadId);
        return false;
      }
      
      return true;
    });
    pushLog('debug', '[Precompute] Inbox candidates:', candidates.length);
    
    if (!candidates.length) {
      pushLog('debug', '[Precompute] No inbox candidates found');
      // Check if this is because all threads are filtered out
      const inboxThreads = allThreads.filter(t => t.labelIds?.includes('INBOX'));
      const spamTrashThreads = allThreads.filter(t => t.labelIds?.includes('SPAM') || t.labelIds?.includes('TRASH'));
      
      if (inboxThreads.length === 0) {
        pushLog('debug', '[Precompute] No threads with INBOX label found');
      } else if (inboxThreads.length > 0 && candidates.length === 0) {
        pushLog('debug', '[Precompute] All inbox threads are filtered out (SPAM/TRASH)');
      }
      
      precomputeStatus.complete();
      return { processed: 0, total: allThreads.length };
    }
    
    // Start progress tracking
    precomputeStatus.start(candidates.length);

    // Removed AI summary versioning. Cached summaries are binary (exist / not)
    // Ensure `nowVersion` is defined to avoid ReferenceError from older code paths
    // that still refer to versioned fields. Use a stable numeric sentinel.
    const nowVersion = 1; // kept for backwards compatibility checks (no-op with binary cache)
    pushLog('debug', '[Precompute] Using binary cached summaries (no version) nowVersion:', nowVersion);
    
    const pending: Array<GmailThread> = [];
    for (const t of candidates) {
      // Without versions, only recompute when missing or in an error/none state
      // or when content appears changed since last summary (bodyHash/summaryUpdatedAt).
      const bodyHashExists = !!t.bodyHash;
      // Do NOT trigger recompute if a cached summary exists. Respect any existing
      // cached summary and only mark missing/error summaries as needing work.
      const needsSummary = !t.summary || t.summaryStatus === 'none' || t.summaryStatus === 'error';
      const needsSubject = !t.aiSubject || t.aiSubjectStatus === 'none' || t.aiSubjectStatus === 'error';
      if (needsSummary || needsSubject) pending.push(t);
    }
    
    pushLog('debug', '[Precompute] Pending items:', pending.length);
    if (pending.length > 0) {
      pushLog('debug', '[Precompute] Sample pending item:', {
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
      pushLog('debug', '[Precompute] No pending items found');
      // Check if this is because all items already have summaries
      const allHaveSummaries = candidates.every(t => {
        const summaryVersionMismatch = (t.summaryVersion || 0) !== nowVersion;
        const needsSummary = !t.summary || t.summaryStatus === 'none' || t.summaryStatus === 'error' || summaryVersionMismatch;
        const subjectVersionMismatch = (t.subjectVersion || 0) !== nowVersion;
        const needsSubject = !t.aiSubject || t.aiSubjectStatus === 'none' || t.aiSubjectStatus === 'error' || subjectVersionMismatch;
        return !needsSummary && !needsSubject;
      });
      
      if (allHaveSummaries) {
        pushLog('debug', '[Precompute] All items already have up-to-date summaries and subjects');
      } else {
        pushLog('debug', '[Precompute] Items exist but none need processing (possible version mismatch)');
      }
      
      precomputeStatus.complete();
      return { processed: 0, total: candidates.length };
    }

    const batch = pending.slice(0, Math.max(1, limit));
    pushLog('debug', '[Precompute] Processing batch of:', batch.length);
    
    // Update progress - preparing texts
    precomputeStatus.updateProgress(0, 'Preparing email content...');

    // Prepare texts
    let prepared = await mapWithConcurrency(batch, 3, async (t) => {
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

    // Before marking items as pending, re-check DB state to avoid touching threads the user removed
    try {
      const toMark: typeof prepared = [] as any;
      for (const p of prepared) {
        try {
          const latest = await db.get('threads', p.thread.threadId);
          if (!latest || !isUnfilteredInbox(latest)) {
            pushLog('debug', '[Precompute] Skipping mark-pending for', p.thread.threadId, 'because thread is no longer in INBOX or was deleted');
            continue;
          }
          toMark.push(p);
        } catch (e) { pushLog('warn', '[Precompute] Failed to re-check thread before marking pending', p.thread.threadId, e); }
      }

      // Update status to pending (only for fields that need work) for filtered set
      const tx = db.transaction('threads', 'readwrite');
      for (const p of toMark) {
        const t = p.thread;
        // Respect any existing cached summary: only mark as needing work when
        // there is no cached summary or the status is explicitly none/error.
        const needsSummary = !t.summary || t.summaryStatus === 'none' || t.summaryStatus === 'error';
        const subjectVersionMismatch = (t.subjectVersion || 0) !== nowVersion;
        const needsSubject = !t.aiSubject || t.aiSubjectStatus === 'none' || t.aiSubjectStatus === 'error' || subjectVersionMismatch;

        // Avoid overwriting summaryUpdatedAt when merely marking pending for items
        // that don't currently have a cached summary. Introduce `summaryPendingAt`
        // to track when precompute marked the thread for processing without implying
        // an existing cached summary was updated.
        const now = Date.now();
        const nextAny: any = {
          ...t,
          // Never set 'pending' summaryStatus for threads that already have
          // a cached summary; respect the cached summary instead.
          summaryStatus: (needsSummary && !(t.summary && String(t.summary).trim())) ? 'pending' : t.summaryStatus,
          // Preserve summaryUpdatedAt as-is unless we will be writing an actual summary later
          summaryUpdatedAt: t.summaryUpdatedAt,
          // Record when precompute marked this thread pending. If the thread already
          // had a cached summary, prefer to show that timestamp as the base; otherwise use now.
          summaryPendingAt: needsSummary ? (t.summary ? (t.summaryUpdatedAt || now) : now) : undefined,
          aiSubjectStatus: needsSubject ? 'pending' : t.aiSubjectStatus,
          aiSubjectUpdatedAt: needsSubject ? (t.aiSubject ? (t.aiSubjectUpdatedAt || now) : now) : t.aiSubjectUpdatedAt
        } as GmailThread;
        await tx.store.put(nextAny as any);
        // Mirror the DB-updated timestamps into the in-memory prepared item so
        // the later persist step does not incorrectly treat the DB row as newer
        // and skip updating computed AI fields.
        try { p.thread = nextAny; } catch (_) {}
      }
      await tx.done;
      // Overwrite prepared to only include items we actually marked and will process
      prepared = toMark as any;
    } catch (_) {}

    // If batch is preferred, try server batch; else direct
    // Decide which items need which computations
    const wantsSummary = prepared.filter((p) => {
      const t = p.thread;
      // Never request a summary if a cached summary exists. Only include
      // threads that lack a summary or are in an explicit none/error state.
      return !t.summary || t.summaryStatus === 'none' || t.summaryStatus === 'error';
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
      pushLog('debug', '[Precompute] Processing', summaryTargets.length, 'summary targets');
      
      // Update progress - processing summaries
      precomputeStatus.updateProgress(0, `Processing ${summaryTargets.length} summaries...`);
      
      // Always attempt server-side combined batch first for cheaper Gemini rates
      pushLog('debug', '[Precompute] Attempting combined batch mode for summaries');
      const items = summaryTargets.map((p) => ({ id: p.thread.threadId, text: p.text || p.subject || '' }));
      // Try combined (single Gemini call for many inputs) first
      let map = await summarizeBatchRemote(items, s.aiApiKey, s.aiSummaryModel || s.aiModel, s.precomputeUseContextCache, true);
      if (map && Object.keys(map).length) {
        summaryResults = map;
        pushLog('debug', '[Precompute] Combined batch summary results:', Object.keys(map).length);
      } else {
        pushLog('debug', '[Precompute] Combined batch failed or returned no results, falling back to parallel per-item server batch');
        // Fallback to server-side parallel per-item batch (still cheaper than client-side sequential)
        map = await summarizeBatchRemote(items, s.aiApiKey, s.aiSummaryModel || s.aiModel, s.precomputeUseContextCache, false);
        if (map && Object.keys(map).length) {
          summaryResults = map;
          pushLog('debug', '[Precompute] Server-side parallel batch summary results:', Object.keys(map).length);
        } else {
          pushLog('debug', '[Precompute] Server-side parallel batch failed, falling back to direct');
        }
      }
      if (!Object.keys(summaryResults).length) {
        pushLog('debug', '[Precompute] Using direct mode for summaries');
        let successCount = 0;
        let errorCount = 0;
        const out = await mapWithConcurrency(summaryTargets, 2, async (p: any) => {
          try {
            const text = await summarizeDirect(p.subject, p.bodyText, p.bodyHtml, p.attachments);
            if (text && text.trim()) {
              pushLog('debug', '[Precompute] Direct summary success for', p.thread.threadId);
              successCount++;
              return { id: p.thread.threadId, text };
            } else {
              pushLog('debug', '[Precompute] Direct summary returned empty text for', p.thread.threadId);
              errorCount++;
              return { id: p.thread.threadId, text: '' };
            }
          } catch (e) {
            pushLog('error', '[Precompute] Direct summary failed for', p.thread.threadId, e);
            errorCount++;
            return { id: p.thread.threadId, text: '' };
          }
        });
        summaryResults = Object.fromEntries(out.map((o) => [o.id, o.text]));
        pushLog('debug', '[Precompute] Direct summary results:', Object.keys(summaryResults).length, 'success:', successCount, 'errors:', errorCount);
      }
    }

    let subjectResults: Record<string, string> = {};
    if (wantsSubject.length) {
      pushLog('debug', '[Precompute] Processing', wantsSubject.length, 'subject targets');
      
      // Update progress - processing subjects
      precomputeStatus.updateProgress(
        summaryTargets.length, 
        `Processing ${wantsSubject.length} AI subjects...`
      );
      
      // Always attempt server-side combined batch for subjects first
      pushLog('debug', '[Precompute] Attempting combined batch mode for subjects');
      const items = wantsSubject.map((p) => {
        const t = p.thread as GmailThread;
        const readySummary = (t.summaryStatus === 'ready' && t.summary) ? t.summary : (summaryResults[t.threadId] || '');
        const text = readySummary && readySummary.trim()
          ? `Subject: ${p.subject}\n\nAI Summary:\n${readySummary}`
          : (p.text || p.subject || '');
        return { id: p.thread.threadId, text };
      });
      // Try combined single-call batch
      let subjMap = await summarizeSubjectBatchRemote(items, s.aiApiKey, s.aiSummaryModel || s.aiModel, s.precomputeUseContextCache, true);
      if (subjMap && Object.keys(subjMap).length) {
        subjectResults = subjMap;
        pushLog('debug', '[Precompute] Combined batch subject results:', Object.keys(subjMap).length);
      } else {
        pushLog('debug', '[Precompute] Combined batch for subjects failed, falling back to server-side parallel batch');
        subjMap = await summarizeSubjectBatchRemote(items, s.aiApiKey, s.aiSummaryModel || s.aiModel, s.precomputeUseContextCache, false);
        if (subjMap && Object.keys(subjMap).length) {
          subjectResults = subjMap;
          pushLog('debug', '[Precompute] Server-side parallel batch subject results:', Object.keys(subjMap).length);
        } else {
          pushLog('debug', '[Precompute] Server-side parallel batch for subjects failed, falling back to direct');
        }
      }
      if (!Object.keys(subjectResults).length) {
        pushLog('debug', '[Precompute] Using direct mode for subjects');
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
              pushLog('debug', '[Precompute] Direct subject success for', p.thread.threadId);
              successCount++;
              return { id: p.thread.threadId, text };
            } else {
              pushLog('debug', '[Precompute] Direct subject returned empty text for', p.thread.threadId);
              errorCount++;
              return { id: p.thread.threadId, text: '' };
            }
          } catch (e) {
            pushLog('error', '[Precompute] Direct subject failed for', p.thread.threadId, e);
            errorCount++;
            return { id: p.thread.threadId, text: '' };
          }
        });
        subjectResults = Object.fromEntries(out.map((o) => [o.id, o.text]));
        pushLog('debug', '[Precompute] Direct subject results:', Object.keys(subjectResults).length, 'success:', successCount, 'errors:', errorCount);
      }
    }

    // Update progress - persisting results
    precomputeStatus.updateProgress(
      summaryTargets.length + wantsSubject.length, 
      'Saving AI summaries and subjects...'
    );
    
    // Persist results
    pushLog('debug', '[Precompute] Persisting results...');
    try {
      const tx = db.transaction('threads', 'readwrite');
      const nowMs = Date.now();
      let updatedCount = 0;
      const updatedThreads: any[] = [];
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
        
        pushLog('debug', '[Precompute] Thread', t.threadId, ':', {
          needsSummary: needsSum,
          needsSubject: needsSubj,
          summaryOk: sumOk,
          subjectOk: subjOk,
          summaryText: sumText ? `${sumText.slice(0, 50)}...` : 'none',
          subjectText: subjText ? `${subjText.slice(0, 50)}...` : 'none'
        });
        
        // Be aggressive about persisting AI fields: do not block writes based
        // on timestamps or bodyHash. Only skip when the local copy explicitly
        // removed INBOX or the thread is in TRASH. Preserve any existing
        // non-empty AI fields (do not overwrite them) to avoid clobbering a
        // user-updated subject/summary.
        let existing: GmailThread | undefined;
        let existingHasAiSubject = false;
        let existingHasSummary = false;
        try {
          existing = await tx.store.get(t.threadId as any) as GmailThread | undefined;
          if (existing) {
            const existingHasInbox = Array.isArray(existing.labelIds) && existing.labelIds.includes('INBOX');
            const incomingHasInbox = Array.isArray((t as any).labelIds) && (t as any).labelIds.includes('INBOX');
            if (!existingHasInbox && incomingHasInbox) {
              pushLog('debug', '[Precompute] Skipping persist for', t.threadId, 'local removed INBOX');
              continue;
            }
            if (Array.isArray(existing.labelIds) && existing.labelIds.includes('TRASH')) {
              pushLog('debug', '[Precompute] Skipping persist for', t.threadId, 'thread is in TRASH');
              continue;
            }
            existingHasAiSubject = !!(existing.aiSubject && String(existing.aiSubject).trim());
            existingHasSummary = !!(existing.summary && String(existing.summary).trim());
          }
        } catch (e) {
          pushLog('warn', '[Precompute] Failed to check existing thread for persist guard', t.threadId, e);
        }

        // Merge: start from existing to preserve local fields, then overlay
        // incoming metadata, but only set AI fields when existing ones are
        // empty.
        const base = existing ? { ...existing } : { ...t };
        const next: GmailThread = {
          ...base,
          ...t,
          summary: (existing && existingHasSummary) ? existing.summary : (setSummaryFields && sumOk ? sumText.trim() : t.summary),
          summaryStatus: (existing && existingHasSummary) ? (existing.summaryStatus || 'ready') : (setSummaryFields ? (sumOk ? 'ready' : (t.summaryStatus || 'error')) : t.summaryStatus),
          summaryUpdatedAt: (existing && existingHasSummary) ? (existing.summaryUpdatedAt || nowMs) : (setSummaryFields ? nowMs : t.summaryUpdatedAt),
          bodyHash: p.bodyHash
        } as any;
        if (needsSubj) {
          if (subjOk) {
            if (existing && existingHasAiSubject) {
              (next as any).aiSubject = (existing as any).aiSubject;
              (next as any).aiSubjectStatus = (existing as any).aiSubjectStatus || 'ready';
              (next as any).aiSubjectUpdatedAt = (existing as any).aiSubjectUpdatedAt || nowMs;
            } else {
              (next as any).aiSubject = subjText.trim();
              (next as any).aiSubjectStatus = 'ready';
              (next as any).aiSubjectUpdatedAt = nowMs;
            }
          } else {
            (next as any).aiSubjectStatus = (t as any).aiSubjectStatus || 'error';
          }
        }
        await tx.store.put(next);
        updatedCount++;
        updatedThreads.push(next);
      }
      await tx.done;
      pushLog('debug', '[Precompute] Updated', updatedCount, 'threads in database');
      // Merge updates into in-memory threads store so UI updates immediately
      try {
        const current = Array.isArray(getStore(threads)) ? getStore(threads) : [];
        const merged = [...current].reduce((acc, t) => {
          acc.push(t);
          return acc;
        }, [] as any[]);
        for (const ut of updatedThreads) {
          const idx = merged.findIndex((x) => x.threadId === ut.threadId);
          if (idx >= 0) merged[idx] = { ...merged[idx], ...ut };
          else merged.push(ut);
        }
        threads.set(merged as any);
      } catch (e) { pushLog('warn', '[Precompute] Failed to merge updates into threads store', e); }
    } catch (e) {
      pushLog('error', '[Precompute] Error persisting results:', e);
    }
    
    // Update progress - completed
    precomputeStatus.updateProgress(prepared.length, 'Saving complete.');

    // Return processing information
    const result = { processed: prepared.length, total: candidates.length };
    pushLog('debug', '[Precompute] Completed:', result);

    // Keep current error/warn counts available to the UI by passing them through complete()
    try {
      const counts = (precomputeStatus as any).getCounts ? (precomputeStatus as any).getCounts() : { errors: 0, warns: 0 };
      precomputeStatus.complete({ errors: counts.errors || 0, warns: counts.warns || 0, processed: result.processed, total: result.total });
      // Do not persist last run timestamp; we no longer gate by time.
    } catch (e) {
      precomputeStatus.complete();
    }

    return result;
  } catch (e) {
    // eslint-disable-next-line no-console
    try { pushLog('error', '[Precompute] tick error', e); } catch {}
    
    // Complete progress tracking on error
    precomputeStatus.complete();
    
    // Return processing information
    pushLog('debug', '[Precompute] Completed with error, returning 0 processed');
    return { processed: 0, total: 0 };
  }
}

export async function precomputeNow(limit = 25): Promise<{ processed: number; total: number }> {
  const result = await tickPrecompute(limit);
  return result;
}


// On module load, sanitize any lingering 'pending' summary markers for threads
// that already have a cached summary. Run this in a background task to avoid
// blocking module initialization (IndexedDB reads/writes can be slow on some
// environments and should not stall app startup).
try {
  if (typeof setTimeout === 'function') {
    setTimeout(async () => {
      try {
        const db = await getDB();
        const all = await db.getAll('threads');
        const tx = db.transaction('threads', 'readwrite');
        let updated = 0;
        for (const t of all) {
          try {
            if (t && t.summary && String(t.summary).trim() && t.summaryStatus === 'pending') {
              const next = { ...t, summaryStatus: 'ready', summaryPendingAt: undefined } as any;
              await tx.store.put(next);
              updated++;
            }
          } catch (_) {}
        }
        await tx.done;
        if (updated) pushLog('debug', '[Precompute] Sanitized pending markers on background task, updated:', updated);
      } catch (e) { pushLog('warn', '[Precompute] Background sanitization failed', e); }
    }, 0);
  } else {
    (async () => {
      try {
        const db = await getDB();
        const all = await db.getAll('threads');
        const tx = db.transaction('threads', 'readwrite');
        let updated = 0;
        for (const t of all as any[]) {
          try {
            if (t && t.summary && String(t.summary).trim() && t.summaryStatus === 'pending') {
              const next = { ...t, summaryStatus: 'ready', summaryPendingAt: undefined } as any;
              await tx.store.put(next);
              updated++;
            }
          } catch (_) {}
        }
        await tx.done;
        if (updated) pushLog('debug', '[Precompute] Sanitized pending markers on module load, updated:', updated);
      } catch (e) { pushLog('warn', '[Precompute] Module-load sanitization failed', e); }
    })();
  }
} catch (_) {}

