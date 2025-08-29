import { writable } from 'svelte/store';
import { getDB } from '$lib/db/indexeddb';

export type LabelMapping = Record<string, string>; // ruleKey => labelId

export type AppSettings = {
  anchorHour: number;
  roundMinutes: number;
  unreadOnUnsnooze: boolean;
  labelMapping: LabelMapping;
  notifEnabled?: boolean;
  aiProvider?: 'openai' | 'anthropic' | 'gemini';
  aiApiKey?: string;
  aiModel?: string;
  aiSummaryModel?: string;
  aiDraftModel?: string;
  aiPageFetchOptIn?: boolean;
  taskFilePath?: string;
  trailingRefreshDelayMs?: number;
  /** Duration for residual slide-out on refresh/removal (ms) */
  trailingSlideOutDurationMs?: number;
  /** Primary action when swiping to the right */
  swipeRightPrimary?: 'archive' | 'delete';
  /** Primary action when swiping to the left */
  swipeLeftPrimary?: 'archive' | 'delete';
  /** Ask for confirmation before Delete (keyboard or swipe) */
  confirmDelete?: boolean;
  /** Commit by velocity >= this px/s (recommended 800-1200) */
  swipeCommitVelocityPxPerSec?: number;
  /** Total duration for swipe disappear (exit+collapse) in ms */
  swipeDisappearMs?: number;
  /** Sorting preference for inbox thread list */
  inboxSort?: 'date_desc' | 'date_asc' | 'unread_first' | 'sender_az' | 'sender_za' | 'subject_az' | 'subject_za';
  /** Global font scale percent for rem-based MD3 typography (100 = default) */
  fontScalePercent?: number;
  /** Enable precomputation of summaries in background */
  precomputeSummaries?: boolean;
  /** Auto-run a nightly / initial backfill when missing summaries are detected (once per 24h) */
  precomputeAutoRun?: boolean;
  /** Prefer Gemini Batch Mode for nightly backfills */
  precomputeUseBatch?: boolean;
  /** Use Gemini Context Caching for stable instructions/signatures */
  precomputeUseContextCache?: boolean;
  // Note: AI summary schema version concept removed; cached summaries are
  // treated as binary (exists / does not exist) and preserved while thread
  // remains in INBOX. No app-controlled summary version is stored.
  /** Number of messages to load per inbox page */
  inboxPageSize?: number;
};

const DEFAULTS: AppSettings = {
  anchorHour: 5,
  roundMinutes: 5,
  unreadOnUnsnooze: true,
  labelMapping: {},
  notifEnabled: false,
  trailingRefreshDelayMs: 5000,
  trailingSlideOutDurationMs: 260,
  swipeRightPrimary: 'archive',
  swipeLeftPrimary: 'delete',
  confirmDelete: false,
  swipeCommitVelocityPxPerSec: 1000,
  swipeDisappearMs: 5000,
  inboxSort: 'date_desc',
  fontScalePercent: 100,
  aiProvider: 'gemini',
  aiSummaryModel: 'gemini-2.5-flash-lite',
  precomputeSummaries: false,
  precomputeUseBatch: true,
  precomputeUseContextCache: true,
  
  // Auto-run nightly/initial backfill by default
  precomputeAutoRun: true,
  // Default to 100 messages per page for a denser inbox load while keeping performance reasonable
  inboxPageSize: 100
};

export const settings = writable<AppSettings>({ ...DEFAULTS });

export async function loadSettings(): Promise<void> {
  const db = await getDB();
  const [app, mapping] = await Promise.all([
    db.get('settings', 'app'),
    db.get('settings', 'labelMapping')
  ]);
  const merged: AppSettings = {
    ...DEFAULTS,
    ...(app as Partial<AppSettings> | undefined),
    labelMapping: (mapping as LabelMapping | undefined) || {}
  };
  // Normalize slide-out duration back to normal pace if previously slowed
  const normalSlideMs = 260;
  let needsWrite = false;
  if (
    typeof merged.trailingSlideOutDurationMs !== 'number' ||
    merged.trailingSlideOutDurationMs <= 0 ||
    merged.trailingSlideOutDurationMs > normalSlideMs
  ) {
    merged.trailingSlideOutDurationMs = normalSlideMs;
    needsWrite = true;
  }
  settings.set(merged);
  if (needsWrite) {
    const nextApp = { ...(app as object), trailingSlideOutDurationMs: normalSlideMs };
    await db.put('settings', nextApp, 'app');
  }
}

export async function saveLabelMapping(newMapping: LabelMapping): Promise<void> {
  const db = await getDB();
  // Ensure we persist a plain object (avoid Svelte $state proxies not being cloneable)
  const clean: LabelMapping = JSON.parse(JSON.stringify(newMapping));
  await db.put('settings', clean, 'labelMapping');
  settings.update((s) => ({ ...s, labelMapping: clean }));
}

export async function updateAppSettings(patch: Partial<AppSettings>): Promise<void> {
  settings.update((s) => ({ ...s, ...patch }));
  const db = await getDB();
  const current = await db.get('settings', 'app');
  await db.put('settings', { ...(current as object), ...patch }, 'app');
}

export function seedDefaultMapping(): Record<string, string> {
  // Placeholder IDs; user must map these in Settings after label discovery.
  // Canonical keys matching SnoozePanel options and rules.
  const keys = [
    '10m','30m','1h','2h','3h',
    '6am','2pm','7pm',
    ...Array.from({ length: 30 }, (_, i) => `${i + 1}d`),
    'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday',
    'Desktop','long-term'
  ];
  const mapping: Record<string, string> = {};
  for (const k of keys) mapping[k] = '';
  return mapping;
}

