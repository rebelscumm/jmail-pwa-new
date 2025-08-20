<script lang="ts">
  import { onMount } from 'svelte';
  import { initAuth, acquireTokenInteractive } from '$lib/gmail/auth';
  import { listLabels, listInboxMessageIds, getMessageMetadata } from '$lib/gmail/api';
  import { labels as labelsStore } from '$lib/stores/labels';
  import { threads as threadsStore, messages as messagesStore } from '$lib/stores/threads';
  import { getDB } from '$lib/db/indexeddb';

  const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;

  let loading = true;
  let error: string | null = null;

  onMount(async () => {
    try {
      await initAuth(CLIENT_ID);
      await hydrateFromCache();
      navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
        if ((e.data && e.data.type) === 'SYNC_TICK') void hydrateFromCache();
      });
    } catch (e: any) {
      error = String(e?.message || e);
    }
    loading = false;
  });

  async function signIn() {
    error = null;
    try {
      await acquireTokenInteractive();
      await hydrate();
    } catch (e: any) {
      error = String(e?.message || e);
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
      const dict: Record<string, any> = {};
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
    const ids = await listInboxMessageIds(25);
    const msgs = await Promise.all(ids.map((id) => getMessageMetadata(id)));
    const threadMap = new Map<string, { messageIds: string[]; labelIds: Set<string>; last: { from?: string; subject?: string; date?: number } }>();
    for (const m of msgs) {
      const entry = threadMap.get(m.threadId) || { messageIds: [], labelIds: new Set<string>(), last: {} };
      entry.messageIds.push(m.id);
      m.labelIds.forEach((x) => entry.labelIds.add(x));
      const date = m.internalDate || Date.parse(m.headers?.Date || '');
      if (!entry.last.date || (date && date > entry.last.date)) {
        entry.last = { from: m.headers?.From, subject: m.headers?.Subject, date };
      }
      threadMap.set(m.threadId, entry);
    }
    const threadList = Array.from(threadMap.entries()).map(([threadId, v]) => ({
      threadId,
      messageIds: v.messageIds,
      lastMsgMeta: v.last,
      labelIds: Array.from(v.labelIds)
    }));
    // Persist
    const txMsgs = db.transaction('messages', 'readwrite');
    for (const m of msgs) await txMsgs.store.put(m);
    await txMsgs.done;
    const txThreads = db.transaction('threads', 'readwrite');
    for (const t of threadList) await txThreads.store.put(t);
    await txThreads.done;
    threadsStore.set(threadList);
    const msgDict: Record<string, any> = {};
    for (const m of msgs) msgDict[m.id] = m;
    messagesStore.set(msgDict);
  }
</script>

{#if loading}
  <p>Loading…</p>
{:else}
  <button on:click={signIn}>Sign in with Google</button>
  {#if error}
    <p style="color:red">{error}</p>
  {/if}
  <h3>Inbox (first 25)</h3>
  <ul>
    {#each $threadsStore as t}
      <li>
        <a href={`/viewer/${t.threadId}`}>{t.lastMsgMeta.subject}</a>
        <small> — {t.lastMsgMeta.from}</small>
      </li>
    {/each}
  </ul>
{/if}

