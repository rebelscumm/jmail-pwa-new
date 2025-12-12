import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { labels as labelsStore } from '$lib/stores/labels';
import { listThreadIdsByLabelId, getThreadSummary, batchModify } from '$lib/gmail/api';
import { resolveRule, normalizeRuleKey } from '$lib/snooze/rules';
import { pushGmailDiag } from '$lib/gmail/diag';
import type { GmailThread } from '$lib/types';

interface SnoozeCandidate {
  thread: GmailThread;
  snoozeTime: Date;
  snoozeRule: string;
  labelId: string;
}

/**
 * Gets the snooze time for a given rule key
 */
function getSnoozeTime(ruleKey: string): Date | null {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const s = get(settings);
  return resolveRule(ruleKey, zone, { anchorHour: s.anchorHour, roundMinutes: s.roundMinutes });
}

/**
 * Finds all snoozed threads and returns them sorted by snooze time (soonest first)
 */
export async function findSnoozedThreads(maxCount: number): Promise<SnoozeCandidate[]> {
  const s = get(settings);
  const labels = get(labelsStore);
  const labelMapping = s.labelMapping || {};
  
  pushGmailDiag({
    type: 'snooze_scan',
    action: 'findSnoozedThreads',
    labelMappingKeys: Object.keys(labelMapping),
    labelsCount: labels.length
  });

  const candidates: SnoozeCandidate[] = [];
  
  // Go through each mapped snooze label
  for (const [ruleKey, labelId] of Object.entries(labelMapping)) {
    if (!labelId) continue;
    
    // Find the label in our labels list to ensure it exists
    const label = labels.find(l => l.id === labelId);
    if (!label) {
      pushGmailDiag({ type: 'snooze_scan_skip', reason: 'label_not_found', ruleKey, labelId });
      continue;
    }
    
    // Skip persistent snooze buckets (Desktop, long-term)
    const normalizedRule = normalizeRuleKey(ruleKey);
    if (normalizedRule === 'Desktop' || normalizedRule === 'long-term') continue;
    
    // Get the snooze time for this rule
    const snoozeTime = getSnoozeTime(normalizedRule);
    if (!snoozeTime) {
      pushGmailDiag({ type: 'snooze_scan_skip', reason: 'no_snooze_time', ruleKey, normalizedRule });
      continue;
    }
    
    try {
      // Get threads with this label (limiting to a reasonable number per label)
      const { ids } = await listThreadIdsByLabelId(labelId, 10);
      
      if (ids.length > 0) {
        pushGmailDiag({ type: 'snooze_scan_found', ruleKey, labelId, count: ids.length });
      }

      // Get thread summaries for each
      for (const threadId of ids) {
        try {
          const { thread } = await getThreadSummary(threadId);
          candidates.push({
            thread,
            snoozeTime,
            snoozeRule: normalizedRule,
            labelId
          });
        } catch (e) {
          console.warn(`Failed to get thread summary for ${threadId}:`, e);
          pushGmailDiag({ type: 'snooze_scan_error', threadId, error: e instanceof Error ? e.message : String(e) });
          continue;
        }
      }
    } catch (e) {
      console.warn(`Failed to get threads for label ${labelId} (${ruleKey}):`, e);
      pushGmailDiag({ type: 'snooze_scan_label_error', labelId, ruleKey, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
  }
  
  // Sort by snooze time (soonest first) and take the requested count
  candidates.sort((a, b) => a.snoozeTime.getTime() - b.snoozeTime.getTime());
  return candidates.slice(0, maxCount);
}

/**
 * Pulls forward the specified number of snoozed emails by moving them back to inbox
 */
export async function pullForwardSnoozedEmails(count?: number): Promise<{ success: boolean; pulledCount: number; error?: string }> {
  try {
    const s = get(settings);
    const pullCount = count || s.pullForwardCount || 3;
    
    pushGmailDiag({ type: 'pull_forward_start', count: pullCount });

    // Find the snoozed threads with the most proximate snooze times
    const candidates = await findSnoozedThreads(pullCount);
    
    if (candidates.length === 0) {
      pushGmailDiag({ type: 'pull_forward_result', count: 0, reason: 'no_candidates' });
      return { success: true, pulledCount: 0 };
    }
    
    // For each candidate, remove ALL labels except INBOX
    const threadIds = candidates.map(c => c.thread.threadId);
    
    // Collect all labels from all threads to remove them
    const allLabelsToRemove = new Set<string>();
    for (const candidate of candidates) {
      const thread = candidate.thread;
      for (const labelId of thread.labelIds || []) {
        // Don't remove INBOX if it's already there, and skip system labels we want to keep
        if (labelId !== 'INBOX' && labelId !== 'UNREAD' && labelId !== 'IMPORTANT' && labelId !== 'STARRED') {
          allLabelsToRemove.add(labelId);
        }
      }
    }
    
    pushGmailDiag({ type: 'pull_forward_modifying', threadIds, removeLabels: Array.from(allLabelsToRemove) });

    // Use batch modify to move threads back to inbox with clean labels
    // Add INBOX and remove all other labels (except core system labels)
    await batchModify(threadIds, ['INBOX'], Array.from(allLabelsToRemove));
    
    pushGmailDiag({ type: 'pull_forward_success', count: candidates.length });
    return { success: true, pulledCount: candidates.length };
  } catch (error) {
    console.error('Failed to pull forward snoozed emails:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    pushGmailDiag({ type: 'pull_forward_error', error: msg, stack: error instanceof Error ? error.stack : undefined });
    return { 
      success: false, 
      pulledCount: 0, 
      error: msg
    };
  }
}
