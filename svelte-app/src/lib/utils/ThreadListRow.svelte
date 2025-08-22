<script lang="ts">
  import ListItem from '$lib/containers/ListItem.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import SplitButton from '$lib/buttons/SplitButton.svelte';
  import Menu from '$lib/containers/Menu.svelte';
  import { archiveThread, trashThread, markRead, markUnread, undoLast } from '$lib/queue/intents';
  import { snoozeThreadByRule, manualUnsnoozeThread, isSnoozedThread } from '$lib/snooze/actions';
  import { settings } from '$lib/stores/settings';
  import SnoozePanel from '$lib/snooze/SnoozePanel.svelte';
  import { base } from '$app/paths';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { fade } from 'svelte/transition';

  let { thread }: { thread: import('$lib/types').GmailThread } = $props();

  let dx = $state(0);
  let startX = $state(0);
  let dragging = $state(false);
  let animating = $state(false);
  let captured = $state(false);
  let downInInteractive = $state(false);
  let startTarget: HTMLElement | null = null;
  let pendingRemove = $state(false);
  let pendingLabel: string | null = $state(null);
  let snoozeMenuOpen = $state(false);
  let mappedKeys = $derived(Object.keys($settings.labelMapping || {}).filter((k) => $settings.labelMapping[k]));
  let defaultSnoozeKey = $derived(mappedKeys.includes('1h') ? '1h' : (mappedKeys[0] || null));
  
  // Unified slide-out performer used by all trailing actions
  async function animateAndPerform(label: string, doIt: () => Promise<void>, isError = false): Promise<void> {
    pendingRemove = isError;
    pendingLabel = label;
    animating = true;
    dx = 160;
    await new Promise((r) => setTimeout(r, 180));
    await doIt();
    showSnackbar({ message: label, actions: { Undo: () => undoLast(1) } });
  }

  function onPointerDown(e: PointerEvent) {
    startTarget = e.target as HTMLElement;
    downInInteractive = !!startTarget?.closest(
      'button,summary,details,input,textarea,select,[data-no-row-nav]'
    );
    if (downInInteractive) return;
    dragging = true;
    animating = false;
    startX = e.clientX;
    // Do not capture immediately; only capture after small movement to allow native click
  }

  async function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    if (downInInteractive) {
      // Let interactive children handle their own clicks without affecting row
      downInInteractive = false;
      return;
    }
    dragging = false;
    const threshold = 120;
    const currentDx = dx;
    dx = 0;
    animating = true;
    if (captured) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
      captured = false;
      if (currentDx > threshold) {
        // Swipe right: Archive (with same animation as delete)
        await animateAndArchive();
      } else if (currentDx < -threshold) {
        // Swipe left: Quick snooze 1h
        await animateAndPerform('Snoozed 1h', () => snoozeThreadByRule(thread.threadId, '1h', { optimisticLocal: false }));
      }
      // If swipe distance didn't cross threshold, do nothing (no navigation). Tap will be handled by <a>
    }
    setTimeout(() => (animating = false), 180);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || downInInteractive) return;
    const delta = e.clientX - startX;
    if (!captured && Math.abs(delta) > 6) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      captured = true;
    }
    dx = Math.max(Math.min(delta, 160), -160);
  }

  async function animateAndDelete(): Promise<void> {
    await animateAndPerform('Deleted', () => trashThread(thread.threadId, { optimisticLocal: false }), true);
  }

  async function animateAndArchive(): Promise<void> {
    await animateAndPerform('Archived', () => archiveThread(thread.threadId, { optimisticLocal: false }));
  }

  async function animateAndUnsnooze(): Promise<void> {
    await animateAndPerform('Unsnoozed', () => manualUnsnoozeThread(thread.threadId, { optimisticLocal: false }));
  }

  async function animateAndSnooze(ruleKey: string, label = 'Snoozed'): Promise<void> {
    await animateAndPerform(label, () => snoozeThreadByRule(thread.threadId, ruleKey, { optimisticLocal: false }));
  }

  function onUndoBgClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const last = pendingLabel || 'action';
    pendingLabel = null;
    pendingRemove = false;
    undoLast(1).then(() => {
      showSnackbar({ message: `Undid ${last}` });
    });
  }

  function formatDateTime(ts?: number): string {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    } catch {
      return '';
    }
  }
</script>

