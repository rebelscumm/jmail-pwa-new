import { writable } from 'svelte/store';
import { getDB } from '$lib/db/indexeddb';

// Request persistent storage to prevent browser from clearing IndexedDB
async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      const isPersisted = await navigator.storage.persisted();
      if (!isPersisted) {
        const granted = await navigator.storage.persist();
        console.log('[Settings] Persistent storage requested:', granted ? 'granted' : 'denied');
        return granted;
      }
      console.log('[Settings] Storage is already persistent');
      return true;
    }
  } catch (e) {
    console.warn('[Settings] Failed to request persistent storage:', e);
  }
  return false;
}

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
  /** Suppress authentication popups with rate limiting */
  suppressAuthPopups?: boolean;
  /** Cooldown period in seconds between authentication popups */
  authPopupCooldownSeconds?: number;
  /** Number of emails to pull forward from snooze when inbox is empty */
  pullForwardCount?: number;
  /** AI summary schema version (legacy but kept for compat) */
  aiSummaryVersion?: number;
  /** Force recompute of summaries when version bumps */
  forceRecomputeOnVersionBump?: boolean;
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
  aiSummaryModel: 'gemini-1.5-flash',
  precomputeSummaries: false,
  precomputeUseBatch: true,
  precomputeUseContextCache: true,
  
  // Auto-run nightly/initial backfill by default
  precomputeAutoRun: true,
  // Default to 100 messages per page for a denser inbox load while keeping performance reasonable
  inboxPageSize: 100,
  // Default to pulling forward 3 emails when inbox is empty
  pullForwardCount: 3
};

export const settings = writable<AppSettings>({ ...DEFAULTS });

export async function loadSettings(): Promise<void> {
  console.log('[Settings] loadSettings() called');
  
  // Request persistent storage on first load
  await requestPersistentStorage();
  
  const db = await getDB();
  const [app, mapping] = await Promise.all([
    db.get('settings', 'app'),
    db.get('settings', 'labelMapping')
  ]);
  
  console.log('[Settings] Raw data from IndexedDB:', { 
    app: app ? 'present' : 'null/undefined', 
    appKeys: app ? Object.keys(app as object) : [],
    hasApiKey: !!(app as any)?.aiApiKey,
    mapping: mapping ? 'present' : 'null/undefined',
    mappingKeys: mapping ? Object.keys(mapping as object).length : 0
  });
  
  const merged: AppSettings = {
    ...DEFAULTS,
    ...(app as Partial<AppSettings> | undefined),
    labelMapping: (mapping as LabelMapping | undefined) || {}
  };

  // Automatically enable precompute if API key is present
  const hasKey = merged.aiApiKey && merged.aiApiKey.trim() !== '';
  if (hasKey) {
    merged.precomputeSummaries = true;
  } else {
    merged.precomputeSummaries = false;
  }
  
  console.log('[Settings] loadSettings() final merged state:', {
    aiProvider: merged.aiProvider,
    hasApiKey: hasKey,
    apiKeyLength: merged.aiApiKey?.length || 0,
    labelMappingCount: Object.keys(merged.labelMapping).length,
    precomputeSummaries: merged.precomputeSummaries
  });
  
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
  
  console.log('[Settings] loadSettings() complete');
}

export async function saveLabelMapping(newMapping: LabelMapping): Promise<void> {
  console.log('[Settings] saveLabelMapping() called with', Object.keys(newMapping).length, 'keys');
  const db = await getDB();
  // Ensure we persist a plain object (avoid Svelte $state proxies not being cloneable)
  const clean: LabelMapping = JSON.parse(JSON.stringify(newMapping));
  await db.put('settings', clean, 'labelMapping');
  settings.update((s) => ({ ...s, labelMapping: clean }));
  
  // Verify the save worked
  const verify = await db.get('settings', 'labelMapping');
  console.log('[Settings] saveLabelMapping() verification:', {
    saved: !!verify,
    keyCount: verify ? Object.keys(verify as object).length : 0
  });
}

export async function updateAppSettings(patch: Partial<AppSettings>): Promise<void> {
  console.log('[Settings] updateAppSettings() called with keys:', Object.keys(patch));
  console.log('[Settings] updateAppSettings() hasApiKey:', !!patch.aiApiKey);
  
  const db = await getDB();
  const current = (await db.get('settings', 'app')) as Partial<AppSettings> || {};
  
  // Merge current and patch
  const merged = { ...current, ...patch };

  // Enforce precomputeSummaries based on aiApiKey
  const hasKey = merged.aiApiKey && merged.aiApiKey.trim() !== '';
  if (hasKey) {
    merged.precomputeSummaries = true;
  } else {
    merged.precomputeSummaries = false;
  }
  
  console.log('[Settings] updateAppSettings() final merged state:', {
    aiProvider: merged.aiProvider,
    hasApiKey: hasKey,
    apiKeyLength: merged.aiApiKey?.length || 0,
    precomputeSummaries: merged.precomputeSummaries
  });

  // Ensure we persist a plain object (avoid Svelte $state proxies not being cloneable)
  const clean = JSON.parse(JSON.stringify(merged));
  
  settings.set({ ...DEFAULTS, ...clean, labelMapping: (await db.get('settings', 'labelMapping')) as LabelMapping || {} });
  await db.put('settings', clean, 'app');
  
  // Verify the save worked
  const verify = await db.get('settings', 'app');
  console.log('[Settings] updateAppSettings() verification:', {
    saved: !!verify,
    hasApiKey: !!(verify as any)?.aiApiKey,
    aiProvider: (verify as any)?.aiProvider,
    precomputeSummaries: (verify as any)?.precomputeSummaries
  });
}

export function seedDefaultMapping(): Record<string, string> {
  // Placeholder IDs; user must map these in Settings after label discovery.
  // Canonical keys matching CalendarPopover options and rules.
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

