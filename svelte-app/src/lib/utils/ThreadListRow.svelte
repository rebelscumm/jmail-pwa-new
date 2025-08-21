<script lang="ts">
  import ListItem from '$lib/containers/ListItem.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import { archiveThread, markRead, markUnread } from '$lib/queue/intents';
  import { snoozeThreadByRule, manualUnsnoozeThread, isSnoozedThread } from '$lib/snooze/actions';
  import SnoozePanel from '$lib/snooze/SnoozePanel.svelte';

  let { thread }: { thread: import('$lib/types').GmailThread } = $props();

  let dx = $state(0);
  let startX = $state(0);
  let dragging = $state(false);
  let animating = $state(false);

  function onPointerDown(e: PointerEvent) {
    dragging = true;
    animating = false;
    startX = e.clientX;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  async function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const threshold = 120;
    const currentDx = dx;
    dx = 0;
    animating = true;
    if (currentDx > threshold) {
      // Swipe right: Archive
      await archiveThread(thread.threadId);
    } else if (currentDx < -threshold) {
      // Swipe left: Quick snooze 1h
      await snoozeThreadByRule(thread.threadId, '1h');
    }
    setTimeout(() => (animating = false), 180);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const delta = e.clientX - startX;
    dx = Math.max(Math.min(delta, 160), -160);
  }
</script>

{#snippet trailing()}
  <div style="display:flex; gap:0.5rem; align-items:center;">
    {#if isSnoozedThread(thread)}
      <Button variant="text" onclick={() => manualUnsnoozeThread(thread.threadId)}>Unsnooze</Button>
    {/if}
    <Button variant="text" onclick={() => archiveThread(thread.threadId)}>Archive</Button>
    {#if thread.labelIds && thread.labelIds.includes('UNREAD')}
      <Button variant="text" onclick={() => markRead(thread.threadId)}>Read</Button>
    {:else}
      <Button variant="text" onclick={() => markUnread(thread.threadId)}>Unread</Button>
    {/if}
    <details>
      <summary class="m3-font-label-medium" style="cursor:pointer">Snooze ▾</summary>
      <div style="position:relative">
        <div style="position:absolute; right:0; z-index:10;">
          <SnoozePanel onSelect={(k: string) => snoozeThreadByRule(thread.threadId, k)} />
        </div>
      </div>
    </details>
  </div>
{/snippet}

<div class="swipe-wrapper"
     onpointerdown={onPointerDown}
     onpointermove={onPointerMove}
     onpointerup={onPointerUp}
>
  <div class="bg" aria-hidden="true">
    <div class="left">{dx > 40 ? 'Archive' : ''}</div>
    <div class="right">{dx < -40 ? 'Snooze 1h' : ''}</div>
  </div>
  <div class="fg" style={`transform: translateX(${dx}px); transition: ${animating ? 'transform 180ms var(--m3-util-easing-fast)' : 'none'};`}>
    <ListItem
      headline={thread.lastMsgMeta.subject || '(no subject)'}
      supporting={thread.lastMsgMeta.from || ''}
      lines={2}
      href={`/viewer/${thread.threadId}`}
      trailing={trailing}
    />
  </div>
</div>

<style>
  .swipe-wrapper {
    position: relative;
    overflow: hidden;
  }
  .bg {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 1rem;
    pointer-events: none;
    color: rgb(var(--m3-scheme-on-secondary-container));
  }
  .bg .left {
    background: rgb(var(--m3-scheme-secondary-container));
    padding: 0.25rem 0.5rem;
    border-radius: 0.5rem;
    min-width: 5rem;
    text-align: center;
  }
  .bg .right {
    background: rgb(var(--m3-scheme-tertiary-container));
    padding: 0.25rem 0.5rem;
    border-radius: 0.5rem;
    min-width: 5rem;
    text-align: center;
  }
  .fg {
    position: relative;
    background: transparent;
  }
</style>


