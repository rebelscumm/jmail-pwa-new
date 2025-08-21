import { writable } from 'svelte/store';
import { getDB } from '$lib/db/indexeddb';

export type LabelMapping = Record<string, string>; // ruleKey => labelId

export type AppSettings = {
  anchorHour: number;
  roundMinutes: number;
  unreadOnUnsnooze: boolean;
  labelMapping: LabelMapping;
  notifEnabled?: boolean;
};

const DEFAULTS: AppSettings = {
  anchorHour: 5,
  roundMinutes: 5,
  unreadOnUnsnooze: true,
  labelMapping: {},
  notifEnabled: false
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
  settings.set(merged);
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
  // Keys cover hours, times, relative days, ranges, weekdays, and buckets.
  const keys = [
    'zz-1hour','zz-2Hour','3Hour',
    '6am','2pm','7pm',
    'Day2','Day4','Day7','zDay14',
    ...Array.from({ length: 30 }, (_, i) => `${String(i + 1).padStart(2,'0')} day${i===0?'':'s'}`),
    'Monday','Friday',
    'Desktop','long-term'
  ];
  const mapping: Record<string, string> = {};
  for (const k of keys) mapping[k] = '';
  return mapping;
}

