<script lang="ts">
  import ListItem from '$lib/containers/ListItem.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import SplitButton from '$lib/buttons/SplitButton.svelte';
  import Menu from '$lib/containers/Menu.svelte';
  import SnoozePanel from '$lib/snooze/SnoozePanel.svelte';
  import Dialog from '$lib/containers/Dialog.svelte';
  import DatePickerDocked from '$lib/forms/DatePickerDocked.svelte';
  import { archiveThread, trashThread, markRead, markUnread, undoLast } from '$lib/queue/intents';
  import { snoozeThreadByRule, manualUnsnoozeThread, isSnoozedThread } from '$lib/snooze/actions';
  import { settings } from '$lib/stores/settings';
  import { base } from '$app/paths';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { fade } from 'svelte/transition';
  import { rules, DEFAULTS, normalizeRuleKey, resolveRule } from '$lib/snooze/rules';
  import { holdThread, clearHold } from '$lib/stores/holds';
  // Lazy import to avoid circular or route coupling; fallback no-op if route not mounted
  async function scheduleReload() {
    try {
      const delay = Math.max(0, Number($settings.trailingRefreshDelayMs || 5000));
      setTimeout(async () => {
        try {
          const mod = await import('../../routes/inbox/+page.svelte');
          if (typeof (mod as any).reloadFromCache === 'function') await (mod as any).reloadFromCache();
        } catch (_) {}
      }, delay);
    } catch (_) {}
  }

  let { thread, selected = false, onToggleSelected = undefined }: { thread: import('$lib/types').GmailThread; selected?: boolean; onToggleSelected?: ((next: boolean, ev: Event) => void) | undefined } = $props();
  
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
  let mappedKeys = $derived(Array.from(new Set(Object.keys($settings.labelMapping || {}).filter((k) => $settings.labelMapping[k]).map((k) => normalizeRuleKey(k)))));
  let defaultSnoozeKey = $derived(mappedKeys.includes('1h') ? '1h' : (mappedKeys[0] || null));

  let dateDialogOpen = $state(false);
  function isMapped(key: string): boolean {
    try { return mappedKeys.includes(normalizeRuleKey(key)); } catch { return false; }
  }
  async function trySnooze(key: string): Promise<void> {
    const k = normalizeRuleKey(key);
    if (!isMapped(k)) {
      showSnackbar({ message: 'No snooze labels configured. Map them in Settings.' });
      return;
    }
    await animateAndSnooze(k, 'Snoozed');
  }
  function daysFromToday(dateStr: string): number {
    try {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const chosen = new Date(dateStr + 'T00:00:00');
      const diffMs = chosen.getTime() - startOfToday.getTime();
      return Math.round(diffMs / 86400000);
    } catch {
      return 0;
    }
  }
  function dateValidator(dateStr: string): boolean {
    const n = daysFromToday(dateStr);
    return n >= 1 && n <= 30 && isMapped(`${n}d`);
  }
  async function onDatePicked(dateStr: string): Promise<void> {
    const n = daysFromToday(dateStr);
    if (n < 1 || n > 30) return;
    const key = `${n}d`;
    if (!isMapped(key)) {
      showSnackbar({ message: 'No snooze labels configured for that date. Map in Settings.' });
      return;
    }
    await animateAndSnooze(key, 'Snoozed');
  }
  
  // Unified slide-out performer used by all trailing actions
  async function animateAndPerform(label: string, doIt: () => Promise<void>, isError = false): Promise<void> {
    pendingRemove = isError;
    pendingLabel = label;
    animating = true;
    dx = 160;
    await new Promise((r) => setTimeout(r, 180));
    // Place a hold to keep the thread visible until the user-configured delay elapses
    try {
      const delay = Math.max(0, Number($settings.trailingRefreshDelayMs || 5000));
      holdThread(thread.threadId, delay);
    } catch {}
    await doIt();
    showSnackbar({ message: label, actions: { Undo: () => undoLast(1) } });
    // Schedule a reload to refresh list after trailing action
    scheduleReload();
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
    try { clearHold(thread.threadId); } catch {}
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
  
  function pickShortestSnooze(keys: string[]): string | null {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      let bestKey: string | null = null;
      let bestTime: number | null = null;
      for (const raw of keys) {
        const k = normalizeRuleKey(raw);
        const dt = resolveRule(k, zone, DEFAULTS);
        if (!dt) continue;
        const t = new Date(dt).getTime();
        if (Number.isNaN(t)) continue;
        if (bestTime == null || t < bestTime) { bestTime = t; bestKey = k; }
      }
      return bestKey || (keys[0] || null);
    } catch {
      return keys[0] || null;
    }
  }
  
  $effect(() => {
    if (mappedKeys && mappedKeys.length) {
      const shortest = pickShortestSnooze(mappedKeys);
      if (shortest) defaultSnoozeKey = shortest as any;
    }
  });
</script>

