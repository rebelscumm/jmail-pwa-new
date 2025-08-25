<script lang="ts">
  import { onMount } from 'svelte';
  import { initAuth, acquireTokenInteractive, authState, getAuthDiagnostics, resolveGoogleClientId } from '$lib/gmail/auth';
  import { listLabels, listInboxMessageIds, getMessageMetadata, GmailApiError, getProfile, copyGmailDiagnosticsToClipboard, getAndClearGmailDiagnostics } from '$lib/gmail/api';
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
  let CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;

  let loading = $state(true);
  let ready = $state(false);
  let apiErrorMessage: string | null = $state(null);
  let apiErrorStatus: number | undefined = $state();
  let nextPageToken: string | undefined = $state();
  let syncing = $state(false);
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
    // Keep threads with pending AI subject at the bottom until ready
    try {
      const ready = arr.filter((t) => ((t as any).aiSubjectStatus || 'none') !== 'pending');
      const pending = arr.filter((t) => ((t as any).aiSubjectStatus || 'none') === 'pending');
      return [...ready, ...pending];
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
      const merged = [...current, ...cachedThreads].reduce((acc, t) => {
        const idx = acc.findIndex((x) => x.threadId === t.threadId);
        if (idx >= 0) acc[idx] = t; else acc.push(t);
        return acc;
      }, [] as typeof current);
      threadsStore.set(merged);
    }
    const cachedMessages = await db.getAll('messages');
    if (cachedMessages?.length) {
      const dict: Record<string, import('$lib/types').GmailMessage> = { ...$messagesStore };
      for (const m of cachedMessages) dict[m.id] = m;
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
        // Clear stale local cache before fetching fresh data
        try { await resetInboxCache(); } catch {}
        await hydrate();
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
          const idx = acc.findIndex((x) => x.threadId === t.threadId);
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

    // Messages + Threads (first 25) and label stats for accurate counts
    // Optional profile ping only in dev for diagnostics
    if (import.meta.env.DEV) { try { await getProfile(); } catch (_) {} }
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
    const page = await listInboxMessageIds(25);
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
            summaryVersion: prev.summaryVersion,
            summaryUpdatedAt: prev.summaryUpdatedAt,
            bodyHash: prev.bodyHash,
            aiSubject: (prev as any).aiSubject,
            aiSubjectStatus: (prev as any).aiSubjectStatus,
            subjectVersion: (prev as any).subjectVersion,
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
    const current = $threadsStore || [];
    const merged = [...current, ...threadList].reduce((acc, t) => {
      const idx = acc.findIndex((x) => x.threadId === t.threadId);
      if (idx >= 0) acc[idx] = { ...acc[idx], ...t } as any; else acc.push(t);
      return acc;
    }, [] as typeof current);
    threadsStore.set(merged);
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
  }

  async function loadMore() {
    if (!nextPageToken) return;
    syncing = true;
    try {
      const page = await listInboxMessageIds(25, nextPageToken);
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
            : await aiSummarizeEmail(p.subject, p.bodyText, p.bodyHtml);
          const text = await aiSummarizeSubject(p.subject, undefined, undefined, messageSummary);
          return { id: p.t.threadId, ok: true, text } as const;
        } catch (e) {
          return { id: p.t.threadId, ok: false, error: e } as const;
        }
      });

      // Persist and update store
      const tx = db.transaction('threads', 'readwrite');
      const nowMs = Date.now();
      const nowVersion = Number($settings.aiSummaryVersion || 1);
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

