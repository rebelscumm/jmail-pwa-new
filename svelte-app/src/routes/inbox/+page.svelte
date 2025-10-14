<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { initAuth, acquireTokenInteractive, authState, getAuthDiagnostics, resolveGoogleClientId } from '$lib/gmail/auth';
  import { listLabels, listInboxMessageIds, listThreadIdsByLabelId, getMessageMetadata, GmailApiError, getProfile, copyGmailDiagnosticsToClipboard, getAndClearGmailDiagnostics, listHistory, getThreadSummary } from '$lib/gmail/api';
  import { labels as labelsStore } from '$lib/stores/labels';
  import { threads as threadsStore, messages as messagesStore } from '$lib/stores/threads';
  import { optimisticCounters } from '$lib/stores/optimistic-counters';
  import { getDB } from '$lib/db/indexeddb';
  import VirtualList from '$lib/utils/VirtualList.svelte';
  import ThreadListRow from '$lib/utils/ThreadListRow.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import Card from '$lib/containers/Card.svelte';
  import LoadingIndicator from '$lib/forms/LoadingIndicator.svelte';
  import SessionStatus from '$lib/components/SessionStatus.svelte';
  import SessionRefreshButton from '$lib/components/SessionRefreshButton.svelte';
  import { sessionManager } from '$lib/auth/session-manager';
  
  import Checkbox from '$lib/forms/Checkbox.svelte';
  
  import { archiveThread, trashThread, undoLast } from '$lib/queue/intents';
  import { snoozeThreadByRule } from '$lib/snooze/actions';
  import { settings, updateAppSettings } from '$lib/stores/settings';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { pullForwardSnoozedEmails } from '$lib/snooze/pull-forward';
  
  import { getLabel } from '$lib/gmail/api';
  import { trailingHolds } from '$lib/stores/holds';
  import Menu from '$lib/containers/Menu.svelte';
  import MenuItem from '$lib/containers/MenuItem.svelte';
  import Dialog from '$lib/containers/Dialog.svelte';
  import { searchQuery } from '$lib/stores/search';
  import FilterBar from '$lib/utils/FilterBar.svelte';
  import { filters as filtersStore, applyFilterToThreads, loadFilters } from '$lib/stores/filters';
  import { aiSummarizeSubject, aiSummarizeEmail, aiDetectCollegeRecruiting } from '$lib/ai/providers';
  import Icon from '$lib/misc/_icon.svelte';
  import iconSync from '@ktibow/iconset-material-symbols/sync';

  // Helper: check pending ops with retries; returns array of ops, or null if lookup failed
  async function getPendingOpsWithRetry(db: any, scopeKey: string, attempts = 3): Promise<any[] | null> {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await db.getAllFromIndex('ops', 'by_scopeKey', scopeKey);
        return res || [];
      } catch (e) {
        // small backoff before retry
        await new Promise(r => setTimeout(r, 200 * (i + 1)));
      }
    }
    return null; // unresolved
  }

  // Helper: show a snackbar with choice buttons and return the choice key
  function promptSnackbarChoice(message: string, choices: string[]): Promise<string> {
    return new Promise((resolve) => {
      const actions: Record<string, () => void> = {};
      for (const c of choices) {
        actions[c] = () => { resolve(c); };
      }
      // no timeout so user can decide; closable true
      showSnackbar({ message, actions, timeout: null, closable: true });
    });
  }

  // Keyboard shortcut handling
  function handleKeyboardShortcuts(event: KeyboardEvent) {
    // Only handle shortcuts when not typing in inputs, textareas, or content-editable elements
    const target = event.target as Element;
    if (target.tagName === 'INPUT' || 
        target.tagName === 'TEXTAREA' || 
        (target as HTMLElement).isContentEditable ||
        target.closest('[contenteditable="true"]')) {
      return;
    }

    // Find the first visible thread that hasn't been acted upon
    const firstAvailableThread = sortedVisibleThreads.find(thread => {
      // Check if thread is in holds (meaning it's been acted upon)
      const isHeld = (($trailingHolds || {})[thread.threadId] || 0) > Date.now();
      return !isHeld;
    });

    if (!firstAvailableThread) return;

    switch (event.key) {
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        // Open the first available thread (subject email) in the viewer
        (async () => {
          try {
            const href = `/viewer/${firstAvailableThread.threadId}`;
            if (typeof window !== 'undefined') {
              try { 
                const nav = await import('$app/navigation');
                nav.goto(href);
              } catch { 
                window.location.href = href; 
              }
            }
          } catch (_) {}
        })();
        break;
      case '#':
        event.preventDefault();
        // Trigger slide animation with full action performance
        window.dispatchEvent(new CustomEvent('jmail:keyboardAction', {
          detail: { action: 'delete', threadId: firstAvailableThread.threadId }
        }));
        break;
      case 'e':
        event.preventDefault();
        // Trigger slide animation with full action performance
        window.dispatchEvent(new CustomEvent('jmail:keyboardAction', {
          detail: { action: 'archive', threadId: firstAvailableThread.threadId }
        }));
        break;
      case 'b':
        event.preventDefault();
        // Trigger snooze menu for the first available thread
        window.dispatchEvent(new CustomEvent('jmail:openSnoozeMenu', {
          detail: { threadId: firstAvailableThread.threadId }
        }));
        break;
      case '1':
        event.preventDefault();
        // Snooze for 1 hour with slide animation
        window.dispatchEvent(new CustomEvent('jmail:keyboardSnooze', {
          detail: { threadId: firstAvailableThread.threadId, ruleKey: '1h' }
        }));
        break;
      case '2':
        event.preventDefault();
        // Snooze for 2 hours with slide animation
        window.dispatchEvent(new CustomEvent('jmail:keyboardSnooze', {
          detail: { threadId: firstAvailableThread.threadId, ruleKey: '2h' }
        }));
        break;
    }
  }

  type InboxSort = NonNullable<import('$lib/stores/settings').AppSettings['inboxSort']>;
  const sortOptions: { key: InboxSort; label: string }[] = [
    { key: 'date_desc', label: 'Date (newest first)' },
    { key: 'date_asc', label: 'Date (oldest first)' },
    { key: 'unread_first', label: 'Unread first' },
    { key: 'sender_az', label: 'Sender (A–Z)' },
    { key: 'sender_za', label: 'Sender (Z–A)' },
    { key: 'subject_az', label: 'Subject (A–Z)' },
    { key: 'subject_za', label: 'Subject (Z–A)' }
  ];
  let CLIENT_ID: string = $state(import.meta.env.VITE_GOOGLE_CLIENT_ID as string);

  let loading = $state(true);
  let ready = $state(false);
  let sortDetails: HTMLDetailsElement | null = $state(null);
  let apiErrorMessage: string | null = $state(null);
  let apiErrorStatus: number | undefined = $state();
  let apiErrorStack: string | undefined = $state();
  let nextPageToken: string | undefined = $state();
  let syncing = $state(false);
  let authoritativeSyncProgress = $state({ running: false, pagesCompleted: 0, pagesTotal: 0 });
  let pendingRefresh = $state(false);
  let backgroundSyncing = $state(false);
  let copiedDiagOk = $state(false);
  let debouncedQuery = $state('');
  $effect(() => { const id = setTimeout(() => debouncedQuery = $searchQuery, 300); return () => clearTimeout(id); });
  let now = $state(Date.now());
  onMount(() => { const id = setInterval(() => { now = Date.now(); }, 250); return () => clearInterval(id); });
  let pullingForward = $state(false);
  let staleDialogOpen = $state(false);
  let staleCandidates: Array<{ threadId: string; subject?: string; from?: string; labels?: string[] }> = $state([]);
  let selectedToDelete = $state(new Set<string>());
  // Temporarily lock interactions during coordinated collapses
  let listLocked = $state(false);
  // Restore list lock handler
  onMount(() => {
    const handler = (ev: Event) => {
      try {
        const e = ev as CustomEvent<{ ms?: number }>;
        const ms = Math.max(0, Math.min(1000, (e.detail?.ms ?? 400)));
        listLocked = true;
        setTimeout(() => { listLocked = false; }, ms);
      } catch {}
    };
    window.addEventListener('jmail:listLock', handler as EventListener);
    return () => window.removeEventListener('jmail:listLock', handler as EventListener);
  });

  // Keyboard shortcuts
  onMount(() => {
    window.addEventListener('keydown', handleKeyboardShortcuts);
    return () => window.removeEventListener('keydown', handleKeyboardShortcuts);
  });
  
  // Listen for authoritative sync requests from TopAppBar
  onMount(() => {
    const handleAuthoritativeSync = async () => {
      try {
        await performAuthoritativeInboxSync();
        // Emit completion event for TopAppBar
        window.dispatchEvent(new CustomEvent('jmail:authSyncComplete'));
      } catch (e) {
        console.error('[Inbox] Authoritative sync failed:', e);
        // Still emit completion event so TopAppBar doesn't hang
        window.dispatchEvent(new CustomEvent('jmail:authSyncComplete'));
        throw e;
      }
    };
    
    // Expose sync function on window for TopAppBar to call directly
    (window as any).__performAuthoritativeSync = handleAuthoritativeSync;
    
    window.addEventListener('jmail:performAuthoritativeSync', handleAuthoritativeSync);
    return () => {
      window.removeEventListener('jmail:performAuthoritativeSync', handleAuthoritativeSync);
      delete (window as any).__performAuthoritativeSync;
    };
  });

  // Periodic background sync to keep inbox fresh
  onMount(() => {
    console.log('[Inbox] Starting periodic background sync (every 2 minutes when visible)');
    
    // Initial check after a short delay to let the initial load complete
    const initialTimeout = setTimeout(() => {
      if (!backgroundSyncing && !syncing && ready) {
        console.log('[Inbox] Running initial background check');
        maybeRemoteRefresh().catch(console.error);
      }
    }, 30000); // Wait 30 seconds after page load
    
    // Then check periodically
    const syncInterval = setInterval(() => {
      // Only sync if page is visible, online, not already syncing, and ready
      const isVisible = typeof document !== 'undefined' && (document as any).visibilityState !== 'hidden';
      const isOnline = typeof navigator !== 'undefined' && navigator.onLine;
      
      if (isVisible && isOnline && !backgroundSyncing && !syncing && ready) {
        console.log('[Inbox] Running periodic background check');
        maybeRemoteRefresh().catch(console.error);
      } else {
        console.log('[Inbox] Skipping periodic check:', {
          isVisible,
          isOnline,
          backgroundSyncing,
          syncing,
          ready
        });
      }
    }, 120000); // Check every 2 minutes
    
    // Also check when page becomes visible again
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && (document as any).visibilityState === 'visible') {
        console.log('[Inbox] Page became visible, checking for updates');
        setTimeout(() => {
          if (!backgroundSyncing && !syncing && ready) {
            maybeRemoteRefresh().catch(console.error);
          }
        }, 1000); // Small delay to let page settle
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      clearTimeout(initialTimeout);
      clearInterval(syncInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });
  // Lightweight remote change detection state
  let lastRemoteCheckAtMs: number | null = $state(null);
  let remoteCheckInFlight = $state(false);

  async function maybeRemoteRefresh() {
    if (remoteCheckInFlight) return;
    const nowMs = Date.now();
    const minIntervalMs = 60_000;
    if (lastRemoteCheckAtMs && (nowMs - lastRemoteCheckAtMs) < minIntervalMs) return;
    if (typeof document !== 'undefined' && (document as any).visibilityState === 'hidden') return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    remoteCheckInFlight = true;
    try {
      const inboxLabel = await getLabel('INBOX');
      const remoteThreadsTotal = inboxLabel.threadsTotal ?? 0;
      const remoteThreadsUnread = inboxLabel.threadsUnread ?? 0;
      const localThreadsTotal = inboxThreads.length;
      const localThreadsUnread = inboxThreads.filter((t) => (t.labelIds || []).includes('UNREAD')).length;
      
      // Account for optimistic adjustments when comparing
      const optimisticInboxTotal = remoteThreadsTotal + $optimisticCounters.inboxDelta;
      const optimisticUnreadTotal = remoteThreadsUnread + $optimisticCounters.unreadDelta;
      
      const differs = Math.abs(optimisticInboxTotal - localThreadsTotal) > 2 || 
                     Math.abs(optimisticUnreadTotal - localThreadsUnread) > 2;
      
      const addedCount = Math.max(0, optimisticInboxTotal - localThreadsTotal);
      const removedCount = Math.max(0, localThreadsTotal - optimisticInboxTotal);
      const unreadDiff = optimisticUnreadTotal - localThreadsUnread;
      
      try { 
        if (import.meta.env.DEV) {
          console.debug('[InboxUI] remoteCheck', { 
            remoteThreadsTotal, 
            localThreadsTotal,
            optimisticInboxTotal,
            remoteThreadsUnread, 
            localThreadsUnread,
            optimisticUnreadTotal,
            optimisticDelta: $optimisticCounters.inboxDelta,
            differs,
            addedCount,
            removedCount,
            unreadDiff
          }); 
        }
      } catch {}
      
      if (differs) {
        // Only use hydrate for background refresh - it's gentler and respects optimistic updates
        try { 
          syncing = true;
          console.log('[InboxUI] Starting background hydrate due to differences');
          await hydrate();
          
          // Show subtle notification about what changed if significant
          if (addedCount > 5 || removedCount > 5) {
            let message = 'Inbox updated';
            const parts = [];
            if (addedCount > 0) parts.push(`${addedCount} new`);
            if (removedCount > 0) parts.push(`${removedCount} removed`);
            message += `: ${parts.join(', ')}`;
            
            showSnackbar({ message, timeout: 3000, closable: true });
          }
          console.log('[InboxUI] Background hydrate completed');
        } catch (e) {
          console.error('[InboxUI] Background hydrate failed:', e);
          // Don't show error snackbar for background sync failures - they're not user-initiated
        } finally { 
          syncing = false; 
        }
      }
    } catch (e) {
      // ignore transient errors but log them
      console.warn('[InboxUI] Remote check failed:', e);
    } finally {
      lastRemoteCheckAtMs = nowMs;
      remoteCheckInFlight = false;
    }
  }

  // Background reconciliation using Gmail History API. This attempts to fetch
  // history deltas since the last known historyId stored in DB and apply label
  // changes in-place to IndexedDB so the UI can reload conservatively.
  async function performBackgroundHistorySync() {
    try {
      const db = await getDB();
      const meta = (await db.get('settings', 'lastHistoryId')) as any || {};
      const lastHistoryId = meta?.value || null;
      if (!lastHistoryId) {
        // Nothing to do: caller can fall back to full list via hydrate when needed
        return;
      }
      let data: any;
      try {
        data = await listHistory(lastHistoryId);
      } catch (e) {
        // If history API fails (e.g. expired historyId) surface a subtle
        // telemetry toast so the user (or developer) knows background sync
        // didn't complete; allow a foreground hydrate to reconcile later.
        try { showSnackbar({ message: 'Background sync failed', timeout: 5000, actions: { 'Refresh': () => { void hydrate(); } } }); } catch (_) {}
        return;
      }
      const history = Array.isArray((data || {}).history) ? (data as any).history : [];
      if (!history.length) return;
      
      // Build a map of threads with recent journal entries (user actions) to preserve
      const recentUserActions = new Set<string>();
      try {
        const journalEntries = await db.getAll('journal') as any[];
        const fiveMinutesAgo = Date.now() - 300000; // 5 minutes
        for (const entry of journalEntries) {
          if (entry && entry.threadId && entry.createdAt > fiveMinutesAgo) {
            // Check if this was an INBOX removal action
            if (entry.intent && Array.isArray(entry.intent.removeLabelIds) && 
                entry.intent.removeLabelIds.includes('INBOX')) {
              recentUserActions.add(entry.threadId);
            }
          }
        }
      } catch (_) {
        // If we can't read journal, be conservative and don't apply any changes
        console.warn('[HistorySync] Could not read journal, skipping history sync to be safe');
        return;
      }
      
      const txThreads = db.transaction('threads', 'readwrite');
      const txMsgs = db.transaction('messages', 'readwrite');
      for (const h of history) {
        try {
          // Each history entry can contain messagesAdded/messagesDeleted/labelsAdded/labelsRemoved etc.
          if (h.messages && Array.isArray(h.messages)) {
            for (const m of h.messages) {
              if (m.id && m.threadId) {
                // Ensure message metadata is present for downstream filters
                try { await txMsgs.store.put({ id: m.id, threadId: m.threadId, labelIds: m.labelIds || [], internalDate: m.internalDate }); } catch (_) {}
              }
            }
          }
          if (h.labels && Array.isArray(h.labels)) {
            // labels list is uncommon here; skip
          }
          // Look for threadMetadata / label changes
          if (h.threadId || h.messages) {
            const threadId = h.threadId || (h.messages && h.messages[0] && h.messages[0].threadId);
            if (!threadId) continue;
            
            // Skip threads with recent user actions
            if (recentUserActions.has(threadId)) {
              console.log(`[HistorySync] Skipping ${threadId} - recent user action`);
              continue;
            }
            
            try {
              const existing = await txThreads.store.get(threadId) as any;
              if (!existing) continue;
              // Apply label changes present in history entry, but preserve optimistic updates
              if (h.labelsAdded || h.labelsRemoved) {
                const labels = Array.isArray(existing.labelIds) ? existing.labelIds.slice() : [];
                
                // Check if this thread was optimistically modified (removed from INBOX)
                const localHasInbox = labels.includes('INBOX');
                const wouldAddInbox = (h.labelsAdded || []).includes('INBOX');
                const wouldRemoveInbox = (h.labelsRemoved || []).includes('INBOX');
                
                // If locally removed from INBOX but server wants to add it back, preserve the optimistic change
                const wasOptimisticallyModified = !localHasInbox && wouldAddInbox;
                
                if (!wasOptimisticallyModified) {
                  // Apply server changes normally
                  for (const la of (h.labelsAdded || [])) { if (!labels.includes(la)) labels.push(la); }
                  for (const lr of (h.labelsRemoved || [])) { const idx = labels.indexOf(lr); if (idx >= 0) labels.splice(idx, 1); }
                } else {
                  // Apply server changes but preserve INBOX removal
                  console.log(`[HistorySync] Preserving optimistic INBOX removal for ${threadId}`);
                  for (const la of (h.labelsAdded || [])) { 
                    if (!labels.includes(la) && la !== 'INBOX') labels.push(la); 
                  }
                  for (const lr of (h.labelsRemoved || [])) { 
                    const idx = labels.indexOf(lr); 
                    if (idx >= 0) labels.splice(idx, 1); 
                  }
                }
                
                const next = { ...existing, labelIds: labels } as any;
                await txThreads.store.put(next);
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
      await txMsgs.done;
      await txThreads.done;
      // Don't show snackbar for background history sync - it's too noisy
      // Update lastHistoryId if provided
      const newHistoryId = (data || {}).historyId;
      if (newHistoryId) {
        try { await db.put('settings', newHistoryId, 'lastHistoryId'); } catch (_) {}
      }
      // Notify UI to reload conservative cache view
      try {
        const clients = await (navigator.serviceWorker && navigator.serviceWorker.controller) ? [] : [];
      } catch (_) {}
    } catch (_) {}
  }
  const inboxThreads = $derived.by(() => {
    try {
      const store = $threadsStore;
      if (!store || !Array.isArray(store)) return [];
      return store.filter((t) => {
        // Guard against undefined/partial entries
        if (!t || typeof (t as any).threadId !== 'string') return false;
        const labels = Array.isArray((t as any).labelIds) ? ((t as any).labelIds as string[]) : [];
        const inInbox = labels.includes('INBOX');
        const held = (($trailingHolds || {})[(t as any).threadId] || 0) > now;
        return inInbox || held;
      });
    } catch (e) {
      console.warn('Error in inboxThreads derived:', e);
      return [];
    }
  });
  const visibleThreads = $derived.by(() => {
    try {
      if (!debouncedQuery) return inboxThreads;
      return inboxThreads.filter((t) => {
        try {
          const subj = (t.lastMsgMeta?.subject || '').toLowerCase();
          const from = (t.lastMsgMeta?.from || '').toLowerCase();
          const q = debouncedQuery.toLowerCase();
          return subj.includes(q) || from.includes(q);
        } catch (e) {
          return false;
        }
      });
    } catch (e) {
      console.warn('Error in visibleThreads derived:', e);
      return [];
    }
  });
  const filteredThreads = $derived.by(() => {
    try {
      return applyFilterToThreads(visibleThreads, $messagesStore || {}, $filtersStore?.active);
    } catch (e) {
      console.warn('Error in filteredThreads derived:', e);
      return visibleThreads || [];
    }
  });
  function cmp(a: string, b: string): number { return a.localeCompare(b); }
  function num(n: unknown): number { return typeof n === 'number' && !Number.isNaN(n) ? n : 0; }
  function getSender(a: import('$lib/types').GmailThread): string {
    const raw = a.lastMsgMeta.from || '';
    const m = raw.match(/^(.*?)\s*<([^>]+)>/);
    return (m ? (m[1] || m[2]) : raw).toLowerCase();
  }
  function getSubject(a: import('$lib/types').GmailThread): string { return (a.lastMsgMeta.subject || '').toLowerCase(); }
  function getDate(a: import('$lib/types').GmailThread): number { return num(a.lastMsgMeta.date) || 0; }
  function isUnread(a: import('$lib/types').GmailThread): boolean { return (a.labelIds || []).includes('UNREAD'); }
  const currentSort: InboxSort = $derived(($settings.inboxSort || 'date_desc') as InboxSort);
  const sortedVisibleThreads = $derived.by(() => {
    try {
      if (!Array.isArray(filteredThreads)) return [];
      const arr = [...filteredThreads];
      
      switch (currentSort) {
        case 'date_asc':
          arr.sort((a, b) => getDate(a) - getDate(b));
          break;
        case 'unread_first':
          arr.sort((a, b) => {
            const d = (isUnread(b) as any) - (isUnread(a) as any);
            if (d !== 0) return d;
            return getDate(b) - getDate(a);
          });
          break;
        case 'sender_az':
          arr.sort((a, b) => {
            const s = cmp(getSender(a), getSender(b));
            if (s !== 0) return s;
            return getDate(b) - getDate(a);
          });
          break;
        case 'sender_za':
          arr.sort((a, b) => {
            const s = cmp(getSender(b), getSender(a));
            if (s !== 0) return s;
            return getDate(b) - getDate(a);
          });
          break;
        case 'subject_az':
          arr.sort((a, b) => {
            const s = cmp(getSubject(a), getSubject(b));
            if (s !== 0) return s;
            return getDate(b) - getDate(a);
          });
          break;
        case 'subject_za':
          arr.sort((a, b) => {
            const s = cmp(getSubject(b), getSubject(a));
            if (s !== 0) return s;
            return getDate(b) - getDate(a);
          });
          break;
        case 'date_desc':
        default:
          arr.sort((a, b) => getDate(b) - getDate(a));
          break;
      }
      
      // Prioritize threads that already have an AI summary, then others,
      // and keep threads with pending AI subject at the bottom until ready
      try {
        const pending = arr.filter((t) => ((t as any).aiSubjectStatus || 'none') === 'pending');
        const notPending = arr.filter((t) => ((t as any).aiSubjectStatus || 'none') !== 'pending');
        const withSummary = notPending.filter((t) => (t.summaryStatus === 'ready' && (t.summary || '').trim() !== ''));
        const withoutSummary = notPending.filter((t) => !(t.summaryStatus === 'ready' && (t.summary || '').trim() !== ''));
        return [...withSummary, ...withoutSummary, ...pending];
      } catch (_) {
        return arr;
      }
    } catch (e) {
      console.warn('Error in sortedVisibleThreads derived:', e);
      return [];
    }
  });
  const currentSortLabel = $derived((sortOptions.find(o => o.key === currentSort)?.label) || 'Date (newest first)');
  function setSort(next: InboxSort) { updateAppSettings({ inboxSort: next }); }
  // Selection state keyed by threadId
  let selectedMap = $state<Record<string, true>>({});
  const selectedCount = $derived.by(() => {
    try {
      return Object.keys(selectedMap || {}).length;
    } catch (e) {
      return 0;
    }
  });
  const allVisibleSelected = $derived.by(() => {
    try {
      return Array.isArray(filteredThreads) && filteredThreads.length > 0 && filteredThreads.every(t => selectedMap?.[t?.threadId]);
    } catch (e) {
      return false;
    }
  });
  function toggleSelectThread(threadId: string, next: boolean) {
    if (next) selectedMap = { ...selectedMap, [threadId]: true };
    else { const { [threadId]: _, ...rest } = selectedMap; selectedMap = rest; }
  }
  function selectAllVisible(next: boolean) {
    if (next) {
      const map: Record<string, true> = {};
      for (const t of filteredThreads) map[t.threadId] = true;
      selectedMap = map;
    } else {
      selectedMap = {};
    }
  }
  function isEventFromTextInput(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    const editable = (t as any).isContentEditable;
    return tag === 'input' || tag === 'textarea' || editable;
  }
  function onKeyDown(e: KeyboardEvent) {
    if (isEventFromTextInput(e)) return;
    if (e.key === 'Delete') {
      if (selectedCount > 0) {
        if ($settings.confirmDelete) {
          if (!confirm(`Delete ${selectedCount} conversation(s)?`)) return;
        }
        void bulkDelete();
      }
    } else if (e.key === 'e' || e.key === 'E') {
      if (selectedCount > 0) {
        void bulkArchive();
      }
    } else if (e.key === 'z' || e.key === 'Z') {
      void undoLast(1);
    }
  }
  async function bulkArchive() {
    const ids = Object.keys(selectedMap);
    if (!ids.length) return;
    
    // For bulk operations, we update local state for each thread immediately
    // The baseInboxCount will decrease naturally, so no counter adjustment needed
    for (const id of ids) await archiveThread(id);
    selectedMap = {};
    showSnackbar({ message: 'Archived', actions: { Undo: () => undoLast(ids.length) } });
  }
  async function bulkDelete() {
    const ids = Object.keys(selectedMap);
    if (!ids.length) return;
    
    // For bulk operations, we update local state for each thread immediately
    // The baseInboxCount will decrease naturally, so no counter adjustment needed
    for (const id of ids) await trashThread(id);
    selectedMap = {};
    showSnackbar({ message: 'Deleted', actions: { Undo: () => undoLast(ids.length) } });
  }
  async function bulkSnooze(ruleKey: string) {
    const ids = Object.keys(selectedMap);
    if (!ids.length) return;
    // Dispatch a group slide event to animate all visible selected items simultaneously
    try {
      window.dispatchEvent(new CustomEvent('jmail:groupSlide', { detail: { action: 'snooze', ids, ruleKey } }));
    } catch (_) {}
    for (const id of ids) await snoozeThreadByRule(id, ruleKey, { optimisticLocal: true });
    selectedMap = {};
    showSnackbar({ message: `Snoozed ${ids.length} • ${ruleKey}`, actions: { Undo: () => undoLast(ids.length) } });
  }
  const totalThreadsCount = $derived.by(() => {
    try {
      return $threadsStore?.length || 0;
    } catch (e) {
      return 0;
    }
  });
  let inboxLabelStats = $state<{ messagesTotal?: number; messagesUnread?: number; threadsTotal?: number; threadsUnread?: number } | null>(null);
  
  // Optimistically adjusted counters that update immediately when processing messages
  const adjustedInboxTotal = $derived.by(() => {
    const base = inboxLabelStats?.threadsTotal ?? 0;
    const delta = $optimisticCounters.inboxDelta;
    return Math.max(0, base + delta);
  });
  
  const adjustedInboxUnread = $derived.by(() => {
    const base = inboxLabelStats?.threadsUnread ?? 0;
    const delta = $optimisticCounters.unreadDelta;
    return Math.max(0, base + delta);
  });
  
  const visibleThreadsCount = $derived.by(() => {
    try {
      return Array.isArray(filteredThreads) ? filteredThreads.length : 0;
    } catch (e) {
      return 0;
    }
  });
  $effect(() => {
    // Log UI-level diagnostics in dev builds only
    try {
      if (import.meta.env.DEV) {
        const entries = getAndClearGmailDiagnostics();
        // eslint-disable-next-line no-console
        console.debug('[InboxUI]', {
          time: new Date().toISOString(),
          type: 'ui_state',
          searchQuery: debouncedQuery,
          threadsCount: totalThreadsCount,
          visibleThreadsCount,
          nextPageToken,
          entries
        });
        // Re-push previously captured entries so copy includes them later
        if (entries && entries.length) {
          // put them back through copy helper by appending in copyDiagnostics
          __uiBufferedEntries = entries;
        }
      }
    } catch (_) {}
  });

  // Buffer to include last API entries in next copyDiagnostics call
  let __uiBufferedEntries: any[] = [];

  export async function reloadFromCache() {
    const db = await getDB();
    const cachedThreads = await db.getAll('threads');
    if (cachedThreads?.length) {
      const current = $threadsStore || [];
      
      // Build a map of threads with pending operations to preserve their optimistic state
      const hasPendingOps = new Set<string>();
      try {
        const allOps = await db.getAll('ops');
        for (const op of allOps) {
          if (op.scopeKey) hasPendingOps.add(op.scopeKey);
        }
      } catch (_) {}
      
      function threadLastActivity(th: any) {
        try { return Math.max(Number(th?.lastMsgMeta?.date) || 0, Number((th as any).aiSubjectUpdatedAt) || 0, Number((th as any).summaryUpdatedAt) || 0); } catch { return 0; }
      }
      const merged = current.slice();
      for (const t of cachedThreads) {
        const idx = merged.findIndex((x: any) => x.threadId === t.threadId);
        if (idx >= 0) {
          try {
            const existing = merged[idx];
            
            // If this thread has pending operations, preserve its current labelIds
            if (hasPendingOps.has(t.threadId)) {
              // Keep the existing thread with optimistic changes, but update non-label fields from DB
              merged[idx] = { ...t, labelIds: existing.labelIds };
              continue;
            }
            
            const existingLast = threadLastActivity(existing);
            const cachedLast = threadLastActivity(t);
            // Prefer in-memory/local thread when it appears newer, or when it has been removed from INBOX locally
            if (existingLast >= cachedLast) continue;
            if (Array.isArray(existing.labelIds) && !existing.labelIds.includes('INBOX')) continue;
            // Otherwise merge cached data into the existing slot
            merged[idx] = { ...existing, ...t };
          } catch {
            merged[idx] = t;
          }
        } else {
          merged.push(t);
        }
      }
      const { setThreadsWithReset } = await import('$lib/stores/optimistic-counters');
      setThreadsWithReset(merged);
    }
    const cachedMessages = await db.getAll('messages');
    if (cachedMessages?.length) {
      const dict: Record<string, import('$lib/types').GmailMessage> = { ...$messagesStore };
      for (const m of cachedMessages) {
        try {
          const existing = dict[m.id];
          // Prefer existing in-memory message if it looks newer (by internalDate) or already contains body
          if (existing) {
            const existingDate = Number(existing.internalDate) || 0;
            const incomingDate = Number(m.internalDate) || 0;
            const existingHasBody = !!(existing.bodyText || existing.bodyHtml);
            const incomingHasBody = !!(m.bodyText || m.bodyHtml);
            if (existingHasBody && !incomingHasBody) continue;
            if (existingDate >= incomingDate) continue;
          }
          dict[m.id] = m;
        } catch {
          dict[m.id] = m;
        }
      }
      messagesStore.set(dict);
    }
  }

  export async function resetInboxCache() {
    const db = await getDB();
    try { await db.clear('threads'); } catch {}
    try { await db.clear('messages'); } catch {}
    threadsStore.set([]);
    messagesStore.set({});
  }

  async function handlePullForward() {
    if (pullingForward) return;
    
    pullingForward = true;
    try {
      const result = await pullForwardSnoozedEmails();
      
      if (result.success) {
        if (result.pulledCount > 0) {
          showSnackbar({ 
            message: `Pulled forward ${result.pulledCount} email${result.pulledCount === 1 ? '' : 's'} from snooze`, 
            timeout: 3000 
          });
          // Refresh the inbox to show the newly pulled emails
          await hydrate();
        } else {
          showSnackbar({ 
            message: 'No snoozed emails found to pull forward', 
            timeout: 3000 
          });
        }
      } else {
        showSnackbar({ 
          message: `Failed to pull forward emails: ${result.error || 'Unknown error'}`, 
          timeout: 5000 
        });
      }
    } catch (error) {
      console.error('Error pulling forward emails:', error);
      showSnackbar({ 
        message: 'Failed to pull forward emails', 
        timeout: 5000 
      });
    } finally {
      pullingForward = false;
    }
  }

  onMount(() => {
    const unsub = authState.subscribe((s) => {
      const wasReady = ready;
      ready = s.ready;
      if (!wasReady && s.ready && pendingRefresh) {
        pendingRefresh = false;
        setTimeout(() => {
          try {
            window.dispatchEvent(new CustomEvent('jmail:refresh'));
          } catch (_) {}
        }, 50);
      }
    });
    
    if (($threadsStore || []).length) loading = false;
    (async () => {
      let hadCache = false;
      try {
        // Check for server session first (long-lasting auth)
        try {
          const { checkServerSession, storeServerSessionInDB } = await import('$lib/gmail/server-session-check');
          const serverSession = await checkServerSession();
          if (serverSession.authenticated) {
            console.log('[Inbox] Using server-side session for', serverSession.email);
            
            // Store server session in DB so the app recognizes the user
            await storeServerSessionInDB(serverSession);
            
            // Immediately notify session manager that we're authenticated
            const { sessionManager } = await import('$lib/auth/session-manager');
            sessionManager.applyServerSession(serverSession.email);
            
            ready = true;
            // Continue with inbox loading using server session
            try {
              const { loadSettings } = await import('$lib/stores/settings');
              await loadSettings();
              await loadFilters();
              hadCache = await hydrateFromCache();
              if (hadCache) loading = false;
              // Use server APIs for data loading
              try {
                syncing = true;
                await hydrate(); // Load first page quickly for immediate UX
                
                // Notify session manager that authentication is working
                const { sessionManager } = await import('$lib/auth/session-manager');
                sessionManager.applyServerSession(serverSession.email);
              } catch (e) {
                console.error('[Inbox] Server session API call failed:', e);
                setApiError(e);
              } finally {
                syncing = false;
              }
              
              // Start background authoritative sync to match Gmail exactly (non-blocking)
              console.log('[Inbox] ===== SCHEDULING BACKGROUND SYNC (SERVER SESSION) =====');
              void (async () => {
                try {
                  backgroundSyncing = true;
                  console.log('[Inbox] BACKGROUND SYNC STARTED (server session path)');
                  
                  // Check if we need sync by comparing local vs Gmail thread counts
                  console.log('[Inbox] Starting background sync analysis...');
                  const db = await getDB();
                  
                  // Check for pending operations that might conflict with sync
                  const pendingOps = await db.getAll('ops');
                  const pendingLabelOps = pendingOps.filter(op => 
                    op.op.type === 'batchModify' && 
                    (op.op.addLabelIds.includes('INBOX') || op.op.removeLabelIds.includes('INBOX'))
                  );
                  
                  if (pendingLabelOps.length > 0) {
                    // Check if operations are stuck (old and repeatedly failed)
                    const now = Date.now();
                    const stuckOps = pendingLabelOps.filter(op => 
                      op.attempts > 5 && (now - (op.createdAt || 0)) > 300000 // 5+ attempts and older than 5 minutes
                    );
                    
                    if (stuckOps.length > 0) {
                      console.warn(`[Inbox] Found ${stuckOps.length} stuck operations (5+ attempts, >5min old) - clearing them to unblock sync`);
                      const tx = db.transaction('ops', 'readwrite');
                      for (const op of stuckOps) {
                        console.warn(`[Inbox] Clearing stuck op: ${op.id}, attempts: ${op.attempts}, error: ${op.lastError}`);
                        await tx.store.delete(op.id);
                      }
                      await tx.done;
                      
                      // Re-check remaining operations
                      const remainingOps = pendingLabelOps.filter(op => !stuckOps.includes(op));
                      if (remainingOps.length > 0) {
                        console.log(`[Inbox] Still ${remainingOps.length} pending INBOX operations after clearing stuck ones - skipping sync`);
                        return;
                      } else {
                        console.log(`[Inbox] All stuck operations cleared - proceeding with sync`);
                      }
                    } else {
                      console.log(`[Inbox] Skipping background sync - ${pendingLabelOps.length} pending INBOX operations found`);
                      pendingLabelOps.forEach(op => {
                        console.log(`[Inbox] Pending op: ${op.id}, attempts: ${op.attempts}, nextAttempt: ${new Date(op.nextAttemptAt || 0).toISOString()}, error: ${op.lastError || 'none'}`);
                      });
                      return; // Skip sync entirely to avoid resurrecting locally-deleted threads
                    }
                  }
                  
                  const localThreads = await db.getAll('threads');
                  const localInboxThreads = localThreads.filter((t: any) => 
                    Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
                  );
                  
                  console.log(`[Inbox] Local analysis: ${localThreads.length} total threads, ${localInboxThreads.length} with INBOX label, ${pendingLabelOps.length} pending INBOX ops`);
                  
                  try {
                    const inboxLabel = await getLabel('INBOX');
                    const gmailThreadCount = inboxLabel.threadsTotal || 0;
                    const localThreadCount = localInboxThreads.length;
                    
                    console.log(`[Inbox] Gmail label stats: ${gmailThreadCount} threads in INBOX`);
                    console.log(`[Inbox] Sync decision: Gmail=${gmailThreadCount}, Local=${localThreadCount}, Diff=${Math.abs(gmailThreadCount - localThreadCount)}`);
                    
                    // Always run authoritative sync; avoid referring to "quick sync" in logs
                    if (localThreadCount === 0 || Math.abs(gmailThreadCount - localThreadCount) > 2) {
                      console.log(`[Inbox] TRIGGERING FULL AUTHORITATIVE SYNC - Major discrepancy detected`);
                      await performAuthoritativeInboxSync();
                      console.log(`[Inbox] Full authoritative sync completed`);
                    } else {
                      console.log(`[Inbox] Thread counts are close - running authoritative sync (short mode)`);
                      await performAuthoritativeInboxSync({ perPageTimeoutMs: 10000, maxRetries: 1 });
                      console.log(`[Inbox] Authoritative sync (short mode) completed`);
                    }
                  } catch (e) {
                    console.warn('[Inbox] Label check failed, running full sync anyway:', e);
                    console.log(`[Inbox] TRIGGERING FALLBACK FULL SYNC due to error`);
                    await performAuthoritativeInboxSync();
                    console.log(`[Inbox] Fallback full sync completed`);
                  }
                  
                  // Verify sync results
                  console.log('[Inbox] Verifying sync results...');
                  const postSyncThreads = await db.getAll('threads');
                  const postSyncInboxThreads = postSyncThreads.filter((t: any) => 
                    Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
                  );
                  console.log(`[Inbox] POST-SYNC: ${postSyncThreads.length} total threads, ${postSyncInboxThreads.length} with INBOX label`);
                  
                  if (postSyncInboxThreads.length === 0) {
                    console.error('[Inbox] CRITICAL: Sync completed but still 0 threads with INBOX label!');
                  } else {
                    console.log(`[Inbox] SUCCESS: Sync resulted in ${postSyncInboxThreads.length} inbox threads`);
                  }
                  
                  console.log('[Inbox] Background full sync completed');
                } catch (e) {
                  console.error('[Inbox] Background full sync failed:', e);
                  // Show user-facing error for critical sync failures
                  if (e instanceof Error && (e.message.includes('403') || e.message.includes('401'))) {
                    setApiError(new Error('Gmail sync failed - please refresh the page or check your authentication'));
                  } else {
                    // Try one more time with reduced parameters for robustness
                    try {
                      console.log('[Inbox] Retrying sync with reduced parameters...');
                      await performAuthoritativeInboxSync({ perPageTimeoutMs: 30000, maxRetries: 3 });
                      console.log('[Inbox] Retry sync completed successfully');
                    } catch (retryE) {
                      console.error('[Inbox] Retry sync also failed:', retryE);
                      setApiError(new Error('Gmail sync failed after retry - please use the refresh button'));
                    }
                  }
                } finally {
                  backgroundSyncing = false;
                }
              })();
              return; // Skip client auth initialization
            } catch (e) {
              console.warn('[Inbox] Server session hydration failed:', e);
              // Continue to client auth fallback
            }
          } else {
            console.log('[Inbox] No server session found, falling back to client auth');
          }
        } catch (e) {
          console.warn('[Inbox] Server session check failed:', e);
        }

        // Check if localhost - use special localhost auth
        const isLocalhost = typeof window !== 'undefined' && 
          (window.location.hostname === 'localhost' || 
           window.location.hostname === '127.0.0.1' || 
           window.location.hostname.startsWith('192.168.'));
        
        if (isLocalhost) {
          try {
            const { initLocalhostAuth } = await import('$lib/gmail/localhost-auth');
            await initLocalhostAuth();
            console.log('[Inbox] Localhost auth initialized');
            ready = true;
          } catch (e) {
            console.warn('[Inbox] Localhost auth failed, falling back to client auth:', e);
          }
        }

        // Fall back to client-side auth
        CLIENT_ID = CLIENT_ID || resolveGoogleClientId() as string;
        await initAuth(CLIENT_ID);
        // Load settings first for snooze defaults  
        const { loadSettings } = await import('$lib/stores/settings');
        await loadSettings();
        await loadFilters();
        hadCache = await hydrateFromCache();
        if (hadCache) loading = false;
        navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
          if ((e.data && e.data.type) === 'SYNC_TICK') {
            try { if (import.meta.env.DEV) console.debug('[InboxUI] SYNC_TICK received'); } catch {}
            // Schedule background history-based reconciliation and a quick cache reload.
            void performBackgroundHistorySync();
            void hydrateFromCache();
            void maybeRemoteRefresh();
            
            // Periodically verify sync integrity (every ~10 sync ticks)
            if (Math.random() < 0.1) {
              void verifySyncIntegrity();
            }
          }
        });
        // Attempt initial remote hydrate without blocking UI if cache exists
        try {
          syncing = true;
          await hydrate(); // Load first page quickly
          
          // Notify session manager that authentication is working
          const { sessionManager } = await import('$lib/auth/session-manager');
          sessionManager.applyServerSession();
        } catch (e) {
          setApiError(e);
        } finally {
          syncing = false;
        }
        
        // Start background authoritative sync to match Gmail exactly (non-blocking)
        console.log('[Inbox] ===== SCHEDULING BACKGROUND SYNC (CLIENT AUTH) =====');
        void (async () => {
          try {
            backgroundSyncing = true;
            console.log('[Inbox] BACKGROUND SYNC STARTED (client auth path)');
            
            // Check if we need sync by comparing local vs Gmail thread counts
            const db = await getDB();
            
            // Check for pending operations that might conflict with sync
            const pendingOps = await db.getAll('ops');
            const pendingLabelOps = pendingOps.filter(op => 
              op.op.type === 'batchModify' && 
              (op.op.addLabelIds.includes('INBOX') || op.op.removeLabelIds.includes('INBOX'))
            );
            
            if (pendingLabelOps.length > 0) {
              // Check if operations are stuck (old and repeatedly failed)
              const now = Date.now();
              const stuckOps = pendingLabelOps.filter(op => 
                op.attempts > 5 && (now - (op.createdAt || 0)) > 300000 // 5+ attempts and older than 5 minutes
              );
              
              if (stuckOps.length > 0) {
                console.warn(`[Inbox] Found ${stuckOps.length} stuck operations (5+ attempts, >5min old) - clearing them to unblock sync`);
                const tx = db.transaction('ops', 'readwrite');
                for (const op of stuckOps) {
                  console.warn(`[Inbox] Clearing stuck op: ${op.id}, attempts: ${op.attempts}, error: ${op.lastError}`);
                  await tx.store.delete(op.id);
                }
                await tx.done;
                
                // Re-check remaining operations
                const remainingOps = pendingLabelOps.filter(op => !stuckOps.includes(op));
                if (remainingOps.length > 0) {
                  console.log(`[Inbox] Still ${remainingOps.length} pending INBOX operations after clearing stuck ones - skipping sync`);
                  return;
                } else {
                  console.log(`[Inbox] All stuck operations cleared - proceeding with sync`);
                }
              } else {
                console.log(`[Inbox] Skipping background sync - ${pendingLabelOps.length} pending INBOX operations found`);
                pendingLabelOps.forEach(op => {
                  console.log(`[Inbox] Pending op: ${op.id}, attempts: ${op.attempts}, nextAttempt: ${new Date(op.nextAttemptAt || 0).toISOString()}, error: ${op.lastError || 'none'}`);
                });
                return; // Skip sync entirely to avoid resurrecting locally-deleted threads
              }
            }
            
            const localThreads = await db.getAll('threads');
            const localInboxThreads = localThreads.filter((t: any) => 
              Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
            );
            
            try {
              const inboxLabel = await getLabel('INBOX');
              const gmailThreadCount = inboxLabel.threadsTotal || 0;
              const localThreadCount = localInboxThreads.length;
              
              if (import.meta.env.DEV) {
                console.log(`[Inbox] Sync check: Gmail has ${gmailThreadCount} threads, local has ${localThreadCount} threads`);
              }
              
              // Always run authoritative sync; avoid referring to "quick sync" in logs
              if (localThreadCount === 0 || Math.abs(gmailThreadCount - localThreadCount) > 2) {
                console.log(`[Inbox] Significant sync discrepancy detected, running full authoritative sync`);
                await performAuthoritativeInboxSync();
              } else {
                console.log(`[Inbox] Thread counts are close - running authoritative sync (short mode)`);
                await performAuthoritativeInboxSync({ perPageTimeoutMs: 10000, maxRetries: 1 });
              }
            } catch (e) {
              console.warn('[Inbox] Label check failed, running full sync anyway:', e);
              await performAuthoritativeInboxSync();
            }
            
            console.log('[Inbox] Background full sync completed');
          } catch (e) {
            console.error('[Inbox] Background full sync failed:', e);
            // Show user-facing error for critical sync failures
            if (e instanceof Error && (e.message.includes('403') || e.message.includes('401'))) {
              setApiError(new Error('Gmail sync failed - please refresh the page or check your authentication'));
            } else {
              // Try one more time with reduced parameters for robustness
              try {
                console.log('[Inbox] Retrying sync with reduced parameters...');
                await performAuthoritativeInboxSync({ perPageTimeoutMs: 30000, maxRetries: 3 });
                console.log('[Inbox] Retry sync completed successfully');
              } catch (retryE) {
                console.error('[Inbox] Retry sync also failed:', retryE);
                setApiError(new Error('Gmail sync failed after retry - please use the refresh button'));
              }
            }
          } finally {
            backgroundSyncing = false;
          }
        })();
      } catch (e) {
        setApiError(e);
      } finally {
        if (!hadCache) loading = false;
      }
    })();
    // Listen for global refresh requests
    async function handleGlobalRefresh() {
      console.log('[Inbox] ===== REFRESH EVENT RECEIVED =====');
      let queuedRefresh = false;
      try {
        // Note: The actual authoritative sync is performed by TopAppBar calling
        // __performAuthoritativeSync directly, and the TopAppBar also handles
        // refreshing label stats. This handler just logs for debugging.
        
        // Check if we're in a valid state to refresh
        if (!ready) {
          pendingRefresh = true;
          queuedRefresh = true;
          return;
        }
        
        console.log('[Inbox] Refresh complete - UI should now reflect updated data');
        
        // Log current state for debugging
        try {
          const db = await getDB();
          const localThreads = await db.getAll('threads');
          const localInboxThreads = localThreads.filter((t: any) => 
            Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
          );
          
          console.log(`[Inbox] Local state after refresh: ${localInboxThreads.length} inbox threads`);
        } catch (e) {
          console.warn('[Inbox] Could not check local state:', e);
        }
        
      } catch (e) {
        console.error('[Inbox] Refresh event handler failed:', e);
      } finally {
        if (!queuedRefresh) pendingRefresh = false;
      }
    }
    console.log('[Inbox] Setting up refresh event listeners...');
    window.addEventListener('jmail:refresh', handleGlobalRefresh);
    // Expose for debugging/manual trigger
    try { 
      (window as any).__jmailRefresh = () => {
        console.log('[Debug] Manual refresh triggered via __jmailRefresh()');
        window.dispatchEvent(new CustomEvent('jmail:refresh'));
      };
      console.log('[Inbox] __jmailRefresh() function exposed for debugging');
    } catch (e) {
      console.error('[Inbox] Failed to expose debug refresh function:', e);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => { 
      window.removeEventListener('jmail:refresh', handleGlobalRefresh); 
      window.removeEventListener('keydown', onKeyDown); 
      unsub(); 
    };
  });

  function setApiError(e: unknown) {
    // Handle transient IndexedDB errors with a snackbar instead of blocking UI
    const errorMessage = e instanceof Error ? e.message : String(e);
    const isTransientDBError = errorMessage.includes('IDBTransaction') || 
                               errorMessage.includes('transaction has finished') ||
                               errorMessage.includes('objectStore');
    
    if (isTransientDBError) {
      // Show as a dismissible snackbar - these errors often self-resolve
      showSnackbar({
        message: 'Database sync issue detected (may self-resolve)',
        timeout: 5000,
        closable: true,
        actions: {
          'Details': () => {
            console.error('[Inbox] IndexedDB error details:', e);
          }
        }
      });
      // Still log to console for debugging
      console.warn('[Inbox] Transient IndexedDB error (shown as snackbar):', e);
      return;
    }
    
    // For all other errors, show the full error card
    if (e instanceof GmailApiError) {
      apiErrorStatus = e.status;
      apiErrorMessage = e.message || `Gmail API error ${e.status}`;
    } else if (e instanceof Error) {
      apiErrorStatus = undefined;
      apiErrorMessage = e.message;
    } else {
      apiErrorStatus = undefined;
      apiErrorMessage = String(e);
    }
    // Best-effort automatic diagnostics copy only in dev (may be blocked without user gesture)
    if (import.meta.env.DEV) void copyDiagnostics();
  }

  // Explicit full INBOX reconciliation: pages through all INBOX message ids,
  // records threadIds seen, updates local DB to remove `INBOX` from threads
  // that are no longer present on the server, and refreshes the in-memory store.
  async function performAuthoritativeInboxSync(opts?: { perPageTimeoutMs?: number; maxRetries?: number }) {
    const perPageTimeoutMs = opts?.perPageTimeoutMs ?? 20_000; // 20s per page
    const maxRetries = opts?.maxRetries ?? 2;
    const db = await getDB();
    try {
      const pageSize = 500; // Max page size supported by Gmail threads.list to reduce pages
      let pageToken: string | undefined = undefined;
      const seenThreadIds = new Set<string>();
      let consecutiveEmptyPages = 0;
      let totalThreadsProcessed = 0;
      let totalPagesAttempted = 0;
      let lastPageToken: string | undefined = undefined;
      let consecutiveNoNewThreads = 0;
      const seenPageTokens = new Set<string>();
      let MAX_PAGES_SAFETY_LIMIT = 50; // Default safety limit; will adjust dynamically when possible
      authoritativeSyncProgress = { running: true, pagesCompleted: 0, pagesTotal: 0 };

      console.log(`[AuthSync] ===== STARTING AUTHORITATIVE INBOX SYNC =====`);
      console.log(`[AuthSync] Config: pageSize=${pageSize}, timeout=${perPageTimeoutMs}ms, maxRetries=${maxRetries}`);
      
      // Log current local state
      const preSyncThreads = await db.getAll('threads');
      const preSyncInboxThreads = preSyncThreads.filter((t: any) => 
        Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
      );
      console.log(`[AuthSync] PRE-SYNC STATE: ${preSyncThreads.length} total threads, ${preSyncInboxThreads.length} with INBOX`);

      console.log(`[AuthSync] Starting authoritative inbox sync with pageSize: ${pageSize}`);
      console.log(`[AuthSync] Database has ${preSyncThreads.length} threads, ${preSyncInboxThreads.length} with INBOX label`);
      
      // Get Gmail's reported count
      try {
        const inboxLabel = await getLabel('INBOX');
        console.log(`[AuthSync] Gmail reports: ${inboxLabel.threadsTotal} total INBOX threads, ${inboxLabel.threadsUnread} unread`);
        console.log(`[AuthSync] Discrepancy: Gmail has ${(inboxLabel.threadsTotal || 0) - preSyncInboxThreads.length} more threads than local DB`);
      } catch (e) {
        console.warn(`[AuthSync] Could not fetch Gmail INBOX label stats:`, e);
      }

      // Try to compute a dynamic page limit based on INBOX size to avoid premature stop for large inboxes
      try {
        const inboxLabel = await getLabel('INBOX');
        const threadsTotal = Number((inboxLabel as any)?.threadsTotal || 0);
        if (threadsTotal > 0) {
          const estimatedPages = Math.ceil(threadsTotal / pageSize);
          // Allow a small buffer over the estimate
          MAX_PAGES_SAFETY_LIMIT = Math.max(50, estimatedPages + 2);
          authoritativeSyncProgress = { ...authoritativeSyncProgress, pagesTotal: estimatedPages };
          if (import.meta.env.DEV) {
            console.log(`[AuthSync] INBOX threadsTotal=${threadsTotal}, estimatedPages=${estimatedPages}, maxPages=${MAX_PAGES_SAFETY_LIMIT}`);
          }
        }
      } catch (_) {}

      // Stream thread ids (preferred) rather than messages to avoid missing
      // threads due to message-level pagination nuances.
      // Helper: fetch thread IDs by enumerating INBOX messages and extracting their threadIds
      async function fetchInboxThreadIdsByMessagePage(pageSize: number, pageToken?: string) {
        // listInboxMessageIds returns message ids; we need to fetch message metadata to get threadIds
        const page = await listInboxMessageIds(pageSize, pageToken);
        const msgIds = page.ids || [];
        if (!msgIds.length) return { ids: [] as string[], nextPageToken: page.nextPageToken };
        const msgs = await mapWithConcurrency(msgIds, 4, async (id: string) => {
          try { const m = await getMessageMetadata(id); return m; } catch (_) { return null; }
        });
        const threadIds = Array.from(new Set((msgs || []).filter(Boolean).map((m: any) => m.threadId).filter(Boolean)));
        return { ids: threadIds, nextPageToken: page.nextPageToken };
      }

      while (true) {
        totalPagesAttempted++;
        
        // Safety check to prevent runaway syncs
        if (totalPagesAttempted > MAX_PAGES_SAFETY_LIMIT) {
          if (import.meta.env.DEV) {
            console.error(`[AuthSync] SAFETY STOP: Attempted ${totalPagesAttempted} pages, stopping to prevent runaway sync`);
          }
          throw new Error(`Sync exceeded safety limit of ${MAX_PAGES_SAFETY_LIMIT} pages`);
        }
        // Attempt to fetch a page with a per-page timeout and retry policy
        let page: { ids: string[]; nextPageToken?: string } | null = null;
        let attempt = 0;
        while (attempt <= maxRetries && !page) {
          attempt += 1;
          try {
            // Enumerate INBOX by messages to ensure only threads with INBOX messages are considered
            page = await Promise.race([
              fetchInboxThreadIdsByMessagePage(pageSize, pageToken),
              new Promise((_, rej) => setTimeout(() => rej(new Error('page_timeout')), perPageTimeoutMs))
            ]) as { ids: string[]; nextPageToken?: string };
          } catch (e) {
            if (attempt > maxRetries) throw e; // escalate after retries
            // small backoff
            await new Promise((res) => setTimeout(res, 500 * attempt));
          }
        }
        if (!page) break; // defensive
        
        // Detect non-advancing page tokens to avoid infinite loops
        if (lastPageToken && page.nextPageToken && lastPageToken === page.nextPageToken) {
          if (import.meta.env.DEV) {
            console.warn(`[AuthSync] nextPageToken did not advance; breaking to avoid loop: ${page.nextPageToken}`);
          }
          break;
        }
        // If we have seen this nextPageToken before (cycle), break
        if (page.nextPageToken && seenPageTokens.has(page.nextPageToken)) {
          if (import.meta.env.DEV) {
            console.warn(`[AuthSync] Detected repeated nextPageToken cycle; breaking: ${page.nextPageToken}`);
          }
          break;
        }
        if (page.nextPageToken) seenPageTokens.add(page.nextPageToken);
        lastPageToken = pageToken;
        pageToken = page.nextPageToken;
        
        // Debug logging for each page
        console.log(`[AuthSync] ===== PAGE ${authoritativeSyncProgress.pagesCompleted + 1} RESULTS =====`);
        console.log(`[AuthSync] Page returned ${page.ids?.length || 0} threads, hasNextToken: ${!!page.nextPageToken}`);
        if (page.ids?.length) {
          console.log(`[AuthSync] First 5 thread IDs: ${page.ids.slice(0, 5).join(', ')}`);
        }
        
        // Check if this page is empty or making no progress
        if (!page.ids || !page.ids.length) {
          consecutiveEmptyPages++;
          if (import.meta.env.DEV) {
            console.log(`[AuthSync] Empty page ${consecutiveEmptyPages}, nextToken: ${!!page.nextPageToken}`);
          }
          // Break if we get too many consecutive empty pages OR no next token
          if (consecutiveEmptyPages >= 3 || !pageToken) {
            if (import.meta.env.DEV) {
              console.log(`[AuthSync] Breaking due to ${consecutiveEmptyPages} consecutive empty pages or no nextToken`);
            }
            break;
          }
          continue; // Don't increment page counter for empty pages
        }
        
        // Reset empty page counter and increment progress only for non-empty pages
        consecutiveEmptyPages = 0;
        authoritativeSyncProgress = { ...authoritativeSyncProgress, pagesCompleted: authoritativeSyncProgress.pagesCompleted + 1 };
        
        const ids = page.ids;
        totalThreadsProcessed += ids.length;
        
        // Add all thread IDs from this page to seenThreadIds for proper reconciliation
        const before = seenThreadIds.size;
        for (const tid of ids) {
          seenThreadIds.add(tid);
        }
        const delta = seenThreadIds.size - before;
        if (delta === 0) {
          consecutiveNoNewThreads++;
          if (import.meta.env.DEV) {
            console.warn('[AuthSync] Page yielded no new threads; consecutiveNoNewThreads=', consecutiveNoNewThreads);
          }
          if (consecutiveNoNewThreads >= 3) {
            if (import.meta.env.DEV) {
              console.warn('[AuthSync] Breaking due to repeated pages with no new threads');
            }
            break;
          }
        } else {
          consecutiveNoNewThreads = 0;
        }
        
        // For threads on this page, fetch summaries only for those missing or
        // needing update in local DB to keep network usage reasonable.
        const toFetch: string[] = [];
        console.log(`[AuthSync] Checking which of ${ids.length} threads need to be fetched...`);
        
        for (const tid of ids) {
          try {
            const existing = await db.get('threads', tid) as any | undefined;
            if (!existing) {
              toFetch.push(tid);
            } else {
              // Check if existing thread has INBOX label
              const hasInbox = Array.isArray(existing.labelIds) && existing.labelIds.includes('INBOX');
              console.log(`[AuthSync] Thread ${tid}: exists=${!!existing}, hasINBOX=${hasInbox}, labels=${existing.labelIds?.join(',') || 'none'}`);
            }
          } catch (_) { 
            toFetch.push(tid); 
          }
        }
        
        console.log(`[AuthSync] Need to fetch ${toFetch.length} threads: ${toFetch.slice(0, 5).join(', ')}${toFetch.length > 5 ? '...' : ''}`)
        
        // Fetch thread summaries with modest concurrency
        const fetched = await mapWithConcurrency(toFetch, 4, async (tid) => {
          try { 
            console.log(`[AuthSync] Fetching thread summary for ${tid}...`);
            const result = await getThreadSummary(tid);
            console.log(`[AuthSync] Successfully fetched thread ${tid}, has ${result.messages.length} messages, labels: ${result.thread.labelIds.join(',')}`);
            return result;
          } catch (e) { 
            console.error(`[AuthSync] Failed to fetch thread ${tid}:`, e);
            return null; 
          }
        });
        
        console.log(`[AuthSync] Successfully fetched ${fetched.filter(f => !!f).length} out of ${toFetch.length} threads`);
        
        // Store fetched threads and messages with fresh transactions
        let storedThreads = 0;
        let storedMessages = 0;
        
        if (fetched.some(f => !!f)) {
          console.log(`[AuthSync] Creating fresh transactions for database storage...`);
          const txMsgs = db.transaction('messages', 'readwrite');
          const txThreads = db.transaction('threads', 'readwrite');
          
          for (const f of fetched) {
            if (!f) continue;
            try {
              for (const m of f.messages) {
                try { 
                  await txMsgs.store.put(m); 
                  storedMessages++;
                } catch (e) {
                  console.error(`[AuthSync] Failed to store message ${m.id}:`, e);
                }
              }
              try {
                // TERMINAL LABEL RULE: Don't store threads with TRASH/SPAM in INBOX sync
                const threadLabels = new Set<string>(f.thread.labelIds || []);
                if (threadLabels.has('TRASH') || threadLabels.has('SPAM')) {
                  console.log(`[AuthSync] Skipping thread ${f.thread.threadId} storage - has terminal label (TRASH/SPAM)`);
                  continue;
                }
                
                // Check for pending operations before storing thread
                // Check pending ops with retries to avoid transient IDB errors
                const pendingOps = await getPendingOpsWithRetry(db, f.thread.threadId, 3);
                // For NEW threads from Gmail, null or empty means "no ops found" which is normal
                // Only skip if we found actual pending ops that affect INBOX
                const hasPendingLabelChanges = pendingOps && pendingOps.length > 0 && pendingOps.some((op: any) => op.op?.type === 'batchModify' && ((op.op.addLabelIds || []).includes('INBOX') || (op.op.removeLabelIds || []).includes('INBOX')));
                if (hasPendingLabelChanges) {
                  console.log(`[AuthSync] Skipping thread ${f.thread.threadId} storage - has ${pendingOps?.length || 0} pending INBOX operations`);
                } else {
                  await txThreads.store.put(f.thread);
                  storedThreads++;
                  console.log(`[AuthSync] Stored thread ${f.thread.threadId} with labels: ${f.thread.labelIds.join(',')}`);
                }
              } catch (e) {
                console.error(`[AuthSync] Failed to store thread ${f.thread.threadId}:`, e);
              }
            } catch (e) {
              console.error(`[AuthSync] Failed to process fetched thread:`, e);
            }
          }
          
          try {
            await txMsgs.done;
            await txThreads.done;
            console.log(`[AuthSync] Transactions completed successfully`);
          } catch (e) {
            console.error(`[AuthSync] Transaction completion failed:`, e);
          }
        }
        
        console.log(`[AuthSync] Database storage complete: ${storedThreads} threads, ${storedMessages} messages stored`);
        if (!pageToken) break;
      }

      // Reconcile threads in DB:
      // 1) Ensure all seen threads are present locally with correct INBOX label
      // 2) Remove INBOX label from threads not seen
      console.log(`[AuthSync] ===== STARTING RECONCILIATION PHASE =====`);
      console.log(`[AuthSync] Reconciliation: ${seenThreadIds.size} threads seen from Gmail`);
      // Fallback enrichment: also enumerate threads.list for INBOX and union results.
      // This ensures we don't miss brand-new threads that message-level paging might skip.
      try {
        const { listThreadIdsByLabelId } = await import('$lib/gmail/api');
        let fallbackToken: string | undefined = undefined;
        let added = 0;
        let pages = 0;
        const MAX_FALLBACK_PAGES = 10; // safety to avoid runaway in pathological cases
        while (pages < MAX_FALLBACK_PAGES) {
          const page = await listThreadIdsByLabelId('INBOX', 500, fallbackToken);
          pages += 1;
          const ids = page?.ids || [];
          for (const tid of ids) {
            if (!seenThreadIds.has(tid)) { seenThreadIds.add(tid); added += 1; }
          }
          if (!page?.nextPageToken) break;
          fallbackToken = page.nextPageToken;
        }
        console.log(`[AuthSync] Fallback threads.list union: +${added} ids across ${pages} pages. Seen now ${seenThreadIds.size}`);
      } catch (e) {
        console.warn('[AuthSync] Fallback threads.list enumeration failed:', e);
      }
      
      // Pass 1: fetch any missing seen threads and ensure INBOX label is present
      console.log(`[AuthSync] Phase 1: Ensuring all seen threads have INBOX label...`);
      try {
        const toFetch: string[] = [];
        const toUpdateLabelsOnly: Array<{threadId: string, existing: any}> = [];
        
        for (const tid of seenThreadIds) {
          try {
            const existing = await db.get('threads', tid) as any | undefined;
            // Determine if there are pending ops that would conflict with label updates
            // CHECK BOTH ops queue AND journal (for recently completed operations that haven't cleared yet)
            let hasPendingInboxRemoval = false;
            let hasPendingLabelChanges = false;
            try {
              // Check ops queue
              const pendingOps = await db.getAllFromIndex('ops', 'by_scopeKey', tid);
              for (const op of pendingOps) {
                if (op.op?.type === 'batchModify') {
                  if (op.op.removeLabelIds?.includes('INBOX')) {
                    hasPendingInboxRemoval = true;
                  }
                  if (op.op.addLabelIds?.includes('INBOX') || op.op.removeLabelIds?.includes('INBOX')) {
                    hasPendingLabelChanges = true;
                  }
                }
              }
              
              // Also check journal for VERY recent user actions (even if op completed)
              // Use 30-second window for Phase 1 to allow new emails to appear quickly
              // This protects immediate user actions while not blocking fresh data
              if (!hasPendingInboxRemoval || !hasPendingLabelChanges) {
                const recentCutoff = Date.now() - (30 * 1000); // 30 seconds for Phase 1
                const journalAll = await db.getAll('journal');
                let recentJournalCount = 0;
                for (const e of journalAll as any[]) {
                  if (!e || e.threadId !== tid || !e.intent) continue;
                  if (!e.createdAt || e.createdAt < recentCutoff) continue; // Skip old or missing timestamp
                  recentJournalCount++;
                  const rem = Array.isArray(e.intent.removeLabelIds) ? e.intent.removeLabelIds : [];
                  if (rem.includes('INBOX')) {
                    hasPendingInboxRemoval = true;
                    hasPendingLabelChanges = true;
                    console.log(`[AuthSync] Thread ${tid}: Found recent INBOX removal in journal (age: ${Math.round((Date.now() - e.createdAt) / 1000)}s)`);
                  }
                }
                if (recentJournalCount > 0) {
                  console.log(`[AuthSync] Thread ${tid}: ${recentJournalCount} journal entries from last 30s - protecting from Phase 1`);
                }
              }
            } catch (err) {
              // If lookup fails for a NEW thread (doesn't exist), still fetch it
              // Only be conservative for EXISTING threads
              console.warn(`[AuthSync] Thread ${tid}: Error checking ops/journal - ${err}`);
              if (!existing) {
                console.log(`[AuthSync] Thread ${tid}: Error during check but thread is NEW - will fetch anyway`);
                // Don't set flags - let it be fetched below
              } else {
                // For existing threads, be CONSERVATIVE: assume there ARE pending changes to avoid undoing user actions
                hasPendingLabelChanges = true;
                hasPendingInboxRemoval = true;
                console.log(`[AuthSync] Thread ${tid}: Error during check for EXISTING thread - assuming pending changes`);
              }
            }

            if (!existing) {
              console.log(`[AuthSync] Thread ${tid} missing from database, will fetch`);
              toFetch.push(tid);
            } else if (!Array.isArray(existing.labelIds) || !existing.labelIds.includes('INBOX')) {
              // TERMINAL LABEL RULE: Never add INBOX if thread has TRASH or SPAM
              const hasTerminalLabel = existing.labelIds?.includes('TRASH') || existing.labelIds?.includes('SPAM');
              if (hasTerminalLabel) {
                console.log(`[AuthSync] Thread ${tid} has terminal label (TRASH/SPAM) - NEVER adding INBOX back`);
              } else if (hasPendingInboxRemoval) {
                console.log(`[AuthSync] Thread ${tid} exists but has pending INBOX removal; SKIPPING to preserve user edit`);
                // Don't re-add INBOX if user just removed it
              } else if (hasPendingLabelChanges) {
                console.log(`[AuthSync] Thread ${tid} exists but has pending ops; skipping label update`);
                // skip quick update for other pending changes
              } else {
                console.log(`[AuthSync] Thread ${tid} exists but missing INBOX label, current labels: ${existing.labelIds?.join(',') || 'none'}`);
                toUpdateLabelsOnly.push({threadId: tid, existing});
              }
            }
          } catch (e) {
            console.error(`[AuthSync] Error checking thread ${tid}:`, e);
            toFetch.push(tid);
          }
        }
        
        console.log(`[AuthSync] Phase 1a: Need to fetch ${toFetch.length} missing threads`);
        console.log(`[AuthSync] Phase 1b: Need to add INBOX label to ${toUpdateLabelsOnly.length} existing threads`);
        
        // Phase 1a: Update existing threads with INBOX label (fast path)
        if (toUpdateLabelsOnly.length > 0) {
          console.log(`[AuthSync] Phase 1a: Adding INBOX labels to existing threads (batched)...`);
          const txThreadsUpdate = db.transaction('threads', 'readwrite');
          const putPromises: Array<Promise<any>> = [];
          let quickUpdates = 0;

          for (const {threadId, existing} of toUpdateLabelsOnly) {
            try {
              const labels = new Set<string>(existing.labelIds || []);
              // TERMINAL LABEL RULE: Never add INBOX if TRASH or SPAM present
              if (labels.has('TRASH') || labels.has('SPAM')) {
                console.log(`[AuthSync] Phase 1a: Skipping INBOX add for thread ${threadId} - has terminal label (TRASH/SPAM)`);
                continue;
              }
              labels.add('INBOX');
              const updatedThread = { ...existing, labelIds: Array.from(labels) } as any;
              // queue puts without awaiting to keep transaction alive
              putPromises.push(txThreadsUpdate.store.put(updatedThread));
              quickUpdates++;
              console.log(`[AuthSync] Phase 1a: Queued INBOX add for thread ${threadId}, labels: ${Array.from(labels).join(',')}`);
            } catch (e) {
              console.error(`[AuthSync] Phase 1a: Failed to prepare update for thread ${threadId}:`, e);
            }
          }

          try {
            await Promise.all(putPromises);
            await txThreadsUpdate.done;
            console.log(`[AuthSync] Phase 1a: Quick INBOX label updates completed: ${quickUpdates} threads`);
          } catch (e) {
            console.error(`[AuthSync] Phase 1a: Transaction completion failed:`, e);
          }
        }
        
        // Phase 1b: Fetch completely missing threads
        if (toFetch.length) {
          console.log(`[AuthSync] Phase 1b: Fetching ${toFetch.length} missing threads from Gmail...`);
          const fetched = await mapWithConcurrency(toFetch, 4, async (tid) => {
            try { 
              const result = await getThreadSummary(tid);
              console.log(`[AuthSync] Phase 1b: Fetched ${tid}, original labels: ${result.thread.labelIds.join(',')}`);
              return result;
            } catch (e) {
              console.error(`[AuthSync] Phase 1b: Failed to fetch ${tid}:`, e);
              return null;
            }
          });
          
          console.log(`[AuthSync] Phase 1b: Successfully fetched ${fetched.filter(f => !!f).length} missing threads`);
          
          let newThreadsStored = 0;
          
          if (fetched.some(f => !!f)) {
          console.log(`[AuthSync] Phase 1b: Creating fresh transactions for storing missing threads (per-thread transactions)...`);
            let newThreadsStored = 0;
            for (const f of fetched) {
              if (!f) continue;
              try {
                // Check pending ops with retry to avoid transient IDB errors
                const pendingOps = await getPendingOpsWithRetry(db, f.thread.threadId, 3);
                // For NEW threads from Gmail, null means "no ops found" which is expected
                // Only skip if we found ops that affect INBOX
                if (pendingOps !== null && pendingOps.length > 0) {
                  const hasPendingLabelChanges = pendingOps.some((op: any) => op.op?.type === 'batchModify' && ((op.op.addLabelIds || []).includes('INBOX') || (op.op.removeLabelIds || []).includes('INBOX')));
                  if (hasPendingLabelChanges) {
                    console.log(`[AuthSync] Phase 1b: Skipping new thread ${f.thread.threadId} - has ${pendingOps.length} pending label operations`);
                    continue;
                  }
                }
                // If pendingOps is null or empty, proceed - no conflicts for this new thread

                // TERMINAL LABEL RULE: Never add INBOX if thread has TRASH or SPAM
                const labels = new Set<string>(f.thread.labelIds || []);
                const hasTerminalLabel = labels.has('TRASH') || labels.has('SPAM');
                if (hasTerminalLabel) {
                  console.log(`[AuthSync] Phase 1b: Skipping new thread ${f.thread.threadId} - has terminal label (TRASH/SPAM), not adding to INBOX`);
                  continue;
                }

                // Per-thread short transaction
                const tx = db.transaction(['messages', 'threads'], 'readwrite');
                const msgsStore = tx.objectStore('messages');
                const threadsStoreDb = tx.objectStore('threads');
                for (const m of f.messages) {
                  try { msgsStore.put(m); } catch (e) { console.error(`[AuthSync] Phase 1b: Failed to store message ${m.id}:`, e); }
                }
                labels.add('INBOX');
                const threadWithInbox = { ...f.thread, labelIds: Array.from(labels) } as any;
                try { threadsStoreDb.put(threadWithInbox); newThreadsStored++; } catch (e) { console.error(`[AuthSync] Phase 1b: Failed to store thread ${f.thread.threadId}:`, e); }
                await new Promise((res) => { tx.oncomplete = () => res(undefined); tx.onerror = () => res(undefined); tx.onabort = () => res(undefined); });
                console.log(`[AuthSync] Phase 1b: Stored new thread ${f.thread.threadId} with INBOX label, labels: ${Array.from(labels).join(',')}`);

              } catch (e) {
                console.error(`[AuthSync] Phase 1b: Failed to process thread ${f?.thread?.threadId || '<unknown>'}:`, e);
              }
            }
            console.log(`[AuthSync] Phase 1b: Missing threads storage completed: ${newThreadsStored} new threads stored`);
          }
          
          console.log(`[AuthSync] Phase 1b: Stored ${newThreadsStored} new threads with INBOX labels`);
        } else {
          console.log(`[AuthSync] Phase 1b: No missing threads to fetch`);
        }
      } catch (e) {
        console.error(`[AuthSync] Phase 1 failed:`, e);
      }

      console.log(`[AuthSync] Phase 2: Removing INBOX label from threads not seen in Gmail...`);
      // Read all threads and ops once to avoid per-iteration async calls that can
      // prematurely finish transactions. We'll compute updates in-memory and
      // then write them in a single short-lived transaction.
      const allThreads = await db.getAll('threads');
      let threadsUpdated = 0;

      console.log(`[AuthSync] Phase 2: Checking ${allThreads.length} local threads for stale INBOX labels`);

      // Prefetch all pending ops and group by scopeKey to avoid repeated index lookups
      let opsByScope: Record<string, any[]> = {};
      try {
        const allOps = await db.getAll('ops');
        for (const op of (allOps || [])) {
          try {
            const anyOp = op as any;
            const key = anyOp.scopeKey || (anyOp.op && anyOp.op.threadId) || '';
            if (!key) continue;
            opsByScope[key] = opsByScope[key] || [];
            opsByScope[key].push(op);
          } catch (_) {}
        }
      } catch (_) {
        opsByScope = {};
      }

      // Also prefetch journal entries to check for recent user actions  
      // Use 2-minute window for Phase 2 - more conservative than Phase 1 but not too long
      let journalByThread: Record<string, any[]> = {};
      try {
        const recentCutoff = Date.now() - (2 * 60 * 1000); // 2 minutes for Phase 2
        const allJournal = await db.getAll('journal');
        for (const entry of (allJournal || [])) {
          try {
            const e = entry as any;
            if (!e || !e.threadId) continue;
            if (e.createdAt && e.createdAt < recentCutoff) continue; // Skip old entries
            journalByThread[e.threadId] = journalByThread[e.threadId] || [];
            journalByThread[e.threadId].push(e);
          } catch (_) {}
        }
      } catch (_) {
        journalByThread = {};
      }

      const updates: any[] = [];
      for (const t of (allThreads || [])) {
        try {
          const labels = Array.isArray(t.labelIds) ? t.labelIds.slice() : [];
          if (labels.includes('INBOX') && !seenThreadIds.has(t.threadId)) {
            // TERMINAL LABEL RULE: Never modify threads with TRASH or SPAM
            // These should stay in their terminal state regardless of Gmail's INBOX state
            const hasTerminalLabel = labels.includes('TRASH') || labels.includes('SPAM');
            if (hasTerminalLabel) {
              console.log(`[AuthSync] Phase 2: Skipping thread ${t.threadId} - has terminal label (TRASH/SPAM), preserving as-is`);
              continue;
            }
            
            const pendingOps = opsByScope[t.threadId] || [];
            // Check if there are any pending operations that affect INBOX label
            const hasPendingInboxOps = pendingOps.some((op: any) => 
              op.op?.type === 'batchModify' && 
              (op.op.addLabelIds?.includes('INBOX') || op.op.removeLabelIds?.includes('INBOX'))
            );
            if (hasPendingInboxOps) {
              console.log(`[AuthSync] Phase 2: Skipping INBOX removal from thread ${t.threadId} - has pending INBOX operations`);
              continue;
            }
            // Also check if there are ANY pending operations as a safety measure
            if (pendingOps.length > 0) {
              console.log(`[AuthSync] Phase 2: Skipping INBOX removal from thread ${t.threadId} - has pending operations (${pendingOps.length})`);
              continue;
            }
            
            // Check journal for recent user actions that added INBOX back
            const journalEntries = journalByThread[t.threadId] || [];
            const hasJournalInboxAddition = journalEntries.some((e: any) => {
              const add = Array.isArray(e.intent?.addLabelIds) ? e.intent.addLabelIds : [];
              return add.includes('INBOX');
            });
            if (hasJournalInboxAddition) {
              console.log(`[AuthSync] Phase 2: Skipping INBOX removal from thread ${t.threadId} - journal shows user added INBOX back`);
              continue;
            }
            const next = { ...t, labelIds: labels.filter((l) => l !== 'INBOX') } as any;
            updates.push(next);
            threadsUpdated++;
            console.log(`[AuthSync] Phase 2: Scheduled INBOX removal for thread: ${t.threadId}`);
          }
        } catch (e) {
          console.error(`[AuthSync] Phase 2: Error processing thread ${t.threadId}:`, e);
        }
      }

      if (updates.length > 0) {
        try {
          console.log(`[AuthSync] Phase 2: Removing INBOX from ${updates.length} threads not seen in Gmail:`);
          updates.slice(0, 5).forEach((u: any) => console.log(`[AuthSync] Phase 2:   - ${u.threadId} (labels: ${u.labelIds?.join(',') || 'none'})`));
          if (updates.length > 5) console.log(`[AuthSync] Phase 2:   - ... and ${updates.length - 5} more`);
          
          const txThreadsPut = db.transaction('threads', 'readwrite');
          for (const u of updates) {
            try { txThreadsPut.store.put(u); } catch (e) { console.error('[AuthSync] Phase 2: put failed for thread', u.threadId, e); }
          }
          await txThreadsPut.done;
          console.log(`[AuthSync] Phase 2: Reconciliation complete - removed INBOX from ${threadsUpdated} stale threads`);
        } catch (e) {
          console.error(`[AuthSync] Phase 2: Transaction completion failed:`, e);
        }
      } else {
        console.log(`[AuthSync] Phase 2: Reconciliation complete - removed INBOX from ${threadsUpdated} stale threads (no updates needed)`);
      }

      // Phase 3: Update ALL labels for existing INBOX threads to fix stale label issues
      // This ensures that threads with outdated labels (not just INBOX) are refreshed from Gmail
      console.log(`[AuthSync] Phase 3: Updating all labels for existing INBOX threads to fix stale labels...`);
      try {
        const allThreads = await db.getAll('threads');
        const inboxThreads = allThreads.filter((t: any) => 
          Array.isArray(t.labelIds) && t.labelIds.includes('INBOX') && seenThreadIds.has(t.threadId)
        );
        
        console.log(`[AuthSync] Phase 3: Found ${inboxThreads.length} INBOX threads to check for stale labels`);
        
        // Prefetch all pending ops and journal entries to avoid repeated lookups
        let opsByScope: Record<string, any[]> = {};
        try {
          const allOps = await db.getAll('ops');
          for (const op of (allOps || [])) {
            try {
              const anyOp = op as any;
              const key = anyOp.scopeKey || (anyOp.op && anyOp.op.threadId) || '';
              if (!key) continue;
              opsByScope[key] = opsByScope[key] || [];
              opsByScope[key].push(op);
            } catch (_) {}
          }
        } catch (_) {
          opsByScope = {};
        }
        
        let journalByThread: Record<string, any[]> = {};
        try {
          const recentCutoff = Date.now() - (5 * 60 * 1000);
          const allJournal = await db.getAll('journal');
          for (const entry of (allJournal || [])) {
            try {
              const e = entry as any;
              if (!e || !e.threadId) continue;
              if (e.createdAt && e.createdAt < recentCutoff) continue;
              journalByThread[e.threadId] = journalByThread[e.threadId] || [];
              journalByThread[e.threadId].push(e);
            } catch (_) {}
          }
        } catch (_) {
          journalByThread = {};
        }
        
        // Identify threads that need label refresh (no pending ops, no recent actions)
        const threadsToRefresh: any[] = [];
        for (const t of inboxThreads) {
          try {
            // Check for pending label operations
            const pendingOps = opsByScope[t.threadId] || [];
            const hasPendingLabelOps = pendingOps.some((op: any) => 
              op.op?.type === 'batchModify' && 
              (op.op.addLabelIds?.length > 0 || op.op.removeLabelIds?.length > 0)
            );
            
            if (hasPendingLabelOps) {
              continue; // Skip threads with pending operations
            }
            
            // Check for recent user actions
            const journalEntries = journalByThread[t.threadId] || [];
            const hasRecentLabelChange = journalEntries.some((e: any) => {
              const hasLabelChange = (e.intent?.addLabelIds?.length > 0) || (e.intent?.removeLabelIds?.length > 0);
              return hasLabelChange;
            });
            
            if (hasRecentLabelChange) {
              continue; // Skip threads with recent user actions
            }
            
            // This thread is safe to refresh
            threadsToRefresh.push(t);
          } catch (e) {
            console.error(`[AuthSync] Phase 3: Error checking thread ${t.threadId}:`, e);
          }
        }
        
        console.log(`[AuthSync] Phase 3: ${threadsToRefresh.length} threads safe to refresh (no pending ops or recent actions)`);
        
        // Fetch fresh labels from Gmail for these threads in batches
        // Use smaller batches to avoid overwhelming the API
        const batchSize = 10;
        let totalRefreshed = 0;
        
        for (let i = 0; i < threadsToRefresh.length; i += batchSize) {
          const batch = threadsToRefresh.slice(i, i + batchSize);
          console.log(`[AuthSync] Phase 3: Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(threadsToRefresh.length / batchSize)}...`);
          
          const refreshed = await mapWithConcurrency(batch, 4, async (t: any) => {
            try {
              const freshThread = await getThreadSummary(t.threadId);
              return { threadId: t.threadId, existing: t, fresh: freshThread.thread };
            } catch (e) {
              console.warn(`[AuthSync] Phase 3: Failed to fetch ${t.threadId}:`, e);
              return null;
            }
          });
          
          // Update threads with fresh labels
          const tx = db.transaction('threads', 'readwrite');
          for (const item of refreshed) {
            if (!item) continue;
            try {
              const updatedThread = {
                ...item.existing,
                labelIds: item.fresh.labelIds,
                messageIds: item.fresh.messageIds
              };
              await tx.store.put(updatedThread);
              totalRefreshed++;
              
              // Log if labels actually changed
              const oldLabels = (item.existing.labelIds || []).sort().join(',');
              const newLabels = (item.fresh.labelIds || []).sort().join(',');
              if (oldLabels !== newLabels) {
                console.log(`[AuthSync] Phase 3: Updated ${item.threadId}: ${oldLabels} → ${newLabels}`);
              }
            } catch (e) {
              console.error(`[AuthSync] Phase 3: Failed to update ${item.threadId}:`, e);
            }
          }
          
          try {
            await tx.done;
          } catch (e) {
            console.error(`[AuthSync] Phase 3: Transaction failed for batch:`, e);
          }
        }
        
        console.log(`[AuthSync] Phase 3: Label refresh complete - updated ${totalRefreshed} threads`);
      } catch (e) {
        console.error(`[AuthSync] Phase 3 failed:`, e);
      }

      authoritativeSyncProgress = { ...authoritativeSyncProgress, running: false };

      // Clear trailing holds to prevent stale display after authoritative sync
      try {
        const { trailingHolds } = await import('$lib/stores/holds');
        trailingHolds.set({});
      } catch (_) {}

      // Refresh in-memory store from authoritative DB state
      try {
        const refreshed = await db.getAll('threads');
        const { setThreadsWithReset } = await import('$lib/stores/optimistic-counters');
        setThreadsWithReset(refreshed as any);
      } catch (_) {}
      
      // Final verification and summary
      console.log(`[AuthSync] ===== FINAL VERIFICATION =====`);
      const finalThreads = await db.getAll('threads');
      const finalInboxThreads = finalThreads.filter((t: any) => 
        Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
      );
      
      console.log(`[AuthSync] FINAL STATE: ${finalThreads.length} total threads, ${finalInboxThreads.length} with INBOX label`);
      console.log(`[AuthSync] SYNC SUMMARY:`);
      console.log(`[AuthSync]   - Pages processed: ${authoritativeSyncProgress.pagesCompleted}`);
      console.log(`[AuthSync]   - Total pages attempted: ${totalPagesAttempted}`);
      console.log(`[AuthSync]   - Threads seen from Gmail: ${seenThreadIds.size}`);
      console.log(`[AuthSync]   - Threads processed: ${totalThreadsProcessed}`);
      console.log(`[AuthSync]   - Final inbox threads: ${finalInboxThreads.length}`);
      console.log(`[AuthSync]   - Stale threads cleaned: ${threadsUpdated}`);
      console.log(`[AuthSync]   - Change: ${finalInboxThreads.length - preSyncInboxThreads.length} net threads (${preSyncInboxThreads.length} → ${finalInboxThreads.length})`);
      
      // Compare with Gmail
      try {
        const inboxLabel = await getLabel('INBOX');
        const gmailTotal = inboxLabel.threadsTotal || 0;
        const localTotal = finalInboxThreads.length;
        const discrepancy = gmailTotal - localTotal;
        console.log(`[AuthSync] Gmail vs Local: ${gmailTotal} (Gmail) vs ${localTotal} (Local) = ${discrepancy > 0 ? '+' : ''}${discrepancy} discrepancy`);
        if (discrepancy > 0) {
          console.warn(`[AuthSync] ⚠️ Still missing ${discrepancy} threads from Gmail!`);
        } else if (discrepancy < 0) {
          console.warn(`[AuthSync] ⚠️ Local has ${Math.abs(discrepancy)} more threads than Gmail reports!`);
        } else {
          console.log(`[AuthSync] ✅ Counts match!`);
        }
      } catch (e) {
        console.warn(`[AuthSync] Could not compare with Gmail counts:`, e);
      }
      
      if (finalInboxThreads.length === 0 && seenThreadIds.size > 0) {
        console.error(`[AuthSync] CRITICAL ERROR: Sync completed but 0 inbox threads despite seeing ${seenThreadIds.size} from Gmail!`);
      } else if (finalInboxThreads.length > 0) {
        console.log(`[AuthSync] SUCCESS: Sync resulted in ${finalInboxThreads.length} inbox threads`);
      }
      
      console.log(`[AuthSync] ===== AUTHORITATIVE SYNC COMPLETE =====`);
      // EXTRA STEP: authoritative prune using message-level INBOX membership
      try {
        console.log('[AuthSync] Running authoritative prune using message-level INBOX membership...');
        const authoritativeInboxThreadIds = new Set<string>();
        let msgPageToken: string | undefined = undefined;
        const msgPageSize = 200;
        // enumerate all INBOX messages and extract threadIds
        while (true) {
          const msgPage = await listInboxMessageIds(msgPageSize, msgPageToken);
          const msgIds = msgPage.ids || [];
          if (msgIds.length) {
            const msgs = await mapWithConcurrency(msgIds, 6, async (id: string) => {
              try { const m = await getMessageMetadata(id); return m; } catch (_) { return null; }
            });
            for (const m of msgs) if (m && m.threadId) authoritativeInboxThreadIds.add(m.threadId);
          }
          if (!msgPage.nextPageToken) break;
          msgPageToken = msgPage.nextPageToken;
        }

        // Now remove INBOX label from any local thread not in authoritative set
        const allLocal = await db.getAll('threads');
        const removals: any[] = [];
        for (const t of (allLocal || [])) {
          try {
            const labels = Array.isArray(t.labelIds) ? t.labelIds.slice() : [];
            if (labels.includes('INBOX') && !authoritativeInboxThreadIds.has(t.threadId)) {
              // skip if pending ops exist
              const pendingOps = await db.getAllFromIndex('ops', 'by_scopeKey', t.threadId).catch(() => []);
              if ((pendingOps || []).length > 0) {
                console.log(`[AuthSync] Prune: skipping ${t.threadId} due to pending ops`);
                continue;
              }
              const next = { ...t, labelIds: labels.filter((l) => l !== 'INBOX') } as any;
              removals.push(next);
            }
          } catch (e) {
            console.error('[AuthSync] Prune: error checking thread', t.threadId, e);
          }
        }
        if (removals.length) {
          const tx = db.transaction('threads', 'readwrite');
          for (const u of removals) {
            try { tx.store.put(u); } catch (e) { console.error('[AuthSync] Prune: put failed', u.threadId, e); }
          }
          await tx.done;
          console.log(`[AuthSync] Prune: removed INBOX from ${removals.length} local threads`);
        } else {
          console.log('[AuthSync] Prune: no local INBOX removals necessary');
        }
      } catch (e) {
        console.error('[AuthSync] Authoritative prune failed:', e);
      }
    } catch (e) {
      // Surface a subtle telemetry snackbar so user can retry if needed
      try { showSnackbar({ message: 'Full sync failed', timeout: 5000, actions: { 'Retry': () => { void performAuthoritativeInboxSync(); } } }); } catch (_) {}
      throw e;
    }
  }

  // Periodic sync integrity verification to catch and fix drift
  async function verifySyncIntegrity() {
    try {
      const db = await getDB();
      const localThreads = await db.getAll('threads');
      const localInboxThreads = localThreads.filter((t: any) => 
        Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
      );
      
      // Check Gmail's reported inbox count
      const inboxLabel = await getLabel('INBOX');
      const gmailThreadCount = inboxLabel.threadsTotal || 0;
      const localThreadCount = localInboxThreads.length;
      
      if (import.meta.env.DEV) {
        console.log(`[SyncVerify] Integrity check: Gmail=${gmailThreadCount}, Local=${localThreadCount}`);
      }
      
      // If there's a significant discrepancy, trigger background sync
      if (localThreadCount === 0 || Math.abs(gmailThreadCount - localThreadCount) > 3) {
        console.log(`[SyncVerify] Integrity issue detected, triggering background resync`);
        
        // Don't run if already syncing
        if (backgroundSyncing || syncing) return;
        
        void (async () => {
          try {
            backgroundSyncing = true;
            await performAuthoritativeInboxSync({ 
              perPageTimeoutMs: 15000, 
              maxRetries: 2 
            });
            console.log(`[SyncVerify] Integrity fix completed`);
          } catch (e) {
            console.warn(`[SyncVerify] Integrity fix failed:`, e);
          } finally {
            backgroundSyncing = false;
          }
        })();
      }
    } catch (e) {
      if (import.meta.env.DEV) {
        console.warn('[SyncVerify] Integrity check failed:', e);
      }
    }
  }

  async function signIn() {
    apiErrorMessage = null;
    apiErrorStatus = undefined;
    try {
      if (!ready) {
        CLIENT_ID = CLIENT_ID || resolveGoogleClientId() as string;
        try { await initAuth(CLIENT_ID); } catch (_) {}
      }
      try {
        await acquireTokenInteractive('consent', 'inbox_signin_click');
        await hydrate();
      } catch (e: unknown) {
        // If auth is intentionally server-managed, fall back to server-side login flow
        const msg = e instanceof Error ? e.message : String(e);
        if (typeof msg === 'string' && msg.includes('Auth not initialized')) {
          try {
            // Redirect to server login endpoint to establish server-managed session
            const loginUrl = typeof window !== 'undefined' ? new URL('/api/google-login', window.location.href).toString() : '/api/google-login';
            window.location.href = loginUrl;
            return;
          } catch (_) {}
        }
        throw e;
      }
    } catch (e: unknown) {
      setApiError(e);
      try {
        const diag = getAuthDiagnostics();
        void copyDiagnostics();
        // eslint-disable-next-line no-console
        console.error('[Auth] Sign-in failed in inbox', { error: e instanceof Error ? e.message : String(e), diag });
      } catch (_) {}
    }
  }

  async function hydrateFromCache() {
    const db = await getDB();
    let hasCached = false;
    const cachedLabels = await db.getAll('labels');
    if (cachedLabels?.length) { labelsStore.set(cachedLabels); hasCached = true; }
    const cachedThreads = await db.getAll('threads');
    if (cachedThreads?.length) {
      const current = $threadsStore || [];
      if (current.length === 0) {
        threadsStore.set(cachedThreads);
      } else {
        // Build a map of threads with pending operations to preserve their optimistic state
        const hasPendingOps = new Set<string>();
        try {
          const allOps = await db.getAll('ops');
          for (const op of allOps) {
            if (op.scopeKey) hasPendingOps.add(op.scopeKey);
          }
        } catch (_) {}
        
        const merged = [...current, ...cachedThreads].reduce((acc, t) => {
          const idx = acc.findIndex((candidate: any) => candidate.threadId === t.threadId);
          if (idx >= 0) {
            const existingThread = acc[idx];
            // If this thread has pending operations, preserve its current state (optimistic updates)
            if (hasPendingOps.has(t.threadId)) {
              // Keep the existing thread with optimistic changes, but update non-label fields from DB
              acc[idx] = { ...t, labelIds: existingThread.labelIds };
            } else {
              // No pending ops, safe to use DB version
              acc[idx] = t;
            }
          } else {
            acc.push(t);
          }
          return acc;
        }, [] as typeof current);
        const { setThreadsWithReset } = await import('$lib/stores/optimistic-counters');
        setThreadsWithReset(merged);
      }
      hasCached = true;
    }
    const cachedMessages = await db.getAll('messages');
    if (cachedMessages?.length) {
      const dict: Record<string, import('$lib/types').GmailMessage> = { ...$messagesStore };
      for (const m of cachedMessages) dict[m.id] = m;
      messagesStore.set(dict);
      hasCached = true;
    }
    return hasCached;
  }

  async function hydrate() {
    const db = await getDB();
    // Labels
    const remoteLabels = await listLabels();
    const tx = db.transaction('labels', 'readwrite');
    for (const l of remoteLabels) await tx.store.put(l);
    await tx.done;
    labelsStore.set(remoteLabels);
    
    // Notify session manager that Gmail API is working
    try {
      const { sessionManager } = await import('$lib/auth/session-manager');
      sessionManager.applyServerSession();
    } catch (_) {}

    // Messages + Threads (first N) and label stats for accurate counts
    // Attempt profile ping to capture the latest historyId for incremental syncs
    try {
      const profile = await getProfile();
      try { if (profile?.historyId) await db.put('settings', profile.historyId, 'lastHistoryId'); } catch (_) {}
    } catch (_) {}
    // Fetch INBOX label metadata for totals
    try {
      const inboxLabel = await getLabel('INBOX');
      inboxLabelStats = {
        messagesTotal: inboxLabel.messagesTotal,
        messagesUnread: inboxLabel.messagesUnread,
        threadsTotal: inboxLabel.threadsTotal,
        threadsUnread: inboxLabel.threadsUnread
      };
    } catch (_) {
      inboxLabelStats = null;
    }
    const pageSize = Number($settings.inboxPageSize || 25);
    const page = await listInboxMessageIds(pageSize);
    nextPageToken = page.nextPageToken;
    const msgs = await mapWithConcurrency(page.ids, 4, (id) => getMessageMetadata(id));
    const threadMap: Record<string, { messageIds: string[]; labelIds: Record<string, true>; last: { from?: string; subject?: string; date?: number } }> = {};
    for (const m of msgs) {
      const existing = threadMap[m.threadId] || { messageIds: [], labelIds: {}, last: {} };
      existing.messageIds.push(m.id);
      for (const x of m.labelIds) existing.labelIds[x] = true;
      const date = m.internalDate || Date.parse(m.headers?.Date || '');
      if (!existing.last.date || (date && date > existing.last.date)) {
        existing.last = { from: m.headers?.From, subject: m.headers?.Subject, date };
      }
      threadMap[m.threadId] = existing;
    }
    // Build thread list preserving any cached AI/computed fields
    const dbThreads = await (await getDB());
    const threadList = [] as Array<import('$lib/types').GmailThread>;
    const newlyArrived: Array<import('$lib/types').GmailThread> = [];
    for (const [threadId, v] of Object.entries(threadMap)) {
      const base = { threadId, messageIds: v.messageIds, lastMsgMeta: v.last, labelIds: Object.keys(v.labelIds) } as import('$lib/types').GmailThread;
      try {
        const prev = await dbThreads.get('threads', threadId) as import('$lib/types').GmailThread | undefined;
        if (prev) {
          const lastPrevId = (prev.messageIds || [])[Math.max(0, (prev.messageIds || []).length - 1)];
          const lastNewId = base.messageIds[Math.max(0, base.messageIds.length - 1)];
          const prevUpdatedAt = (prev as any).aiSubjectUpdatedAt || 0;
          const newDate = base.lastMsgMeta?.date || 0;
          const changed = (!!lastPrevId && !!lastNewId && lastPrevId !== lastNewId) || (newDate > prevUpdatedAt);
          
          // Check if the local thread has been optimistically modified (e.g., archived/deleted)
          const localHasInbox = Array.isArray(prev.labelIds) && prev.labelIds.includes('INBOX');
          const serverHasInbox = Array.isArray(base.labelIds) && base.labelIds.includes('INBOX');
          const wasOptimisticallyModified = !localHasInbox && serverHasInbox;
          
          // Also check for pending operations that would affect labels
          let hasPendingLabelOps = false;
          try {
            const pendingOps = await db.getAllFromIndex('ops', 'by_scopeKey', threadId);
            hasPendingLabelOps = pendingOps.some((op: any) => 
              op.op?.type === 'batchModify' && 
              (op.op.addLabelIds?.length > 0 || op.op.removeLabelIds?.length > 0)
            );
          } catch (_) {
            // If we can't check pending ops, assume no pending ops
            hasPendingLabelOps = false;
          }
          
          const carry: import('$lib/types').GmailThread = {
            ...base,
            // Preserve local labelIds if they were optimistically modified OR have pending operations
            labelIds: (wasOptimisticallyModified || hasPendingLabelOps) ? prev.labelIds : base.labelIds,
            summary: prev.summary,
            summaryStatus: prev.summaryStatus,
            // drop legacy summaryVersion preservation
            summaryUpdatedAt: prev.summaryUpdatedAt,
            bodyHash: prev.bodyHash,
            aiSubject: (prev as any).aiSubject,
            aiSubjectStatus: (prev as any).aiSubjectStatus,
            // drop legacy subjectVersion preservation
            aiSubjectUpdatedAt: (prev as any).aiSubjectUpdatedAt
          } as any;
          if (changed) {
            (carry as any).aiSubjectStatus = 'pending';
            newlyArrived.push(carry);
          }
          threadList.push(carry);
        } else {
          // Mark brand-new threads as pending AI subject so they render at the bottom
          const pending: import('$lib/types').GmailThread = { ...base, aiSubjectStatus: 'pending' } as any;
          threadList.push(pending);
          newlyArrived.push(pending);
        }
      } catch {
        const pending: import('$lib/types').GmailThread = { ...base, aiSubjectStatus: 'pending' } as any;
        threadList.push(pending);
        newlyArrived.push(pending);
      }
    }
    // Persist messages
    const txMsgs = db.transaction('messages', 'readwrite');
    for (const m of msgs) await txMsgs.store.put(m);
    await txMsgs.done;
    
    // Persist threads, but don't overwrite optimistically modified ones or those with pending ops
    const txThreads = db.transaction('threads', 'readwrite');
    for (const t of threadList) {
      const existing = await txThreads.store.get(t.threadId);
      if (existing) {
        const localHasInbox = Array.isArray(existing.labelIds) && existing.labelIds.includes('INBOX');
        const serverHasInbox = Array.isArray(t.labelIds) && t.labelIds.includes('INBOX');
        const wasOptimisticallyModified = !localHasInbox && serverHasInbox;
        
        // Check for pending operations
        let hasPendingLabelOps = false;
        try {
          const pendingOps = await db.getAllFromIndex('ops', 'by_scopeKey', t.threadId);
          hasPendingLabelOps = pendingOps.some((op: any) => 
            op.op?.type === 'batchModify' && 
            (op.op.addLabelIds?.length > 0 || op.op.removeLabelIds?.length > 0)
          );
        } catch (_) {
          hasPendingLabelOps = false;
        }
        
        // Only update if not optimistically modified and no pending ops, or preserve the optimistic changes
        if (!wasOptimisticallyModified && !hasPendingLabelOps) {
          await txThreads.store.put(t);
        } else {
          // Update everything except labelIds to preserve optimistic changes
          const preserved = { ...t, labelIds: existing.labelIds };
          await txThreads.store.put(preserved);
        }
      } else {
        await txThreads.store.put(t);
      }
    }
    await txThreads.done;

    // Offline-first, non-disruptive merge: update the in-memory store using
    // the authoritative DB copies but preserve current UI ordering/state so
    // the user doesn't see jarring replaces/flash. We avoid immediately
    // removing `INBOX` labels for threads that weren't present on this
    // paginated fetch because that can be a false negative during
    // incremental page loads; instead rely on background sync or a full
    // authoritative sync to perform removals safely.
    try {
      const allThreads = await db.getAll('threads');
      const dbById: Record<string, any> = {};
      for (const t of (allThreads || [])) dbById[t.threadId] = t;
      const current = $threadsStore || [];
      
      // Build a map of threads with pending operations to preserve their optimistic state
      const hasPendingOps = new Set<string>();
      try {
        const allOps = await db.getAll('ops');
        for (const op of allOps) {
          if (op.scopeKey) hasPendingOps.add(op.scopeKey);
        }
      } catch (_) {}
      
      // Update existing in-memory entries with DB authoritative fields, but preserve optimistic changes
      const merged = current.map((c) => {
        const dbVersion = dbById[c.threadId];
        if (!dbVersion) return c;
        
        // If this thread has pending operations, preserve its current labelIds
        if (hasPendingOps.has(c.threadId)) {
          return { ...dbVersion, labelIds: c.labelIds };
        }
        
        // Otherwise, use DB version
        return dbVersion;
      });
      
      // Append any DB-only threads after existing UI list (non-disruptive)
      for (const t of (allThreads || [])) {
        if (!merged.find((m) => m.threadId === t.threadId)) merged.push(t as any);
      }
      const { setThreadsWithReset } = await import('$lib/stores/optimistic-counters');
      setThreadsWithReset(merged as any);
    } catch (e) {
      // Fallback: conservative merge of newly fetched threads into memory
      const current = $threadsStore || [];
      const merged = [...current, ...threadList].reduce((acc, t) => {
        const idx = acc.findIndex((candidate: any) => candidate.threadId === t.threadId);
        if (idx >= 0) acc[idx] = { ...acc[idx], ...t } as any; else acc.push(t);
        return acc;
      }, [] as typeof current);
      const { setThreadsWithReset } = await import('$lib/stores/optimistic-counters');
      setThreadsWithReset(merged);
    }
    const msgDict: Record<string, import('$lib/types').GmailMessage> = { ...$messagesStore };
    for (const m of msgs) msgDict[m.id] = m;
    messagesStore.set(msgDict);

    // Proactive auto-apply: apply saved filters with autoApply to new items
    try {
      const autoFilters = ($filtersStore.saved || []).filter((f) => f.autoApply && (f.action === 'archive' || f.action === 'delete'));
      if (autoFilters.length) {
        for (const t of threadList) {
          for (const f of autoFilters) {
            const matches = (await import('$lib/stores/filters')).threadMatchesFilter(t as any, msgDict, f);
            if (matches) {
              if (f.action === 'archive') await archiveThread(t.threadId, { optimisticLocal: true });
              else if (f.action === 'delete') await trashThread(t.threadId, { optimisticLocal: true });
              break;
            }
          }
        }
      }
    } catch (_) {}

    // Fire-and-forget: attempt AI subject summaries for newly arrived threads immediately
    try {
      if (newlyArrived.length) {
        void summarizeSubjectsForThreads(newlyArrived);
      }
    } catch (_) {}

    // Additionally: if any inbox threads are missing AI summaries/subjects (not just newly arrived),
    // kick off a full precompute in the background and surface a snackbar + progress indicator.
    try {
      // Dynamic imports so this stays lazy and only runs in-browser
      const precomputeModule = await import('$lib/ai/precompute');
      const precomputeStoreModule = await import('$lib/stores/precompute');
      // Check if a precompute is already running
      let isRunning = false;
      try {
        const unsub = precomputeStoreModule.precomputeStatus.subscribe((s) => { isRunning = !!s.isRunning; });
        try { unsub(); } catch (_) {}
      } catch (_) { isRunning = false; }
    
      if (!isRunning) {
        // Determine if any inbox thread needs processing
        try {
          const allThreads = await db.getAll('threads');
          const needAny = (allThreads || []).some((t: any) => {
            try {
              const labels = t.labelIds || [];
              if (!labels.includes('INBOX')) return false;
              // Respect cached summaries by default: only recompute when missing
              // or in an error/none state. Subject recompute is similar.
              const hasCachedSummary = !!t.summary;
              const needsSummary = !hasCachedSummary || t.summaryStatus === 'none' || t.summaryStatus === 'error';
              const needsSubject = !(t.aiSubject) || (t.aiSubjectStatus || 'none') === 'none' || (t.aiSubjectStatus || 'none') === 'error';
              return needsSummary || needsSubject;
            } catch (_) { return false; }
          });
          if (needAny) {
            // Respect user setting: if precomputeSummaries is disabled, inform the user instead of starting
            try {
              const { settings: settingsStore } = await import('$lib/stores/settings');
              const s = get(settingsStore);
              if (!s?.precomputeSummaries) {
                try {
                  const rootCauses = 'Possible root causes: missing summary field, precompute disabled, missing Gmail body scopes, filtered threads, previous precompute failure.';
                  showSnackbar({ 
                    message: `AI precompute is disabled in Settings. Enable Precompute summaries to allow background AI processing.\n${rootCauses}`, 
                    timeout: 9000, 
                    actions: { 'Open Settings': () => { location.href = '/settings'; } },
                    settingsConfig: {
                      title: 'AI Precompute Settings',
                      settingKeys: ['precomputeSummaries', 'precomputeAutoRun', 'precomputeUseBatch', 'precomputeUseContextCache'],
                      currentSettings: {
                        precomputeSummaries: s?.precomputeSummaries || false,
                        precomputeAutoRun: s?.precomputeAutoRun || false,
                        precomputeUseBatch: s?.precomputeUseBatch || false,
                        precomputeUseContextCache: s?.precomputeUseContextCache || false
                      },
                      onSettingChange: async (key, value) => {
                        try {
                          await updateAppSettings({ [key]: value });
                          // If precomputeSummaries was just enabled, automatically trigger precompute
                          if (key === 'precomputeSummaries' && value === true) {
                            try {
                              showSnackbar({ message: 'Starting AI precompute…' });
                              const precomputeModule = await import('$lib/ai/precompute');
                              await precomputeModule.precomputeNow(25);
                            } catch (e) {
                              console.warn('Auto-precompute failed:', e);
                            }
                          }
                        } catch (e) {
                          console.error('Failed to update setting:', e);
                        }
                      }
                    }
                  });
                } catch (_) {}
              } else {
                try { showSnackbar({ message: 'Starting AI precompute…' }); } catch (_) {}
                // Call precompute and handle skip reasons so the user sees the real outcome
                if (s?.precomputeAutoRun !== false) {
                  try {
                    const result: any = await precomputeModule.precomputeNow(25);
                    if (result && result.__reason) {
                      showSnackbar({ message: `Precompute skipped: ${result.__reason}`, timeout: 6000, actions: { 'Force run': async () => { await precomputeModule.precomputeNow(25); } } });
                    }
                  } catch (e) {
                    // ignore
                  }
                }
              }
            } catch (_) {
              // If settings couldn't be loaded for some reason, fall back to starting precompute
              try { showSnackbar({ message: 'Starting AI precompute…' }); } catch (_) {}
              void precomputeModule.precomputeNow(25);
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }


  async function loadMore() {
    if (!nextPageToken) return;
    syncing = true;
    try {
      const pageSize = Number($settings.inboxPageSize || 25);
      const page = await listInboxMessageIds(pageSize, nextPageToken);
      nextPageToken = page.nextPageToken;
      const msgs = await mapWithConcurrency(page.ids, 4, (id) => getMessageMetadata(id));
      const db = await getDB();
      const txMsgs = db.transaction('messages', 'readwrite');
      for (const m of msgs) await txMsgs.store.put(m);
      await txMsgs.done;
      // Merge into existing threads/messages
      const threadMap: Record<string, { messageIds: string[]; labelIds: Record<string, true>; last: { from?: string; subject?: string; date?: number } }> = {};
      for (const m of msgs) {
        const existing = threadMap[m.threadId] || { messageIds: [], labelIds: {}, last: {} };
        existing.messageIds.push(m.id);
        for (const x of m.labelIds) existing.labelIds[x] = true;
        const date = m.internalDate || Date.parse(m.headers?.Date || '');
        if (!existing.last.date || (date && date > existing.last.date)) {
          existing.last = { from: m.headers?.From, subject: m.headers?.Subject, date };
        }
        threadMap[m.threadId] = existing;
      }
      const threadList = Object.entries(threadMap).map(([threadId, v]) => ({
        threadId,
        messageIds: v.messageIds,
        lastMsgMeta: v.last,
        labelIds: Object.keys(v.labelIds)
      }));
      const txThreads = db.transaction('threads', 'readwrite');
      for (const t of threadList) await txThreads.store.put(t);
      await txThreads.done;
      // Update store by merging
      const current = $threadsStore || [];
      const merged = [...current, ...threadList].reduce((acc, t) => {
        const idx = acc.findIndex((x) => x.threadId === t.threadId);
        if (idx >= 0) acc[idx] = t; else acc.push(t);
        return acc;
      }, [] as typeof current);
      const { setThreadsWithReset } = await import('$lib/stores/optimistic-counters');
      setThreadsWithReset(merged);
      const msgDict: Record<string, import('$lib/types').GmailMessage> = { ...$messagesStore };
      for (const m of msgs) msgDict[m.id] = m;
      messagesStore.set(msgDict);

      // Proactive auto-apply for loaded page
      try {
        const autoFilters = ($filtersStore.saved || []).filter((f) => f.autoApply && (f.action === 'archive' || f.action === 'delete'));
        if (autoFilters.length) {
          for (const t of threadList) {
            for (const f of autoFilters) {
              const matches = (await import('$lib/stores/filters')).threadMatchesFilter(t as any, msgDict, f);
              if (matches) {
                if (f.action === 'archive') await archiveThread(t.threadId, { optimisticLocal: true });
                else if (f.action === 'delete') await trashThread(t.threadId, { optimisticLocal: true });
                break;
              }
            }
          }
        }
      } catch (_) {}
    } catch (e) {
      setApiError(e);
    } finally {
      syncing = false;
      pendingRefresh = false;
    }
  }

  async function copyDiagnostics(): Promise<boolean> {
    try {
      const payload = {
        note: 'Gmail diagnostics snapshot',
        at: new Date().toISOString(),
        ...getAuthDiagnostics(),
        clientIdPresent: !!CLIENT_ID && String(CLIENT_ID).trim().length > 0,
        clientIdPreview: CLIENT_ID ? String(CLIENT_ID).slice(0, 8) + '…' : undefined,
        threadsCount: totalThreadsCount,
        visibleThreadsCount,
        searchQuery: debouncedQuery,
        nextPageToken,
        errorStatus: apiErrorStatus,
        errorMessage: apiErrorMessage,
        localStorageKeys: Object.keys(localStorage || {}),
      };
      // Merge any buffered API entries captured by the UI effect
      const merged = { ...payload } as any;
      if (__uiBufferedEntries && __uiBufferedEntries.length) {
        merged.entries = __uiBufferedEntries;
        __uiBufferedEntries = [];
      }
      copiedDiagOk = await copyGmailDiagnosticsToClipboard(merged);
      if (!copiedDiagOk) {
        // Fallback: log to console for manual copy
        // eslint-disable-next-line no-console
        console.log('Gmail diagnostics (fallback):', { payload: merged, entries: getAndClearGmailDiagnostics() });
      }
    } catch (_) {
      copiedDiagOk = false;
    }
    return copiedDiagOk;
  }

  // Dev helper: compare local DB threads with Gmail's authoritative INBOX thread list
  async function compareLocalToGmail() {
    try {
      const db = await getDB();
      const local = await db.getAll('threads');
      const localIds = new Set((local || []).map((t: any) => t.threadId));
      const gmailIds: string[] = [];
      let pageToken: string | undefined = undefined;
      // Page through thread ids (small safety cap)
      for (let i = 0; i < 20; i++) {
        const page = await listThreadIdsByLabelId('INBOX', 500, pageToken);
        if (!page || !Array.isArray(page.ids) || !page.ids.length) break;
        for (const id of page.ids) gmailIds.push(id);
        if (!page.nextPageToken) break;
        pageToken = page.nextPageToken;
      }
      const gmailSet = new Set(gmailIds);
      const inLocalNotGmail = Array.from(localIds).filter(id => !gmailSet.has(id));
      const inGmailNotLocal = gmailIds.filter(id => !localIds.has(id));
      console.log('[Compare] localCount=', localIds.size, 'gmailCountSample=', gmailIds.length, 'inLocalNotGmail=', inLocalNotGmail.slice(0,20), 'inGmailNotLocal=', inGmailNotLocal.slice(0,20));
      try { showSnackbar({ message: `Compare complete — local:${localIds.size} gmailSample:${gmailIds.length}`, timeout: 4000 }); } catch (_) {}
      return { localCount: localIds.size, gmailSampleCount: gmailIds.length, inLocalNotGmail: inLocalNotGmail.slice(0,200), inGmailNotLocal: inGmailNotLocal.slice(0,200) };
    } catch (e) {
      console.error('[Compare] failed', e);
      try { showSnackbar({ message: `Compare failed: ${e instanceof Error ? e.message : String(e)}`, timeout: 4000 }); } catch (_) {}
      throw e;
    }
  }

  if (typeof window !== 'undefined') {
    (window as any).__copyPageDiagnostics = async () => { await copyDiagnostics(); };
  }

  async function runInboxSyncDiagnostics(): Promise<boolean> {
    const debugLog: string[] = [];
    let diagnosticData: any = {};
    
    function log(msg: string, data?: any) {
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] ${msg}`;
      debugLog.push(logEntry);
      console.log(logEntry, data || '');
      if (data) {
        diagnosticData[`step_${debugLog.length}`] = { message: msg, data };
      }
    }
    
    try {
      log('🔍 COMPREHENSIVE INBOX SYNC DIAGNOSTICS STARTED');
      
      const db = await getDB();
      
      // Step 1: Environment check
      log('Step 1: Environment diagnostics');
      const envInfo = {
        url: window.location.href,
        userAgent: navigator.userAgent,
        online: navigator.onLine,
        ready: ready,
        syncing: syncing,
        backgroundSyncing: backgroundSyncing,
        loading: loading,
        hasNextPageToken: !!nextPageToken,
        isProduction: !import.meta.env.DEV
      };
      log('Environment check complete', envInfo);
      
      // Step 2: Database state analysis  
      log('Step 2: Database state analysis');
      const allLocalThreads = await db.getAll('threads');
      const allLocalMessages = await db.getAll('messages');
      const localInboxThreads = allLocalThreads.filter((t: any) => 
        Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
      );
      
      // Check for database integrity
      const dbIntegrity = {
        totalThreads: allLocalThreads.length,
        totalMessages: allLocalMessages.length,
        inboxThreads: localInboxThreads.length,
        threadsWithoutLabels: allLocalThreads.filter(t => !t.labelIds || !Array.isArray(t.labelIds)).length,
        threadsWithInboxLabel: localInboxThreads.length,
        sampleInboxThreadIds: localInboxThreads.slice(0, 5).map(t => t.threadId),
        sampleThreadLabels: localInboxThreads.slice(0, 3).map(t => ({ id: t.threadId, labels: t.labelIds }))
      };
      log('Database integrity check complete', dbIntegrity);
      
      // Step 3: In-memory store analysis
      log('Step 3: In-memory store analysis');
      const currentThreads = get(threadsStore);
      const currentMessages = get(messagesStore);
      const storeInboxThreads = currentThreads.filter((t) => (t.labelIds || []).includes('INBOX'));
      
      const storeState = {
        storeThreadsCount: currentThreads.length,
        storeMessagesCount: currentMessages.length,
        storeInboxThreadsCount: storeInboxThreads.length,
        sampleStoreThreadIds: storeInboxThreads.slice(0, 5).map(t => t.threadId)
      };
      log('Store state analysis complete', storeState);
      
      // Step 4: Gmail API connectivity test
      log('Step 4: Gmail API connectivity test');
      let gmailConnectivity: any = {};
      
      try {
        // Test 1: Get INBOX label
        const inboxLabel = await getLabel('INBOX');
        gmailConnectivity.labelTest = {
          success: true,
          threadsTotal: inboxLabel.threadsTotal,
          threadsUnread: inboxLabel.threadsUnread,
          messagesTotal: inboxLabel.messagesTotal,
          messagesUnread: inboxLabel.messagesUnread
        };
        log('✅ Gmail label test successful', gmailConnectivity.labelTest);
        
        // Test 2: List thread IDs
        const firstPage = await listThreadIdsByLabelId('INBOX', 20, undefined);
        gmailConnectivity.threadListTest = {
          success: true,
          threadCount: firstPage.ids?.length || 0,
          hasNextPageToken: !!firstPage.nextPageToken,
          sampleThreadIds: (firstPage.ids || []).slice(0, 5)
        };
        log('✅ Gmail thread listing test successful', gmailConnectivity.threadListTest);
        
        // Test 3: Fetch a single thread
        if (firstPage.ids && firstPage.ids.length > 0) {
          const sampleThreadId = firstPage.ids[0];
          const threadSummary = await getThreadSummary(sampleThreadId);
          gmailConnectivity.threadFetchTest = {
            success: true,
            threadId: sampleThreadId,
            messageCount: threadSummary.messages.length,
            labels: threadSummary.thread.labelIds,
            hasInboxLabel: threadSummary.thread.labelIds.includes('INBOX'),
            subject: threadSummary.messages[0]?.headers?.Subject || 'No subject'
          };
          log('✅ Gmail thread fetch test successful', gmailConnectivity.threadFetchTest);
        }
        
      } catch (e) {
        gmailConnectivity.error = String(e);
        log('❌ Gmail API connectivity test failed', gmailConnectivity);
        throw new Error(`Gmail API test failed: ${e}`);
      }
      
      // Step 5: Sync discrepancy analysis
      log('Step 5: Sync discrepancy analysis');
      const gmailThreadCount = gmailConnectivity.labelTest.threadsTotal || 0;
      const syncAnalysis = {
        gmailThreadCount,
        dbInboxThreadCount: localInboxThreads.length,
        storeInboxThreadCount: storeInboxThreads.length,
        discrepancyGmailToDb: gmailThreadCount - localInboxThreads.length,
        discrepancyDbToStore: localInboxThreads.length - storeInboxThreads.length,
        criticalIssue: localInboxThreads.length === 0 && gmailThreadCount > 0,
        minorDiscrepancy: Math.abs(gmailThreadCount - localInboxThreads.length) <= 5 && localInboxThreads.length > 0
      };
      log('Sync discrepancy analysis complete', syncAnalysis);
      
      // Step 6: Pending operations check
      log('Step 6: Checking for pending operations');
      const allOps = await db.getAll('ops');
      const now = Date.now();
      
      // Determine if ops are pending (ready to be processed), failed, or completed
      const pendingOps = allOps.filter((op: any) => op.nextAttemptAt <= now && op.attempts < 5);
      const failedOps = allOps.filter((op: any) => op.attempts >= 5 || (op.lastError && op.nextAttemptAt > now + 300000));
      const futureOps = allOps.filter((op: any) => op.nextAttemptAt > now && op.attempts < 5);
      
      const inboxOps = allOps.filter((op: any) => 
        op.op.type === 'batchModify' && 
        (op.op.addLabelIds?.includes('INBOX') || op.op.removeLabelIds?.includes('INBOX'))
      );
      
      const opsAnalysis = {
        totalOps: allOps.length,
        pendingOps: pendingOps.length,
        failedOps: failedOps.length,
        futureOps: futureOps.length,
        inboxRelatedOps: inboxOps.length,
        recentOps: allOps.slice(-5).map((op: any) => ({
          id: op.id.substring(0, 8),
          type: op.op?.type,
          scopeKey: op.scopeKey,
          attempts: op.attempts,
          nextAttemptMs: op.nextAttemptAt - now,
          hasError: !!op.lastError,
          error: op.lastError?.substring(0, 50)
        }))
      };
      log('Operations analysis complete', opsAnalysis);
      
      // Decision point: What type of repair to run?
      if (syncAnalysis.criticalIssue) {
        log('🚨 CRITICAL ISSUE DETECTED: Running comprehensive repair');
        
        showSnackbar({
          message: `🚨 Critical sync issue: ${syncAnalysis.discrepancyGmailToDb} threads missing locally. Starting repair...`,
          timeout: 12000,
          closable: true
        });
        
        // Step 7: Comprehensive repair
        log('Step 7: Starting comprehensive inbox repair');
        
        // Get ALL Gmail thread IDs
        const gmailThreadIds = new Set<string>();
        let pageToken: string | undefined = undefined;
        let pageCount = 0;
        const maxPages = Math.min(50, Math.ceil(gmailThreadCount / 100) + 5);
        
        log(`Fetching all Gmail thread IDs (estimated ${Math.ceil(gmailThreadCount / 100)} pages)`);
        
        while (pageCount < maxPages) {
          try {
            const page = await listThreadIdsByLabelId('INBOX', 100, pageToken);
            pageCount++;
            
            if (!page.ids?.length) {
              log(`Page ${pageCount}: Empty page, nextToken=${!!page.nextPageToken}`);
              if (!page.nextPageToken) break;
              pageToken = page.nextPageToken;
              continue;
            }
            
            page.ids.forEach(tid => gmailThreadIds.add(tid));
            log(`Page ${pageCount}: Found ${page.ids.length} threads (total: ${gmailThreadIds.size})`);
            
            if (!page.nextPageToken) {
              log(`Page ${pageCount}: Last page reached`);
              break;
            }
            pageToken = page.nextPageToken;
            
          } catch (e) {
            log(`Page ${pageCount}: Error fetching - ${String(e)}`);
            break;
          }
        }
        
        // Find missing threads
        const localThreadIds = new Set(localInboxThreads.map((t: any) => t.threadId));
        const missingThreadIds = Array.from(gmailThreadIds).filter(tid => !localThreadIds.has(tid));
        
        log(`Thread reconciliation: Gmail=${gmailThreadIds.size}, Local=${localThreadIds.size}, Missing=${missingThreadIds.length}`, {
          missingThreadIds: missingThreadIds.slice(0, 10)
        });
        
        if (missingThreadIds.length === 0) {
          log('No missing threads - running authoritative sync to fix labels');
          showSnackbar({
            message: '🔧 No missing threads found. Running label repair...',
            timeout: 5000
          });
          await performAuthoritativeInboxSync();
        } else {
          // Fetch missing threads
          log(`Starting batch fetch of ${missingThreadIds.length} missing threads`);
          
          const batchSize = 3; // Reduced batch size for better error handling
          let fetchedCount = 0;
          let storedCount = 0;
          let errorCount = 0;
          const fetchErrors: string[] = [];
          
          showSnackbar({
            message: `📥 Fetching ${missingThreadIds.length} missing threads...`,
            timeout: 5000
          });
          
          for (let i = 0; i < missingThreadIds.length; i += batchSize) {
            const batch = missingThreadIds.slice(i, i + batchSize);
            log(`Processing batch ${Math.floor(i/batchSize) + 1}: threads ${i+1}-${Math.min(i+batchSize, missingThreadIds.length)}`);
            
            try {
              // Fetch batch
              const fetchPromises = batch.map(async (tid) => {
                try {
                  const result = await getThreadSummary(tid);
                  fetchedCount++;
                  return { tid, result };
                } catch (e) {
                  const error = `Thread ${tid}: ${String(e)}`;
                  fetchErrors.push(error);
                  errorCount++;
                  log(`❌ Fetch failed: ${error}`);
                  return { tid, result: null };
                }
              });
              
              const batchResults = await Promise.all(fetchPromises);
              
              // Store batch
              const storePromises = batchResults
                .filter(item => item.result !== null)
                .map(async ({ tid, result }) => {
                  try {
                    // Store messages
                    for (const msg of result!.messages) {
                      await db.put('messages', msg);
                    }
                    
                    // Store thread
                    await db.put('threads', result!.thread);
                    storedCount++;
                    log(`✅ Stored thread ${tid} with ${result!.messages.length} messages`);
                  } catch (e) {
                    const error = `Store ${tid}: ${String(e)}`;
                    fetchErrors.push(error);
                    errorCount++;
                    log(`❌ Store failed: ${error}`);
                  }
                });
              
              await Promise.all(storePromises);
              
              // Progress update
              if (i % 15 === 0 || i + batchSize >= missingThreadIds.length) {
                const progress = Math.min(i + batchSize, missingThreadIds.length);
                showSnackbar({
                  message: `📥 Progress: ${progress}/${missingThreadIds.length} threads processed (${storedCount} stored, ${errorCount} errors)`,
                  timeout: 3000
                });
              }
              
            } catch (e) {
              log(`❌ Batch processing failed: ${String(e)}`);
              errorCount += batch.length;
            }
          }
          
          log(`Fetch/store complete: ${fetchedCount} fetched, ${storedCount} stored, ${errorCount} errors`);
          
          if (fetchErrors.length > 0) {
            log('Fetch/store errors summary', { errors: fetchErrors.slice(0, 10) });
          }
          
          showSnackbar({
            message: `📥 Repair complete: ${storedCount} threads synced${errorCount > 0 ? `, ${errorCount} errors` : ''}. Refreshing...`,
            timeout: 6000,
            closable: true
          });
        }
        
        // Step 8: Refresh stores and UI
        log('Step 8: Refreshing stores and UI');
        
        try {
          // Clear trailing holds
          const { trailingHolds } = await import('$lib/stores/holds');
          trailingHolds.set({});
          
          // Refresh thread store
          const refreshedThreads = await db.getAll('threads');
          const { setThreadsWithReset } = await import('$lib/stores/optimistic-counters');
          setThreadsWithReset(refreshedThreads as any);
          
          log('Store refresh completed');
          
          // Trigger inbox refresh
          window.dispatchEvent(new CustomEvent('jmail:refresh'));
          log('UI refresh triggered');
          
        } catch (e) {
          log(`❌ Refresh failed: ${String(e)}`);
        }
        
      } else if (!syncAnalysis.minorDiscrepancy && Math.abs(syncAnalysis.discrepancyGmailToDb) > 2) {
        log('⚠️ MINOR DISCREPANCY: Launching background authoritative sync (transparent to user)');
        try {
          // Start authoritative sync in the background; do not block diagnostics or show UI feedback
          void performAuthoritativeInboxSync({ perPageTimeoutMs: 15000, maxRetries: 2 })
            .then(() => log('Background authoritative sync completed'))
            .catch(err => log('Background authoritative sync failed', err));
        } catch (e) {
          log('Failed to start background authoritative sync', e);
        }
      } else {
        log('✅ NO MAJOR ISSUES: Sync appears healthy');
        
        // Still copy comprehensive diagnostics for analysis
        const fullDiagnostics = {
          timestamp: new Date().toISOString(),
          conclusion: "No major sync issues detected",
          environment: envInfo,
          database: dbIntegrity,
          store: storeState,
          gmail: gmailConnectivity,
          syncAnalysis,
          operations: opsAnalysis,
          debugLog: debugLog.slice(-20) // Last 20 log entries
        };
        
        await navigator.clipboard.writeText(JSON.stringify(fullDiagnostics, null, 2));
        
        showSnackbar({
          message: `✅ Sync healthy (${syncAnalysis.discrepancyGmailToDb} thread difference). Full diagnostics copied to clipboard.`,
          timeout: 6000,
          closable: true
        });
      }
      
      log('🏁 DIAGNOSTICS COMPLETED SUCCESSFULLY');
      return true;
      
    } catch (e) {
      log(`💥 DIAGNOSTICS FAILED: ${String(e)}`);
      
      // Copy error diagnostics
      const errorDiagnostics = {
        timestamp: new Date().toISOString(),
        error: e instanceof Error ? { message: e.message, stack: e.stack } : String(e),
        diagnosticData,
        debugLog,
        partialResults: diagnosticData
      };
      
      try {
        await navigator.clipboard.writeText(JSON.stringify(errorDiagnostics, null, 2));
      } catch {}
      
      showSnackbar({
        message: `💥 Diagnostics failed: ${e instanceof Error ? e.message : String(e)}. Error details copied to clipboard.`,
        timeout: 10000,
        closable: true,
        actions: {
          'View Console': () => {
            console.error('[Inbox] Complete diagnostic log:', debugLog);
            console.error('[Inbox] Error diagnostics:', errorDiagnostics);
          }
        }
      });
      return false;
    }
  }

  async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let idx = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (true) {
        const current = idx++;
        if (current >= items.length) break;
        results[current] = await fn(items[current]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  // Helper: best-effort fetch of the latest message body if scopes allow
  async function tryGetLastMessageFull(messageId: string): Promise<import('$lib/types').GmailMessage | null> {
    try {
      const { fetchTokenInfo } = await import('$lib/gmail/auth');
      const info = await fetchTokenInfo();
      const hasBodyScopes = !!info?.scope && (info.scope.includes('gmail.readonly') || info.scope.includes('gmail.modify'));
      if (!hasBodyScopes) return null;
    } catch (_) {
      return null;
    }
    try {
      const { getMessageFull } = await import('$lib/gmail/api');
      const full = await getMessageFull(messageId);
      return full;
    } catch (_) {
      return null;
    }
  }

  function getLastMessageId(thread: import('$lib/types').GmailThread): string | null {
    try {
      const ids = thread.messageIds || [];
      if (!ids.length) return null;
      return ids[ids.length - 1];
    } catch {
      return null;
    }
  }

  async function summarizeSubjectsForThreads(targets: Array<import('$lib/types').GmailThread>): Promise<void> {
    if (!targets || !targets.length) return;
    try {
      const db = await getDB();
      // Mark pending in DB to persist state across reloads
      try {
        const tx = db.transaction('threads', 'readwrite');
        for (const t of targets) {
          const current = await tx.store.get(t.threadId) as import('$lib/types').GmailThread | undefined;
          const next = { ...(current || t), aiSubjectStatus: 'pending' as const, aiSubjectUpdatedAt: Date.now() } as any;
          await tx.store.put(next);
        }
        await tx.done;
      } catch (_) {}

      const prepared = await mapWithConcurrency(targets, 3, async (t) => {
        const lastId = getLastMessageId(t);
        let bodyText: string | undefined;
        let bodyHtml: string | undefined;
        if (lastId) {
          const full = await tryGetLastMessageFull(lastId);
          if (full) { bodyText = full.bodyText; bodyHtml = full.bodyHtml; }
        }
        const subject = t.lastMsgMeta?.subject || '';
        return { t, subject, bodyText, bodyHtml };
      });

      // Summarize with modest concurrency: compute message summary first, then subject from that
      const results = await mapWithConcurrency(prepared, 2, async (p) => {
        try {
          const readySummary = (p.t.summary && p.t.summaryStatus === 'ready') ? p.t.summary : '';
          const messageSummary = readySummary && readySummary.trim()
            ? readySummary
            : await aiSummarizeEmail(p.subject, p.bodyText, p.bodyHtml, undefined, p.t.threadId);
          const text = await aiSummarizeSubject(p.subject, undefined, undefined, messageSummary);
          return { id: p.t.threadId, ok: true, text, messageSummary } as const;
        } catch (e) {
          return { id: p.t.threadId, ok: false, error: e } as const;
        }
      });

      // Persist and update store
      const tx = db.transaction('threads', 'readwrite');
      const nowMs = Date.now();
      const nowVersion = undefined as any;
      for (const r of results) {
        try {
          const current = (await tx.store.get(r.id)) as import('$lib/types').GmailThread | undefined;
          if (!current) continue;
          const next: import('$lib/types').GmailThread = { ...current } as any;
          if (r.ok && r.text && r.text.trim()) {
            (next as any).aiSubject = r.text.trim();
            (next as any).aiSubjectStatus = 'ready';
          } else {
            (next as any).aiSubjectStatus = (current as any).aiSubjectStatus || 'error';
          }
          // Also persist the AI message summary if we computed it here
          if ((r as any).messageSummary && String((r as any).messageSummary).trim()) {
            (next as any).summary = String((r as any).messageSummary).trim();
            (next as any).summaryStatus = 'ready';
            (next as any).summaryVersion = nowVersion;
            (next as any).summaryUpdatedAt = nowMs;
          }
          (next as any).subjectVersion = nowVersion;
          (next as any).aiSubjectUpdatedAt = nowMs;
          await tx.store.put(next);
          // Update live store
          threadsStore.update((arr) => {
            const idx = arr.findIndex((x) => x.threadId === r.id);
            if (idx >= 0) {
              const copy = arr.slice();
              (copy as any)[idx] = next as any;
              return copy as any;
            }
            return arr;
          });
        } catch (_) {}
      }
      await tx.done;
    } catch (_) {}
  }

  // Compute stale candidates and open review dialog
  async function computeStaleCandidatesAndShowDialog() {
    try {
      const { getDB } = await import('$lib/db/indexeddb');
      const { listThreadIdsByLabelId } = await import('$lib/gmail/api');
      const db = await getDB();

      const localThreads = await db.getAll('threads');
      const localInboxThreads = localThreads.filter((t: any) => Array.isArray(t.labelIds) && t.labelIds.includes('INBOX'));

      const gmailThreadIds = new Set<string>();
      let pageToken: string | undefined = undefined;
      let pageCount = 0;
      const maxPages = 50;
      while (pageCount < maxPages) {
        const page = await listThreadIdsByLabelId('INBOX', 100, pageToken);
        pageCount++;
        if (page.ids && page.ids.length) page.ids.forEach((id) => gmailThreadIds.add(id));
        if (!page.nextPageToken) break;
        pageToken = page.nextPageToken;
      }

      const stale = localInboxThreads.filter((t: any) => !gmailThreadIds.has(t.threadId));
      staleCandidates = stale.map((t: any) => ({ threadId: t.threadId, subject: t.lastMsgMeta?.subject, from: t.lastMsgMeta?.from, labels: t.labelIds }));
      selectedToDelete = new Set(staleCandidates.map(s => s.threadId));
      staleDialogOpen = true;
    } catch (e) {
      console.error('computeStaleCandidatesAndShowDialog failed', e);
      showSnackbar({ message: 'Failed to compute stale threads', closable: true });
    }
  }

  function toggleStaleSelection(threadId: string) {
    try {
      if (selectedToDelete.has(threadId)) selectedToDelete.delete(threadId);
      else selectedToDelete.add(threadId);
      // Reassign to trigger reactive updates
      selectedToDelete = new Set(selectedToDelete);
    } catch (e) {
      console.error('toggleStaleSelection failed', e);
    }
  }

  async function deleteSelectedStaleThreads() {
    try {
      const db = await getDB();
      const toDelete = Array.from(selectedToDelete || []);
      if (!toDelete.length) {
        showSnackbar({ message: 'No threads selected', closable: true });
        return;
      }
      const txThreads = db.transaction('threads', 'readwrite');
      for (const id of toDelete) {
        try { await txThreads.store.delete(id); } catch (_) {}
      }
      await txThreads.done;

      // Also remove messages belonging to deleted threads
      try {
        const allMessages = await db.getAll('messages');
        const txMsgs = db.transaction('messages', 'readwrite');
        for (const m of allMessages) {
          if (toDelete.includes(m.threadId)) {
            try { await txMsgs.store.delete(m.id); } catch (_) {}
          }
        }
        await txMsgs.done;
      } catch (_) {}

      // Refresh live stores
      const allThreads = await db.getAll('threads');
      threadsStore.set(allThreads);
      const allMessages = await db.getAll('messages');
      const msgDict: Record<string, import('$lib/types').GmailMessage> = {} as any;
      for (const m of allMessages) msgDict[m.id] = m;
      messagesStore.set(msgDict);

      showSnackbar({ message: `Deleted ${toDelete.length} local thread(s)`, closable: true });
      staleDialogOpen = false;
      selectedToDelete = new Set();
      staleCandidates = [];
    } catch (e) {
      console.error('deleteSelectedStaleThreads failed', e);
      showSnackbar({ message: 'Failed to delete selected threads', closable: true });
    }
  }

  // Repair: rehydrate local INBOX from authoritative server messages/threads
  async function repairInboxFromServerMessages() {
    try {
      showSnackbar({ message: 'Repairing inbox from server messages...', timeout: 4000, closable: true });
      const db = await getDB();
      // Collect authoritative threadIds from INBOX messages
      const threadIds = new Set<string>();
      let pageToken: string | undefined = undefined;
      do {
        const page = await listInboxMessageIds(500, pageToken);
        for (const mid of page.ids || []) {
          try {
            const meta = await getMessageMetadata(mid);
            if (meta && meta.threadId) threadIds.add(meta.threadId);
          } catch (e) {
            console.warn('[Repair] message metadata failed', mid, e);
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);

      let stored = 0;
      for (const tid of Array.from(threadIds)) {
        try {
          // Skip threads that have pending local operations to avoid resurrecting
          // user-deleted or -modified threads. If there are pending ops for this
          // scopeKey/threadId, do not fetch/store the thread now.
          try {
            const pendingOps = await db.getAllFromIndex('ops', 'by_scopeKey', tid).catch(() => []);
            if ((pendingOps || []).length > 0) {
              console.log('[Repair] skipping thread due to pending ops:', tid);
              continue;
            }
          } catch (e) {
            // ignore and proceed if index isn't available
          }

          const threadSummary = await getThreadSummary(tid);
          const tx = db.transaction(['messages', 'threads'], 'readwrite');
          const msgsStore = tx.objectStore('messages');
          const threadsStoreDb = tx.objectStore('threads');
          for (const m of threadSummary.messages) {
            try { msgsStore.put(m); } catch (e) { console.warn('[Repair] put message failed', m.id, e); }
          }
          // Ensure INBOX present
          const labels = new Set<string>(threadSummary.thread.labelIds || []);
          labels.add('INBOX');
          const threadObj = { ...threadSummary.thread, labelIds: Array.from(labels) } as any;
          try { threadsStoreDb.put(threadObj); } catch (e) { console.warn('[Repair] put thread failed', tid, e); }
          await new Promise((res) => { tx.oncomplete = () => res(undefined); tx.onerror = () => res(undefined); tx.onabort = () => res(undefined); });
          stored++;
        } catch (e) {
          console.warn('[Repair] failed for thread', tid, e);
        }
      }

      // Refresh live stores
      try {
        const allThreads = await db.getAll('threads');
        threadsStore.set(allThreads);
        const allMessages = await db.getAll('messages');
        const msgDict: Record<string, any> = {};
        for (const m of allMessages) msgDict[m.id] = m;
        messagesStore.set(msgDict);
      } catch (_) {}

      showSnackbar({ message: `Repair complete: stored ${stored} threads`, timeout: 4000, closable: true });
      // Give UI a moment then refresh
      setTimeout(() => { try { location.reload(); } catch (_) {} }, 500);
    } catch (e) {
      console.error('[Repair] failed', e);
      showSnackbar({ message: 'Repair failed: ' + String(e), closable: true });
    }
  }

  const can10m = $derived.by(() => {
    try {
      return Object.keys($settings?.labelMapping || {}).some((k)=>k==='10m' && $settings?.labelMapping?.[k]);
    } catch (e) {
      return false;
    }
  });
  const can3h = $derived.by(() => {
    try {
      return Object.keys($settings?.labelMapping || {}).some((k)=>k==='3h' && $settings?.labelMapping?.[k]);
    } catch (e) {
      return false;
    }
  });
  const can1d = $derived.by(() => {
    try {
      return Object.keys($settings?.labelMapping || {}).some((k)=>k==='1d' && $settings?.labelMapping?.[k]);
    } catch (e) {
      return false;
    }
  });

  async function bulkApplyActiveFilterAction() {
    const f = $filtersStore.active;
    if (!f || !f.action || f.action === 'none') return;
    const targetIds = filteredThreads.map((t) => t.threadId);
    if (!targetIds.length) return;
    if (f.action === 'delete' && $settings.confirmDelete) {
      if (!confirm(`Delete ${targetIds.length} conversation(s)?`)) return;
    }
    for (const id of targetIds) {
      if (f.action === 'archive') await archiveThread(id, { optimisticLocal: false });
      else if (f.action === 'delete') await trashThread(id, { optimisticLocal: false });
    }
    showSnackbar({ message: `${f.action === 'archive' ? 'Archived' : 'Deleted'} ${targetIds.length}`, actions: { Undo: () => undoLast(targetIds.length) } });
  }
</script>

{#if loading}
  <div style="display:grid; place-items:center; height:70vh;">
    <LoadingIndicator />
  </div>
  
  <!-- Stale threads review dialog -->
  <Dialog headline="Review stale local threads" bind:open={staleDialogOpen} closeOnEsc={true} closeOnClick={false}>
    {#snippet children()}
      <div style="max-height:40vh; overflow:auto;">
        {#if staleCandidates && staleCandidates.length}
          <ul style="list-style:none; padding:0; margin:0;">
            {#each staleCandidates as s}
              <li style="display:flex; align-items:center; gap:0.5rem; padding:0.5rem; border-bottom:1px solid rgba(0,0,0,0.04);">
                <input type="checkbox" checked={selectedToDelete.has(s.threadId)} onchange={() => toggleStaleSelection(s.threadId)} />
                <div style="flex:1;">
                  <div style="font-weight:600">{s.subject || '(no subject)'}</div>
                  <div style="font-size:0.85rem; color: rgb(var(--m3-scheme-on-surface-variant));">{s.from || ''} • {s.threadId}</div>
                </div>
              </li>
            {/each}
          </ul>
        {:else}
          <p>No stale threads detected.</p>
        {/if}
      </div>
    {/snippet}
    {#snippet buttons()}
      <div class="btns">
        <Button variant="text" onclick={() => { staleDialogOpen = false; }}>Cancel</Button>
        <Button variant="outlined" color="error" onclick={deleteSelectedStaleThreads}>Delete selected</Button>
      </div>
    {/snippet}
  </Dialog>
{:else}
  {#if apiErrorStatus === 403}
    <Card variant="filled" style="max-width:36rem; margin: 0 auto 1rem;">
      <h3 class="m3-font-title-medium" style="margin:0 0 0.25rem 0">Permission needed</h3>
      <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">Jmail needs Gmail access. Please re-authorize your Google account.</p>
      {#if apiErrorMessage}
        <p class="m3-font-body-small" style="margin:0.5rem 0 0; color:rgb(var(--m3-scheme-error))">{apiErrorMessage}</p>
      {/if}
      <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:0.75rem;">
        <Button variant="text" href="https://myaccount.google.com/permissions">Review permissions</Button>
        <Button variant="outlined" onclick={async () => {
          try {
            const ok = await copyDiagnostics();
            showSnackbar({ message: ok ? 'Diagnostics copied to clipboard' : 'Failed to copy diagnostics; check console', closable: true });
          } catch (_) {
            showSnackbar({ message: 'Failed to copy diagnostics; check console', closable: true });
          }
        }}>Copy diagnostics</Button>
        <Button variant="filled" onclick={signIn}>Sign in with Google</Button>
      </div>
    </Card>
  {:else if apiErrorMessage}
    <Card variant="outlined" style="max-width:36rem; margin: 0 auto 1rem;">
      <h3 class="m3-font-title-medium" style="margin:0 0 0.25rem 0">{apiErrorStatus ? `Error ${apiErrorStatus}` : 'Error'}</h3>
      <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">{apiErrorMessage}</p>
      <p class="m3-font-body-small" style="margin:0.25rem 0 0; color:rgb(var(--m3-scheme-on-surface-variant))">If you just completed Google sign-in, wait a moment and click "Try again". If the problem persists, copy diagnostics and open an issue.</p>
      <details style="margin-top:0.5rem;">
        <summary style="cursor:pointer; font-size:0.9rem; color:rgb(var(--m3-scheme-on-surface-variant));">Show diagnostic preview</summary>
        <pre style="white-space:pre-wrap; word-break:break-word; font-size:0.75rem; max-height:16rem; overflow:auto; background:rgba(0,0,0,0.03); padding:0.5rem; border-radius:4px;">{JSON.stringify({ errorStatus: apiErrorStatus, errorMessage: apiErrorMessage, ...getAuthDiagnostics() }, null, 2)}</pre>
      </details>
      <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:0.75rem;">
        <Button variant="text" onclick={() => { apiErrorMessage = null; apiErrorStatus = undefined; apiErrorStack = undefined; }}>Dismiss</Button>
        <Button variant="outlined" onclick={async () => {
          try {
            const ok = await copyDiagnostics();
            showSnackbar({ message: ok ? 'Diagnostics copied to clipboard' : 'Failed to copy diagnostics; check console', closable: true });
          } catch (_) {
            showSnackbar({ message: 'Failed to copy diagnostics; check console', closable: true });
          }
        }}>Copy diagnostics</Button>
        <Button variant="filled" onclick={signIn}>Try again</Button>
      </div>
    </Card>
  {/if}

  <!-- Session Status Component - only show if there are actual auth issues -->
  {#if apiErrorStatus === 401 || apiErrorStatus === 403}
    <div style="margin-bottom: 1rem;">
      <SessionStatus />
    </div>
  {/if}

  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.5rem; gap:0.5rem;">
    <div style="display:flex; align-items:center; gap:1rem;">
      <h3 class="m3-font-title-medium" style="margin:0">Inbox</h3>
    </div>
    <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
      
      <details class="sort" bind:this={sortDetails}>
        <summary class="summary-btn" onclick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          
          const d = sortDetails || (e.currentTarget as HTMLElement).closest('details') as HTMLDetailsElement | null;
          if (!d) return;
          
          // Android-specific handling for details/summary toggle
          const isAndroid = /Android/i.test(navigator.userAgent);
          
          if (isAndroid) {
            try {
              // For Android, use setTimeout to ensure the toggle happens after event handling
              const currentState = d.open;
              setTimeout(() => {
                try {
                  d.open = !currentState;
                  // Force a reflow to ensure the change takes effect
                  d.offsetHeight;
                } catch (e1) {
                  console.error('[Inbox] Sort toggle failed:', e1);
                  // Emergency fallback
                  try {
                    if (currentState) {
                      d.removeAttribute('open');
                    } else {
                      d.setAttribute('open', '');
                    }
                  } catch (e2) {
                    console.error('[Inbox] Sort toggle attribute fallback failed:', e2);
                  }
                }
              }, 16);
            } catch (e) {
              console.error('[Inbox] Android sort setup failed:', e);
              d.open = !d.open;
            }
          } else {
            d.open = !d.open;
          }
        }}>
          <Button variant="text">
            {#snippet children()}
              <span class="label">Sort: {currentSortLabel}</span>
            {/snippet}
          </Button>
        </summary>
        <Menu>
          {#each sortOptions as opt}
            <MenuItem onclick={() => setSort(opt.key)}>{opt.label}{opt.key === currentSort ? ' ✓' : ''}</MenuItem>
          {/each}
        </Menu>
      </details>
      {#if backgroundSyncing}
        <Button variant="outlined" disabled={true}>
          Syncing all emails…
        </Button>
      {:else if nextPageToken && !backgroundSyncing}
        <Button variant="outlined" disabled={syncing} onclick={(e: MouseEvent) => {
          const isAndroid = /Android/i.test(navigator.userAgent);
          if (isAndroid) {
            e.preventDefault();
            setTimeout(() => loadMore(), 16);
          } else {
            loadMore();
          }
        }}>
          {#if syncing}
            Loading…
          {:else}
            Load more
          {/if}
        </Button>
      {/if}
      {#if authoritativeSyncProgress.running}
        <div style="display:flex; align-items:center; gap:0.5rem; margin-left:0.5rem;">
          <div style="width:160px">
            <div style="height:6px; background:var(--m3-scheme-surface-variant); border-radius:4px; overflow:hidden;">
              <div style="height:100%; background:linear-gradient(90deg, rgb(var(--m3-scheme-primary)), rgb(var(--m3-scheme-primary-container))); width: {Math.min(100, authoritativeSyncProgress.pagesCompleted / Math.max(1, authoritativeSyncProgress.pagesTotal || 1) * 100)}%; transition: width 200ms;"></div>
            </div>
          </div>
          <div style="font-size:0.85rem; color: rgb(var(--m3-scheme-on-surface-variant));">Page {authoritativeSyncProgress.pagesCompleted}/{authoritativeSyncProgress.pagesTotal || '?'}</div>
        </div>
      {/if}
      {#if import.meta.env.DEV}
        <Button variant="outlined" onclick={compareLocalToGmail}>Compare DB ↔ Gmail</Button>
      {/if}
      {#if authoritativeSyncProgress.running}
        <Card variant="outlined" style="display:flex; align-items:center; gap:0.5rem; padding:0.25rem 0.5rem;">
          <span class="m3-font-body-small">
            {#if authoritativeSyncProgress.pagesCompleted === 0}
              Syncing inbox...
            {:else}
              Syncing inbox: {authoritativeSyncProgress.pagesCompleted} pages
            {/if}
          </span>
        </Card>
      {/if}
    </div>
  </div>

  {#if selectedCount > 0}
    <Card variant="elevated" style="margin: 0 0 0.5rem 0;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; flex-wrap:wrap;">
        <div class="m3-font-body-medium" style="display:flex; align-items:center; gap:0.5rem;">
          <label class="m3-font-body-medium" style="display:flex; align-items:center; gap:0.5rem;">
            <Checkbox>
              <input type="checkbox" checked={allVisibleSelected} onchange={(e: Event) => selectAllVisible((e.currentTarget as HTMLInputElement).checked)} />
            </Checkbox>
            Select all ({selectedCount})
          </label>
        </div>
        <div style="display:flex; gap:0.5rem; align-items:center;">
          <Button variant="text" onclick={(e: MouseEvent) => {
            const isAndroid = /Android/i.test(navigator.userAgent);
            if (isAndroid) {
              e.preventDefault();
              setTimeout(() => bulkArchive(), 16);
            } else {
              bulkArchive();
            }
          }}>Archive</Button>
          <Button variant="text" color="error" onclick={(e: MouseEvent) => {
            const isAndroid = /Android/i.test(navigator.userAgent);
            if (isAndroid) {
              e.preventDefault();
              setTimeout(() => bulkDelete(), 16);
            } else {
              bulkDelete();
            }
          }}>Delete</Button>
          <Button variant="text" onclick={(e: MouseEvent) => {
            const isAndroid = /Android/i.test(navigator.userAgent);
            if (isAndroid) {
              e.preventDefault();
              setTimeout(() => bulkSnooze('10m'), 16);
            } else {
              bulkSnooze('10m');
            }
          }} disabled={!can10m}>10m</Button>
          <Button variant="text" onclick={(e: MouseEvent) => {
            const isAndroid = /Android/i.test(navigator.userAgent);
            if (isAndroid) {
              e.preventDefault();
              setTimeout(() => bulkSnooze('3h'), 16);
            } else {
              bulkSnooze('3h');
            }
          }} disabled={!can3h}>3h</Button>
          <Button variant="text" onclick={(e: MouseEvent) => {
            const isAndroid = /Android/i.test(navigator.userAgent);
            if (isAndroid) {
              e.preventDefault();
              setTimeout(() => bulkSnooze('1d'), 16);
            } else {
              bulkSnooze('1d');
            }
          }} disabled={!can1d}>1d</Button>
        </div>
      </div>
    </Card>
  {/if}

  {#if (!visibleThreads || visibleThreads.length === 0)}
    <Card variant="outlined" style="max-width:36rem; margin: 0 auto 1rem;">
      <h3 class="m3-font-title-medium" style="margin:0 0 0.25rem 0">No threads to display</h3>
      {#if debouncedQuery}
        <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">Your search returned no results. Clear the search to see all {totalThreadsCount} threads.</p>
      {:else}
        <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">
          Your inbox is empty! {#if ready && !loading}You can pull forward snoozed emails to get back to work.{:else}If you just connected your account, try reloading or copying diagnostics to share.{/if}
        </p>
      {/if}
      <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:0.75rem;">
        {#if debouncedQuery}
          <Button variant="outlined" onclick={(e: MouseEvent) => {
            const isAndroid = /Android/i.test(navigator.userAgent);
            if (isAndroid) {
              e.preventDefault();
              setTimeout(() => { import('$lib/stores/search').then(m=>m.searchQuery.set('')); }, 16);
            } else {
              import('$lib/stores/search').then(m=>m.searchQuery.set(''));
            }
          }}>Clear search</Button>
        {:else if ready && !loading}
          <Button variant="filled" disabled={pullingForward} onclick={(e: MouseEvent) => {
            const isAndroid = /Android/i.test(navigator.userAgent);
            if (isAndroid) {
              e.preventDefault();
              setTimeout(() => handlePullForward(), 16);
            } else {
              handlePullForward();
            }
          }}>
            {#if pullingForward}
              Pulling forward...
            {:else}
              Pull forward {$settings.pullForwardCount || 3} emails
            {/if}
          </Button>
        {/if}
      </div>
    </Card>
  {/if}
  <div class="inbox-list-wrap" class:locked={listLocked} style="height:70vh">
    <VirtualList items={sortedVisibleThreads} rowHeight={88} getKey={(t: import('$lib/types').GmailThread) => t.threadId} persistKey="inbox:threads">
      {#snippet children(item: import('$lib/types').GmailThread)}
      <ThreadListRow thread={item} />
      {/snippet}
    </VirtualList>
  </div>
{/if}

<style>
  .inbox-list-wrap.locked { pointer-events: none; }
  .sort { position: relative; }
  .sort > summary { list-style: none; }
  .summary-btn { cursor: pointer; }
  .sort[open] > :global(.m3-container) { position: absolute; right: 0; margin-top: 0.25rem; }
</style>