{#snippet trailing()}
  <div class="actions">
    {#if isSnoozedThread(thread)}
      <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndUnsnooze(); }}>Unsnooze</Button>
    {/if}
    <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndArchive(); }}>Archive</Button>
    <Button variant="text" color="error" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndDelete(); }}>Delete</Button>
    <div class="snooze-wrap" role="button" tabindex="0" data-no-row-nav onclick={(e) => { if (!(e.target as Element)?.closest('summary')) { e.preventDefault(); } e.stopPropagation(); }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { if (!(e.target as Element)?.closest('summary')) { e.preventDefault(); } e.stopPropagation(); } }}>
      {#if defaultSnoozeKey}
      <SplitButton variant="outlined" x="right" y="down" onclick={() => { animateAndSnooze(defaultSnoozeKey, `Snoozed ${defaultSnoozeKey}`); }} on:toggle={(e) => { snoozeMenuOpen = (e.detail as boolean); }}>
        {#snippet children()}
          {defaultSnoozeKey}
        {/snippet}
        {#snippet menu()}
          <div class="snooze-menu">
            <Menu>
              <SnoozePanel onSelect={(k: string) => animateAndSnooze(k, 'Snoozed')} />
            </Menu>
          </div>
        {/snippet}
      </SplitButton>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet trailingWithDate()}
  {#if thread.lastMsgMeta?.date}
    <span>{formatDateTime(thread.lastMsgMeta.date)}</span>
  {/if}
  {@render trailing()}
{/snippet}

<div class="swipe-wrapper" class:menu-open={snoozeMenuOpen}
     onpointerdown={onPointerDown}
     onpointermove={onPointerMove}
     onpointerup={onPointerUp}
>
  <div class="bg" aria-hidden="true" style={`pointer-events:${pendingLabel ? 'auto' : 'none'}`}> 
    <div class="left" style={`background:${pendingRemove ? 'rgb(var(--m3-scheme-error-container))' : 'rgb(var(--m3-scheme-secondary-container))'}; color:${pendingRemove ? 'rgb(var(--m3-scheme-on-error-container))' : 'rgb(var(--m3-scheme-on-secondary-container))'}`}>
      {#if pendingLabel}
        <div class="pending-wrap" role="status" aria-live="polite">
          <span class="pending-label m3-font-label-large">{pendingLabel}</span>
          <Button variant="text" class="undo-btn" onclick={onUndoBgClick}>Undo</Button>
        </div>
      {:else}
        {dx > 40 ? 'Archive' : ''}
      {/if}
    </div>
    <div class="right">{dx < -40 ? '1h' : ''}</div>
  </div>
  <div class="fg" style={`transform: translateX(${dx}px); transition: ${animating ? 'transform 180ms var(--m3-util-easing-fast)' : 'none'};`} in:fade={{ duration: 120 }} out:fade={{ duration: 180 }}>
    <ListItem
      headline={thread.lastMsgMeta.subject || '(no subject)'}
      supporting={`${thread.lastMsgMeta.from || ''}`}
      lines={3}
      unread={(thread.labelIds || []).includes('UNREAD')}
      href={`${base || ''}/viewer/${thread.threadId}`}
      trailing={trailingWithDate}
    />
  </div>
</div>

<style>
  .swipe-wrapper {
    position: relative;
    overflow: hidden;
    min-width: 0;
  }
  .swipe-wrapper:has(:global(details[open])) {
    overflow: visible;
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
    border-radius: var(--m3-util-rounding-extra-small);
    min-width: 5rem;
    text-align: center;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    box-shadow: var(--m3-util-elevation-1);
  }
  .bg .right {
    background: rgb(var(--m3-scheme-tertiary-container));
    padding: 0.25rem 0.5rem;
    border-radius: var(--m3-util-rounding-extra-small);
    min-width: 5rem;
    text-align: center;
    box-shadow: var(--m3-util-elevation-1);
  }
  .pending-wrap { display: inline-flex; align-items: center; gap: 0.5rem; }
  /* Make the inline Undo button MD3-compliant for container backgrounds */
  .bg .left :global(.m3-container.undo-btn) {
    height: 2rem;
    padding: 0 0.5rem;
    background: transparent;
    color: inherit !important;
    box-shadow: none;
    border-radius: var(--m3-util-rounding-small);
    min-width: auto;
  }
  .fg {
    position: relative;
    background: transparent;
    min-width: 0;
  }
  .actions { display:flex; flex-direction: column; gap:0.25rem; align-items:flex-end; }
  .snooze-menu :global(.m3-container) { padding: 0; }
</style>


