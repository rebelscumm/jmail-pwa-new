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
  // If there are still pending ops, we preserve current counter values
  // because they were correctly set by adjustOptimisticCounters when the action was taken
  try {
    const { getDB } = await import('$lib/db/indexeddb');
    const { resetOptimisticCounters } = await import('$lib/stores/optimistic-counters');
    
    const db = await getDB();
    const remainingOps = await db.getAll('ops');
    
    if (!remainingOps || remainingOps.length === 0) {
      // All operations completed - safe to reset counters
      console.log('[syncNow] All operations completed, resetting counters');
      resetOptimisticCounters();
    } else {
      // Some operations still pending - keep current counter values
      console.log(`[syncNow] ${remainingOps.length} operations still pending, preserving current counters`);
    }
  } catch (e) {
    console.warn('Failed to update optimistic counters:', e);
  }
}

import type { QueuedOp } from '$lib/types';

export const queue = writable<QueuedOp[]>([]);

