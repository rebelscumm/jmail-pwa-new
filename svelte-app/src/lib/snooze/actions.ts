import { get } from 'svelte/store';
import { DateTime } from 'luxon';
import { settings } from '$lib/stores/settings';
import { resolveRule, DEFAULTS } from '$lib/snooze/rules';
import { enqueueSnooze } from '$lib/snooze/scheduler';
import { getDB } from '$lib/db/indexeddb';
import { queueThreadModify } from '$lib/queue/intents';

const ACCOUNT_SUB = 'me';

export async function snoozeThreadByRule(threadId: string, ruleKey: string) {
  const db = await getDB();
  const thread = await db.get('threads', threadId);
  if (!thread) return;
  const s = get(settings);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const due = resolveRule(ruleKey, zone, { anchorHour: s.anchorHour ?? DEFAULTS.anchorHour, roundMinutes: s.roundMinutes ?? DEFAULTS.roundMinutes });
  const labelId = s.labelMapping[ruleKey];
  if (!labelId) throw new Error(`No labelId mapped for rule ${ruleKey}`);

  // Optimistically remove INBOX
  await queueThreadModify(threadId, [], ['INBOX']);
  // Persistent bucket: no due date
  if (!due) {
    await queueThreadModify(threadId, [labelId], []);
    return;
  }
  // Enqueue snooze item
  await enqueueSnooze(ACCOUNT_SUB, threadId, thread.messageIds, labelId, due, zone, s.unreadOnUnsnooze);
}

