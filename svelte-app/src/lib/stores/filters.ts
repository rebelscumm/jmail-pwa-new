import { writable } from 'svelte/store';
import { getDB } from '$lib/db/indexeddb';

export type ThreadFilter = {
  id?: string; // assigned when saved
  name?: string; // present for saved filters
  // Criteria
  subjectIncludes?: string; // case-insensitive substring
  senderIncludes?: string; // case-insensitive substring
  labelIds?: string[]; // any of these labels present
  unreadOnly?: boolean;
};

export type FiltersState = {
  saved: Array<Required<Pick<ThreadFilter, 'id'>> & ThreadFilter>;
  active: ThreadFilter | null;
};

const defaultState: FiltersState = { saved: [], active: null };

export const filters = writable<FiltersState>(defaultState);

const SAVED_KEY = 'filters:saved';
const ACTIVE_KEY = 'filters:active';

export async function loadFilters(): Promise<void> {
  const db = await getDB();
  const [saved, active] = await Promise.all([
    db.get('settings', SAVED_KEY) as Promise<FiltersState['saved'] | undefined>,
    db.get('settings', ACTIVE_KEY) as Promise<ThreadFilter | null | undefined>
  ]);
  filters.set({ saved: saved || [], active: active || null });
}

export async function saveActiveFilter(next: ThreadFilter | null): Promise<void> {
  const db = await getDB();
  await db.put('settings', next, ACTIVE_KEY);
  filters.update((s) => ({ ...s, active: next }));
}

function generateId(): string {
  return 'f_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function upsertSavedFilter(f: ThreadFilter & { id?: string; name: string }): Promise<string> {
  const db = await getDB();
  const current = ((await db.get('settings', SAVED_KEY)) as FiltersState['saved'] | undefined) || [];
  const id = f.id || generateId();
  const entry = { ...f, id } as Required<Pick<ThreadFilter, 'id'>> & ThreadFilter;
  const idx = current.findIndex((x) => x.id === id);
  const next = [...current];
  if (idx >= 0) next[idx] = entry; else next.push(entry);
  await db.put('settings', next, SAVED_KEY);
  filters.set({ saved: next, active: null });
  return id;
}

export async function deleteSavedFilter(id: string): Promise<void> {
  const db = await getDB();
  const current = ((await db.get('settings', SAVED_KEY)) as FiltersState['saved'] | undefined) || [];
  const next = current.filter((x) => x.id !== id);
  await db.put('settings', next, SAVED_KEY);
  filters.update((s) => ({ ...s, saved: next }));
}

export function applyFilterToThreads(threads: import('$lib/types').GmailThread[], messagesById: Record<string, import('$lib/types').GmailMessage>, f: ThreadFilter | null): import('$lib/types').GmailThread[] {
  if (!f) return threads;
  const subjQ = (f.subjectIncludes || '').trim().toLowerCase();
  const senderQ = (f.senderIncludes || '').trim().toLowerCase();
  const labelSet = new Set((f.labelIds || []));
  const unreadOnly = !!f.unreadOnly;
  return threads.filter((t) => {
    // Subject and sender come from lastMsgMeta on thread
    if (subjQ) {
      const subj = (t.lastMsgMeta.subject || '').toLowerCase();
      if (!subj.includes(subjQ)) return false;
    }
    if (senderQ) {
      const from = (t.lastMsgMeta.from || '').toLowerCase();
      if (!from.includes(senderQ)) return false;
    }
    if (labelSet.size) {
      const labels = new Set(t.labelIds || []);
      // require at least one label to match
      let any = false;
      for (const id of labelSet) { if (labels.has(id)) { any = true; break; } }
      if (!any) return false;
    }
    if (unreadOnly) {
      if (!((t.labelIds || []).includes('UNREAD'))) return false;
    }
    return true;
  });
}

