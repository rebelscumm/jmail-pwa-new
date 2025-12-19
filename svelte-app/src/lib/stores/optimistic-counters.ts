import { writable } from 'svelte/store';
import { threads as threadsStore } from './threads';

/**
 * Optimistic counter adjustments that apply immediately before thread store updates
 * These provide instant feedback and are automatically cleared when thread store updates
 */
export interface OptimisticCounters {
  inboxDelta: number;
  unreadDelta: number;
  timestamp: number;
}

export const optimisticCounters = writable<OptimisticCounters>({
  inboxDelta: 0,
  unreadDelta: 0,
  timestamp: Date.now()
});

/**
 * Recalculate optimistic counters based on ALL pending operations
 * This ensures counters always reflect the true pending state
 */
export async function recalculateOptimisticCounters() {
  try {
    const { getDB } = await import('$lib/db/indexeddb');
    const db = await getDB();
    
    // Get all pending operations
    const allOps = await db.getAll('ops');
    
    // Track which threads have pending label changes
    const pendingChanges = new Map<string, { addLabels: Set<string>; removeLabels: Set<string> }>();
    
    for (const op of allOps) {
      if (op.op?.type === 'batchModify') {
        const threadId = op.scopeKey;
        if (!pendingChanges.has(threadId)) {
          pendingChanges.set(threadId, { addLabels: new Set(), removeLabels: new Set() });
        }
        const change = pendingChanges.get(threadId)!;
        for (const label of op.op.addLabelIds || []) {
          change.addLabels.add(label);
        }
        for (const label of op.op.removeLabelIds || []) {
          change.removeLabels.add(label);
        }
      }
    }
    
    // Calculate the net impact on counters
    let inboxDelta = 0;
    let unreadDelta = 0;
    
    for (const [threadId, change] of pendingChanges.entries()) {
      const thread = await db.get('threads', threadId);
      if (!thread) continue;
      
      const currentLabels = new Set(thread.labelIds || []);
      const wasInInbox = currentLabels.has('INBOX');
      const wasUnread = currentLabels.has('UNREAD');
      
      // Apply pending changes
      const newLabels = new Set(currentLabels);
      for (const label of change.removeLabels) {
        newLabels.delete(label);
      }
      for (const label of change.addLabels) {
        newLabels.add(label);
      }
      
      const willBeInInbox = newLabels.has('INBOX');
      const willBeUnread = newLabels.has('UNREAD');
      
      // Calculate deltas based on unread status WITHIN the inbox
      const wasUnreadInbox = wasInInbox && wasUnread;
      const willBeUnreadInbox = willBeInInbox && willBeUnread;
      
      inboxDelta += (willBeInInbox ? 1 : 0) - (wasInInbox ? 1 : 0);
      unreadDelta += (willBeUnreadInbox ? 1 : 0) - (wasUnreadInbox ? 1 : 0);
    }
    
    optimisticCounters.set({ inboxDelta, unreadDelta, timestamp: Date.now() });
  } catch (e) {
    console.error('[OptimisticCounters] Failed to recalculate:', e);
  }
}

/**
 * Apply an immediate adjustment to counters
 */
export function adjustOptimisticCounters(inboxDelta: number, unreadDelta: number) {
  optimisticCounters.update(counters => ({
    inboxDelta: counters.inboxDelta + inboxDelta,
    unreadDelta: counters.unreadDelta + unreadDelta,
    timestamp: Date.now()
  }));
}

/**
 * Reset counters to zero
 */
export function resetOptimisticCounters() {
  optimisticCounters.set({ inboxDelta: 0, unreadDelta: 0, timestamp: Date.now() });
}

/**
 * Wrapper for threadsStore.set that preserves optimistic counters if there are pending operations
 * Use this when updating threads from server/external sources
 */
export async function setThreadsWithReset(threads: any[]) {
  // Set flag to prevent automatic subscription from interfering
  isSettingThreads = true;

  try {
    const { getDB } = await import('$lib/db/indexeddb');
    const db = await getDB();
    const pendingOps = await db.getAll('ops');

    // If there are pending operations, PRESERVE current optimistic counter values
    // We cannot recalculate from IndexedDB because the thread labels have already 
    // been updated optimistically, so the delta calculation would be incorrect.
    // The adjustOptimisticCounters() calls in queueThreadModify ensure counters
    // are accurate from the moment of user action.
    if (!pendingOps || pendingOps.length === 0) {
      // No pending ops means all operations have been flushed to server
      // Safe to reset counters since server state matches local state
      resetOptimisticCounters();
    }
    // If there ARE pending ops, we keep the current counter values unchanged
  } catch (e) {
    // If we can't check pending ops, just reset to be safe
    resetOptimisticCounters();
  }

  threadsStore.set(threads);

  // Clear flag after a short delay to allow store update to complete
  setTimeout(() => { isSettingThreads = false; }, 0);
}

// Monitor thread store updates
// Note: We no longer auto-recalculate counters here because:
// 1. User actions (archive, delete, snooze) call adjustOptimisticCounters directly
// 2. Sync operations use setThreadsWithReset which handles counter management
// 3. recalculateOptimisticCounters reads from IndexedDB which is already updated,
//    so it would calculate incorrect deltas
let isSettingThreads = false;

// Track changes for debugging purposes only
threadsStore.subscribe(threads => {
  // No-op: counter management is now handled by adjustOptimisticCounters and setThreadsWithReset
});
