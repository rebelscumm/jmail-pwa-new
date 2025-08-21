<script lang="ts">
  import { onMount } from 'svelte';
  import { initAuth, acquireTokenInteractive } from '$lib/gmail/auth';
  import { listLabels, listInboxMessageIds, getMessageMetadata } from '$lib/gmail/api';
  import { labels as labelsStore } from '$lib/stores/labels';
  import { threads as threadsStore, messages as messagesStore } from '$lib/stores/threads';
  import { getDB } from '$lib/db/indexeddb';
  import { archiveThread, markRead, markUnread, undoLast } from '$lib/queue/intents';
  import { snoozeThreadByRule } from '$lib/snooze/actions';
  import VirtualList from '$lib/utils/VirtualList.svelte';

  const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;

  let loading = true;
  let error: string | null = null;
  let nextPageToken: string | undefined;
  let syncing = false;
  let query = '';
  let debouncedQuery = '';
  $effect(() => { const id = setTimeout(() => debouncedQuery = query, 300); return () => clearTimeout(id); });
  const visibleThreads = $derived(
    !debouncedQuery
      ? $threadsStore
      : $threadsStore.filter((t) => {
          const subj = (t.lastMsgMeta.subject || '').toLowerCase();
          const from = (t.lastMsgMeta.from || '').toLowerCase();
          const q = debouncedQuery.toLowerCase();
          return subj.includes(q) || from.includes(q);
        })
  );

  onMount(async () => {
    try {
      await initAuth(CLIENT_ID);
      // Load settings first for snooze defaults
      const { loadSettings } = await import('$lib/stores/settings');
      await loadSettings();
      await hydrateFromCache();
      navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
        if ((e.data && e.data.type) === 'SYNC_TICK') void hydrateFromCache();
      });
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
    }
    loading = false;
  });

  async function signIn() {
    error = null;
    try {
      await acquireTokenInteractive();
      await hydrate();
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
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
    const page = await listInboxMessageIds(25);
    nextPageToken = page.nextPageToken;
    const msgs = await Promise.all(page.ids.map((id) => getMessageMetadata(id)));
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
      const msgs = await Promise.all(page.ids.map((id) => getMessageMetadata(id)));
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
    } finally {
      syncing = false;
    }
  }
</script>

{#if loading}
  <p>Loading…</p>
{:else}
  <button on:click={signIn}>Sign in with Google</button>
  {#if error}
    <p style="color:red">{error}</p>
  {/if}
  <h3>Inbox</h3>
  <button on:click={() => undoLast(1)}>Undo</button>
  <button disabled={!nextPageToken || syncing} on:click={loadMore}>{syncing ? 'Loading…' : 'Load more'}</button>
  <input placeholder="Search" bind:value={query} style="margin-left:0.5rem; height:2rem;" />
  <div style="height:70vh">
    <VirtualList items={visibleThreads} rowHeight={68}>
      {#snippet children(item: import('$lib/types').GmailThread)}
      <div style="display:flex; align-items:center; gap:0.5rem; overflow:hidden">
        <input type="checkbox" aria-label="Select thread" />
        <a href={`/viewer/${item.threadId}`} style="flex:1; min-width:0; white-space:nowrap; text-overflow:ellipsis; overflow:hidden">{item.lastMsgMeta.subject}</a>
        <small style="white-space:nowrap">{item.lastMsgMeta.from}</small>
        <button on:click={() => archiveThread(item.threadId)}>Archive</button>
        {#if item.labelIds && item.labelIds.includes('UNREAD')}
          <button on:click={() => markRead(item.threadId)}>Mark read</button>
        {:else}
          <button on:click={() => markUnread(item.threadId)}>Mark unread</button>
        {/if}
        <button on:click={() => snoozeThreadByRule(item.threadId, '10m')}>10m</button>
        <button on:click={() => snoozeThreadByRule(item.threadId, '3h')}>3h</button>
        <button on:click={() => snoozeThreadByRule(item.threadId, '1d')}>1d</button>
      </div>
      {/snippet}
    </VirtualList>
  </div>
{/if}

