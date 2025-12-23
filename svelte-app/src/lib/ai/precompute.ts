import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { getDB } from '$lib/db/indexeddb';
import type { GmailMessage, GmailThread, GmailAttachment } from '$lib/types';
import {
  aiSummarizeEmail,
  aiSummarizeSubject,
  aiRunModeration
} from '$lib/ai/providers';
import {
  getEmailSummaryCombinedPrompt,
  getSubjectImprovementCombinedPrompt,
  getCollegeRecruitingModerationPrompt,
  getReviewsModerationPrompt
} from '$lib/ai/prompts';
import { queueThreadModify } from '$lib/queue/intents';
import { precomputeStatus } from '$lib/stores/precompute';
import { threads } from '$lib/stores/threads';
import { get as getStore } from 'svelte/store';

// In-memory precompute log buffer (UI consumable)
type PrecomputeLogEntry = { ts: number; level: 'debug' | 'warn' | 'error'; message: string };
const PRECOMPUTE_LOG_CAP = 1000; // hard cap on retained logs
const PRECOMPUTE_LOG_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const _precomputeLogs: PrecomputeLogEntry[] = [];

// Moderation Rules Configuration
const MODERATION_RULES = [
  {
    id: 'college_recruiting_v2',
    labelName: 'college_recruiting',
    prompt: getCollegeRecruitingModerationPrompt(),
    version: 2
  },
  {
    id: 'reviews_v2',
    labelName: 'reviews',
    prompt: getReviewsModerationPrompt(),
    version: 2
  }
];

// Cache for label IDs
const _labelIdCache: Record<string, string> = {};

async function ensureLabel(name: string): Promise<string | null> {
  if (_labelIdCache[name]) return _labelIdCache[name];
  
  try {
    const { listLabels, createLabel } = await import('$lib/gmail/api');
    const labels = await listLabels();
    const existing = labels.find((l) => l.name === name);
    
    if (existing && existing.id) {
      _labelIdCache[name] = existing.id;
      pushLog('debug', `[Precompute] Found existing label "${name}":`, existing.id);
      return existing.id;
    }
    
    // Create the label
    pushLog('debug', `[Precompute] Creating label "${name}"`);
    const newLabel = await createLabel(name);
    _labelIdCache[name] = newLabel.id;
    pushLog('debug', `[Precompute] Created label "${name}":`, newLabel.id);
    return newLabel.id;
  } catch (e) {
    pushLog('error', `[Precompute] Failed to ensure label "${name}":`, e);
    return null;
  }
}

function getEligibleModerationRule(thread: GmailThread, prepared: { bodyText?: string; bodyHtml?: string; subject?: string; summary?: string }): typeof MODERATION_RULES[0] | null {
  try {
    const labels = thread.labelIds || [];
    if (!labels.includes('INBOX')) return null;
    if (labels.includes('TRASH') || labels.includes('SPAM')) return null;
    
    // Check content availability
    const hasSubject = prepared.subject && prepared.subject.trim().length > 0;
    const hasSummary = prepared.summary && prepared.summary.trim().length > 0;
    const hasBody = !!(prepared.bodyText || prepared.bodyHtml);
    if (!hasSubject && !hasSummary && !hasBody) return null;

    const lastActivity = Number(thread.lastMsgMeta?.date) || 0;

    for (const rule of MODERATION_RULES) {
      // Skip if already labeled with this rule's label
      const hasLabel = labels.some(l => l.includes(rule.labelName) || l === _labelIdCache[rule.labelName]);
      if (hasLabel) continue;

      const existing = thread.autoModeration?.[rule.id];
      if (!existing) return rule;

      // Retry if status is not decisive or error
      if (existing.status === 'pending' || existing.status === 'error' || existing.status === 'unknown') return rule;

      // Retry if prompt version changed
      if (existing.promptVersion !== rule.version) return rule;

      // Retry if new activity since last moderation
      if (existing.status === 'not_match' && lastActivity > (existing.updatedAt || 0)) return rule;

      // Retry if match but action failed
      if (existing.status === 'match' && existing.actionTaken !== 'label_enqueued') return rule;
    }

    return null;
  } catch (e) {
    pushLog('warn', '[Precompute] Error checking moderation eligibility:', thread.threadId, e);
    return null;
  }
}

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
    if (hasCustomSnoozeLabels && !labels.includes('INBOX')) {
      return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

async function summarizeDirect(subject: string, bodyText?: string, bodyHtml?: string, attachments?: import('$lib/types').GmailAttachment[], threadId?: string): Promise<string> {
  return aiSummarizeEmail(subject || '', bodyText, bodyHtml, attachments, threadId);
}

type GeminiBatchMode = 'summary' | 'subject';
type GeminiBatchItem = { id: string; text: string };

const GEMINI_COMBINED_BATCH_SIZE = 8;

function extractGeminiJson(text: string): string | null {
  try {
    if (!text) return null;
    let trimmed = text.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('```')) {
      const firstNewline = trimmed.indexOf('\n');
      trimmed = firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed;
      const fence = trimmed.lastIndexOf('```');
      if (fence >= 0) trimmed = trimmed.slice(0, fence);
      trimmed = trimmed.trim();
    }
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start >= 0 && end >= start) {
      trimmed = trimmed.slice(start, end + 1);
    }
    return trimmed;
  } catch {
    return null;
  }
}

