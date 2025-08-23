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
  swipeDisappearMs: 5000
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
  await db.put('settings', newMapping, 'labelMapping');
  settings.update((s) => ({ ...s, labelMapping: newMapping }));
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

