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

