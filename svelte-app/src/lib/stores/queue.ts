import { writable } from 'svelte/store';
import { getDB } from '$lib/db/indexeddb';

export type SyncState = {
  pendingOps: number;
  lastError?: string;
  lastUpdatedAt: number;
};

export const syncState = writable<SyncState>({ pendingOps: 0, lastUpdatedAt: 0 });

export async function refreshSyncState(): Promise<void> {
  const db = await getDB();
  const ops = await db.getAll('ops');
  const lastError = ops.map((o) => o.lastError).filter(Boolean).pop();
  syncState.set({ pendingOps: ops.length, lastError: lastError || undefined, lastUpdatedAt: Date.now() });
}

export async function syncNow(): Promise<void> {
  const { flushOnce } = await import('$lib/queue/flush');
  await flushOnce();
  await refreshSyncState();
  
  // Check if there are still pending operations after flush
  // Only reset counters if all operations completed successfully
  try {
    const { getDB } = await import('$lib/db/indexeddb');
    const { resetOptimisticCounters, recalculateOptimisticCounters } = await import('$lib/stores/optimistic-counters');
    
    const db = await getDB();
    const remainingOps = await db.getAll('ops');
    
    if (remainingOps && remainingOps.length > 0) {
      // Some operations still pending - recalculate counters to reflect current state
      console.log(`[syncNow] ${remainingOps.length} operations still pending, recalculating counters`);
      await recalculateOptimisticCounters();
    } else {
      // All operations completed - safe to reset
      console.log('[syncNow] All operations completed, resetting counters');
      resetOptimisticCounters();
    }
  } catch (e) {
    console.warn('Failed to update optimistic counters:', e);
  }
}

import type { QueuedOp } from '$lib/types';

export const queue = writable<QueuedOp[]>([]);

