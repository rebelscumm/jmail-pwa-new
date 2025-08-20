import { writable } from 'svelte/store';
import { getDB } from '$lib/db/indexeddb';

export type LabelMapping = Record<string, string>; // ruleKey => labelId

export type AppSettings = {
  anchorHour: number;
  roundMinutes: number;
  unreadOnUnsnooze: boolean;
  labelMapping: LabelMapping;
};

const DEFAULTS: AppSettings = {
  anchorHour: 5,
  roundMinutes: 5,
  unreadOnUnsnooze: true,
  labelMapping: {}
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

