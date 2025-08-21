import { getDB } from '$lib/db/indexeddb';
import type { QueuedOp } from '$lib/types';
import { v4 as uuidv4 } from 'uuid';

export function hashIntent(input: unknown): string {
  const json = JSON.stringify(input);
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    const chr = json.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return `${hash}`;
}

export async function enqueueBatchModify(
  accountSub: string,
  ids: string[],
  addLabelIds: string[],
  removeLabelIds: string[],
  scopeKey: string
): Promise<QueuedOp> {
  const db = await getDB();
  const intent = { type: 'batchModify' as const, ids, addLabelIds, removeLabelIds };
  const op: QueuedOp = {
    id: uuidv4(),
    accountSub,
    op: intent,
    scopeKey,
    opHash: hashIntent(intent),
    createdAt: Date.now(),
    attempts: 0,
    nextAttemptAt: Date.now()
  };
  await db.put('ops', op);
  return op;
}

export async function enqueueSendMessage(
  accountSub: string,
  raw: string,
  threadId?: string
): Promise<QueuedOp> {
  const db = await getDB();
  const intent = { type: 'sendMessage' as const, raw, threadId };
  const op: QueuedOp = {
    id: uuidv4(),
    accountSub,
    op: intent,
    scopeKey: threadId || `compose:${uuidv4()}`,
    opHash: hashIntent(intent),
    createdAt: Date.now(),
    attempts: 0,
    nextAttemptAt: Date.now()
  };
  await db.put('ops', op);
  return op;
}

export async function getDueOps(now = Date.now()): Promise<QueuedOp[]> {
  const db = await getDB();
  const tx = db.transaction('ops');
  const idx = tx.store.index('by_nextAttemptAt');
  const results: QueuedOp[] = [];
  let cursor = await idx.openCursor();
  while (cursor) {
    if (cursor.value.nextAttemptAt <= now) results.push(cursor.value);
    cursor = await cursor.continue();
  }
  return results;
}

export function backoffDelay(attempts: number): number {
  const base = [1000, 4000, 16000, 60000, 180000, 300000];
  const idx = Math.min(attempts, base.length - 1);
  const jitter = Math.floor(Math.random() * 500);
  return base[idx] + jitter;
}

export async function pruneDuplicateOps(): Promise<void> {
  const db = await getDB();
  const all = await db.getAll('ops');
  const byKey = new Map<string, QueuedOp>();
  const toDelete: string[] = [];
  for (const o of all) {
    const key = `${o.scopeKey}:${o.opHash}`;
    if (byKey.has(key)) toDelete.push(o.id);
    else byKey.set(key, o);
  }
  if (toDelete.length) {
    const tx = db.transaction('ops', 'readwrite');
    for (const id of toDelete) await tx.store.delete(id);
    await tx.done;
  }
}

