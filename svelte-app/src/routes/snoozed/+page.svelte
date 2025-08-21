<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { getDB } from '$lib/db/indexeddb';
  import { listMessageIdsByLabelId, getMessageMetadata } from '$lib/gmail/api';
  import { labels as labelsStore } from '$lib/stores/labels';
  import { threads as threadsStore, messages as messagesStore } from '$lib/stores/threads';
  import { settings } from '$lib/stores/settings';
  import VirtualList from '$lib/utils/VirtualList.svelte';
  import { manualUnsnoozeThread, isSnoozedThread } from '$lib/snooze/actions';

  let loading = true;
  let error: string | null = null;
  let nextPageToken: string | undefined;
  let activeLabelId: string | null = null;
  let labelOptions: { id: string; name: string }[] = [];
  let syncing = false;

  onMount(async () => {
    try {
      // derive snooze labels from mapping
      const s = get(settings);
      const snoozeIds = Array.from(new Set(Object.values(s.labelMapping || {}).filter(Boolean)));
      const mapName: Record<string, string> = {};
      for (const l of get(labelsStore)) mapName[l.id] = l.name;
      labelOptions = snoozeIds.map((id) => ({ id, name: mapName[id] || id }));
      activeLabelId = snoozeIds[0] || null;
      if (activeLabelId) await hydrate(activeLabelId);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
    }
    loading = false;
  });

  async function hydrate(labelId: string) {
    const db = await getDB();
    const page = await listMessageIdsByLabelId(labelId, 25);
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
    if (!activeLabelId || !nextPageToken) return;
    syncing = true;
    try {
      const page = await listMessageIdsByLabelId(activeLabelId, 25, nextPageToken);
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

<h3>Snoozed</h3>
{#if labelOptions.length > 1}
  <label>
    Label:
    <select bind:value={activeLabelId} on:change={(e)=>{ const id=(e.currentTarget as HTMLSelectElement).value; threadsStore.set([]); messagesStore.set({}); hydrate(id); }}>
      {#each labelOptions as opt}
        <option value={opt.id}>{opt.name}</option>
      {/each}
    </select>
  </label>
{/if}

{#if loading}
  <p>Loading…</p>
{:else if error}
  <p style="color:red">{error}</p>
{:else if !activeLabelId}
  <p>No snooze labels configured. Map them in Settings.</p>
{:else}
  <button disabled={!nextPageToken || syncing} on:click={loadMore}>{syncing ? 'Loading…' : 'Load more'}</button>
  <div style="height:70vh">
    <VirtualList items={$threadsStore} rowHeight={68}>
      {#snippet children(item: import('$lib/types').GmailThread)}
      <div style="display:flex; align-items:center; gap:0.5rem; overflow:hidden">
        <a href={`/viewer/${item.threadId}`} style="flex:1; min-width:0; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; font-weight:{item.labelIds?.includes('UNREAD') ? 'bold' : 'normal'}">{item.lastMsgMeta.subject}</a>
        <small style="white-space:nowrap">{item.lastMsgMeta.from}</small>
        {#if isSnoozedThread(item)}
          <button on:click={() => manualUnsnoozeThread(item.threadId)}>Unsnooze</button>
        {/if}
      </div>
      {/snippet}
    </VirtualList>
  </div>
{/if}


