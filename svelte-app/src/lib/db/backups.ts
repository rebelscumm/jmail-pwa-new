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
  
  // Clear all stores first
  await Promise.all([
    db.clear('labels'),
    db.clear('threads'),
    db.clear('messages'),
    db.clear('snoozeQueue'),
    db.clear('ops'),
    db.clear('settings'),
    db.clear('auth')
  ]);
  
  // Restore labels
  const labelsTx = db.transaction('labels', 'readwrite');
  for (const l of labels as unknown[]) {
    labelsTx.store.put(l as any);
  }
  await labelsTx.done;
  
  // Restore threads
  const threadsTx = db.transaction('threads', 'readwrite');
  for (const t of threads as unknown[]) {
    threadsTx.store.put(t as any);
  }
  await threadsTx.done;
  
  // Restore messages
  const messagesTx = db.transaction('messages', 'readwrite');
  for (const m of messages as unknown[]) {
    messagesTx.store.put(m as any);
  }
  await messagesTx.done;
  
  // Restore snoozeQueue
  const snoozeQueueTx = db.transaction('snoozeQueue', 'readwrite');
  for (const s of snoozeQueue as unknown[]) {
    snoozeQueueTx.store.put(s as any);
  }
  await snoozeQueueTx.done;
  
  // Restore ops
  const opsTx = db.transaction('ops', 'readwrite');
  for (const o of ops as unknown[]) {
    opsTx.store.put(o as any);
  }
  await opsTx.done;
  
  // Restore settings
  const settingsTx = db.transaction('settings', 'readwrite');
  for (const [k, v] of Object.entries(settings)) {
    settingsTx.store.put(v as any, k);
  }
  await settingsTx.done;
  
  // Restore auth
  const authTx = db.transaction('auth', 'readwrite');
  for (const a of auth as unknown[]) {
    authTx.store.put(a as any, (a as any).sub || 'me');
  }
  await authTx.done;
}

export async function maybeCreateWeeklySnapshot(): Promise<void> {
  const db = await getDB();
  const all = await db.getAllFromIndex('backups', 'by_createdAt');
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const latest = all[all.length - 1];
  if (!latest || (now - latest.createdAt) > weekMs) {
    await createBackup();
    await pruneOldBackups(4);
  }
}


