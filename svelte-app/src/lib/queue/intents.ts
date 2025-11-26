import { getDB } from '$lib/db/indexeddb';
import { enqueueBatchModify, enqueueSendMessage, hashIntent } from '$lib/queue/ops';
import type { GmailMessage, GmailThread, QueuedOp } from '$lib/types';
import { get } from 'svelte/store';
import { messages as messagesStore, threads as threadsStore } from '$lib/stores/threads';

const ACCOUNT_SUB = 'me';

type JournalEntry = {
  id: string;
  createdAt: number;
  threadId: string;
  intent: { type: string; addLabelIds: string[]; removeLabelIds: string[]; ruleKey?: string };
  inverse: { addLabelIds: string[]; removeLabelIds: string[] };
};

// In-memory redo stack for the current session. When an entry is undone, we push it here.
// Redo will re-apply from this stack and clear entries as they are re-applied.
const undoneStack: JournalEntry[] = [];

function applyLabels(list: string[], add: string[], remove: string[]): string[] {
  const set = new Set(list);
  for (const r of remove) set.delete(r);
  for (const a of add) set.add(a);
  return Array.from(set);
}

export async function updateLocalThreadAndMessages(
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
  const updatedThreads = currentThreads.map((t) => (t.threadId === threadId ? newThread : t));

  // Just update the threads store directly - optimistic counter adjustment was already applied
  // Don't use setThreadsWithReset here because it recalculates from pending ops, but the
  // current operation hasn't been enqueued yet (happens after this function returns)
  threadsStore.set(updatedThreads);

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

export async function queueThreadModify(threadId: string, addLabelIds: string[], removeLabelIds: string[], options?: { optimisticLocal?: boolean }) {
  const db = await getDB();
  const thread = await db.get('threads', threadId);
  if (!thread) return;
  
  // When optimisticLocal is true (default), update local store immediately
  // This updates the base count immediately, providing instant UI feedback
  // When optimisticLocal is false (bulk operations), DON'T update local store
  // The caller should apply optimistic counter adjustments manually if needed
  if (options?.optimisticLocal !== false) {
    await updateLocalThreadAndMessages(threadId, addLabelIds, removeLabelIds);
  }
  
  const queued = await maybeEnqueue(threadId, thread.messageIds, addLabelIds, removeLabelIds);
  
  // After enqueuing, recalculate optimistic counters to ensure they reflect pending ops
  // This ensures counts update immediately even if local state update hasn't propagated yet
  if (queued) {
    try {
      const { recalculateOptimisticCounters } = await import('$lib/stores/optimistic-counters');
      // Recalculate immediately to update counts optimistically
      void recalculateOptimisticCounters();
    } catch (e) {
      console.warn('[queueThreadModify] Failed to recalculate optimistic counters:', e);
    }
    
    try {
      const { refreshSyncState } = await import('$lib/stores/queue');
      await refreshSyncState();
    } catch (_) {}
  }
}

export async function archiveThread(threadId: string, options?: { optimisticLocal?: boolean }) {
  await queueThreadModify(threadId, [], ['INBOX'], options);
  await recordIntent(threadId, { type: 'archive', addLabelIds: [], removeLabelIds: ['INBOX'] }, { addLabelIds: ['INBOX'], removeLabelIds: [] });
}

export async function spamThread(threadId: string, options?: { optimisticLocal?: boolean }) {
  await queueThreadModify(threadId, ['SPAM'], ['INBOX'], options);
  await recordIntent(threadId, { type: 'spam', addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }, { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] });
}

export async function trashThread(threadId: string, options?: { optimisticLocal?: boolean }) {
  await queueThreadModify(threadId, ['TRASH'], ['INBOX'], options);
  await recordIntent(threadId, { type: 'trash', addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] }, { addLabelIds: ['INBOX'], removeLabelIds: ['TRASH'] });
}

export async function markRead(threadId: string, options?: { optimisticLocal?: boolean }) {
  await queueThreadModify(threadId, [], ['UNREAD'], options);
  await recordIntent(threadId, { type: 'markRead', addLabelIds: [], removeLabelIds: ['UNREAD'] }, { addLabelIds: ['UNREAD'], removeLabelIds: [] });
}

export async function markUnread(threadId: string, options?: { optimisticLocal?: boolean }) {
  await queueThreadModify(threadId, ['UNREAD'], [], options);
  await recordIntent(threadId, { type: 'markUnread', addLabelIds: ['UNREAD'], removeLabelIds: [] }, { addLabelIds: [], removeLabelIds: ['UNREAD'] });
}

function formatIntentLabel(e: JournalEntry): string {
  const t = e.intent.type;
  switch (t) {
    case 'archive':
      return 'Archived';
    case 'trash':
      return 'Deleted';
    case 'spam':
      return 'Marked as spam';
    case 'markRead':
      return 'Marked read';
    case 'markUnread':
      return 'Marked unread';
    case 'snooze':
      return e.intent.ruleKey ? `Snoozed ${e.intent.ruleKey}` : 'Snoozed';
    case 'unsnooze':
      return 'Unsnoozed';
    default:
      return t;
  }
}

