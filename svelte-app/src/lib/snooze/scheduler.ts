import { DateTime } from 'luxon';
import { getDB } from '$lib/db/indexeddb';
import type { SnoozeQueueItem } from '$lib/types';
import { enqueueBatchModify, hashIntent } from '$lib/queue/ops';

export async function enqueueSnooze(
  accountSub: string,
  threadId: string,
  messageIds: string[],
  snoozeLabelId: string,
  dueLocal: Date,
  zone: string,
  addUnreadOnUnsnooze = true
) {
  const dueAtUtc = DateTime.fromJSDate(dueLocal).setZone(zone).toUTC().toMillis();
  const id = `${threadId}:${snoozeLabelId}`;
  const item: SnoozeQueueItem = {
    id,
    accountSub,
    threadId,
    messageIds,
    snoozeLabelId,
    dueAtUtc,
    sourceTimeZone: zone,
    addUnreadOnUnsnooze
  };
  const db = await getDB();
  await db.put('snoozeQueue', item);
}

export async function processDueSnoozes(now = Date.now(), inboxLabelId = 'INBOX', unreadLabelId = 'UNREAD') {
  const db = await getDB();
  const tx = db.transaction('snoozeQueue', 'readwrite');
  const idx = tx.store.index('by_dueAtUtc');
  const due: SnoozeQueueItem[] = [];
  let cursor = await idx.openCursor();
  while (cursor) {
    if (cursor.value.dueAtUtc <= now) due.push(cursor.value);
    cursor = await cursor.continue();
  }
  for (const item of due) {
    const add = item.addUnreadOnUnsnooze ? [inboxLabelId, unreadLabelId] : [inboxLabelId];
    const remove = [item.snoozeLabelId];
    // Dedupe by scopeKey+opHash to avoid duplicates across restarts
    const intent = { type: 'batchModify' as const, ids: item.messageIds, addLabelIds: add, removeLabelIds: remove };
    const opHash = hashIntent(intent);
    const existing = await db.getAllFromIndex('ops', 'by_scopeKey', item.threadId);
    if (!existing.some((o) => o.opHash === opHash)) {
      await enqueueBatchModify(item.accountSub, item.messageIds, add, remove, item.threadId);
    }
    await tx.store.delete(item.id);
    // Notify per-thread
    try {
      if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SHOW_NOTIFICATION', payload: { title: 'Unsnoozed', body: `Thread ${item.threadId} returned to Inbox`, tag: `unsnooze-${item.threadId}`, data: { threadId: item.threadId } } });
      }
    } catch (_) {}
  }
  await tx.done;
  // Fire a lightweight notification request to the SW if settings allow (UI decides)
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'SHOW_NOTIFICATION', payload: { title: 'Unsnoozed', body: `${due.length} thread(s) returned to Inbox`, tag: 'unsnooze' } });
    }
  } catch (_) {}
}

let timer: number | null = null;
export function startSnoozeTimer() {
  if (timer) return;
  const run = async () => {
    try {
      await processDueSnoozes();
    } finally {
      timer = setTimeout(run, 60_000) as unknown as number;
    }
  };
  run();
}

