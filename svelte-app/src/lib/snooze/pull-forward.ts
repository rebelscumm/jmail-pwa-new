import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { labels as labelsStore } from '$lib/stores/labels';
import { listThreadIdsByLabelId, getThreadSummary, batchModify } from '$lib/gmail/api';
import { resolveRule, normalizeRuleKey } from '$lib/snooze/rules';
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
  
  const candidates: SnoozeCandidate[] = [];
  
  // Go through each mapped snooze label
  for (const [ruleKey, labelId] of Object.entries(labelMapping)) {
    if (!labelId) continue;
    
    // Find the label in our labels list to ensure it exists
    const label = labels.find(l => l.id === labelId);
    if (!label) continue;
    
    // Skip persistent snooze buckets (Desktop, long-term)
    const normalizedRule = normalizeRuleKey(ruleKey);
    if (normalizedRule === 'Desktop' || normalizedRule === 'long-term') continue;
    
    // Get the snooze time for this rule
    const snoozeTime = getSnoozeTime(normalizedRule);
    if (!snoozeTime) continue;
    
    try {
      // Get threads with this label (limiting to a reasonable number per label)
      const { ids } = await listThreadIdsByLabelId(labelId, 10);
      
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
          continue;
        }
      }
    } catch (e) {
      console.warn(`Failed to get threads for label ${labelId} (${ruleKey}):`, e);
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
    
    // Find the snoozed threads with the most proximate snooze times
    const candidates = await findSnoozedThreads(pullCount);
    
    if (candidates.length === 0) {
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
    
    // Use batch modify to move threads back to inbox with clean labels
    // Add INBOX and remove all other labels (except core system labels)
    await batchModify(threadIds, ['INBOX'], Array.from(allLabelsToRemove));
    
    return { success: true, pulledCount: candidates.length };
  } catch (error) {
    console.error('Failed to pull forward snoozed emails:', error);
    return { 
      success: false, 
      pulledCount: 0, 
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
