import { writable } from 'svelte/store';

export const trailingHolds = writable<Record<string, number>>({});

export function holdThread(threadId: string, ms: number): void {
  try {
    const delay = Math.max(0, Number(ms || 0));
    const until = Date.now() + delay;
    trailingHolds.update((m) => ({ ...m, [threadId]: until }));
    // Auto-clear after expiry to avoid stale holds
    setTimeout(() => {
      trailingHolds.update((m) => {
        const expiry = m[threadId];
        if (expiry && expiry <= Date.now()) {
          const { [threadId]: _removed, ...rest } = m;
          return rest;
        }
        return m;
      });
    }, delay + 50);
  } catch {
    // no-op
  }
}

export function clearHold(threadId: string): void {
  try {
    trailingHolds.update((m) => {
      if (!(threadId in m)) return m;
      const { [threadId]: _removed, ...rest } = m;
      return rest;
    });
  } catch {
    // no-op
  }
}

export function clearAllHolds(): void {
  try {
    trailingHolds.set({});
  } catch {
    // no-op
  }
}