{#snippet trailing()}
  <div class="actions">
    {#if isSnoozedThread(thread)}
      <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndUnsnooze(); }}>Unsnooze</Button>
    {/if}
    <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndArchive(); }}>Archive</Button>
    <Button variant="text" color="error" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndDelete(); }}>Delete</Button>
    <div class="snooze-wrap" role="button" tabindex="0" data-no-row-nav onclick={(e) => { if (!(e.target as Element)?.closest('summary')) { e.preventDefault(); } e.stopPropagation(); }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { if (!(e.target as Element)?.closest('summary')) { e.preventDefault(); } e.stopPropagation(); } }}>
      <SplitButton variant="outlined" x="right" y="down" onclick={() => { if (defaultSnoozeKey) { animateAndSnooze(defaultSnoozeKey, `Snoozed ${defaultSnoozeKey}`); } else { showSnackbar({ message: 'No snooze labels configured. Map them in Settings.' }); } }} on:toggle={(e) => { snoozeMenuOpen = (e.detail as boolean); }}>
        {#snippet children()}
          {defaultSnoozeKey || 'Snooze'}
        {/snippet}
        {#snippet menu()}
          <div class="snooze-menu">
            <Menu>
              {#if mappedKeys.length > 0}
                <SnoozePanel onSelect={(k) => trySnooze(k)} />
                <div class="footer">
                  <Button variant="text" onclick={() => { dateDialogOpen = true; }}>Pick date…</Button>
                </div>
              {:else}
                <div style="padding:0.5rem 0.75rem; max-width: 18rem;" class="m3-font-body-small">No snooze labels configured. Map them in Settings.</div>
              {/if}
            </Menu>
          </div>
        {/snippet}
      </SplitButton>
    </div>
  </div>
{/snippet}

{#snippet trailingWithDate()}
  {@render trailing()}
{/snippet}

{#snippet selectionLeading()}
  <label class="leading-checkbox">
    <input type="checkbox" checked={selected} onclick={(e: Event) => { e.preventDefault(); e.stopPropagation(); onToggleSelected?.(!selected, e); }} onchange={(e: Event) => { e.preventDefault(); e.stopPropagation(); }} />
    <span class="checkbox-box" aria-hidden="true"></span>
  </label>
{/snippet}

<div class="swipe-wrapper" class:menu-open={snoozeMenuOpen}
     onpointerdown={onPointerDown}
     onpointermove={onPointerMove}
     onpointerup={onPointerUp}
>
  <div class="bg" aria-hidden="true" style={`pointer-events:${pendingLabel ? 'auto' : 'none'}`}> 
    {#if pendingLabel || dx > 0}
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
    {/if}
    {#if dx < 0}
    <div class="right">{dx < -40 ? '1h' : ''}</div>
    {/if}
  </div>
  <div class="fg" style={`transform: translateX(${dx}px); transition: ${animating ? 'transform 180ms var(--m3-util-easing-fast)' : 'none'};`} in:fade={{ duration: 120 }} out:fade={{ duration: 180 }}>
    <ListItem
      leading={onToggleSelected ? selectionLeading : undefined}
      headline={`${(thread.lastMsgMeta.subject || '(no subject)')}${(thread.lastMsgMeta.from ? ' — ' + thread.lastMsgMeta.from : '')}${(thread.lastMsgMeta?.date ? ' • ' + formatDateTime(thread.lastMsgMeta.date) : '')}`}
      supporting={''}
      lines={3}
      unread={(thread.labelIds || []).includes('UNREAD')}
      href={`${base || ''}/viewer/${thread.threadId}`}
      trailing={trailingWithDate}
    />
  </div>
</div>

<Dialog headline="Pick date" bind:open={dateDialogOpen} closeOnClick={false}>
  {#snippet children()}
    <DatePickerDocked
      date={''}
      clearable={false}
      dateValidator={dateValidator}
      close={() => (dateDialogOpen = false)}
      setDate={onDatePicked}
    />
  {/snippet}
  {#snippet buttons()}
    <Button variant="text" onclick={() => (dateDialogOpen = false)}>Close</Button>
  {/snippet}
</Dialog>

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
    --m3-button-shape: var(--m3-util-rounding-small);
    height: 2rem;
    padding: 0 0.5rem;
    min-width: auto;
    background: transparent;
    color: inherit !important;
    box-shadow: none;
    border: none;
    outline: none;
    appearance: none;
  }
  .fg {
    position: relative;
    background: transparent;
    min-width: 0;
  }
  .actions { display:flex; flex-direction: column; gap:0.25rem; align-items:flex-end; }
  .snooze-menu :global(.m3-container) { padding: 0; }
  .snooze-menu .footer { display:flex; justify-content:flex-end; padding: 0.25rem 0.5rem; border-top: 1px solid rgb(var(--m3-scheme-outline-variant)); }
  .leading-checkbox {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    position: relative;
    cursor: pointer;
  }
  .leading-checkbox > input { position: absolute; opacity: 0; pointer-events: none; }
  .leading-checkbox .checkbox-box {
    width: 1.125rem;
    height: 1.125rem;
    border-radius: 0.25rem;
    border: 2px solid rgb(var(--m3-scheme-outline));
    background: transparent;
    box-sizing: border-box;
  }
  :global(.leading-checkbox input:checked) + .checkbox-box {
    background: selecteditem;
    border-color: selecteditem !important;
    box-shadow: inset 0 0 0 2px rgb(var(--m3-scheme-on-primary));
  }
</style>


