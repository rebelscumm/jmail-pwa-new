import { getDB } from '$lib/db/indexeddb';
import { batchModify } from '$lib/gmail/api';
import type { QueuedOp } from '$lib/types';
import { backoffDelay, getDueOps } from './ops';

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
      }
      await tx.done;
    }
  }
}

let timer: number | null = null;

export function startFlushLoop() {
  if (timer) return;
  const run = async () => {
    try {
      await flushOnce();
    } finally {
      timer = setTimeout(run, 2000) as unknown as number;
    }
  };
  run();
}

