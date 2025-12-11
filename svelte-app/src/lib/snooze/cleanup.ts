import type { GmailThread, GmailLabel } from '$lib/types';
import type { LabelMapping } from '$lib/stores/settings';

export function isSnoozeLabel(labelId: string, labelMapping: LabelMapping, allLabels: GmailLabel[]): boolean {
    // 1. Check if it's in the mapping (fastest)
    const knownIds = new Set(Object.values(labelMapping).filter(Boolean));
    if (knownIds.has(labelId)) return true;

    // 2. Check label name pattern
    const label = allLabels.find(l => l.id === labelId);
    if (label && label.name) {
        if (label.name.startsWith('?jlmSnooze/')) return true;
        if (label.name.startsWith('Snooze/')) return true;
    }
    return false;
}

export function removeInboxIfSnoozed(thread: GmailThread, labelMapping: LabelMapping, allLabels: GmailLabel[]): boolean {
    if (!thread.labelIds || !thread.labelIds.includes('INBOX')) return false;

    const hasSnooze = thread.labelIds.some(id => isSnoozeLabel(id, labelMapping, allLabels));
    
    if (hasSnooze) {
        thread.labelIds = thread.labelIds.filter(id => id !== 'INBOX');
        return true;
    }
    return false;
}