async function buildEntryDescriptions(entries: JournalEntry[]): Promise<Array<{ id: string; createdAt: number; threadId: string; type: string; description: string }>> {
  const db = await getDB();
  // Preload threads involved to derive subjects
  const threadsMap = new Map<string, GmailThread | undefined>();
  for (const e of entries) {
    if (!threadsMap.has(e.threadId)) {
      threadsMap.set(e.threadId, await db.get('threads', e.threadId));
    }
  }
  return entries.map((e) => {
    const th = threadsMap.get(e.threadId);
    const subject = th?.lastMsgMeta?.subject || '(no subject)';
    const action = formatIntentLabel(e);
    return {
      id: e.id,
      createdAt: e.createdAt,
      threadId: e.threadId,
      type: e.intent.type,
      description: `${action} • ${subject}`
    };
  });
}

export async function getUndoHistory(limit = 10): Promise<Array<{ id: string; createdAt: number; threadId: string; type: string; description: string }>> {
  const db = await getDB();
  const entries = await db.getAllFromIndex('journal', 'by_createdAt');
  const recent = entries.slice(-limit).reverse() as JournalEntry[]; // most recent first
  return buildEntryDescriptions(recent);
}

export async function getRedoHistory(limit = 10): Promise<Array<{ id: string; createdAt: number; threadId: string; type: string; description: string }>> {
  const recent = undoneStack.slice(-limit).reverse(); // most recently undone first
  return buildEntryDescriptions(recent);
}

export async function recordIntent(
  threadId: string,
  intent: { type: string; addLabelIds: string[]; removeLabelIds: string[]; ruleKey?: string },
  inverse: { addLabelIds: string[]; removeLabelIds: string[] },
  options?: { source?: 'redo' | 'user' | 'system' }
) {
  const db = await getDB();
  const entry = { id: crypto.randomUUID(), createdAt: Date.now(), threadId, intent, inverse };
  await db.put('journal', entry);
  // Any new forward action should invalidate redo history unless it's from a redo
  if (!options || options.source !== 'redo') undoneStack.length = 0;
  
  // Prune old journal entries (older than 10 minutes) to prevent unbounded growth
  // Journal is used for undo and for protecting recent user actions during sync
  void pruneOldJournalEntries();
}

/**
 * Remove journal entries older than 10 minutes
 * Journal entries serve two purposes:
 * 1. Enable undo functionality (keep recent entries)
 * 2. Protect user actions during sync (only need last few minutes)
 */
export async function pruneOldJournalEntries(maxAgeMs = 10 * 60 * 1000): Promise<number> {
  try {
    const db = await getDB();
    const cutoff = Date.now() - maxAgeMs;
    const allEntries = await db.getAll('journal');
    const toDelete = allEntries.filter((e: any) => e && e.createdAt && e.createdAt < cutoff);
    
    if (toDelete.length > 0) {
      const tx = db.transaction('journal', 'readwrite');
      for (const entry of toDelete) {
        await tx.store.delete((entry as any).id);
      }
      await tx.done;
      console.log(`[Journal] Pruned ${toDelete.length} old entries (cutoff: ${new Date(cutoff).toISOString()})`);
    }
    
    return toDelete.length;
  } catch (e) {
    console.warn('[Journal] Failed to prune old entries:', e);
    return 0;
  }
}

