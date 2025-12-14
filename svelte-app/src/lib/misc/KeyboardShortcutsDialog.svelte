<script lang="ts">
  import Dialog from "$lib/containers/Dialog.svelte";
  import Button from "$lib/buttons/Button.svelte";
  let open = $state(false);
  
  export function show(): void { open = true; }
</script>

<Dialog headline="Keyboard shortcuts" bind:open closeOnClick={true}>
  {#snippet children()}
    <div class="content">
      <p class="m3-font-body-medium">Gmail-like shortcuts are enabled. Some highlights:</p>
      <ul class="shortcuts">
        <li><span class="k">?</span><span class="v">Open this help</span></li>
        <li><span class="k">/</span><span class="v">Focus search</span></li>
        <li><span class="k">j / k</span><span class="v">Move selection down / up</span></li>
        <li><span class="k">o or Enter</span><span class="v">Open selected conversation</span></li>
        <li><span class="k">Space</span><span class="v">Open first conversation (Inbox)</span></li>
        <li><span class="k">b</span><span class="v">Open Snooze menu (Viewer & Inbox row)</span></li>
        <li><span class="k">x</span><span class="v">Select conversation</span></li>
        <li><span class="k">y</span><span class="v">Archive</span></li>
        <li><span class="k"># or Delete</span><span class="v">Delete</span></li>
        <li><span class="k">e</span><span class="v">Archive (Gmail uses e)</span></li>
        <li><span class="k">z</span><span class="v">Undo</span></li>
        <li><span class="k">Esc</span><span class="v">Back to inbox (from viewer)</span></li>
      </ul>
      <p class="m3-font-body-small note">Note: Shortcuts generally ignore typing inside inputs and respect current page context.</p>
    </div>
  {/snippet}
  {#snippet buttons()}
    <div class="btns">
      <Button variant="filled" onclick={() => (open = false)}>Close</Button>
    </div>
  {/snippet}
</Dialog>

<style>
  .content { display:flex; flex-direction:column; gap:0.5rem; }
  .shortcuts { list-style:none; padding:0; margin:0; display:grid; grid-template-columns: 1fr 1fr; gap:0.25rem 1rem; }
  .shortcuts li { display:flex; gap:0.5rem; }
  .k { width:8rem; color: rgb(var(--m3-scheme-on-surface-variant)); }
  .v { color: rgb(var(--m3-scheme-on-surface)); }
  .note { color: rgb(var(--m3-scheme-on-surface-variant)); margin-top: 0.5rem; }
  @media (width < 40rem) { .shortcuts { grid-template-columns: 1fr; } .k { width: 6.5rem; } }
</style>