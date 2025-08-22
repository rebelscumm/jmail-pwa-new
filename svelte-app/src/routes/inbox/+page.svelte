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

  let CLIENT_ID: string = (import.meta as any)?.env?.VITE_GOOGLE_CLIENT_ID as string;

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
  const inboxThreads = $derived(($threadsStore || []).filter((t) => (t.labelIds || []).includes('INBOX')));
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
  const totalThreadsCount = $derived($threadsStore?.length || 0);
  const visibleThreadsCount = $derived(visibleThreads?.length || 0);
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

  onMount(() => {
    const unsub = authState.subscribe((s) => (ready = s.ready));
    (async () => {
      try {
        CLIENT_ID = CLIENT_ID || resolveGoogleClientId() as string;
        await initAuth(CLIENT_ID);
        // Load settings first for snooze defaults
        const { loadSettings } = await import('$lib/stores/settings');
        await loadSettings();
        await hydrateFromCache();
        navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
          if ((e.data && e.data.type) === 'SYNC_TICK') void hydrateFromCache();
        });
        // Attempt initial remote hydrate
        try {
          await hydrate();
        } catch (e) {
          setApiError(e);
        }
      } catch (e) {
        setApiError(e);
      } finally {
        loading = false;
      }
    })();
    return () => unsub();
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
      await acquireTokenInteractive('consent');
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
    const cachedLabels = await db.getAll('labels');
    if (cachedLabels?.length) labelsStore.set(cachedLabels);
    const cachedThreads = await db.getAll('threads');
    if (cachedThreads?.length) threadsStore.set(cachedThreads);
    const cachedMessages = await db.getAll('messages');
    if (cachedMessages?.length) {
      const dict: Record<string, import('$lib/types').GmailMessage> = {};
      for (const m of cachedMessages) dict[m.id] = m;
      messagesStore.set(dict);
    }
  }

  async function hydrate() {
    const db = await getDB();
    // Labels
    const remoteLabels = await listLabels();
    const tx = db.transaction('labels', 'readwrite');
    for (const l of remoteLabels) await tx.store.put(l);
    await tx.done;
    labelsStore.set(remoteLabels);

    // Messages + Threads (first 25)
    // Optional profile ping only in dev for diagnostics
    if (import.meta.env.DEV) { try { await getProfile(); } catch (_) {} }
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
    <div style="display:flex; gap:0.5rem; align-items:center;">
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
    <VirtualList items={visibleThreads} rowHeight={68} getKey={(t) => t.threadId}>
      {#snippet children(item: import('$lib/types').GmailThread)}
      <ThreadListRow thread={item} />
      {/snippet}
    </VirtualList>
  </div>
{/if}

