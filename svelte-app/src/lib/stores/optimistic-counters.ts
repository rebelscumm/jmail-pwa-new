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

// Prevent concurrent recalculations
let recalculating = false;

/**
 * Recalculate optimistic counters based on ALL pending operations
 * This ensures counters always reflect the true pending state
 */
export async function recalculateOptimisticCounters() {
  // Prevent concurrent recalculations to avoid race conditions
  if (recalculating) {
    console.log('[OptimisticCounters] Recalculation already in progress, skipping');
    return;
  }
  
  recalculating = true;
  try {
    const { getDB } = await import('$lib/db/indexeddb');
    const db = await getDB();
    
    // Get all pending operations
    const allOps = await db.getAll('ops');
    
    // If no pending operations, reset counters and return
    if (!allOps || allOps.length === 0) {
      resetOptimisticCounters();
      return;
    }
    
    // Track which threads have pending label changes
    const pendingChanges = new Map<string, { addLabels: Set<string>; removeLabels: Set<string> }>();
    
    for (const op of allOps) {
      if (op.op?.type === 'batchModify') {
        const threadId = op.scopeKey;
        if (!threadId) continue; // Skip operations without a valid scopeKey
        
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
    
    // If no label changes found, reset counters
    if (pendingChanges.size === 0) {
      resetOptimisticCounters();
      return;
    }
    
    // Calculate the net impact on counters
    let inboxDelta = 0;
    let unreadDelta = 0;
    
    for (const [threadId, change] of pendingChanges.entries()) {
      try {
        const thread = await db.get('threads', threadId);
        
        // If thread doesn't exist in DB anymore, treat as if it was removed
        // The pending operation will handle re-adding it if needed
        if (!thread) {
          // If we're trying to add INBOX to a non-existent thread, count it as +1
          if (change.addLabels.has('INBOX') && !change.removeLabels.has('INBOX')) {
            inboxDelta += 1;
          }
          // If we're trying to add UNREAD to a non-existent thread, count it as +1
          if (change.addLabels.has('UNREAD') && !change.removeLabels.has('UNREAD')) {
            unreadDelta += 1;
          }
          continue;
        }
        
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
      } catch (e) {
        console.error(`[OptimisticCounters] Failed to process thread ${threadId}:`, e);
        // Continue with other threads
      }
    }
    
    optimisticCounters.set({ inboxDelta, unreadDelta, timestamp: Date.now() });
    console.log(`[OptimisticCounters] Recalculated: inboxDelta=${inboxDelta}, unreadDelta=${unreadDelta}, based on ${pendingChanges.size} threads with pending changes`);
  } catch (e) {
    console.error('[OptimisticCounters] Failed to recalculate:', e);
    // On error, reset counters to safe state
    resetOptimisticCounters();
  } finally {
    recalculating = false;
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
  isSettingThreads = true;
  try {
    const { getDB } = await import('$lib/db/indexeddb');
    const db = await getDB();
    const pendingOps = await db.getAll('ops');
    
    // Update the store first
    threadsStore.set(threads);
    
    // Then recalculate or reset counters based on pending operations
    // This ensures counters are calculated based on the new thread state
    if (pendingOps && pendingOps.length > 0) {
      await recalculateOptimisticCounters();
    } else {
      resetOptimisticCounters();
    }
  } catch (e) {
    console.error('[OptimisticCounters] setThreadsWithReset failed:', e);
    // If we can't check pending ops, set threads and reset counters to be safe
    threadsStore.set(threads);
    resetOptimisticCounters();
  } finally {
    isSettingThreads = false;
    // Update lastThreadsLength to match current state
    lastThreadsLength = threads?.length || 0;
  }
}

// Monitor thread store updates to auto-reset optimistic counters ONLY when appropriate
let lastThreadsLength = 0;
let isSettingThreads = false;
threadsStore.subscribe(threads => {
  // Avoid resetting if we're in the middle of a setThreadsWithReset call
  if (isSettingThreads) return;
  
  const newLength = threads?.length || 0;
  // If threads changed significantly (not just a single thread update), recalculate counters
  if (Math.abs(newLength - lastThreadsLength) > 1) {
    void recalculateOptimisticCounters();
  }
  lastThreadsLength = newLength;
});
