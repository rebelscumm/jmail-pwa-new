<script lang="ts">
  import ListItem from '$lib/containers/ListItem.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import SplitButton from '$lib/buttons/SplitButton.svelte';
  import Menu from '$lib/containers/Menu.svelte';
  import MenuItem from '$lib/containers/MenuItem.svelte';
  import Dialog from '$lib/containers/Dialog.svelte';
  import DatePickerDocked from '$lib/forms/DatePickerDocked.svelte';
  import { archiveThread, trashThread, markRead, markUnread, undoLast } from '$lib/queue/intents';
  import { snoozeThreadByRule, manualUnsnoozeThread, isSnoozedThread } from '$lib/snooze/actions';
  import { settings } from '$lib/stores/settings';
  import SnoozePanel from '$lib/snooze/SnoozePanel.svelte';
  import { base } from '$app/paths';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { fade } from 'svelte/transition';
  import { rules, DEFAULTS, normalizeRuleKey, resolveRule } from '$lib/snooze/rules';
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
  let mappedKeys = $derived(Array.from(new Set(Object.keys($settings.labelMapping || {}).filter((k) => $settings.labelMapping[k]).map((k) => normalizeRuleKey(k)))));
  let defaultSnoozeKey = $derived(mappedKeys.includes('1h') ? '1h' : (mappedKeys[0] || null));
  let datePickerOpen = $state(false);
  let pickedDate = $state(''); // yyyy-mm-dd

  function isMapped(ruleKey: string): boolean {
    const norm = normalizeRuleKey(ruleKey);
    return mappedKeys.includes(norm);
  }

  function openDatePicker() {
    pickedDate = '';
    datePickerOpen = true;
  }

  function applyPickedDate(dateStr: string) {
    try {
      if (!dateStr) return;
      const today = new Date();
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const selected = new Date(dateStr + 'T00:00:00');
      const msPerDay = 24 * 60 * 60 * 1000;
      const diffDays = Math.round((selected.getTime() - startOfToday.getTime()) / msPerDay);
      if (diffDays < 1 || diffDays > 30) {
        showSnackbar({ message: 'Pick between 1 and 30 days from today' });
        return;
      }
      const key = `${diffDays}d`;
      if (!isMapped(key)) {
        showSnackbar({ message: `No snooze label configured for ${key}. Map it in Settings.` });
        return;
      }
      datePickerOpen = false;
      animateAndSnooze(key, `Snoozed ${key}`);
    } catch (_) {
      showSnackbar({ message: 'Failed to apply date' });
    }
  }

  function dateValidator(dateStr: string): boolean {
    try {
      const today = new Date();
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const d = new Date(dateStr + 'T00:00:00');
      const msPerDay = 24 * 60 * 60 * 1000;
      const diffDays = Math.round((d.getTime() - startOfToday.getTime()) / msPerDay);
      return diffDays >= 1 && diffDays <= 30;
    } catch {
      return false;
    }
  }
  
  // Unified slide-out performer used by all trailing actions
  async function animateAndPerform(label: string, doIt: () => Promise<void>, isError = false): Promise<void> {
    pendingRemove = isError;
    pendingLabel = label;
    animating = true;
    dx = 160;
    await new Promise((r) => setTimeout(r, 180));
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
              <MenuItem disabled={!isMapped('1h')} onclick={() => animateAndSnooze('1h', 'Snoozed 1h')}>1h</MenuItem>
              <MenuItem disabled={!isMapped('3h')} onclick={() => animateAndSnooze('3h', 'Snoozed 3h')}>3h</MenuItem>
              <MenuItem disabled={!isMapped('2pm')} onclick={() => animateAndSnooze('2pm', 'Snoozed 2p')}>2p</MenuItem>
              <MenuItem disabled={!isMapped('6am')} onclick={() => animateAndSnooze('6am', 'Snoozed 6a')}>6a</MenuItem>
              <MenuItem disabled={!isMapped('7pm')} onclick={() => animateAndSnooze('7pm', 'Snoozed 7p')}>7p</MenuItem>
              <MenuItem disabled={!isMapped('2d')} onclick={() => animateAndSnooze('2d', 'Snoozed 2d')}>2d</MenuItem>
              <MenuItem disabled={!isMapped('4d')} onclick={() => animateAndSnooze('4d', 'Snoozed 4d')}>4d</MenuItem>
              <MenuItem disabled={!isMapped('7d')} onclick={() => animateAndSnooze('7d', 'Snoozed 7d')}>7d</MenuItem>
              <MenuItem disabled={!isMapped('14d')} onclick={() => animateAndSnooze('14d', 'Snoozed 14d')}>14d</MenuItem>
              <MenuItem disabled={!isMapped('30d')} onclick={() => animateAndSnooze('30d', 'Snoozed 30d')}>30d</MenuItem>
              <MenuItem disabled={!isMapped('mon')} onclick={() => animateAndSnooze('mon', 'Snoozed mon')}>mon</MenuItem>
              <MenuItem disabled={!isMapped('fri')} onclick={() => animateAndSnooze('fri', 'Snoozed fri')}>fri</MenuItem>
              <MenuItem onclick={() => openDatePicker()}>Pick date…</MenuItem>
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

{#if datePickerOpen}
  <Dialog close={() => (datePickerOpen = false)}>
    <DatePickerDocked
      date={pickedDate}
      clearable={false}
      dateValidator={dateValidator}
      close={() => (datePickerOpen = false)}
      setDate={(d) => applyPickedDate(d)}
    />
  </Dialog>
{/if}

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
      headline={`${(thread.lastMsgMeta.subject || '(no subject)')}${(thread.lastMsgMeta.from ? ' — ' + thread.lastMsgMeta.from : '')}${(thread.lastMsgMeta?.date ? ' • ' + formatDateTime(thread.lastMsgMeta.date) : '')}`}
      supporting={''}
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
</style>


