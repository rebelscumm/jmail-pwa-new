import { getDB } from '$lib/db/indexeddb';

export type BackupSnapshot = {
  key: string;
  createdAt: number;
  data: {
    labels: unknown[];
    threads: unknown[];
    messages: unknown[];
    snoozeQueue: unknown[];
    ops: unknown[];
    settings: Record<string, unknown>;
    auth: unknown[];
  };
};

export async function createBackup(): Promise<BackupSnapshot> {
  const db = await getDB();
  const [labels, threads, messages, snoozeQueue, ops] = await Promise.all([
    db.getAll('labels'),
    db.getAll('threads'),
    db.getAll('messages'),
    db.getAll('snoozeQueue'),
    db.getAll('ops')
  ]);
  const settingsKeys = ['app', 'labelMapping'] as const;
  const settingsEntries = await Promise.all(settingsKeys.map((k) => db.get('settings', k)));
  const settings: Record<string, unknown> = {};
  settingsKeys.forEach((k, i) => (settings[k] = settingsEntries[i] || null));
  const auth = await db.getAll('auth');

  const createdAt = Date.now();
  const key = `snapshot-${createdAt}`;
  const snapshot: BackupSnapshot = {
    key,
    createdAt,
    data: { labels, threads, messages, snoozeQueue, ops, settings, auth }
  };

  const tx = db.transaction('backups', 'readwrite');
  await tx.store.put(snapshot);
  await tx.done;
  return snapshot;
}

export async function listBackups(): Promise<BackupSnapshot[]> {
  const db = await getDB();
  return await db.getAll('backups');
}

export async function pruneOldBackups(keep = 4): Promise<void> {
  const db = await getDB();
  const all = await db.getAllFromIndex('backups', 'by_createdAt');
  const excess = Math.max(0, all.length - keep);
  if (!excess) return;
  const toDelete = all.slice(0, excess);
  const tx = db.transaction('backups', 'readwrite');
  for (const s of toDelete) await tx.store.delete(s.key);
  await tx.done;
}

export async function restoreBackup(key: string): Promise<void> {
  const db = await getDB();
  const snapshot = (await db.get('backups', key)) as BackupSnapshot | undefined;
  if (!snapshot) throw new Error('Backup not found');
  const { labels, threads, messages, snoozeQueue, ops, settings, auth } = snapshot.data;
  const tx = db.transaction(['labels', 'threads', 'messages', 'snoozeQueue', 'ops', 'settings', 'auth'], 'readwrite');
  await tx.objectStore('labels').clear();
  await tx.objectStore('threads').clear();
  await tx.objectStore('messages').clear();
  await tx.objectStore('snoozeQueue').clear();
  await tx.objectStore('ops').clear();
  await tx.objectStore('settings').clear();
  await tx.objectStore('auth').clear();
  for (const l of labels as unknown[]) await tx.objectStore('labels').put(l as any);
  for (const t of threads as unknown[]) await tx.objectStore('threads').put(t as any);
  for (const m of messages as unknown[]) await tx.objectStore('messages').put(m as any);
  for (const s of snoozeQueue as unknown[]) await tx.objectStore('snoozeQueue').put(s as any);
  for (const o of ops as unknown[]) await tx.objectStore('ops').put(o as any);
  for (const [k, v] of Object.entries(settings)) await tx.objectStore('settings').put(v as any, k);
  for (const a of auth as unknown[]) await tx.objectStore('auth').put(a as any, (a as any).sub || 'me');
  await tx.done;
}


