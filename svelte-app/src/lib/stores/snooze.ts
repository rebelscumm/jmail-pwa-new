import { writable } from 'svelte/store';
import { getDB } from '$lib/db/indexeddb';

export type SnoozeInfo = { dueAtUtc: number; snoozeLabelId: string };
export const snoozeByThread = writable<Record<string, SnoozeInfo>>({});

// Last snooze rule selected from the down-arrow menu in thread rows.
// Used to drive the 3rd and 4th trailing actions dynamically.
export const lastSelectedSnoozeRuleKey = writable<string | null>(null);

export async function loadSnoozes(): Promise<void> {
  const db = await getDB();
  const all = await db.getAll('snoozeQueue');
  const map: Record<string, SnoozeInfo> = {};
  for (const item of all) map[item.threadId] = { dueAtUtc: item.dueAtUtc, snoozeLabelId: item.snoozeLabelId };
  snoozeByThread.set(map);
}


