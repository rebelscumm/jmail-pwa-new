import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { getDB } from '$lib/db/indexeddb';
import { normalizeRuleKey } from '$lib/snooze/rules';
import { queueThreadModify, recordIntent } from '$lib/queue/intents';
import type { GmailThread } from '$lib/types';

export async function snoozeThreadByRule(threadId: string, ruleKey: string, options?: { optimisticLocal?: boolean }) {
  const db = await getDB();
  const thread = await db.get('threads', threadId);
  if (!thread) return;
  const s = get(settings);
  const norm = normalizeRuleKey(ruleKey);
  let labelId = s.labelMapping[norm];
  if (!labelId) {
    for (const [k, v] of Object.entries(s.labelMapping || {})) {
      if (!v) continue;
      if (normalizeRuleKey(k) === norm) { labelId = v; break; }
    }
  }
  if (!labelId) throw new Error(`No labelId mapped for rule ${ruleKey}`);

  // Label-driven snooze only: add snooze label and remove INBOX; external script handles due time/unsnooze
  await queueThreadModify(threadId, [labelId], ['INBOX'], options);
  await recordIntent(threadId, { type: 'snooze', addLabelIds: [labelId], removeLabelIds: ['INBOX'], ruleKey }, { addLabelIds: ['INBOX'], removeLabelIds: [labelId] });
}

function getMappedSnoozeLabelIds(): string[] {
  const s = get(settings);
  const set = new Set<string>();
  for (const v of Object.values(s.labelMapping || {})) if (v) set.add(v);
  return Array.from(set);
}

export function isSnoozedThread(thread: GmailThread): boolean {
  const snoozeIds = new Set(getMappedSnoozeLabelIds());
  return (thread.labelIds || []).some((l) => snoozeIds.has(l));
}

export async function manualUnsnoozeThread(threadId: string, options?: { optimisticLocal?: boolean }) {
  const db = await getDB();
  const thread = (await db.get('threads', threadId)) as GmailThread | undefined;
  if (!thread) return;
  const snoozeIds = new Set(getMappedSnoozeLabelIds());
  const present = (thread.labelIds || []).filter((l) => snoozeIds.has(l));
  if (!present.length) return; // Nothing to unsnooze
  const s = get(settings);
  const add: string[] = ['INBOX'];
  if (s.unreadOnUnsnooze) add.push('UNREAD');
  await queueThreadModify(threadId, add, present, options);
  await recordIntent(
    threadId,
    { type: 'unsnooze', addLabelIds: add, removeLabelIds: present },
    { addLabelIds: present, removeLabelIds: add }
  );
}

