import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { show } from '$lib/containers/snackbar';
import { getDB } from '$lib/db/indexeddb';

type GeminiRequest = {
  id: string;
  model: string;
  parts?: any[];
  prompt?: string;
  streaming?: boolean;
  priority?: 'interactive' | 'background';
};

type QueueItem = {
  req: GeminiRequest;
  resolve: (v: any) => void;
  reject: (e: any) => void;
  retries: number;
  enqueuedAt: number;
};

const DEFAULTS = {
  maxConcurrent: 3,
  maxConcurrentInteractive: 2,
  batchWindowMs: 50,
  maxBatchSize: 16,
  maxRetries: 5,
  baseBackoffMs: 500,
  maxBackoffMs: 60000
};

const pendingQueue: QueueItem[] = [];
let currentConcurrent = 0;
let currentInteractive = 0;
// Simple in-memory cache: promptHash -> { text, ts }
const responseCache: Map<string, { text: string; ts: number }> = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h default

// Token budget accounting (approx tokens outstanding)
let outstandingTokenBudget = 0;
const MAX_OUTSTANDING_TOKENS = 100000; // configurable limit

// Persisted cache flush scheduling
let cacheFlushScheduled = false;
async function flushCacheToDB() {
  try {
    const db = await getDB();
    const snapshot: Record<string, { text: string; ts: number }> = {};
    // only persist up to 100 entries to avoid storage bloat
    let i = 0;
    for (const [k, v] of responseCache.entries()) {
      snapshot[k] = v;
      i++;
      if (i >= 100) break;
    }
    await db.put('settings', snapshot, 'geminiResponseCache');
  } catch (e) { /* best-effort persist */ }
  cacheFlushScheduled = false;
}

function scheduleCacheFlush() {
  if (cacheFlushScheduled) return;
  cacheFlushScheduled = true;
  setTimeout(() => { try { flushCacheToDB(); } catch {} }, 1000);
}

// Load persisted cache at module init (best-effort)
(async () => {
  try {
    const db = await getDB();
    const saved = await db.get('settings', 'geminiResponseCache');
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(saved as any)) {
        try { responseCache.set(k, (saved as any)[k]); } catch {}
      }
    }
  } catch (e) { /* ignore */ }
})();

function now() { return Date.now(); }

function logInfo(msg: string, ...args: any[]) { try { console.log('[GeminiClient]', msg, ...args); } catch {} }
function logError(msg: string, ...args: any[]) { try { console.error('[GeminiClient]', msg, ...args); } catch {} }

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)); }

function jitter(ms: number) { return Math.floor(Math.random() * ms); }

function backoffForAttempt(attempt: number) {
  const base = DEFAULTS.baseBackoffMs;
  const ms = Math.min(DEFAULTS.maxBackoffMs, Math.pow(2, attempt) * base);
  return Math.floor(ms / 2) + jitter(Math.floor(ms / 2)); // full jitter
}

async function sendDirect(item: QueueItem) {
  const s = get(settings);
  const apiKey = s.aiApiKey || '';
  const model = item.req.model || s.aiModel || 'gemini-1.5-flash';
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = item.req.parts ? { contents: [{ role: 'user', parts: item.req.parts }] } : { contents: [{ parts: [{ text: item.req.prompt || '' }] }] };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const ra = res.headers.get('retry-after');
      const err = new Error(`Gemini error ${res.status}: ${text.slice(0, 200)}`) as any;
      err.status = res.status;
      err.headers = { 'retry-after': ra };
      throw err;
    }
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } catch (e) {
    throw e;
  }
}

function estimateTokensFor(req: GeminiRequest) {
  try {
    const text = req.prompt || (req.parts || []).map((p: any) => p.text || '').join('\n');
    const len = (text || '').length;
    // rough heuristic: 4 chars ~ 1 token
    return Math.max(1, Math.ceil(len / 4));
  } catch {
    return 1;
  }
}

