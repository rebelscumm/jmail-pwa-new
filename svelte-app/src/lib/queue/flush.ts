import { getDB } from '$lib/db/indexeddb';
import { batchModify } from '$lib/gmail/api';
import type { QueuedOp } from '$lib/types';
import { backoffDelay, getDueOps, pruneDuplicateOps } from './ops';
import { refreshSyncState } from '$lib/stores/queue';
import { applyRemoteLabels } from './intents';

export async function flushOnce(now = Date.now()): Promise<void> {
  const db = await getDB();
  const due = await getDueOps(now);
  if (!due.length) return;

  // Coalesce batchModify ops by identical add/remove sets
  const groups = new Map<string, QueuedOp[]>();
  for (const op of due) {
    if (op.op.type !== 'batchModify') continue;
    const key = JSON.stringify({ add: op.op.addLabelIds.sort(), rem: op.op.removeLabelIds.sort() });
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
      // Success: delete ops
      const tx = db.transaction('ops', 'readwrite');
      for (const o of ops) await tx.store.delete(o.id);
      await tx.done;
    } catch (e: unknown) {
      // Retry with backoff
      const tx = db.transaction('ops', 'readwrite');
      for (const o of ops) {
        o.attempts += 1;
        o.nextAttemptAt = Date.now() + backoffDelay(o.attempts);
        const message = e instanceof Error ? e.message : String(e);
        o.lastError = message;
        await tx.store.put(o);
        // Minimal reconcile: fetch server state for one thread and apply locally (server wins)
        try {
          const threadId = o.scopeKey;
          // Fetch messages for thread (ids known), then update local labels
          const labelsByMessage: Record<string, string[]> = {};
          for (const id of o.op.ids) {
            const m = await (await import('$lib/gmail/api')).getMessageMetadata(id);
            labelsByMessage[id] = m.labelIds || [];
          }
          await applyRemoteLabels(threadId, labelsByMessage);
        } catch (_) {}
      }
      await tx.done;
    }
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

