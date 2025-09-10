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
  
  // Reset optimistic counters after sync completes
  try {
    const { resetOptimisticCounters } = await import('$lib/stores/optimistic-counters');
    resetOptimisticCounters();
  } catch (e) {
    console.warn('Failed to reset optimistic counters:', e);
  }
}

import type { QueuedOp } from '$lib/types';

export const queue = writable<QueuedOp[]>([]);

