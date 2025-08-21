<script lang="ts">
  import { page } from "$app/stores";
  import { messages, threads } from "$lib/stores/threads";
  const threadId = $page.params.threadId;
  const currentThread = $derived($threads.find((t) => t.threadId === threadId));
</script>

{#if currentThread}
  <h2>{currentThread.lastMsgMeta.subject}</h2>
  <p><small>{currentThread.lastMsgMeta.from}</small></p>
  <ul>
    {#each currentThread.messageIds as mid}
      <li>{ $messages[mid]?.snippet }</li>
    {/each}
  </ul>
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

