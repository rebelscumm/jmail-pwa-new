import { writable } from 'svelte/store';
import { getDB } from '$lib/db/indexeddb';

export type SnoozeInfo = { dueAtUtc: number; snoozeLabelId: string };
export const snoozeByThread = writable<Record<string, SnoozeInfo>>({});

export async function loadSnoozes(): Promise<void> {
  const db = await getDB();
  const all = await db.getAll('snoozeQueue');
  const map: Record<string, SnoozeInfo> = {};
  for (const item of all) map[item.threadId] = { dueAtUtc: item.dueAtUtc, snoozeLabelId: item.snoozeLabelId };
  snoozeByThread.set(map);
}


