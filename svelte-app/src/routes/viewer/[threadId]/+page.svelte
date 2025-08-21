<script lang="ts">
  import { page } from "$app/stores";
  import { messages, threads } from "$lib/stores/threads";
  import { archiveThread, trashThread, spamThread } from "$lib/queue/intents";
  import { snoozeThreadByRule } from "$lib/snooze/actions";
  import { getMessageFull } from "$lib/gmail/api";
  import { aiSummarizeEmail, aiDraftReply, findUnsubscribeTarget } from "$lib/ai/providers";
  import { htmlToText } from "$lib/ai/redact";
  const threadId = $page.params.threadId;
  const currentThread = $derived($threads.find((t) => t.threadId === threadId));
  function copyText(text: string) { navigator.clipboard.writeText(text); }
  async function loadBody(mid: string) { const m = await getMessageFull(mid); $messages[mid] = m; }
  async function summarize(mid: string) {
    const m = $messages[mid];
    if (!m) return;
    const text = await aiSummarizeEmail(m.headers?.Subject || '', m.bodyText, m.bodyHtml);
    navigator.clipboard.writeText(text);
    alert('Summary copied to clipboard.');
  }
  async function replyDraft(mid: string) {
    const m = $messages[mid]; if (!m) return;
    const draft = await aiDraftReply(m.headers?.Subject || '', m.bodyText, m.bodyHtml);
    navigator.clipboard.writeText(draft);
    alert('Reply draft copied to clipboard.');
  }
  function unsubscribe(mid: string) {
    const m = $messages[mid]; if (!m) return;
    const target = findUnsubscribeTarget(m.headers, m.bodyHtml);
    if (target) {
      const ok = confirm(`Open unsubscribe target?\n${target}`);
      if (ok) window.open(target, '_blank');
    } else {
      alert('No unsubscribe target found.');
    }
  }
  async function createTask(mid: string) {
    const m = $messages[mid]; if (!m) return;
    const link = `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`;
    const line = `- [ ] ${m.headers?.Subject || 'Email'}  (${link})`;
    try {
      // Desktop: copy; user can paste into their task file
      await navigator.clipboard.writeText(line);
      alert('Task line copied to clipboard.');
    } catch { alert(line); }
  }
</script>

{#if currentThread}
  <h2>{currentThread.lastMsgMeta.subject}</h2>
  <p><small>{currentThread.lastMsgMeta.from}</small></p>
  <ul>
    {#each currentThread.messageIds as mid}
      <li>
        <div>{ $messages[mid]?.snippet }</div>
        {#if $messages[mid]?.bodyText}
          <pre style="white-space:pre-wrap">{ $messages[mid]?.bodyText }</pre>
        {:else}
          <button on:click={() => loadBody(mid)}>Load full</button>
        {/if}
      </li>
    {/each}
  </ul>
  <div>
    <button on:click={() => archiveThread(currentThread.threadId)}>Archive</button>
    <button on:click={() => trashThread(currentThread.threadId)}>Delete</button>
    <button on:click={() => spamThread(currentThread.threadId)}>Spam</button>
    <button on:click={() => snoozeThreadByRule(currentThread.threadId, '10m')}>Snooze 10m</button>
    <button on:click={() => snoozeThreadByRule(currentThread.threadId, '3h')}>Snooze 3h</button>
    <button on:click={() => snoozeThreadByRule(currentThread.threadId, '1d')}>Snooze 1d</button>
    <button on:click={() => copyText(currentThread.lastMsgMeta.subject || '')}>Copy Subject</button>
    {#if currentThread.messageIds?.length}
      {@const mid = currentThread.messageIds[currentThread.messageIds.length-1]}
      <button on:click={() => unsubscribe(mid)}>Unsubscribe</button>
      <button on:click={() => summarize(mid)}>Summarize</button>
      <button on:click={() => replyDraft(mid)}>Reply (AI) → Clipboard</button>
      <button on:click={() => createTask(mid)}>Create Task</button>
    {/if}
  </div>
{:else}
  <p>Thread not loaded.</p>
{/if}

<script module lang="ts">
  export const prerender = false;
  export const ssr = false;
  export const csr = true;
  export const trailingSlash = 'ignore';
  export const csrHash = true;
</script>

