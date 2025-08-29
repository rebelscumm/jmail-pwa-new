import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { GmailLabel, GmailMessage, GmailThread, SnoozeQueueItem, QueuedOp, AccountAuthMeta } from '$lib/types';

export interface AppDB extends DBSchema {
  labels: {
    key: string; // id
    value: GmailLabel;
    indexes: { by_name: string };
  };
  threads: {
    key: string; // threadId
    value: GmailThread;
    indexes: { by_lastMsgDate: number };
  };
  messages: {
    key: string; // id
    value: GmailMessage;
    indexes: { by_threadId: string };
  };
  snoozeQueue: {
    key: string; // `${threadId}:${snoozeLabelId}`
    value: SnoozeQueueItem;
    indexes: { by_dueAtUtc: number };
  };
  ops: {
    key: string; // uuid
    value: QueuedOp;
    indexes: { by_scopeKey: string; by_nextAttemptAt: number };
  };
  settings: {
    key: string; // e.g., 'app' | 'labelMapping' | 'accounts'
    value: unknown;
  };
  auth: {
    key: string; // sub
    value: AccountAuthMeta;
  };
  backups: {
    key: string; // snapshot key e.g. `weekly-2025-03`
    value: { key: string; createdAt: number; data: unknown };
    indexes: { by_createdAt: number };
  };
  journal: {
    key: string; // uuid
    value: {
      id: string;
      createdAt: number;
      threadId: string;
      intent: { type: string; addLabelIds: string[]; removeLabelIds: string[]; ruleKey?: string };
      inverse: { addLabelIds: string[]; removeLabelIds: string[] };
    };
    indexes: { by_createdAt: number };
  };
}

let dbPromise: Promise<IDBPDatabase<AppDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<AppDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AppDB>('gmail-pwa-db', 2, {
      upgrade(db, oldVersion, _newVersion, _tx) {
        // v1 initial schema
        if (oldVersion < 1) {
          const labels = db.createObjectStore('labels', { keyPath: 'id' });
          labels.createIndex('by_name', 'name');

          const threads = db.createObjectStore('threads', { keyPath: 'threadId' });
          threads.createIndex('by_lastMsgDate', 'lastMsgMeta.date');

          const messages = db.createObjectStore('messages', { keyPath: 'id' });
          messages.createIndex('by_threadId', 'threadId');

          const snoozeQueue = db.createObjectStore('snoozeQueue', { keyPath: 'id' });
          snoozeQueue.createIndex('by_dueAtUtc', 'dueAtUtc');

          const ops = db.createObjectStore('ops', { keyPath: 'id' });
          ops.createIndex('by_scopeKey', 'scopeKey');
          ops.createIndex('by_nextAttemptAt', 'nextAttemptAt');

          db.createObjectStore('settings');
          db.createObjectStore('auth');
        }
        // v2: backups + journal
        if (oldVersion < 2) {
          const backups = db.createObjectStore('backups', { keyPath: 'key' });
          backups.createIndex('by_createdAt', 'createdAt');
          const journal = db.createObjectStore('journal', { keyPath: 'id' });
          journal.createIndex('by_createdAt', 'createdAt');
        }
      }
    });
  }
  return dbPromise;
}

export async function clearAllStores() {
  const db = await getDB();
  await Promise.all([
    db.clear('labels'),
    db.clear('threads'),
    db.clear('messages'),
    db.clear('snoozeQueue'),
    db.clear('ops'),
    db.clear('settings'),
    db.clear('auth'),
    db.clear('backups'),
    db.clear('journal')
  ]);
}

/**
 * Migration helper: preserve existing cached AI summaries for inbox threads
 * while removing the versioning concept. For any thread in INBOX where a
 * ready summary already exists and the content appears unchanged since the
 * summary was generated, this will ensure the cached summary remains usable
 * and remove legacy `summaryVersion`/`subjectVersion` fields so the app will
 * treat the cache as authoritative until the user requests a regenerate.
 *
 * Returns counts for reporting.
 */
export async function backfillSummaryVersions(): Promise<{ scanned: number; updated: number }> {
  const db = await getDB();
  const tx = db.transaction('threads', 'readwrite');
  try {
    const all = await tx.store.getAll();
    let updated = 0;
    for (const t of all as any[]) {
      try {
        if (!t) continue;
        // Only preserve cached summaries for threads currently in INBOX
        const labels = t.labelIds || [];
        if (!labels.includes('INBOX')) continue;
        if (t.summaryStatus !== 'ready') continue;
        if (!t.summary || String(t.summary).trim() === '') continue;
        // Prefer cached summary when bodyHash exists and appears unchanged
        if (!(t.bodyHash && t.summaryUpdatedAt && t.lastMsgMeta && t.summaryUpdatedAt >= (t.lastMsgMeta.date || 0))) continue;
        // Create a copy without legacy version fields so app treats the cached
        // summary as the single source of truth (exists / does not exist).
        const next = { ...t } as any;
        if ('summaryVersion' in next) delete next.summaryVersion;
        if ('subjectVersion' in next) delete next.subjectVersion;
        await tx.store.put(next);
        updated++;
      } catch (_) {}
    }
    await tx.done;
    return { scanned: all.length, updated };
  } catch (e) {
    try { await tx.done; } catch (_) {}
    throw e;
  }
}

