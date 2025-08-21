<script lang="ts">
  import { onMount } from 'svelte';
  import { initAuth, acquireTokenInteractive } from '$lib/gmail/auth';
  import { listLabels, listInboxMessageIds, getMessageMetadata } from '$lib/gmail/api';
  import { labels as labelsStore } from '$lib/stores/labels';
  import { threads as threadsStore, messages as messagesStore } from '$lib/stores/threads';
  import { getDB } from '$lib/db/indexeddb';
  import { archiveThread, markRead, markUnread } from '$lib/queue/intents';
  import { snoozeThreadByRule } from '$lib/snooze/actions';

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
    const ids = await listInboxMessageIds(25);
    const msgs = await Promise.all(ids.map((id) => getMessageMetadata(id)));
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
        <button on:click={() => archiveThread(t.threadId)}>Archive</button>
        {#if t.labelIds && t.labelIds.includes('UNREAD')}
          <button on:click={() => markRead(t.threadId)}>Mark read</button>
        {:else}
          <button on:click={() => markUnread(t.threadId)}>Mark unread</button>
        {/if}
        <!-- Quick snooze chips -->
        <button on:click={() => snoozeThreadByRule(t.threadId, '10m')}>10m</button>
        <button on:click={() => snoozeThreadByRule(t.threadId, '3h')}>3h</button>
        <button on:click={() => snoozeThreadByRule(t.threadId, '1d')}>1d</button>
      </li>
    {/each}
  </ul>
{/if}

