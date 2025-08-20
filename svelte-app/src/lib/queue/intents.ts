import { getDB } from '$lib/db/indexeddb';
import { enqueueBatchModify, hashIntent } from '$lib/queue/ops';
import type { GmailMessage, GmailThread, QueuedOp } from '$lib/types';
import { get } from 'svelte/store';
import { messages as messagesStore, threads as threadsStore } from '$lib/stores/threads';

const ACCOUNT_SUB = 'me';

function applyLabels(list: string[], add: string[], remove: string[]): string[] {
  const set = new Set(list);
  for (const r of remove) set.delete(r);
  for (const a of add) set.add(a);
  return Array.from(set);
}

async function updateLocalThreadAndMessages(
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[]
) {
  const db = await getDB();
  const thread = await db.get('threads', threadId);
  if (!thread) return;
  const newThread: GmailThread = {
    ...thread,
    labelIds: applyLabels(thread.labelIds, addLabelIds, removeLabelIds)
  };
  const txMsgs = db.transaction('messages', 'readwrite');
  const updatedMessages: Record<string, GmailMessage> = {};
  for (const mid of thread.messageIds) {
    const m = (await txMsgs.store.get(mid)) as GmailMessage | undefined;
    if (!m) continue;
    const newMsg: GmailMessage = { ...m, labelIds: applyLabels(m.labelIds, addLabelIds, removeLabelIds) };
    updatedMessages[mid] = newMsg;
    await txMsgs.store.put(newMsg);
  }
  await txMsgs.done;
  await db.put('threads', newThread);

  // Update stores
  const currentThreads = get(threadsStore);
  threadsStore.set(currentThreads.map((t) => (t.threadId === threadId ? newThread : t)));
  const currentMessages = get(messagesStore);
  messagesStore.set({ ...currentMessages, ...updatedMessages });
}

async function maybeEnqueue(
  threadId: string,
  messageIds: string[],
  addLabelIds: string[],
  removeLabelIds: string[]
): Promise<QueuedOp | null> {
  const db = await getDB();
  const intent = { type: 'batchModify' as const, ids: messageIds, addLabelIds, removeLabelIds };
  const opHash = hashIntent(intent);
  // Dedupe by scopeKey + opHash
  const byScope = await db.getAllFromIndex('ops', 'by_scopeKey', threadId);
  if (byScope.some((o) => o.opHash === opHash)) return null;
  return enqueueBatchModify(ACCOUNT_SUB, messageIds, addLabelIds, removeLabelIds, threadId);
}

export async function queueThreadModify(threadId: string, addLabelIds: string[], removeLabelIds: string[]) {
  const db = await getDB();
  const thread = await db.get('threads', threadId);
  if (!thread) return;
  await updateLocalThreadAndMessages(threadId, addLabelIds, removeLabelIds);
  await maybeEnqueue(threadId, thread.messageIds, addLabelIds, removeLabelIds);
}

export async function archiveThread(threadId: string) {
  await queueThreadModify(threadId, [], ['INBOX']);
}

export async function spamThread(threadId: string) {
  await queueThreadModify(threadId, ['SPAM'], ['INBOX']);
}

export async function trashThread(threadId: string) {
  await queueThreadModify(threadId, ['TRASH'], ['INBOX']);
}

export async function markRead(threadId: string) {
  await queueThreadModify(threadId, [], ['UNREAD']);
}

export async function markUnread(threadId: string) {
  await queueThreadModify(threadId, ['UNREAD'], []);
}

