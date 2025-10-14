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
      
      inboxDelta += (willBeInInbox ? 1 : 0) - (wasInInbox ? 1 : 0);
      unreadDelta += (willBeUnread ? 1 : 0) - (wasUnread ? 1 : 0);
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

    // If there are pending operations, recalculate counters instead of resetting
    if (pendingOps && pendingOps.length > 0) {
      await recalculateOptimisticCounters();
    } else {
      resetOptimisticCounters();
    }
  } catch (e) {
    // If we can't check pending ops, just reset to be safe
    resetOptimisticCounters();
  }

  threadsStore.set(threads);

  // Clear flag after a short delay to allow store update to complete
  setTimeout(() => { isSettingThreads = false; }, 0);
}

// Monitor thread store updates to auto-reset optimistic counters ONLY when appropriate
let lastThreadsLength = 0;
let lastThreadsUnreadCount = 0;
let isSettingThreads = false;

threadsStore.subscribe(threads => {
  // Avoid resetting if we're in the middle of a setThreadsWithReset call
  if (isSettingThreads) return;

  const newLength = threads?.length || 0;
  const newUnreadCount = threads?.filter((t: any) =>
    Array.isArray(t.labelIds) && t.labelIds.includes('INBOX') && t.labelIds.includes('UNREAD')
  ).length || 0;

  // Only recalculate if threads changed significantly (more than 1 thread added/removed at once)
  // Single thread changes are typically from user actions that already applied optimistic adjustments
  // This prevents race conditions where we recalculate before the operation is enqueued
  const lengthDelta = Math.abs(newLength - lastThreadsLength);
  const unreadDelta = Math.abs(newUnreadCount - lastThreadsUnreadCount);
  
  // Recalculate only for bulk changes (likely from sync) or when many unread changed
  if (lengthDelta > 2 || unreadDelta > 2) {
    void recalculateOptimisticCounters();
  }

  lastThreadsLength = newLength;
  lastThreadsUnreadCount = newUnreadCount;
});
