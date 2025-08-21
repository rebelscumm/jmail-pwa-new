<script lang="ts">
  import { page } from "$app/stores";
  import { messages, threads } from "$lib/stores/threads";
  import { archiveThread, trashThread, spamThread } from "$lib/queue/intents";
  import { snoozeThreadByRule, manualUnsnoozeThread, isSnoozedThread } from "$lib/snooze/actions";
  import Button from "$lib/buttons/Button.svelte";
  import { getMessageFull } from "$lib/gmail/api";
  import { aiSummarizeEmail, aiDraftReply, findUnsubscribeTarget, aiExtractUnsubscribeUrl } from "$lib/ai/providers";
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
  async function unsubscribe(mid: string) {
    const m = $messages[mid]; if (!m) return;
    let target = findUnsubscribeTarget(m.headers, m.bodyHtml);
    if (!target) target = await aiExtractUnsubscribeUrl(m.headers?.Subject || '', m.bodyText, m.bodyHtml);
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
          <button onclick={() => loadBody(mid)}>Load full</button>
        {/if}
      </li>
    {/each}
  </ul>
  <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
    <Button variant="text" onclick={() => archiveThread(currentThread.threadId)}>Archive</Button>
    <Button variant="text" onclick={() => trashThread(currentThread.threadId)}>Delete</Button>
    <Button variant="text" onclick={() => spamThread(currentThread.threadId)}>Spam</Button>
    {#if isSnoozedThread(currentThread)}
      <Button variant="text" onclick={() => manualUnsnoozeThread(currentThread.threadId)}>Unsnooze</Button>
    {/if}
    <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '10m')}>Snooze 10m</Button>
    <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '3h')}>Snooze 3h</Button>
    <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '1d')}>Snooze 1d</Button>
    <Button variant="text" onclick={() => copyText(currentThread.lastMsgMeta.subject || '')}>Copy Subject</Button>
    {#if currentThread.messageIds?.length}
      {@const mid = currentThread.messageIds[currentThread.messageIds.length-1]}
      <Button variant="text" onclick={() => unsubscribe(mid)}>Unsubscribe</Button>
      <Button variant="text" onclick={() => summarize(mid)}>Summarize</Button>
      <Button variant="text" onclick={() => replyDraft(mid)}>Reply (AI) → Clipboard</Button>
      <Button variant="text" onclick={() => createTask(mid)}>Create Task</Button>
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

