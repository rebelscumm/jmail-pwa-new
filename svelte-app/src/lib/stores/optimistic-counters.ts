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
 * Apply an immediate adjustment to counters
 */
export function adjustOptimisticCounters(inboxDelta: number, unreadDelta: number) {
  optimisticCounters.update(counters => ({
    inboxDelta: counters.inboxDelta + inboxDelta,
    unreadDelta: counters.unreadDelta + unreadDelta,
    timestamp: Date.now()
  }));
  
  // Auto-clear after a short delay to prevent stale adjustments
  setTimeout(() => {
    optimisticCounters.update(counters => {
      // Only clear if this is the same timestamp (no newer adjustments)
      if (Date.now() - counters.timestamp > 2000) {
        return { inboxDelta: 0, unreadDelta: 0, timestamp: Date.now() };
      }
      return counters;
    });
  }, 2500);
}

/**
 * Reset counters to zero
 */
export function resetOptimisticCounters() {
  optimisticCounters.set({ inboxDelta: 0, unreadDelta: 0, timestamp: Date.now() });
}

/**
 * Wrapper for threadsStore.set that automatically resets optimistic counters
 * Use this when updating threads from server/external sources
 */
export function setThreadsWithReset(threads: any[]) {
  resetOptimisticCounters();
  threadsStore.set(threads);
}

// Monitor thread store updates to auto-reset optimistic counters
// This catches any direct threadsStore.set() calls that bypass the wrapper
let lastThreadsLength = 0;
threadsStore.subscribe(threads => {
  const newLength = threads?.length || 0;
  // If threads changed significantly (not just a single thread update), reset counters
  if (Math.abs(newLength - lastThreadsLength) > 1) {
    resetOptimisticCounters();
  }
  lastThreadsLength = newLength;
});