export async function undoLast(n = 1): Promise<void> {
  const db = await getDB();
  try {
    // Read entries outside of a long-lived transaction to avoid auto-close issues
    const entries = await db.getAllFromIndex('journal', 'by_createdAt');
    const toUndo = entries.slice(-n).reverse() as JournalEntry[];

    const idsToDelete: string[] = [];
    for (const e of toUndo) {
      // Track in redo stack
      undoneStack.push(e);
      
      // Undo updates local state immediately for instant feedback
      await queueThreadModify(e.threadId, e.inverse.addLabelIds, e.inverse.removeLabelIds);
      idsToDelete.push(e.id);
    }

    if (idsToDelete.length) {
      const txDel = db.transaction('journal', 'readwrite');
      for (const id of idsToDelete) await txDel.store.delete(id);
      await txDel.done;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[undoLast] error', err);
    try {
      const { copyGmailDiagnosticsToClipboard } = await import('$lib/gmail/api');
      await copyGmailDiagnosticsToClipboard({
        reason: 'undo_error',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        undoCount: n,
        lastUpdatedAt: Date.now()
      });
    } catch (_) {}
    throw err;
  }
}

export async function redoLast(n = 1): Promise<void> {
  try {
    // Re-apply from the in-memory undone stack
    const toRedo = undoneStack.slice(-n);
    for (const e of toRedo) {
      // Redo updates local state immediately for instant feedback
      await queueThreadModify(e.threadId, e.intent.addLabelIds, e.intent.removeLabelIds);
      await recordIntent(e.threadId, e.intent, e.inverse, { source: 'redo' });
    }
    // Remove the re-applied entries from the stack
    if (n > 0) undoneStack.splice(undoneStack.length - Math.min(n, undoneStack.length), Math.min(n, undoneStack.length));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[redoLast] error', err);
    try {
      const { copyGmailDiagnosticsToClipboard } = await import('$lib/gmail/api');
      await copyGmailDiagnosticsToClipboard({
        reason: 'redo_error',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        redoCount: n,
        lastUpdatedAt: Date.now()
      });
    } catch (_) {}
    throw err;
  }
}

export async function applyRemoteLabels(
  threadId: string,
  labelsByMessage: Record<string, string[]>
): Promise<void> {
  const db = await getDB();
  const thread = await db.get('threads', threadId);
  if (!thread) return;
  // Detect whether this thread was locally acted-upon in a way that removed
  // it from INBOX (archive, snooze, trash, spam, etc.). If so, honor the
  // local intent and avoid re-adding INBOX during server reconciliation.
  let isLocallyInboxRemoved = false;
  const locallyAddedLabels = new Set<string>();
  try {
    const journalAll = await db.getAll('journal');
    for (const e of journalAll as any[]) {
      if (!e || e.threadId !== threadId || !e.intent) continue;
      const rem = Array.isArray(e.intent.removeLabelIds) ? e.intent.removeLabelIds : [];
      const add = Array.isArray(e.intent.addLabelIds) ? e.intent.addLabelIds : [];
      if (rem.includes('INBOX')) {
        isLocallyInboxRemoved = true;
        for (const a of add) locallyAddedLabels.add(a);
      }
    }
  } catch (_) {
    // best-effort: if journal read fails, proceed normally
  }

  const txMsgs = db.transaction('messages', 'readwrite');
  const updatedMessages: Record<string, GmailMessage> = {};
  for (const mid of thread.messageIds) {
    const current = (await txMsgs.store.get(mid)) as GmailMessage | undefined;
    if (!current) continue;
    const serverLabels = labelsByMessage[mid] || current.labelIds || [];
    const labelSet = new Set(serverLabels);
    // If the user performed any local action that removed INBOX, honor it by
    // preventing INBOX from being re-added and by retaining locally-added
    // labels (e.g., TRASH or snooze labels).
    if (isLocallyInboxRemoved) {
      labelSet.delete('INBOX');
      for (const a of locallyAddedLabels) labelSet.add(a);
    }
    const newMsg: GmailMessage = { ...current, labelIds: Array.from(labelSet) };
    updatedMessages[mid] = newMsg;
    await txMsgs.store.put(newMsg);
  }
  await txMsgs.done;

  // Thread labels = union of message labels (but respect local trash)
  const union = new Set<string>();
  for (const mid of thread.messageIds) {
    const labels = labelsByMessage[mid] || [];
    for (const l of labels) union.add(l);
  }
  if (isLocallyInboxRemoved) {
    union.delete('INBOX');
    for (const a of locallyAddedLabels) union.add(a);
  }
  
  // TERMINAL LABEL RULE: Never add INBOX if TRASH or SPAM present
  // This is a critical invariant that prevents resurrecting deleted/spam threads
  if (union.has('TRASH') || union.has('SPAM')) {
    union.delete('INBOX');
    console.log(`[applyRemoteLabels] Thread ${threadId}: Removed INBOX due to terminal label (TRASH/SPAM)`);
  }
  
  const newThread: GmailThread = { ...thread, labelIds: Array.from(union) };
  await db.put('threads', newThread);
  // Update stores
  const currentThreads = get(threadsStore);
  const updatedThreads = currentThreads.map((t) => (t.threadId === threadId ? newThread : t));

  // applyRemoteLabels is called during sync, so use setThreadsWithReset to recalculate
  // optimistic counters from pending operations to ensure accuracy after server reconciliation
  const { setThreadsWithReset } = await import('$lib/stores/optimistic-counters');
  setThreadsWithReset(updatedThreads);

  const currentMessages = get(messagesStore);
  messagesStore.set({ ...currentMessages, ...updatedMessages });
}

export async function queueSendRaw(rawRfc2822: string, threadId?: string): Promise<void> {
  // No local state to mutate for compose. Just enqueue and let flush handle retries.
  await enqueueSendMessage(ACCOUNT_SUB, rawRfc2822, threadId);
  
  // Refresh sync state to update pending operations count
  try {
    const { refreshSyncState } = await import('$lib/stores/queue');
    await refreshSyncState();
  } catch (_) {}
}

