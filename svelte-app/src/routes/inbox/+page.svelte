<script lang="ts">
  import { onMount } from 'svelte';
  import { initAuth, acquireTokenInteractive } from '$lib/gmail/auth';
  import { listLabels, listInboxMessageIds, getMessageMetadata } from '$lib/gmail/api';
  import { labels as labelsStore } from '$lib/stores/labels';
  import { threads as threadsStore, messages as messagesStore } from '$lib/stores/threads';
  import { getDB } from '$lib/db/indexeddb';
  import { archiveThread, markRead, markUnread, undoLast } from '$lib/queue/intents';
  import { snoozeThreadByRule, manualUnsnoozeThread, isSnoozedThread } from '$lib/snooze/actions';
  import VirtualList from '$lib/utils/VirtualList.svelte';
  import ThreadListRow from '$lib/utils/ThreadListRow.svelte';
  import { snoozeByThread } from '$lib/stores/snooze';

  const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;

  let loading = true;
  let error: string | null = null;
  let nextPageToken: string | undefined;
  let syncing = false;
  import { searchQuery } from '$lib/stores/search';
  let debouncedQuery = '';
  $effect(() => { const id = setTimeout(() => debouncedQuery = $searchQuery, 300); return () => clearTimeout(id); });
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
    } finally {
      syncing = false;
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
  <p>Loading…</p>
{:else}
  <button on:click={signIn}>Sign in with Google</button>
  {#if error}
    <p style="color:red">{error}</p>
  {/if}
  <h3>Inbox</h3>
  <button on:click={() => undoLast(1)}>Undo</button>
  <button disabled={!nextPageToken || syncing} on:click={loadMore}>{syncing ? 'Loading…' : 'Load more'}</button>
  <div style="height:70vh">
    <VirtualList items={visibleThreads} rowHeight={68}>
      {#snippet children(item: import('$lib/types').GmailThread)}
      <ThreadListRow {item} thread={item} />
      {/snippet}
    </VirtualList>
  </div>
{/if}

