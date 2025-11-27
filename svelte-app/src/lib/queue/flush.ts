import { getDB } from '$lib/db/indexeddb';
import { batchModify, sendMessageRaw } from '$lib/gmail/api';
import type { QueuedOp } from '$lib/types';
import { backoffDelay, getDueOps, pruneDuplicateOps } from './ops';
import { refreshSyncState } from '$lib/stores/queue';
import { copyGmailDiagnosticsToClipboard } from '$lib/gmail/api';

export async function flushOnce(now = Date.now()): Promise<void> {
  // In server-managed auth mode, we rely on the server session; proceed and handle 401s per-call.
  const db = await getDB();
  const due = await getDueOps(now);
  if (!due.length) return;

  let anyOpsCompleted = false;

  // 1) Handle sendMessage ops individually
  const sendOps = due.filter((o) => o.op.type === 'sendMessage');
  for (const o of sendOps) {
    try {
      await sendMessageRaw(o.op.raw, o.op.threadId);
      const tx = db.transaction('ops', 'readwrite');
      await tx.store.delete(o.id);
      await tx.done;
      anyOpsCompleted = true;
    } catch (e: unknown) {
      const tx = db.transaction('ops', 'readwrite');
      o.attempts += 1;
      o.nextAttemptAt = Date.now() + backoffDelay(o.attempts);
      o.lastError = e instanceof Error ? e.message : String(e);
      await tx.store.put(o);
      await tx.done;
      // Attempt to copy diagnostics to clipboard to assist debugging
      try {
        await copyGmailDiagnosticsToClipboard({ reason: 'send_op_error', lastError: o.lastError, opId: o.id, attempts: o.attempts, pendingOps: (await db.getAll('ops')).length, lastUpdatedAt: Date.now() });
      } catch (_) {}
    }
  }

  // 2) Coalesce batchModify ops by identical add/remove sets
  const groups = new Map<string, QueuedOp[]>();
  for (const op of due) {
    if (op.op.type !== 'batchModify') continue;
    const key = JSON.stringify({ add: op.op.addLabelIds.slice().sort(), rem: op.op.removeLabelIds.slice().sort() });
    const arr = groups.get(key) || [];
    arr.push(op);
    groups.set(key, arr);
  }

  for (const [, ops] of groups) {
    const ids = Array.from(new Set(ops.flatMap((o) => o.op.ids)));
    const addLabelIds = ops[0].op.addLabelIds;
    const removeLabelIds = ops[0].op.removeLabelIds;
    try {
      await batchModify(ids, addLabelIds, removeLabelIds);
      
      // DO NOT reconcile with server immediately after operation success
      // Gmail's eventual consistency is unpredictable (can take 1-10+ seconds)
      // Immediate reconciliation causes thread resurrection when server returns stale state
      // Instead: Trust our optimistic local state, let authoritative sync handle reconciliation
      
      // Success: delete ops from queue
      const tx = db.transaction('ops', 'readwrite');
      for (const o of ops) await tx.store.delete(o.id);
      await tx.done;
      anyOpsCompleted = true;
    } catch (e: unknown) {
      // Retry with backoff
      const tx = db.transaction('ops', 'readwrite');
      for (const o of ops) {
        o.attempts += 1;
        o.nextAttemptAt = Date.now() + backoffDelay(o.attempts);
        const message = e instanceof Error ? e.message : String(e);
        o.lastError = message;
        await tx.store.put(o);
        // DO NOT reconcile with server state on failure - preserve optimistic local state
        // The operation will be retried, and authoritative sync will handle discrepancies
      }
      await tx.done;
      // Clipboard diagnostics with summary
      try {
        const pending = await db.getAll('ops');
        await copyGmailDiagnosticsToClipboard({ reason: 'batch_modify_error', lastError: (e instanceof Error ? e.message : String(e)), groupSize: ops.length, uniqueIds: ids.length, addLabelIds, removeLabelIds, pendingOps: pending.length, lastUpdatedAt: Date.now() });
      } catch (_) {}
    }
  }
  
  // After operations complete, check if we should reset optimistic counters
  // We reset when there are no more pending operations (all synced to server)
  // We preserve counters when there are still pending ops (they reflect the pending changes)
  if (anyOpsCompleted) {
    try {
      const remainingOps = await db.getAll('ops');
      if (!remainingOps || remainingOps.length === 0) {
        const { resetOptimisticCounters } = await import('$lib/stores/optimistic-counters');
        resetOptimisticCounters();
      }
      // If there are still pending ops, keep current counter values
    } catch (_) {}
  }
  
  await refreshSyncState().catch(() => {});
}

let timer: number | null = null;

export function startFlushLoop() {
  if (timer) return;
  const run = async () => {
    try {
      await flushOnce();
      await pruneDuplicateOps();
      // Notify UI for sync state chip if needed
      if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SYNC_TICK' });
      }
    } finally {
      timer = setTimeout(run, 2000) as unknown as number;
    }
  };
  run();
}

