<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { initAuth, acquireTokenInteractive, authState, getAuthDiagnostics, resolveGoogleClientId } from '$lib/gmail/auth';
  import { listLabels, listInboxMessageIds, listThreadIdsByLabelId, getMessageMetadata, GmailApiError, getProfile, copyGmailDiagnosticsToClipboard, getAndClearGmailDiagnostics, listHistory, getThreadSummary } from '$lib/gmail/api';
  import { labels as labelsStore } from '$lib/stores/labels';
  import { threads as threadsStore, messages as messagesStore } from '$lib/stores/threads';
  import { getDB } from '$lib/db/indexeddb';
  import VirtualList from '$lib/utils/VirtualList.svelte';
  import ThreadListRow from '$lib/utils/ThreadListRow.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import Card from '$lib/containers/Card.svelte';
  import LoadingIndicator from '$lib/forms/LoadingIndicator.svelte';
  
  import Checkbox from '$lib/forms/Checkbox.svelte';
  
  import { archiveThread, trashThread, undoLast } from '$lib/queue/intents';
  import { snoozeThreadByRule } from '$lib/snooze/actions';
  import { settings, updateAppSettings } from '$lib/stores/settings';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  
  import { getLabel } from '$lib/gmail/api';
  import { trailingHolds } from '$lib/stores/holds';
  import Menu from '$lib/containers/Menu.svelte';
  import MenuItem from '$lib/containers/MenuItem.svelte';
  import { searchQuery } from '$lib/stores/search';
  import FilterBar from '$lib/utils/FilterBar.svelte';
  import { filters as filtersStore, applyFilterToThreads, loadFilters } from '$lib/stores/filters';
  import { aiSummarizeSubject, aiSummarizeEmail } from '$lib/ai/providers';

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
  let apiErrorMessage: string | null = $state(null);
  let apiErrorStatus: number | undefined = $state();
  let nextPageToken: string | undefined = $state();
  let syncing = $state(false);
  let authoritativeSyncProgress = $state({ running: false, pagesCompleted: 0, pagesTotal: 0 });
  let copiedDiagOk = $state(false);
  let debouncedQuery = $state('');
  $effect(() => { const id = setTimeout(() => debouncedQuery = $searchQuery, 300); return () => clearTimeout(id); });
  let now = $state(Date.now());
  onMount(() => { const id = setInterval(() => { now = Date.now(); }, 250); return () => clearInterval(id); });
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
      const differs = remoteThreadsTotal !== localThreadsTotal || remoteThreadsUnread !== localThreadsUnread;
      try { if (import.meta.env.DEV) console.debug('[InboxUI] remoteCheck', { remoteThreadsTotal, localThreadsTotal, remoteThreadsUnread, localThreadsUnread, differs }); } catch {}
      if (differs) {
        try { syncing = true; await hydrate(); } finally { syncing = false; }
      }
    } catch (_) {
      // ignore transient errors
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
            try {
              const existing = await txThreads.store.get(threadId) as any;
              if (!existing) continue;
              // Apply label changes present in history entry
              if (h.labelsAdded || h.labelsRemoved) {
                const labels = Array.isArray(existing.labelIds) ? existing.labelIds.slice() : [];
                for (const la of (h.labelsAdded || [])) { if (!labels.includes(la)) labels.push(la); }
                for (const lr of (h.labelsRemoved || [])) { const idx = labels.indexOf(lr); if (idx >= 0) labels.splice(idx, 1); }
                const next = { ...existing, labelIds: labels } as any;
                await txThreads.store.put(next);
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
      await txMsgs.done;
      await txThreads.done;
      // Notify user when there were actual changes applied by history so the
      // update is visible but non-disruptive. If no changes, stay silent.
      try { showSnackbar({ message: 'Inbox synchronized', timeout: 2000 }); } catch (_) {}
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
  const inboxThreads = $derived(($threadsStore || []).filter((t) => {
    // Guard against undefined/partial entries
    if (!t || typeof (t as any).threadId !== 'string') return false;
    const labels = Array.isArray((t as any).labelIds) ? ((t as any).labelIds as string[]) : [];
    const inInbox = labels.includes('INBOX');
    const held = (($trailingHolds || {})[(t as any).threadId] || 0) > now;
    return inInbox || held;
  }));
  const visibleThreads = $derived(
    !debouncedQuery
      ? inboxThreads
      : inboxThreads.filter((t) => {
          const subj = (t.lastMsgMeta.subject || '').toLowerCase();
          const from = (t.lastMsgMeta.from || '').toLowerCase();
          const q = debouncedQuery.toLowerCase();
          return subj.includes(q) || from.includes(q);
        })
  );
  const filteredThreads = $derived(applyFilterToThreads(visibleThreads, $messagesStore || {}, $filtersStore.active));
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
  const sortedVisibleThreads = $derived((() => {
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
  })());
  const currentSortLabel = $derived((sortOptions.find(o => o.key === currentSort)?.label) || 'Date (newest first)');
  function setSort(next: InboxSort) { updateAppSettings({ inboxSort: next }); }
  // Selection state keyed by threadId
  let selectedMap = $state<Record<string, true>>({});
  const selectedCount = $derived(Object.keys(selectedMap).length);
  const allVisibleSelected = $derived(filteredThreads.length > 0 && filteredThreads.every(t => selectedMap[t.threadId]));
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
    for (const id of ids) await archiveThread(id, { optimisticLocal: false });
    selectedMap = {};
    showSnackbar({ message: 'Archived', actions: { Undo: () => undoLast(ids.length) } });
  }
  async function bulkDelete() {
    const ids = Object.keys(selectedMap);
    if (!ids.length) return;
    for (const id of ids) await trashThread(id, { optimisticLocal: false });
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
  const totalThreadsCount = $derived($threadsStore?.length || 0);
  let inboxLabelStats = $state<{ messagesTotal?: number; messagesUnread?: number; threadsTotal?: number; threadsUnread?: number } | null>(null);
  const visibleThreadsCount = $derived(filteredThreads?.length || 0);
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
      function threadLastActivity(th: any) {
        try { return Math.max(Number(th?.lastMsgMeta?.date) || 0, Number((th as any).aiSubjectUpdatedAt) || 0, Number((th as any).summaryUpdatedAt) || 0); } catch { return 0; }
      }
      const merged = current.slice();
      for (const t of cachedThreads) {
        const idx = merged.findIndex((x: any) => x.threadId === t.threadId);
        if (idx >= 0) {
          try {
            const existing = merged[idx];
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
      threadsStore.set(merged);
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

  onMount(() => {
    const unsub = authState.subscribe((s) => (ready = s.ready));
    if (($threadsStore || []).length) loading = false;
    (async () => {
      let hadCache = false;
      try {
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
          }
        });
        // Attempt initial remote hydrate without blocking UI if cache exists
        try {
          syncing = true;
          await hydrate();
        } catch (e) {
          setApiError(e);
        } finally {
          syncing = false;
        }
      } catch (e) {
        setApiError(e);
      } finally {
        if (!hadCache) loading = false;
      }
    })();
    // Listen for global refresh requests
    async function handleGlobalRefresh() {
      try {
        showSnackbar({ message: 'Refreshing inbox…' });
        syncing = true;
        // Perform a full authoritative INBOX sync (pages through all messages)
        // to reconcile removals performed on other devices.
        await performAuthoritativeInboxSync();
        showSnackbar({ message: 'Inbox up to date', timeout: 3000 });
      } catch (e) {
        setApiError(e);
        showSnackbar({ message: `Refresh failed: ${e instanceof Error ? e.message : e}`, closable: true });
      } finally {
        syncing = false;
      }
    }
    window.addEventListener('jmail:refresh', handleGlobalRefresh);
    // Expose for debugging/manual trigger
    try { (window as any).__jmailRefresh = () => window.dispatchEvent(new CustomEvent('jmail:refresh')); } catch {}
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('jmail:refresh', handleGlobalRefresh); window.removeEventListener('keydown', onKeyDown); unsub(); };
  });

  function setApiError(e: unknown) {
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
      const pageSize = 500; // reasonably large page for manual full sync
      let pageToken: string | undefined = undefined;
      const seenThreadIds = new Set<string>();
      authoritativeSyncProgress = { running: true, pagesCompleted: 0, pagesTotal: 0 };

      // Stream thread ids (preferred) rather than messages to avoid missing
      // threads due to message-level pagination nuances.
      while (true) {
        // Attempt to fetch a page with a per-page timeout and retry policy
        let page: { ids: string[]; nextPageToken?: string } | null = null;
        let attempt = 0;
        while (attempt <= maxRetries && !page) {
          attempt += 1;
          try {
            page = await Promise.race([
              listThreadIdsByLabelId('INBOX', pageSize, pageToken),
              new Promise((_, rej) => setTimeout(() => rej(new Error('page_timeout')), perPageTimeoutMs))
            ]) as any;
          } catch (e) {
            if (attempt > maxRetries) throw e; // escalate after retries
            // small backoff
            await new Promise((res) => setTimeout(res, 500 * attempt));
          }
        }
        if (!page) break; // defensive
        // Update progress info
        authoritativeSyncProgress = { ...authoritativeSyncProgress, pagesCompleted: authoritativeSyncProgress.pagesCompleted + 1 };
        const pageResolved = page as { ids: string[]; nextPageToken?: string };
        pageToken = pageResolved.nextPageToken;
        if (!pageResolved.ids || !pageResolved.ids.length) {
          if (!pageToken) break; else continue;
        }
        const ids = pageResolved.ids;
        // For threads on this page, fetch summaries only for those missing or
        // needing update in local DB to keep network usage reasonable.
        const toFetch: string[] = [];
        for (const tid of page.ids) {
          try {
            const existing = await db.get('threads', tid) as any | undefined;
            if (!existing) toFetch.push(tid);
            seenThreadIds.add(tid);
          } catch (_) { seenThreadIds.add(tid); toFetch.push(tid); }
        }
        // Fetch thread summaries with modest concurrency
        const fetched = await mapWithConcurrency(toFetch, 4, async (tid) => {
          try { return await getThreadSummary(tid); } catch (e) { return null; }
        });
        const txMsgs = db.transaction('messages', 'readwrite');
        const txThreads = db.transaction('threads', 'readwrite');
        for (const f of fetched) {
          if (!f) continue;
          try {
            for (const m of f.messages) {
              try { await txMsgs.store.put(m); } catch (_) {}
            }
            try { await txThreads.store.put(f.thread); } catch (_) {}
          } catch (_) {}
        }
        await txMsgs.done;
        await txThreads.done;
        if (!pageToken) break;
      }

      // Reconcile threads in DB: remove INBOX label from threads not seen
      const txThreads = db.transaction('threads', 'readwrite');
      const allThreads = await txThreads.store.getAll();
      for (const t of (allThreads || [])) {
        try {
          const labels = Array.isArray(t.labelIds) ? t.labelIds.slice() : [];
          if (labels.includes('INBOX') && !seenThreadIds.has(t.threadId)) {
            const next = { ...t, labelIds: labels.filter((l) => l !== 'INBOX') } as any;
            await txThreads.store.put(next);
          }
        } catch (_) {}
      }
      await txThreads.done;
      authoritativeSyncProgress = { ...authoritativeSyncProgress, running: false };

      // Refresh in-memory store from authoritative DB state
      try {
        const refreshed = await db.getAll('threads');
        threadsStore.set(refreshed as any);
      } catch (_) {}
    } catch (e) {
      // Surface a subtle telemetry snackbar so user can retry if needed
      try { showSnackbar({ message: 'Full sync failed', timeout: 5000, actions: { 'Retry': () => { void performAuthoritativeInboxSync(); } } }); } catch (_) {}
      throw e;
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
      await acquireTokenInteractive('consent', 'inbox_signin_click');
      await hydrate();
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
        const merged = [...current, ...cachedThreads].reduce((acc, t) => {
          const idx = acc.findIndex((candidate: any) => candidate.threadId === t.threadId);
          if (idx >= 0) acc[idx] = t; else acc.push(t);
          return acc;
        }, [] as typeof current);
        threadsStore.set(merged);
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
          const carry: import('$lib/types').GmailThread = {
            ...base,
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
    // Persist
    const txMsgs = db.transaction('messages', 'readwrite');
    for (const m of msgs) await txMsgs.store.put(m);
    await txMsgs.done;
    const txThreads = db.transaction('threads', 'readwrite');
    for (const t of threadList) await txThreads.store.put(t);
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
      // Update existing in-memory entries with DB authoritative fields
      const merged = current.map((c) => dbById[c.threadId] ? { ...c, ...dbById[c.threadId] } : c);
      // Append any DB-only threads after existing UI list (non-disruptive)
      for (const t of (allThreads || [])) {
        if (!merged.find((m) => m.threadId === t.threadId)) merged.push(t as any);
      }
      threadsStore.set(merged as any);
    } catch (e) {
      // Fallback: conservative merge of newly fetched threads into memory
      const current = $threadsStore || [];
      const merged = [...current, ...threadList].reduce((acc, t) => {
        const idx = acc.findIndex((candidate: any) => candidate.threadId === t.threadId);
        if (idx >= 0) acc[idx] = { ...acc[idx], ...t } as any; else acc.push(t);
        return acc;
      }, [] as typeof current);
      threadsStore.set(merged);
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
                  showSnackbar({ message: `AI precompute is disabled in Settings. Enable Precompute summaries to allow background AI processing.\n${rootCauses}`, timeout: 9000, actions: { 'Open Settings': () => { location.href = '/settings'; } } });
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
      threadsStore.set(merged);
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
    }
  }

  async function copyDiagnostics() {
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
  }

  if (typeof window !== 'undefined') {
    (window as any).__copyPageDiagnostics = async () => { await copyDiagnostics(); };
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

  const can10m = $derived(Object.keys($settings.labelMapping || {}).some((k)=>k==='10m' && $settings.labelMapping[k]));
  const can3h = $derived(Object.keys($settings.labelMapping || {}).some((k)=>k==='3h' && $settings.labelMapping[k]));
  const can1d = $derived(Object.keys($settings.labelMapping || {}).some((k)=>k==='1d' && $settings.labelMapping[k]));

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
        <Button variant="filled" onclick={signIn}>Sign in with Google</Button>
      </div>
    </Card>
  {:else if apiErrorMessage}
    <Card variant="outlined" style="max-width:36rem; margin: 0 auto 1rem;">
      <h3 class="m3-font-title-medium" style="margin:0 0 0.25rem 0">Something went wrong</h3>
      <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">{apiErrorMessage}</p>
      <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:0.75rem;">
        <Button variant="text" onclick={() => { apiErrorMessage = null; apiErrorStatus = undefined; }}>Dismiss</Button>
        <Button variant="filled" onclick={signIn}>Try again</Button>
      </div>
    </Card>
  {/if}

  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.5rem; gap:0.5rem;">
    <h3 class="m3-font-title-medium" style="margin:0">Inbox</h3>
    <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
      
      <details class="sort">
        <summary class="summary-btn">
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
      <Button variant="outlined" disabled={!nextPageToken || syncing} onclick={loadMore}>
        {#if syncing}
          Loading…
        {:else}
          Load more
        {/if}
      </Button>
      {#if authoritativeSyncProgress.running}
        <Card variant="outlined" style="display:flex; align-items:center; gap:0.5rem; padding:0.25rem 0.5rem;">
          <span class="m3-font-body-small">Syncing inbox: {authoritativeSyncProgress.pagesCompleted} pages</span>
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
          <Button variant="text" onclick={bulkArchive}>Archive</Button>
          <Button variant="text" color="error" onclick={bulkDelete}>Delete</Button>
          <Button variant="text" onclick={() => bulkSnooze('10m')} disabled={!can10m}>10m</Button>
          <Button variant="text" onclick={() => bulkSnooze('3h')} disabled={!can3h}>3h</Button>
          <Button variant="text" onclick={() => bulkSnooze('1d')} disabled={!can1d}>1d</Button>
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
        <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">If you just connected your account, try reloading or copying diagnostics to share.</p>
      {/if}
      <div style="display:flex; gap:0.5rem; justify-content:flex-end; margin-top:0.75rem;">
        {#if debouncedQuery}
          <Button variant="outlined" onclick={() => { import('$lib/stores/search').then(m=>m.searchQuery.set('')); }}>Clear search</Button>
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

