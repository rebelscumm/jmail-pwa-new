<script lang="ts">
  import { page } from "$app/stores";
  import { messages, threads } from "$lib/stores/threads";
  import { archiveThread, trashThread, spamThread } from "$lib/queue/intents";
  import { snoozeThreadByRule } from "$lib/snooze/actions";
  import { getMessageFull } from "$lib/gmail/api";
  const threadId = $page.params.threadId;
  const currentThread = $derived($threads.find((t) => t.threadId === threadId));
  function copyText(text: string) { navigator.clipboard.writeText(text); }
  async function loadBody(mid: string) { const m = await getMessageFull(mid); $messages[mid] = m; }
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