async function callGeminiCombinedChunk(
  items: GeminiBatchItem[],
  apiKey: string,
  model: string,
  mode: GeminiBatchMode
): Promise<Record<string, string>> {
  if (!items.length || !apiKey) return {};
  const prompt = mode === 'summary'
    ? getEmailSummaryCombinedPrompt()
    : getSubjectImprovementCombinedPrompt();

  let payload = '';
  try {
    payload = JSON.stringify(items.map((item) => ({ id: String(item.id || ''), text: String(item.text || '') })));
  } catch {
    return {};
  }

  const compositePrompt = `${prompt}\n\nINPUT:${payload}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: compositePrompt }] }],
        generationConfig: { temperature: 0.2 }
      })
    });
    if (!res.ok) return {};
    const data = await res.json().catch(() => ({} as any));
    const parts = data?.candidates?.[0]?.content?.parts;
    let textOut: string | undefined;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          textOut = part.text.trim();
          break;
        }
      }
    }
    if (!textOut && typeof data?.text === 'string') {
      textOut = data.text;
    }
    if (!textOut) return {};

    const jsonText = extractGeminiJson(textOut);
    if (!jsonText) return {};
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return {};

    const map: Record<string, string> = {};
    for (const entry of parsed) {
      const id = entry && entry.id != null ? String(entry.id) : '';
      if (!id) continue;
      const value = entry && entry.text != null ? String(entry.text) : '';
      map[id] = value;
    }
    return map;
  } catch {
    return {};
  }
}

async function runGeminiCombinedBatch(
  items: GeminiBatchItem[],
  apiKey?: string,
  model?: string,
  mode: GeminiBatchMode = 'summary'
): Promise<Record<string, string>> {
  const key = (apiKey || '').trim();
  const modelName = (model || '').trim() || 'gemini-1.5-flash';
  if (!key || !items.length) return {};

  const results: Record<string, string> = {};
  for (let i = 0; i < items.length; i += GEMINI_COMBINED_BATCH_SIZE) {
    const chunk = items.slice(i, i + GEMINI_COMBINED_BATCH_SIZE);
    const chunkMap = await callGeminiCombinedChunk(chunk, key, modelName, mode);
    Object.assign(results, chunkMap);
  }
  return results;
}

async function summarizeBatchRemote(
  items: GeminiBatchItem[],
  apiKey?: string,
  model?: string,
  _useCache?: boolean,
  combined = false
): Promise<Record<string, string>> {
  if (!combined) return {};
  try {
    return await runGeminiCombinedBatch(items, apiKey, model, 'summary');
  } catch {
    return {};
  }
}

async function summarizeSubjectBatchRemote(
  items: GeminiBatchItem[],
  apiKey?: string,
  model?: string,
  _useCache?: boolean,
  combined = false
): Promise<Record<string, string>> {
  if (!combined) return {};
  try {
    return await runGeminiCombinedBatch(items, apiKey, model, 'subject');
  } catch {
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

export async function tickPrecompute(limit = 10, skipSync = false, options?: { 
  cumulativeProcessed?: number; 
  totalCandidates?: number; 
  skipComplete?: boolean;
  moderationPriority?: boolean;
  moderationLimit?: number;
}): Promise<{ processed: number; total: number }> {
  try {
    console.log('[Precompute] ===== STARTING PRECOMPUTE ===== limit:', limit, 'skipSync:', skipSync, 'options:', options);
    const s = get(settings);
    // No time-based auto-run gating: allow precompute to run whenever requested.
    console.log('[Precompute] Settings:', { 
      precomputeSummaries: s?.precomputeSummaries, 
      aiProvider: s?.aiProvider, 
      aiApiKey: s?.aiApiKey ? `*** (${s.aiApiKey.length})` : 'missing',
      aiModel: s?.aiModel,
      aiSummaryModel: s?.aiSummaryModel
    });
    pushLog('debug', '[Precompute] Settings:', { 
      precomputeSummaries: s?.precomputeSummaries, 
      aiProvider: s?.aiProvider, 
      aiApiKey: s?.aiApiKey ? `*** (${s.aiApiKey.length})` : 'missing',
      aiModel: s?.aiModel,
      aiSummaryModel: s?.aiSummaryModel,
      skipSync,
      options
    });
    
    if (!s?.precomputeSummaries) {
      console.log('[Precompute] Precompute summaries disabled in settings');
      if (!options?.skipComplete) precomputeStatus.complete();
      return { processed: 0, total: 0 };
    }

    if (!s?.aiApiKey || s.aiApiKey.trim() === '') {
      console.warn('[Precompute] AI API key is missing; cannot run precompute');
      pushLog('warn', '[Precompute] AI API key is missing; cannot run precompute');
      if (!options?.skipComplete) precomputeStatus.complete();
      return { processed: 0, total: 0 };
    }
    
    const db = await getDB();
    // Ensure database has all INBOX message/thread metadata before computing
    // This will walk Gmail pages and populate 'messages' and 'threads' stores in indexeddb
    if (!skipSync) {
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

        // Identify which messages we already have metadata for
        const existingMsgIds = new Set(await db.getAllKeys('messages'));
        const missingMsgIds = allMsgIds.filter(id => !existingMsgIds.has(id));
        
        pushLog('debug', '[Precompute] Syncing inbox messages:', allMsgIds.length, 'total,', missingMsgIds.length, 'missing');
        
        // Fetch metadata ONLY for missing message ids with concurrency and persist
        if (missingMsgIds.length > 0) {
          const newMsgs = await mapWithConcurrency(missingMsgIds, 6, async (id) => await getMessageMetadata(id));
          try {
            const txMsgs = db.transaction('messages', 'readwrite');
            for (const m of newMsgs) await txMsgs.store.put(m);
            await txMsgs.done;
          } catch (e) { pushLog('warn', '[Precompute] Failed to persist new messages', e); }
        }

        // Fetch all current inbox messages from DB (already populated or just updated)
        const txRead = db.transaction('messages', 'readonly');
        const msgsResults = await Promise.all(allMsgIds.map(id => txRead.store.get(id)));
        const msgs = msgsResults.filter((m): m is GmailMessage => !!m);
        
        for (const m of msgs) {
          // Ensure the message has the INBOX label in our local representation
          if (!m.labelIds.includes('INBOX')) {
            m.labelIds.push('INBOX');
          }
        }

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
              const existingHasInbox = existing ? (Array.isArray(existing.labelIds) && existing.labelIds.includes('INBOX')) : false;
              const incomingHasInbox = Array.isArray((t as any).labelIds) && (t as any).labelIds.includes('INBOX');
              
              if (existing) {
                // Compute last-activity markers to decide whether to overwrite
                const existingLast = Math.max(Number(existing.lastMsgMeta?.date) || 0, Number((existing as any).aiSubjectUpdatedAt) || 0, Number(existing.summaryUpdatedAt) || 0);
                const incomingLast = Number((t as any).lastMsgMeta?.date) || 0;
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
    } else {
      pushLog('debug', '[Precompute] Skipping Gmail sync as requested');
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
    console.log('[Precompute] Total threads in DB:', allThreads.length);
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
    console.log('[Precompute] Inbox candidates:', candidates.length);
    pushLog('debug', '[Precompute] Inbox candidates:', candidates.length);
    
    if (!candidates.length) {
      console.log('[Precompute] No inbox candidates found - returning early');
      pushLog('debug', '[Precompute] No inbox candidates found');
      // Check if this is because all threads are filtered out
      const inboxThreads = allThreads.filter(t => t.labelIds?.includes('INBOX'));
      const spamTrashThreads = allThreads.filter(t => t.labelIds?.includes('SPAM') || t.labelIds?.includes('TRASH'));
      
      if (inboxThreads.length === 0) {
        console.log('[Precompute] No threads with INBOX label found');
        pushLog('debug', '[Precompute] No threads with INBOX label found');
      } else if (inboxThreads.length > 0 && candidates.length === 0) {
        console.log('[Precompute] All inbox threads are filtered out (SPAM/TRASH)');
        pushLog('debug', '[Precompute] All inbox threads are filtered out (SPAM/TRASH)');
      }
      
      if (!options?.skipComplete) precomputeStatus.complete();
      return { processed: 0, total: allThreads.length };
    }
    
    // Start progress tracking
    if (options?.cumulativeProcessed === undefined) {
      precomputeStatus.start(options?.totalCandidates || candidates.length);
    }

    // Removed AI summary versioning. Cached summaries are binary (exist / not)
    // Ensure `nowVersion` is defined to avoid ReferenceError from older code paths
    // that still refer to versioned fields. Use a stable numeric sentinel.
    const nowVersion = 1; // kept for backwards compatibility checks (no-op with binary cache)
    pushLog('debug', '[Precompute] Using binary cached summaries (no version) nowVersion:', nowVersion);
    
    const needsSummaryThreads: Array<GmailThread> = [];
    for (const t of candidates) {
      // Without versions, only recompute when missing or in an error/none state
      // or when content appears changed since last summary (bodyHash/summaryUpdatedAt).
      const needsSummary = !t.summary || t.summaryStatus === 'none' || t.summaryStatus === 'error';
      const needsSubject = !t.aiSubject || t.aiSubjectStatus === 'none' || t.aiSubjectStatus === 'error';
      if (needsSummary || needsSubject) needsSummaryThreads.push(t);
    }
    
    // Check which threads need moderation (separate from summary processing)
    const needsModerationThreads = candidates.filter(t => {
      const labels = t.labelIds || [];
      if (!labels.includes('INBOX')) return false;
      if (labels.includes('TRASH') || labels.includes('SPAM')) return false;
      
      // Check if any rule is eligible
      const eligibleRule = getEligibleModerationRule(t, { subject: t.lastMsgMeta?.subject, summary: t.summary });
      return !!eligibleRule;
    });
    
    console.log('[Precompute] Needs moderation:', needsModerationThreads.length, 'threads');
    console.log('[Precompute] Needs summary/subject:', needsSummaryThreads.length, 'threads');

    // Construct the final pending list for this tick, balancing moderation and summaries
    const pending: Array<GmailThread> = [];
    const pendingIds = new Set<string>();

    if (options?.moderationPriority) {
      // If moderation is priority, fill the batch with moderation tasks first
      const moderationBatch = needsModerationThreads.slice(0, limit);
      for (const t of moderationBatch) {
        if (!pendingIds.has(t.threadId)) {
          pending.push(t);
          pendingIds.add(t.threadId);
        }
      }
      // Then fill remaining space with summaries
      if (pending.length < limit) {
        const summaryBatch = needsSummaryThreads
          .filter(t => !pendingIds.has(t.threadId))
          .slice(0, limit - pending.length);
        for (const t of summaryBatch) {
          pending.push(t);
          pendingIds.add(t.threadId);
        }
      }
    } else {
      // Normal behavior: prioritize summaries, then fill with moderation
      const summaryBatch = needsSummaryThreads.slice(0, limit);
      for (const t of summaryBatch) {
        pending.push(t);
        pendingIds.add(t.threadId);
      }
      if (pending.length < limit) {
        const moderationBatch = needsModerationThreads
          .filter(t => !pendingIds.has(t.threadId))
          .slice(0, limit - pending.length);
        for (const t of moderationBatch) {
          pending.push(t);
          pendingIds.add(t.threadId);
        }
      }
    }
    
    pushLog('debug', '[Precompute] Pending items for this tick:', pending.length, 
      '(Summary priority:', !options?.moderationPriority, ')');
    
    if (!pending.length) {
      console.log('[Precompute] No pending items or moderation needed - returning early');
      pushLog('debug', '[Precompute] No pending items found');
      // Check if this is because all items already have summaries
      const allHaveSummaries = candidates.every(t => {
        const needsSummary = !t.summary || t.summaryStatus === 'none' || t.summaryStatus === 'error';
        const needsSubject = !t.aiSubject || t.aiSubjectStatus === 'none' || t.aiSubjectStatus === 'error';
        return !needsSummary && !needsSubject;
      });
      
      if (allHaveSummaries) {
        console.log('[Precompute] All items already have up-to-date summaries and subjects');
        pushLog('debug', '[Precompute] All items already have up-to-date summaries and subjects');
      }
      
      if (!options?.skipComplete) precomputeStatus.complete();
      return { processed: 0, total: candidates.length };
    }

    const batch = pending; // already limited by logic above
    console.log('[Precompute] Processing batch of:', batch.length, 'threads');
    pushLog('debug', '[Precompute] Processing batch of:', batch.length);
    
    const cumulativeOffset = options?.cumulativeProcessed || 0;
    
    // Update progress - preparing texts
    precomputeStatus.updateProgress(cumulativeOffset, 'Preparing email content...');

    // Prepare texts
    console.log('[Precompute] Preparing thread content...');
    let prepared = await mapWithConcurrency(batch, 3, async (t) => {
      const lastId = getLastMessageId(t);
      let bodyText: string | undefined;
      let bodyHtml: string | undefined;
      let attachments: GmailAttachment[] | undefined;
      if (lastId) {
        const full = await tryGetLastMessageFull(lastId);
        if (full) { bodyText = full.bodyText; bodyHtml = full.bodyHtml; attachments = full.attachments; }
      }
      const subject = t.lastMsgMeta?.subject || '';
      const attText = (attachments || []).map((a) => `${a.filename || a.mimeType || 'attachment'}\n${(a.textContent || '').slice(0, 500)}`).join('\n\n');
      const text = `${subject}\n\n${bodyText || ''}${!bodyText && bodyHtml ? bodyHtml : ''}${attText ? `\n\n${attText}` : ''}`.trim();
      const bodyHash = simpleHash(text || subject || t.threadId);
      
      // For moderation, find the first eligible rule
      const summary = t.summary;
      const moderationRule = getEligibleModerationRule(t, { bodyText, bodyHtml, subject, summary });
      return { 
        thread: t, 
        subject, 
        bodyText, 
        bodyHtml, 
        summary, 
        attachments, 
        text, 
        bodyHash, 
        moderationRule, 
        moderationResult: null as null | {
          status: 'match' | 'not_match' | 'unknown' | 'error';
          ruleId: string;
          labelName: string;
          raw?: string;
          error?: unknown;
        } 
      } as any;
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
      precomputeStatus.updateProgress(cumulativeOffset, `Processing ${summaryTargets.length} summaries...`);
      
      const combinedItems = summaryTargets.map((p) => ({ id: p.thread.threadId, text: p.text || p.subject || '' }));
      let map: Record<string, string> = {};
      if (s.aiApiKey && s.aiProvider === 'gemini') {
        pushLog('debug', '[Precompute] Attempting client-side combined batch for summaries');
        map = await summarizeBatchRemote(combinedItems, s.aiApiKey, s.aiSummaryModel || s.aiModel, s.precomputeUseContextCache, true);
        if (map && Object.keys(map).length) {
          pushLog('debug', '[Precompute] Combined batch summary results:', Object.keys(map).length);
          summaryResults = map;
        } else {
          pushLog('debug', '[Precompute] Combined batch summary call returned no data, falling back to direct');
        }
      } else if (s.aiApiKey && s.aiProvider !== 'gemini') {
        pushLog('debug', '[Precompute] Skipping combined batching for provider:', s.aiProvider);
      } else {
        pushLog('warn', `[Precompute] No ${s.aiProvider || 'AI'} API key configured; skipping combined batch for summaries`);
      }

      const missingSummaryTargets = summaryTargets.filter((p) => {
        const val = summaryResults[p.thread.threadId];
        return !(val && val.trim());
      });

      if (missingSummaryTargets.length) {
        pushLog('debug', '[Precompute] Using direct mode for summaries (missing:', missingSummaryTargets.length, ')');
        let successCount = 0;
        let errorCount = 0;
        const out = await mapWithConcurrency(missingSummaryTargets, 2, async (p: any) => {
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
        for (const o of out) summaryResults[o.id] = o.text;
        pushLog('debug', '[Precompute] Direct summary fallback results:', out.length, 'success:', successCount, 'errors:', errorCount);
      }
    }

    // Run moderation for eligible threads
    const moderationTargets = prepared.filter((p) => p.moderationRule);
    console.log('[Precompute] Moderation eligibility check: total prepared:', prepared.length, 'eligible:', moderationTargets.length);
    pushLog('debug', '[Precompute] Moderation eligibility check: total prepared:', prepared.length, 'eligible:', moderationTargets.length);
    
    if (moderationTargets.length) {
      console.log('[Precompute] Running moderation for', moderationTargets.length, 'threads');
      pushLog('debug', '[Precompute] Running moderation for', moderationTargets.length, 'threads');
      
      const modMsg = `Checking ${moderationTargets.length} moderation candidates...`;
      const summMsg = summaryTargets.length > 0 ? ` (and ${summaryTargets.length} summaries)` : '';
      
      precomputeStatus.updateProgress(
        cumulativeOffset + summaryTargets.length + (wantsSubject?.length || 0),
        modMsg + summMsg
      );

      await mapWithConcurrency(moderationTargets, 2, async (p) => {
        try {
          const rule = p.moderationRule;
          console.log('[Precompute] Calling aiRunModeration for', p.thread.threadId, 
            'rule:', rule.id, 'hasSummary:', !!p.summary);
          
          // Prefer using existing AI summary if available, fall back to body
          const contentForAI = p.summary || p.bodyText || p.bodyHtml;
          const result = await aiRunModeration(rule.prompt, p.subject, contentForAI, undefined, p.thread.lastMsgMeta?.from);
          
          p.moderationResult = {
            status:
              result.verdict === 'match' ? 'match' :
              result.verdict === 'not_match' ? 'not_match' : 'unknown',
            ruleId: rule.id,
            labelName: rule.labelName,
            raw: result.raw
          };
          console.log('[Precompute] Moderation verdict for', p.thread.threadId, 'rule:', rule.id, ':', result.verdict);
          pushLog('debug', '[Precompute] Moderation verdict for', p.thread.threadId, 'rule:', rule.id, ':', result.verdict);
        } catch (e) {
          console.error('[Precompute] Moderation failed for', p.thread.threadId, e);
          p.moderationResult = { 
            status: 'error', 
            ruleId: p.moderationRule.id,
            labelName: p.moderationRule.labelName,
            error: e instanceof Error ? e.message : String(e) 
          };
          pushLog('warn', '[Precompute] Moderation failed for', p.thread.threadId, e);
        }
      });
    }

    let subjectResults: Record<string, string> = {};
    if (wantsSubject.length) {
      pushLog('debug', '[Precompute] Processing', wantsSubject.length, 'subject targets');
      
      // Update progress - processing subjects
      precomputeStatus.updateProgress(
        cumulativeOffset + summaryTargets.length, 
        `Processing ${wantsSubject.length} AI subjects...`
      );
      
      const subjectItems = wantsSubject.map((p) => {
        const t = p.thread as GmailThread;
        const readySummary = (t.summaryStatus === 'ready' && t.summary) ? t.summary : (summaryResults[t.threadId] || '');
        const text = readySummary && readySummary.trim()
          ? `Subject: ${p.subject}\n\nAI Summary:\n${readySummary}`
          : (p.text || p.subject || '');
        return { id: p.thread.threadId, text };
      });

      let subjMap: Record<string, string> = {};
      if (s.aiApiKey && s.aiProvider === 'gemini') {
        pushLog('debug', '[Precompute] Attempting client-side combined batch for subjects');
        subjMap = await summarizeSubjectBatchRemote(subjectItems, s.aiApiKey, s.aiSummaryModel || s.aiModel, s.precomputeUseContextCache, true);
        if (subjMap && Object.keys(subjMap).length) {
          pushLog('debug', '[Precompute] Combined batch subject results:', Object.keys(subjMap).length);
          subjectResults = subjMap;
        } else {
          pushLog('debug', '[Precompute] Combined batch subject call returned no data, falling back to direct');
        }
      } else if (s.aiApiKey && s.aiProvider !== 'gemini') {
        pushLog('debug', '[Precompute] Skipping combined batching for provider:', s.aiProvider);
      } else {
        pushLog('warn', `[Precompute] No ${s.aiProvider || 'AI'} API key configured; skipping combined batch for subjects`);
      }

      const missingSubjects = wantsSubject.filter((p) => {
        const val = subjectResults[p.thread.threadId];
        return !(val && val.trim());
      });

      if (missingSubjects.length) {
        pushLog('debug', '[Precompute] Using direct mode for subjects (missing:', missingSubjects.length, ')');
        let successCount = 0;
        let errorCount = 0;
        const out = await mapWithConcurrency(missingSubjects, 2, async (p) => {
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
        for (const o of out) subjectResults[o.id] = o.text;
        pushLog('debug', '[Precompute] Direct subject fallback results:', out.length, 'success:', successCount, 'errors:', errorCount);
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
      const nowMs = Date.now();
      const updatedThreads: GmailThread[] = [];
      const queueActions: Array<{ threadId: string; labelId: string }> = [];
      
      const existingThreadsMap = new Map<string, GmailThread>();
      
      // Use individual db.get calls in parallel instead of a manual transaction
      // This avoids InvalidStateError from long-lived read transactions
      const readResults = await Promise.all(prepared.map(p => db.get('threads', p.thread.threadId)));
      prepared.forEach((p, i) => {
        if (readResults[i]) existingThreadsMap.set(p.thread.threadId, readResults[i] as GmailThread);
      });

      for (const p of prepared) {
        const t = p.thread;
        const sumText = (summaryResults && summaryResults[t.threadId]) || '';
        const sumOk = !!(sumText && sumText.trim());
        const subjText = (subjectResults && subjectResults[t.threadId]) || '';
        const subjOk = !!(subjText && subjText.trim());
        const needsSum = !!wantsSummary.find((x) => x.thread.threadId === t.threadId);
        const needsSubj = !!wantsSubject.find((x) => x.thread.threadId === t.threadId);
        
        const existing = existingThreadsMap.get(t.threadId);
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
        }

        const existingHasAiSubject = !!(existing?.aiSubject && String(existing.aiSubject).trim());
        const existingHasSummary = !!(existing?.summary && String(existing.summary).trim());
        const hadReadySummary = existing?.summaryStatus === 'ready' && !!existing.summary;
        const computedButWasntRequested = !needsSum && sumOk && !hadReadySummary;
        const setSummaryFields = needsSum || computedButWasntRequested;

        // Merge: start from existing to preserve local fields, then overlay incoming metadata
        const base = existing ? { ...existing } : { ...t };
        const next: GmailThread = {
          ...base,
          ...t,
          summary: (existing && existingHasSummary) ? existing.summary : (setSummaryFields && sumOk ? sumText.trim() : t.summary),
          summaryStatus: (existing && existingHasSummary) ? (existing.summaryStatus || 'ready') : (setSummaryFields ? (sumOk ? 'ready' : (t.summaryStatus || 'error')) : t.summaryStatus),
          summaryUpdatedAt: (existing && existingHasSummary) ? (existing.summaryUpdatedAt || nowMs) : (setSummaryFields ? nowMs : t.summaryUpdatedAt),
          bodyHash: p.bodyHash
        } as any;

        if (p.moderationRule && p.moderationResult) {
          const mod = p.moderationResult;
          const ruleId = mod.ruleId;
          const rule = MODERATION_RULES.find(r => r.id === ruleId);
          const prevModeration = (existing || t).autoModeration || {};
          const moderationEntry = (prevModeration as any)[ruleId] || {};
          const nextModerationEntry = {
            ...moderationEntry,
            status: mod.status,
            raw: mod.raw,
            lastError: mod.error ? String(mod.error) : undefined,
            promptVersion: rule?.version,
            updatedAt: nowMs,
            actionTaken: moderationEntry.actionTaken
          };
          (next as any).autoModeration = {
            ...prevModeration,
            [ruleId]: nextModerationEntry
          };

          if (mod.status === 'match') {
            const labelId = await ensureLabel(mod.labelName);
            if (labelId) {
              queueActions.push({ threadId: t.threadId, labelId });
              (next as any).autoModeration[ruleId].actionTaken = 'label_enqueued';
            } else {
              pushLog('error', `[Precompute] Could not get label ID for "${mod.labelName}" on thread`, t.threadId);
              (next as any).autoModeration[ruleId].lastError = 'Failed to get label ID';
            }
          }
        }

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
        updatedThreads.push(next);
      }

      if (updatedThreads.length > 0) {
        // Fast transaction for all puts, parallelized
        const txWrite = db.transaction('threads', 'readwrite');
        const putPromises = updatedThreads.map(ut => txWrite.store.put(ut));
        await Promise.all(putPromises);
        await txWrite.done;
        pushLog('debug', '[Precompute] Updated', updatedThreads.length, 'threads in database');
      }

      // Run queue actions AFTER transaction
      for (const action of queueActions) {
        try {
          pushLog('debug', '[Precompute] Enqueuing label for recruiting match', action.threadId, 'labelId:', action.labelId);
          await queueThreadModify(action.threadId, [action.labelId], ['INBOX'], { optimisticLocal: false });
        } catch (err) {
          pushLog('error', '[Precompute] Failed to enqueue label for', action.threadId, err);
        }
      }

      // Merge updates into in-memory threads store so UI updates immediately
      try {
        const current = Array.isArray(getStore(threads)) ? getStore(threads) : [];
        const merged = [...current];
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
    precomputeStatus.updateProgress(cumulativeOffset + prepared.length, 'Saving complete.');

    // Return processing information
    const result = { processed: prepared.length, total: candidates.length };
    pushLog('debug', '[Precompute] Completed batch tick:', result);

    // Keep current error/warn counts available to the UI by passing them through complete()
    if (!options?.skipComplete) {
      try {
        const counts = (precomputeStatus as any).getCounts ? (precomputeStatus as any).getCounts() : { errors: 0, warns: 0 };
        precomputeStatus.complete({ errors: counts.errors || 0, warns: counts.warns || 0, processed: cumulativeOffset + result.processed, total: options?.totalCandidates || result.total });
        // Do not persist last run timestamp; we no longer gate by time.
      } catch (e) {
        precomputeStatus.complete();
      }
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

export async function precomputeNow(limit = 500, options?: { moderationPriority?: boolean }): Promise<{ processed: number; total: number }> {
  pushLog('debug', '[Precompute] precomputeNow starting with limit:', limit, 'options:', options);
  let totalProcessed = 0;
  let candidatesTotal = 0;
  
  // First tick includes Gmail sync and sets up the progress bar
  // We use a reasonably small batch size for the first tick to give fast feedback
  let result = await tickPrecompute(Math.min(limit, 25), false, { 
    skipComplete: true,
    moderationPriority: options?.moderationPriority
  });
  totalProcessed += result.processed;
  candidatesTotal = result.total;
  
  // If we already hit the limit or have no more work, complete and return
  if (totalProcessed >= limit || (result.processed === 0 && candidatesTotal > 0)) {
    // If we have no more work but candidatesTotal > 0, it means everything is already summarized
    const counts = (precomputeStatus as any).getCounts ? (precomputeStatus as any).getCounts() : { errors: 0, warns: 0 };
    precomputeStatus.complete({ errors: counts.errors || 0, warns: counts.warns || 0, processed: totalProcessed, total: candidatesTotal });
    return { processed: totalProcessed, total: candidatesTotal };
  }

  // If result.total is 0, tickPrecompute already handled complete() if we didn't pass skipComplete, 
  // but we did pass skipComplete.
  if (candidatesTotal === 0) {
    precomputeStatus.complete();
    return { processed: 0, total: 0 };
  }

  // Subsequent ticks skip Gmail sync to be efficient and update the existing progress bar
  while (totalProcessed < limit) {
    const nextBatchSize = Math.min(25, limit - totalProcessed);
    result = await tickPrecompute(nextBatchSize, true, { 
      cumulativeProcessed: totalProcessed, 
      totalCandidates: candidatesTotal,
      skipComplete: true,
      moderationPriority: options?.moderationPriority
    });
    
    if (result.processed === 0) break;
    totalProcessed += result.processed;
  }
  
  // Final completion
  const counts = (precomputeStatus as any).getCounts ? (precomputeStatus as any).getCounts() : { errors: 0, warns: 0 };
  precomputeStatus.complete({ errors: counts.errors || 0, warns: counts.warns || 0, processed: totalProcessed, total: candidatesTotal });
  
  return { processed: totalProcessed, total: candidatesTotal };
}

/**
 * Clear moderation data for threads that were tested but not labeled
 * This allows precompute to reprocess them
 */
export async function clearModerationDataForThread(threadId: string, ruleId?: string): Promise<{ success: boolean; message: string }> {
  try {
    const db = await getDB();
    const thread = await db.get('threads', threadId);
    
    if (!thread) {
      return { success: false, message: 'Thread not found in local database' };
    }
    
    const targetRuleId = ruleId || 'college_recruiting_v2'; // default for backward compat
    const existing = thread.autoModeration?.[targetRuleId];
    if (!existing) {
      return { success: false, message: `No moderation data found for rule "${targetRuleId}" on this thread` };
    }
    
    // Only clear if it was a match but no action was taken
    if (existing.status === 'match' && existing.actionTaken !== 'label_enqueued') {
      const updatedModeration = { ...thread.autoModeration };
      delete updatedModeration[targetRuleId];
      
      const updatedThread = {
        ...thread,
        autoModeration: updatedModeration
      };
      
      await db.put('threads', updatedThread);
      return { success: true, message: `Moderation data for "${targetRuleId}" cleared - thread will be reprocessed by precompute` };
    } else {
      return { success: false, message: `Cannot clear moderation data - status: ${existing.status}, actionTaken: ${existing.actionTaken}` };
    }
  } catch (e) {
    return { 
      success: false, 
      message: `Error clearing moderation data: ${e instanceof Error ? e.message : String(e)}` 
    };
  }
}

/**
 * Manually trigger moderation for a specific thread
 */
export async function moderateThreadManually(threadId: string, ruleId?: string): Promise<{ success: boolean; message: string; result?: any }> {
  try {
    const db = await getDB();
    const thread = await db.get('threads', threadId);
    
    if (!thread) {
      return { success: false, message: 'Thread not found in local database' };
    }

    const targetRuleId = ruleId || 'college_recruiting_v2';
    const rule = MODERATION_RULES.find(r => r.id === targetRuleId);
    if (!rule) {
      return { success: false, message: `Moderation rule "${targetRuleId}" not found` };
    }
    
    // Get the last message with full body
    const lastMsgId = thread.messageIds?.[thread.messageIds.length - 1];
    if (!lastMsgId) {
      return { success: false, message: 'No messages found in thread' };
    }
    
    const { getMessageFull } = await import('$lib/gmail/api');
    const msg = await getMessageFull(lastMsgId);
    const subject = thread.lastMsgMeta?.subject || msg.headers?.Subject || '';
    const from = thread.lastMsgMeta?.from || msg.headers?.From || '';
    
    // Run AI detection
    const contentForAI = thread.summary || msg.bodyText || msg.bodyHtml;
    const result = await aiRunModeration(rule.prompt, subject, contentForAI, undefined, from);
    
    // If it's a match, apply the label
    if (result.verdict === 'match') {
      const labelId = await ensureLabel(rule.labelName);
      if (labelId) {
        await queueThreadModify(threadId, [labelId], ['INBOX'], { optimisticLocal: false });
        
        // Update local thread data
        const nowMs = Date.now();
        const prevModeration = thread.autoModeration || {};
        const moderationEntry = (prevModeration as any)[targetRuleId] || {};
        const nextModerationEntry = {
          ...moderationEntry,
          status: 'match',
          raw: result.raw,
          promptVersion: rule.version,
          updatedAt: nowMs,
          actionTaken: 'label_enqueued'
        };
        
        const updatedThread = {
          ...thread,
          autoModeration: {
            ...prevModeration,
            [targetRuleId]: nextModerationEntry
          }
        };
        
        await db.put('threads', updatedThread);
        
        return { 
          success: true, 
          message: `Thread labeled as "${rule.labelName}" and removed from inbox`,
          result: { verdict: result.verdict, raw: result.raw, labelId }
        };
      } else {
        return { success: false, message: `Failed to get label ID for "${rule.labelName}"` };
      }
    } else {
      // Update local thread data even for non-matches
      const nowMs = Date.now();
      const prevModeration = thread.autoModeration || {};
      const moderationEntry = (prevModeration as any)[targetRuleId] || {};
      const nextModerationEntry = {
        ...moderationEntry,
        status: result.verdict === 'not_match' ? 'not_match' : 'unknown',
        raw: result.raw,
        promptVersion: rule.version,
        updatedAt: nowMs,
        actionTaken: moderationEntry.actionTaken
      };
      
      const updatedThread = {
        ...thread,
        autoModeration: {
          ...prevModeration,
          [targetRuleId]: nextModerationEntry
        }
      };
      
      await db.put('threads', updatedThread);
      
      return { 
        success: true, 
        message: `Thread classified as ${result.verdict} for rule "${targetRuleId}"`,
        result: { verdict: result.verdict, raw: result.raw }
      };
    }
  } catch (e) {
    return { 
      success: false, 
      message: `Error moderating thread: ${e instanceof Error ? e.message : String(e)}` 
    };
  }
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

