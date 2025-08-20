<script lang="ts">
  import { page } from "$app/state";
  import { messages, threads } from "$lib/stores/threads";
  const threadId = $page.params.threadId;
  $effect(() => {
    // noop: rely on hydrated stores for MVP
  });
</script>

{#if $threads.find((t) => t.threadId === threadId) as thread}
  <h2>{thread.lastMsgMeta.subject}</h2>
  <p><small>{thread.lastMsgMeta.from}</small></p>
  <ul>
    {#each thread.messageIds as mid}
      <li>{ $messages[mid]?.snippet }</li>
    {/each}
  </ul>
{:else}
  <p>Thread not loaded.</p>
{/if}

<script context="module" lang="ts">
  export const prerender = false;
  export const ssr = false;
  export const csr = true;
  export const trailingSlash = 'ignore';
  export const csrHash = true;
</script>

