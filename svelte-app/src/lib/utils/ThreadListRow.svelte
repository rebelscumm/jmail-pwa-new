<script lang="ts">
  import ListItem from '$lib/containers/ListItem.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import SplitButton from '$lib/buttons/SplitButton.svelte';
  import Menu from '$lib/containers/Menu.svelte';
  import { archiveThread, trashThread, markRead, markUnread, undoLast } from '$lib/queue/intents';
  import { snoozeThreadByRule, manualUnsnoozeThread, isSnoozedThread } from '$lib/snooze/actions';
  import { settings } from '$lib/stores/settings';
  import { base } from '$app/paths';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { fade } from 'svelte/transition';
  import { rules, DEFAULTS, normalizeRuleKey, resolveRule } from '$lib/snooze/rules';
  import { holdThread } from '$lib/stores/holds';
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
  let snoozeMenuOpen = $state(false);
  let mappedKeys = $derived(Array.from(new Set(Object.keys($settings.labelMapping || {}).filter((k) => $settings.labelMapping[k]).map((k) => normalizeRuleKey(k)))));
  let defaultSnoozeKey = $derived(mappedKeys.includes('1h') ? '1h' : (mappedKeys[0] || null));
  
  // Residual state for inline Undo UI
  let residualActive = $state(false);
  let residualLabel = $state('');
  let residualDirection: 'left' | 'right' | null = $state(null);

  function isMapped(key: string): boolean {
    try { return mappedKeys.includes(normalizeRuleKey(key)); } catch { return false; }
  }
  function toRuleKey(display: string): string {
    const d = display.toLowerCase();
    if (d === '2p') return '2pm';
    if (d === '6a') return '6am';
    if (d === '7p') return '7pm';
    if (d === 'mon') return 'Monday';
    if (d === 'fri') return 'Friday';
    return display;
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
  async function animateAndPerform(label: string, doIt: () => Promise<void>, direction: 'left' | 'right', _isError = false): Promise<void> {
    animating = true;
    dx = direction === 'right' ? 160 : -160;
    await new Promise((r) => setTimeout(r, 180));
    // Place a hold to keep the thread visible until the user-configured delay elapses
    try {
      const delay = Math.max(0, Number($settings.trailingRefreshDelayMs || 5000));
      holdThread(thread.threadId, delay);
    } catch {}
    await doIt();
    // Keep the row slid over and show residual inline Undo until list refresh
    residualActive = true;
    residualLabel = label;
    residualDirection = direction;
    animating = false;
    // Schedule a reload to refresh list after trailing action
    scheduleReload();
  }

  function onPointerDown(e: PointerEvent) {
    if (residualActive) return;
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
        await animateAndPerform('Snoozed 1h', () => snoozeThreadByRule(thread.threadId, '1h', { optimisticLocal: false }), 'left');
      }
      // If swipe distance didn't cross threshold, do nothing (no navigation). Tap will be handled by <a>
    }
    setTimeout(() => (animating = false), 180);
  }
  
  function onPointerMove(e: PointerEvent) {
    if (!dragging || downInInteractive || residualActive) return;
    const delta = e.clientX - startX;
    if (!captured && Math.abs(delta) > 6) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      captured = true;
    }
    dx = Math.max(Math.min(delta, 160), -160);
  }
  
  async function animateAndDelete(): Promise<void> {
    await animateAndPerform('Deleted', () => trashThread(thread.threadId, { optimisticLocal: false }), 'right', true);
  }
  
  async function animateAndArchive(): Promise<void> {
    await animateAndPerform('Archived', () => archiveThread(thread.threadId, { optimisticLocal: false }), 'right');
  }
  
  async function animateAndUnsnooze(): Promise<void> {
    await animateAndPerform('Unsnoozed', () => manualUnsnoozeThread(thread.threadId, { optimisticLocal: false }), 'right');
  }
  
  async function animateAndSnooze(ruleKey: string, label = 'Snoozed'): Promise<void> {
    await animateAndPerform(label, () => snoozeThreadByRule(thread.threadId, ruleKey, { optimisticLocal: false }), 'left');
  }
  
  async function onUndoInline(e: MouseEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    try {
      await undoLast(1);
    } finally {
      animating = true;
      dx = 0;
      await new Promise((r) => setTimeout(r, 180));
      animating = false;
      residualActive = false;
      residualLabel = '';
      residualDirection = null;
    }
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
                <div class="list">
                  {#each ['2p','6a','7p','2d','4d','mon','fri','7 day','14 day','30 days','1h','2h','3h'] as item}
                    {#if isMapped(toRuleKey(item))}
                      <Button variant="text" onclick={() => trySnooze(toRuleKey(item))}>{item}</Button>
                    {/if}
                  {/each}
                  <div class="date-row">
                    <label class="m3-font-body-small" for={`native-date-${thread.threadId}`}>Pick date</label>
                    <input id={`native-date-${thread.threadId}`}
                      type="date"
                      min={(new Date(Date.now()+24*60*60*1000)).toISOString().slice(0,10)}
                      max={(new Date(Date.now()+30*24*60*60*1000)).toISOString().slice(0,10)}
                      onchange={(e) => { const v = (e.currentTarget as HTMLInputElement).value; if (v) { onDatePicked(v); (e.currentTarget as HTMLInputElement).value = ''; } }}
                    />
                  </div>
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
  <div class="bg" aria-hidden="true" style={`pointer-events:none`}>
    {#if dx > 0}
    <div class="left">
      {dx > 40 ? 'Archive' : ''}
    </div>
    {/if}
    {#if dx < 0}
    <div class="right">{dx < -40 ? '1h' : ''}</div>
    {/if}
  </div>
  {#if residualActive}
    <div class="residual {residualDirection === 'right' ? 'left' : 'right'}">
      <div class="pending-wrap">
        <span class="m3-font-body-medium">{residualLabel}</span>
        <Button variant="text" onclick={onUndoInline}>Undo</Button>
      </div>
    </div>
  {/if}
  <div class="fg" style={`transform: translateX(${dx}px); transition: ${animating ? 'transform 180ms var(--m3-util-easing-fast)' : 'none'}; pointer-events: ${residualActive ? 'none' : 'auto'};`} in:fade={{ duration: 120 }} out:fade={{ duration: 180 }}>
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
  /* Residue Undo button removed in favor of global snackbar per MD3 */
  .fg {
    position: relative;
    background: transparent;
    min-width: 0;
  }
  .residual {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 1rem;
    pointer-events: auto;
  }
  .residual.left { justify-content: flex-start; }
  .actions { display:flex; flex-direction: column; gap:0.25rem; align-items:flex-end; }
  .snooze-menu :global(.m3-container) { padding: 0; }
  .snooze-menu .list { display:flex; flex-direction: column; gap: 0.125rem; padding: 0.25rem; }
  .snooze-menu .list :global(button) { justify-content: flex-start; }
  .snooze-menu .footer { display:flex; justify-content:flex-end; padding: 0.25rem 0.5rem; border-top: 1px solid rgb(var(--m3-scheme-outline-variant)); }
  .snooze-menu .date-row { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; padding: 0.25rem 0.5rem; }
  .snooze-menu .date-row input[type="date"] { background: transparent; color: inherit; border: 1px solid rgb(var(--m3-scheme-outline-variant)); border-radius: 0.5rem; padding: 0.25rem 0.5rem; }
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


