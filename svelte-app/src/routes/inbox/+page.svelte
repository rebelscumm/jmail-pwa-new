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
  import Chip from '$lib/forms/Chip.svelte';
  import Checkbox from '$lib/forms/Checkbox.svelte';
  import { snoozeByThread } from '$lib/stores/snooze';
  import { archiveThread, trashThread, undoLast } from '$lib/queue/intents';
  import { snoozeThreadByRule } from '$lib/snooze/actions';
  import { settings } from '$lib/stores/settings';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import iconInbox from '@ktibow/iconset-material-symbols/inbox';
  import iconMarkEmailUnread from '@ktibow/iconset-material-symbols/mark-email-unread';
  import iconSnooze from '@ktibow/iconset-material-symbols/snooze';
  import { getLabel } from '$lib/gmail/api';
  import { trailingHolds } from '$lib/stores/holds';

  let CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;

  let loading = $state(true);
  let ready = $state(false);
  let apiErrorMessage: string | null = $state(null);
  let apiErrorStatus: number | undefined = $state();
  let nextPageToken: string | undefined = $state();
  let syncing = $state(false);
  let copiedDiagOk = $state(false);
  import { searchQuery } from '$lib/stores/search';
  let debouncedQuery = $state('');
  $effect(() => { const id = setTimeout(() => debouncedQuery = $searchQuery, 300); return () => clearTimeout(id); });
  let now = $state(Date.now());
  onMount(() => { const id = setInterval(() => { now = Date.now(); }, 250); return () => clearInterval(id); });
  const inboxThreads = $derived(($threadsStore || []).filter((t) => {
    const inInbox = (t.labelIds || []).includes('INBOX');
    const held = (($trailingHolds || {})[t.threadId] || 0) > now;
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
  // Selection state keyed by threadId
  let selectedMap = $state<Record<string, true>>({});
  const selectedCount = $derived(Object.keys(selectedMap).length);
  const allVisibleSelected = $derived(visibleThreads.length > 0 && visibleThreads.every(t => selectedMap[t.threadId]));
  function toggleSelectThread(threadId: string, next: boolean) {
    if (next) selectedMap = { ...selectedMap, [threadId]: true };
    else { const { [threadId]: _, ...rest } = selectedMap; selectedMap = rest; }
  }
  function selectAllVisible(next: boolean) {
    if (next) {
      const map: Record<string, true> = {};
      for (const t of visibleThreads) map[t.threadId] = true;
      selectedMap = map;
    } else {
      selectedMap = {};
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
    for (const id of ids) await snoozeThreadByRule(id, ruleKey, { optimisticLocal: false });
    selectedMap = {};
    showSnackbar({ message: `Snoozed ${ruleKey}`, actions: { Undo: () => undoLast(ids.length) } });
  }
  const totalThreadsCount = $derived($threadsStore?.length || 0);
  let inboxLabelStats = $state<{ messagesTotal?: number; messagesUnread?: number; threadsTotal?: number; threadsUnread?: number } | null>(null);
  const inboxCount = $derived(inboxLabelStats?.threadsTotal ?? inboxThreads.length);
  const visibleThreadsCount = $derived(visibleThreads?.length || 0);
  const unreadCount = $derived(inboxLabelStats?.threadsUnread ?? inboxThreads.filter((t) => (t.labelIds || []).includes('UNREAD')).length);
  const soonSnoozedCount = $derived(
    (() => {
      try {
        const cutoff = Date.now() + 24 * 60 * 60 * 1000;
        const map = $snoozeByThread || {};
        let count = 0;
        for (const info of Object.values(map)) {
          if (info && typeof info.dueAtUtc === 'number' && info.dueAtUtc <= cutoff) count++;
        }
        return count;
      } catch {
        return 0;
      }
    })()
  );
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
    if (cachedThreads?.length) threadsStore.set(cachedThreads);
    const cachedMessages = await db.getAll('messages');
    if (cachedMessages?.length) {
      const dict: Record<string, import('$lib/types').GmailMessage> = {};
      for (const m of cachedMessages) dict[m.id] = m;
      messagesStore.set(dict);
    }
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
        hadCache = await hydrateFromCache();
        if (hadCache) loading = false;
        navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
          if ((e.data && e.data.type) === 'SYNC_TICK') void hydrateFromCache();
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
    return () => { window.removeEventListener('jmail:refresh', handleGlobalRefresh); unsub(); };
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
    if (cachedThreads?.length) { threadsStore.set(cachedThreads); hasCached = true; }
    const cachedMessages = await db.getAll('messages');
    if (cachedMessages?.length) {
      const dict: Record<string, import('$lib/types').GmailMessage> = {};
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
    const threadList = Object.entries(threadMap).map(([threadId, v]) => ({
      threadId,
      messageIds: v.messageIds,
      lastMsgMeta: v.last,
      labelIds: Object.keys(v.labelIds)
    }));
    // Persist
    const txMsgs = db.transaction('messages', 'readwrite');
    for (const m of msgs) await txMsgs.store.put(m);
    await txMsgs.done;
    const txThreads = db.transaction('threads', 'readwrite');
    for (const t of threadList) await txThreads.store.put(t);
    await txThreads.done;
    threadsStore.set(threadList);
    const msgDict: Record<string, import('$lib/types').GmailMessage> = {};
    for (const m of msgs) msgDict[m.id] = m;
    messagesStore.set(msgDict);
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

  const can10m = $derived(Object.keys($settings.labelMapping || {}).some((k)=>k==='10m' && $settings.labelMapping[k]));
  const can3h = $derived(Object.keys($settings.labelMapping || {}).some((k)=>k==='3h' && $settings.labelMapping[k]));
  const can1d = $derived(Object.keys($settings.labelMapping || {}).some((k)=>k==='1d' && $settings.labelMapping[k]));
</script>

{#if loading}
  <div style="display:grid; place-items:center; height:70vh;">
    <LoadingIndicator />
    <div style="margin-top:0.75rem;">
      <Button variant="text" onclick={copyDiagnostics}>{copiedDiagOk ? 'Copied!' : 'Copy diagnostics'}</Button>
    </div>
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
        <Button variant="text" onclick={copyDiagnostics}>{copiedDiagOk ? 'Copied!' : 'Copy diagnostics'}</Button>
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
      <Chip variant="general" icon={iconInbox} disabled title="Inbox threads" onclick={() => {}}>{inboxCount}</Chip>
      <Chip variant="general" icon={iconMarkEmailUnread} disabled title="Unread threads" onclick={() => {}}>{unreadCount}</Chip>
      <Chip variant="general" icon={iconSnooze} disabled title="Snoozed due in 24h" onclick={() => {}}>{soonSnoozedCount}</Chip>
      <Button variant="text" onclick={copyDiagnostics}>{copiedDiagOk ? 'Copied!' : 'Copy diagnostics'}</Button>
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
        <Button variant="text" onclick={copyDiagnostics}>{copiedDiagOk ? 'Copied!' : 'Copy diagnostics'}</Button>
        {#if debouncedQuery}
          <Button variant="outlined" onclick={() => { import('$lib/stores/search').then(m=>m.searchQuery.set('')); }}>Clear search</Button>
        {/if}
      </div>
    </Card>
  {/if}
  <div style="height:70vh">
    <VirtualList items={visibleThreads} rowHeight={96} getKey={(t) => t.threadId}>
      {#snippet children(item: import('$lib/types').GmailThread)}
      <ThreadListRow thread={item} selected={!!selectedMap[item.threadId]} onToggleSelected={(next) => toggleSelectThread(item.threadId, next)} />
      {/snippet}
    </VirtualList>
  </div>
{/if}

<style></style>