async function processQueueOnce() {
  if (!pendingQueue.length) return;
  // Respect interactive concurrency reservation
  const interactiveSlots = Math.max(0, DEFAULTS.maxConcurrentInteractive - currentInteractive);
  const globalSlots = Math.max(0, DEFAULTS.maxConcurrent - currentConcurrent);
  if (globalSlots <= 0) return;

  // Prefer interactive items first
  const pickable: QueueItem[] = [];
  for (let i = 0; i < pendingQueue.length && pickable.length < globalSlots; i++) {
    const it = pendingQueue[i];
    if (it.req.priority === 'interactive') {
      if (interactiveSlots > 0 || currentInteractive < DEFAULTS.maxConcurrentInteractive) pickable.push(it);
      else continue;
    } else {
      pickable.push(it);
    }
  }

  if (!pickable.length) return;

  // If first pick is background and there are multiple, attempt to batch
  const first = pickable[0];
  if (!first.req.streaming && first.req.priority === 'background') {
    // Build a batch of compatible items
    const batch = [first];
    // gather up to maxBatchSize compatible items
    for (let i = 1; i < pendingQueue.length && batch.length < DEFAULTS.maxBatchSize; i++) {
      const it = pendingQueue[i];
      if (it.req.priority === 'background' && !it.req.streaming && it.req.model === first.req.model) batch.push(it);
    }

    // Remove batch items from pendingQueue
    for (const b of batch) {
      const idx = pendingQueue.indexOf(b);
      if (idx >= 0) pendingQueue.splice(idx, 1);
    }

    // Token accounting: ensure batch doesn't exceed outstanding budget
    const batchTokens = batch.reduce((acc, b) => acc + estimateTokensFor(b.req), 0);
    if (outstandingTokenBudget + batchTokens > MAX_OUTSTANDING_TOKENS) {
      // delay batch slightly to allow token budget to free
      setTimeout(() => { try { processQueueOnce(); } catch {} }, 200);
      return;
    }

    // Execute batch as a single API call using server-side batch endpoint if available
    outstandingTokenBudget += batchTokens;
    currentConcurrent += 1;
    try {
      // Prefer using local server batch proxy if available to consolidate headers and caching
      const s = get(settings);
      const apiKey = s.aiApiKey || undefined;
      const model = batch[0].req.model || s.aiModel;
      // Send to server endpoint which will call Gemini batch/combined modes
      const items = batch.map((b) => ({ id: b.req.id, text: b.req.prompt || (b.req.parts && b.req.parts.map((p: any) => p.text || '').join('\n')) || '' }));
      let resp: any = null;
      try {
        const r = await fetch('/api/gemini', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'summarize_batch', items, model, apiKey }) });
        if (r.ok) resp = await r.json();
      } catch (e) { /* server batch failed; fall back to per-item */ }

      if (resp && resp.map) {
        for (const b of batch) {
          try {
            const text = String(resp.map[b.req.id] || '');
            // update cache
            try { responseCache.set(b.req.prompt || b.req.id, { text, ts: now() }); scheduleCacheFlush(); } catch {}
            b.resolve({ text });
          } catch (e) { b.reject(e); }
        }
      } else {
        // Fall back: call Gemini per item with limited concurrency
        await Promise.all(batch.map(async (b) => {
          try {
            const out = await sendWithRetries(b);
            b.resolve(out);
          } catch (e) { b.reject(e); }
        }));
      }
    } catch (e) {
      for (const b of pickable) try { b.reject(e); } catch {}
    } finally {
      currentConcurrent -= 1;
      outstandingTokenBudget = Math.max(0, outstandingTokenBudget - batchTokens);
    }
    return;
  }

  // Otherwise, process single items up to globalSlots
  for (let i = 0; i < pickable.length; i++) {
    const it = pickable[i];
    const idx = pendingQueue.indexOf(it);
    if (idx >= 0) pendingQueue.splice(idx, 1);
    const tok = estimateTokensFor(it.req);
    if (outstandingTokenBudget + tok > MAX_OUTSTANDING_TOKENS) {
      // requeue and delay
      pendingQueue.push(it);
      setTimeout(() => { try { processQueueOnce(); } catch {} }, 200);
      continue;
    }
    outstandingTokenBudget += tok;
    currentConcurrent += 1;
    if (it.req.priority === 'interactive') currentInteractive += 1;
    (async () => {
      try {
        const out = await sendWithRetries(it);
        it.resolve(out);
      } catch (e) {
        it.reject(e);
      } finally {
        currentConcurrent -= 1;
        if (it.req.priority === 'interactive') currentInteractive -= 1;
        outstandingTokenBudget = Math.max(0, outstandingTokenBudget - tok);
      }
    })();
  }
}

async function sendWithRetries(item: QueueItem) {
  let attempt = item.retries;
  while (true) {
    try {
      const res = await sendDirect(item);
      const textOut = (res?.candidates?.[0]?.content?.parts?.[0]?.text || (res?.raw && String(res.raw)) || '');
      try { responseCache.set(item.req.prompt || item.req.id, { text: String(textOut), ts: now() }); scheduleCacheFlush(); } catch {}
      return { text: textOut };
    } catch (e: any) {
      const status = e?.status || (e?.message && e.message.indexOf('429') >= 0 ? 429 : undefined);
      const ra = e?.headers && e.headers['retry-after'] ? Number(e.headers['retry-after']) : undefined;
      if (status === 429 || status === 503 || status === 500) {
        attempt += 1;
        if (typeof ra === 'number' && ra > 0) {
          const ms = ra * 1000 + jitter(1000);
          logInfo('Respecting Retry-After for', ms, 'ms');
          await wait(ms);
          continue;
        }
        if (attempt > DEFAULTS.maxRetries) {
          logError('Max retries reached for request', item.req.id);
          // surface to user via snackbar minimally
          try { show({ message: `AI request failed after retries (rate limit)`, timeout: 8000 }); } catch {}
          throw e;
        }
        const delay = backoffForAttempt(attempt);
        logInfo('Retrying request', item.req.id, 'after', delay, 'ms (attempt', attempt, ')');
        await wait(delay);
        continue;
      }
      // Non-retryable
      throw e;
    }
  }
}

export function enqueueGemini(req: GeminiRequest): Promise<{ text: string }> {
  return new Promise((resolve, reject) => {
    // Check cache first
    const cacheKey = req.prompt || (req.parts && req.parts.map((p:any)=>p.text||'').join('\n')) || req.id;
    try {
      const hit = responseCache.get(cacheKey);
      if (hit && (now() - hit.ts) < CACHE_TTL_MS) { logInfo('Cache hit for', cacheKey); resolve({ text: hit.text }); return; }
    } catch {}

    const item: QueueItem = { req: { ...req }, resolve, reject, retries: 0, enqueuedAt: now() };
    pendingQueue.push(item);
    // Trigger processing soon (batch window)
    setTimeout(() => { try { processQueueOnce(); } catch (e) { logError('processQueueOnce error', e); } }, DEFAULTS.batchWindowMs);
    // Also attempt immediate processing to pick up interactive slots
    try { processQueueOnce(); } catch (e) { /* swallow */ }
  });
}

// Debug helpers
export function getPendingCount() { return pendingQueue.length; }
export function clearPending() { pendingQueue.length = 0; }


