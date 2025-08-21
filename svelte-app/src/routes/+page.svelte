<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { base } from '$app/paths';
  import ListItem from '$lib/containers/ListItem.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import { initAuth, acquireTokenInteractive, authState } from '$lib/gmail/auth';
  import { getDB } from '$lib/db/indexeddb';
  import { listLabels, listInboxMessageIds, getMessageMetadata } from '$lib/gmail/api';
  import { labels as labelsStore } from '$lib/stores/labels';
  import { threads as threadsStore, messages as messagesStore } from '$lib/stores/threads';

  const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
  let loading = true;
  let ready = false;
  let hasAccount = false;

  onMount(async () => {
    await initAuth(CLIENT_ID).catch(()=>{});
    authState.subscribe((s)=> ready = s.ready)();
    const db = await getDB();
    const account = await db.get('auth', 'me');
    hasAccount = !!account;
    if (hasAccount) {
      await hydrate();
    }
    loading = false;
  });

  async function connect() {
    await acquireTokenInteractive();
    hasAccount = true;
    await hydrate();
  }

  async function hydrate() {
    const db = await getDB();
    const remoteLabels = await listLabels();
    const tx = db.transaction('labels', 'readwrite');
    for (const l of remoteLabels) await tx.store.put(l);
    await tx.done;
    labelsStore.set(remoteLabels);
    const page = await listInboxMessageIds(25);
    const msgs = await Promise.all(page.ids.map((id) => getMessageMetadata(id)));
    const threadMap: Record<string, { messageIds: string[]; labelIds: Record<string, true>; last: { from?: string; subject?: string; date?: number } }> = {};
    for (const m of msgs) {
      const existing = threadMap[m.threadId] || { messageIds: [], labelIds: {}, last: {} };
      existing.messageIds.push(m.id);
      for (const x of m.labelIds) existing.labelIds[x] = true;
      const date = m.internalDate || Date.parse(m.headers?.Date || '');
      if (!existing.last.date || (date && date > existing.last.date)) existing.last = { from: m.headers?.From, subject: m.headers?.Subject, date };
      threadMap[m.threadId] = existing;
    }
    const threadList = Object.entries(threadMap).map(([threadId, v]) => ({ threadId, messageIds: v.messageIds, lastMsgMeta: v.last, labelIds: Object.keys(v.labelIds) }));
    const txMsgs = db.transaction('messages', 'readwrite');
    for (const m of msgs) await txMsgs.store.put(m);
    await txMsgs.done;
    const txThreads = db.transaction('threads', 'readwrite');
    for (const t of threadList) await txThreads.store.put(t);
    await txThreads.done;
    threadsStore.set(threadList);
    const msgDict: Record<string, import('$lib/types').GmailMessage> = {}; for (const m of msgs) msgDict[m.id] = m; messagesStore.set(msgDict);
    // Navigate to inbox
    window.location.href = `${base}/inbox`;
  }
</script>

{#if loading}
  <p>Loading…</p>
{:else if hasAccount}
  <p>Redirecting to Inbox…</p>
{:else}
  <div style="display:grid; gap:1rem; max-width:28rem; margin: 10vh auto;">
    <h2 class="m3-font-headline-large" style="margin:0">Connect Gmail</h2>
    <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">Sign in to your Google account to view and manage your inbox.</p>
    <ListItem headline="Permissions" supporting="We request Gmail read/modify, labels, and metadata scopes to snooze and label threads." />
    <Button variant="filled" onclick={connect} disabled={!ready}>Sign in with Google</Button>
    <Button variant="text" href="https://myaccount.google.com/permissions">Review Google permissions</Button>
  </div>
{/if}
