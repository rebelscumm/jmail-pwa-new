<script lang="ts">
  import ListItem from '$lib/containers/ListItem.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import Menu from '$lib/containers/Menu.svelte';
  import { archiveThread, trashThread, undoLast } from '$lib/queue/intents';
  import { snoozeThreadByRule, manualUnsnoozeThread, isSnoozedThread } from '$lib/snooze/actions';
  import { settings } from '$lib/stores/settings';
  import { base } from '$app/paths';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { fade } from 'svelte/transition';
  import { DEFAULTS, normalizeRuleKey, resolveRule } from '$lib/snooze/rules';
  import { holdThread } from '$lib/stores/holds';
  import SnoozePanel from '$lib/snooze/SnoozePanel.svelte';
  import { lastSelectedSnoozeRuleKey } from '$lib/stores/snooze';
  import Icon from '$lib/misc/_icon.svelte';
  import iconExpand from '@ktibow/iconset-material-symbols/keyboard-arrow-down';
  import iconArchive from '@ktibow/iconset-material-symbols/archive';
  import iconDelete from '@ktibow/iconset-material-symbols/delete';
  import iconSnooze from '@ktibow/iconset-material-symbols/snooze';
  import { onMount } from 'svelte';
  import Chip from '$lib/forms/Chip.svelte';
  import iconX from '@ktibow/iconset-material-symbols/close';
  import { labels as labelsStore } from '$lib/stores/labels';
  import { queueThreadModify, recordIntent } from '$lib/queue/intents';
  import iconSparkles from '@ktibow/iconset-material-symbols/auto-awesome';

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

  let { thread, selected = false, selectionActive = false, onToggleSelected = undefined }: { thread: import('$lib/types').GmailThread; selected?: boolean; selectionActive?: boolean; onToggleSelected?: ((next: boolean, ev: Event) => void) | undefined } = $props();

  const unread = $derived((thread.labelIds || []).includes('UNREAD'));

  function extractSender(raw?: string): string {
    try {
      const r = raw || '';
      const m = r.match(/^\s*"?([^"<]+)"?\s*<[^>]+>\s*$/);
      if (m && m[1]) return m[1].trim();
      const lt = r.indexOf('<');
      if (lt > 0) return r.slice(0, lt).trim();
      const at = r.indexOf('@');
      if (at > 0) return r.slice(0, at).trim();
      return r.trim();
    } catch { return raw || ''; }
  }
  const senderDisplay = $derived(extractSender(thread.lastMsgMeta?.from || ''));
  const senderInitial = $derived((senderDisplay?.[0] || '?').toUpperCase());
  const threadDisplaySubject = $derived((() => {
    try {
      const status = (thread as any).aiSubjectStatus as ('none'|'pending'|'ready'|'error') | undefined;
      const ai = (thread as any).aiSubject as string | undefined;
      if (status === 'ready' && ai) return ai;
    } catch {}
    return thread.lastMsgMeta?.subject || '(no subject)';
  })());
  const aiSubjectReady = $derived((() => {
    try {
      const status = (thread as any).aiSubjectStatus as ('none'|'pending'|'ready'|'error') | undefined;
      const ai = (thread as any).aiSubject as string | undefined;
      return !!(status === 'ready' && ai && ai.trim());
    } catch { return false; }
  })());

  // Work around snippet type mismatches by passing as any
  // These are stable references to snippet blocks defined below
  const SN_defaultLeading: any = defaultLeading;
  const SN_selectionLeading: any = selectionLeading;
  const SN_threadHeadline: any = threadHeadline;
  const SN_threadSupporting: any = threadSupporting;
  const SN_trailingWithDate: any = trailingWithDate;

  let dx = $state(0);
  let startX = $state(0);
  let startY = $state(0);
  let dragging = $state(false);
  let animating = $state(false);
  let captured = $state(false);
  let downInInteractive = $state(false);
  let startTarget: HTMLElement | null = null;
  let snoozeMenuOpen = $state(false);
  let rowEl: HTMLDivElement | null = null;
  let containerEl: HTMLDivElement | null = null;
  let width = $state(320);
  let rowHeightPx: number | null = $state(null);
  let lastMoveAt = $state(0);
  let lastMoveX = $state(0);
  let vx = $state(0); // px/s
  let isHorizontal = $state(false);
  let committed = $state(false);
  let exiting = $state(false);
  let collapsing = $state(false);
  let crossedHint = $state(false);
  let crossedCommit = $state(false);
  let mappedKeys = $derived(Array.from(new Set(Object.keys($settings.labelMapping || {}).filter((k) => $settings.labelMapping[k]).map((k) => normalizeRuleKey(k)))));
  let defaultSnoozeKey = $derived(mappedKeys.includes('1h') ? '1h' : (mappedKeys[0] || null));
  const commitVelocity = $derived(Math.max(100, Number($settings.swipeCommitVelocityPxPerSec || 1000)));
  const disappearMs = $derived(Math.max(100, Number($settings.swipeDisappearMs || 5000)));
  const rightPrimary = $derived(($settings.swipeRightPrimary || 'archive') as 'archive' | 'delete');
  const leftPrimary = $derived(($settings.swipeLeftPrimary || 'delete') as 'archive' | 'delete');
  const confirmDelete = $derived(!!$settings.confirmDelete);
  // Track last committed action for contextual Undo label
  let lastCommittedAction: { type: 'archive' | 'delete' | 'snooze'; ruleKey?: string } | null = $state(null);

  function formatUndoLabel(): string {
    const a = lastCommittedAction;
    if (!a) return 'action';
    if (a.type === 'snooze') {
      return `snooze${a.ruleKey ? ' ' + a.ruleKey : ''}`;
    }
    return a.type;
  }
  // Use on-container colors for the inline Undo action to match the filled background
  function getUndoTextColor(): string {
    const t = lastCommittedAction?.type;
    if (t === 'delete') return 'rgb(var(--m3-scheme-on-error-container))';
    return 'rgb(var(--m3-scheme-on-secondary-container))';
  }

  function cancelGlobalDisappearTimer(): void {
    try {
      const w = window as any;
      if (w.__jmailDisappearTimer) {
        clearTimeout(w.__jmailDisappearTimer);
        w.__jmailDisappearTimer = null;
      }
    } catch {}
  }


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
  function incrementSnoozeKey(baseKey: string): string {
    try {
      const k = normalizeRuleKey(baseKey);
      if (k === '30d') return '1h';
      const m = k.match(/^(\d+)([hd])$/);
      if (!m) return '1h';
      const n = Math.max(0, parseInt(m[1], 10)) + 1;
      const unit = m[2];
      return `${n}${unit}`;
    } catch {
      return '1h';
    }
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

  // Haptics (if available)
  function haptic(kind: 'light' | 'medium' | 'heavy'): void {
    try {
      const nav = navigator as any;
      const patterns = { light: [10], medium: [15], heavy: [25] };
      if (nav?.vibrate) nav.vibrate(patterns[kind]);
    } catch {}
  }

  function primaryFor(dx: number): 'archive' | 'delete' {
    return dx >= 0 ? rightPrimary : leftPrimary;
  }

  function actionLabel(a: 'archive' | 'delete'): string { return a === 'archive' ? 'Archive' : 'Delete'; }

  // Global disappear coordinator
  function startGlobalDisappearTimer(ms: number): void {
    try {
      const w = window as any;
      if (w.__jmailDisappearTimer) return;
      w.__jmailDisappearTimer = setTimeout(() => {
        try { w.__jmailDisappearTimer = null; } catch {}
        window.dispatchEvent(new CustomEvent('jmail:disappearNow'));
      }, ms);
    } catch {}
  }

  // Commit animation + optimistic operation; collapse deferred by global timer
  type CommitOpts = { suppressSnackbar?: boolean; suppressReload?: boolean; forceDirection?: 1 | -1; ruleKey?: string; perform?: boolean };
  async function commitAction(action: 'archive' | 'delete' | 'snooze', opts?: CommitOpts): Promise<void> {
    if (committed) return;
    if (action === 'delete' && confirmDelete) {
      if (!confirm('Delete this conversation?')) return;
    }
    committed = true;
    exiting = true;
    animating = true;
    const sign = (opts?.forceDirection) ?? (dx >= 0 ? 1 : -1);
    const exitMs = 200; // fast initial slide
    const collapseMs = 160; // collapse duration when global timer fires
    try { rowHeightPx = rowEl?.clientHeight || rowHeightPx; } catch {}
    // Translate off-screen
    const W = width || 320;
    dx = sign * (W + 40);
    // Keep row alive through wait + collapse so it can clear with the group
    holdThread(thread.threadId, disappearMs + collapseMs + 100);
    // Briefly lock list interactions during coordinated collapse
    try { window.dispatchEvent(new CustomEvent('jmail:listLock', { detail: { ms: exitMs + collapseMs + 120 } })); } catch {}
    // Start (or join) global disappear timer so all committed items clear together
    startGlobalDisappearTimer(disappearMs);
    await new Promise((r) => setTimeout(r, exitMs));
    exiting = false;
    // Perform action + snackbar immediately after slide
    if (opts?.perform !== false) {
      lastCommittedAction = { type: action, ruleKey: opts?.ruleKey };
      if (action === 'archive') {
        await archiveThread(thread.threadId);
        if (!opts?.suppressSnackbar) showSnackbar({ message: 'Archived 1 conversation', actions: { Undo: () => undoLast(1) }, timeout: 5000 });
      } else if (action === 'delete') {
        await trashThread(thread.threadId);
        if (!opts?.suppressSnackbar) showSnackbar({ message: 'Deleted 1 conversation', actions: { Undo: () => undoLast(1) }, timeout: 5000 });
      } else if (action === 'snooze') {
        const k = opts?.ruleKey || defaultSnoozeKey;
        if (k) {
          await snoozeThreadByRule(thread.threadId, k, { optimisticLocal: true });
          if (!opts?.suppressSnackbar) showSnackbar({ message: `Snoozed ${k}`, actions: { Undo: () => undoLast(1) }, timeout: 5000 });
        } else {
          showSnackbar({ message: 'No snooze labels configured. Map them in Settings.' });
        }
      }
    }
    if (!opts?.suppressReload) scheduleReload();
    // Start (or join) global disappear timer (no-op if already set)
    startGlobalDisappearTimer(disappearMs);
  }

  function onPointerDown(e: PointerEvent) {
    startTarget = e.target as HTMLElement;
    downInInteractive = !!startTarget?.closest(
      'button,summary,details,input,textarea,select,[data-no-row-nav]'
    );
    if (downInInteractive) return;
    if (selectionActive) return; // disable swipe in multi-select mode
    dragging = true;
    animating = false;
    startX = e.clientX;
    startY = e.clientY;
    lastMoveAt = performance.now();
    lastMoveX = startX;
    isHorizontal = false;
    crossedHint = false;
    crossedCommit = false;
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
    const currentDx = dx;
    const absDx = Math.abs(currentDx);
    const commitDist = (width || 1) * 0.5;
    const hintDist = (width || 1) * 0.1;
    const commitByDist = absDx >= commitDist;
    const commitByVelocity = Math.abs(vx) >= commitVelocity;
    const shouldCommit = commitByDist || commitByVelocity;
    if (captured) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
      captured = false;
      if (shouldCommit) {
        const action = primaryFor(currentDx);
        haptic(action === 'delete' ? 'heavy' : 'medium');
        await commitAction(action);
        return;
      }
    }
    // Cancel snap-back
    animating = true;
    dx = 0;
    setTimeout(() => { animating = false; }, 140);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || downInInteractive) return;
    // Measure width lazily
    try { width = containerEl?.clientWidth || rowEl?.clientWidth || width; } catch {}
    const now = performance.now();
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const angleDeg = Math.atan2(absY, Math.max(1, absX)) * 180 / Math.PI;
    const passGuard = angleDeg <= 15;
    if (!captured) {
      if (absX > 8 && passGuard) {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        captured = true;
        isHorizontal = true;
      } else if (absY > 8 && !passGuard) {
        // vertical wins
        dragging = false;
        return;
      } else {
        return;
      }
    }
    // Update velocity (px/s)
    const dtMs = Math.max(1, now - lastMoveAt);
    const dxSince = e.clientX - lastMoveX;
    vx = (dxSince / dtMs) * 1000;
    lastMoveAt = now;
    lastMoveX = e.clientX;
    const maxTranslate = width; // allow full width
    dx = Math.max(Math.min(deltaX, maxTranslate), -maxTranslate);
    const absDx = Math.abs(dx);
    const commitDist = (width || 1) * 0.5;
    const hintDist = (width || 1) * 0.1;
    const crossedHintNow = absDx >= hintDist;
    if (crossedHintNow && !crossedHint) { crossedHint = true; haptic('light'); }
    crossedCommit = absDx >= commitDist;
  }

  function onPointerCancel(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    if (captured) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
      captured = false;
    }
    animating = true;
    dx = 0;
    setTimeout(() => { animating = false; }, 140);
  }

  async function animateAndDelete(): Promise<void> { await commitAction('delete'); }

  async function animateAndArchive(): Promise<void> { await commitAction('archive'); }

  async function animateAndUnsnooze(): Promise<void> {
    // Unsnooze keeps INBOX; no collapse
    await manualUnsnoozeThread(thread.threadId, { optimisticLocal: true });
    showSnackbar({ message: 'Unsnoozed', actions: { Undo: () => undoLast(1) } });
  }

  async function animateAndSnooze(ruleKey: string, label = 'Snoozed'): Promise<void> { await commitAction('snooze', { ruleKey }); }

  // User label chips for inline removal
  const labelById = $derived(Object.fromEntries(($labelsStore || []).filter((l) => l && l.type === 'user').map((l) => [l.id, l])) as Record<string, import('$lib/types').GmailLabel>);
  const userLabelsForThread = $derived((thread.labelIds || []).map((id) => labelById[id]).filter(Boolean) as import('$lib/types').GmailLabel[]);

  async function removeLabelInline(labelId: string, labelName?: string): Promise<void> {
    try {
      await queueThreadModify(thread.threadId, [], [labelId], { optimisticLocal: true });
      await recordIntent(thread.threadId, { type: 'removeLabel', addLabelIds: [], removeLabelIds: [labelId] }, { addLabelIds: [labelId], removeLabelIds: [] });
      showSnackbar({ message: `Removed label${labelName ? ` “${labelName}”` : ''}`, actions: { Undo: () => undoLast(1) }, timeout: 4000 });
    } catch {
      showSnackbar({ message: 'Failed to remove label' });
    }
  }

  function formatDateTime(ts?: number): string {
    if (!ts) return '';
    try {
      const date = new Date(ts);
      const today = new Date();
      const timeStr = date.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' });
      const isToday = (date.getFullYear() === today.getFullYear() &&
                       date.getMonth() === today.getMonth() &&
                       date.getDate() === today.getDate());
      if (isToday) {
        return `Today, ${timeStr}`;
      }
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const isYesterday = (date.getFullYear() === yesterday.getFullYear() &&
                           date.getMonth() === yesterday.getMonth() &&
                           date.getDate() === yesterday.getDate());
      if (isYesterday) {
        return `Yesterday, ${timeStr}`;
      }
      return date.toLocaleString(undefined, {
        weekday: 'short',
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

  // Dynamic trailing snooze buttons (3rd and 4th)
  let thirdSnoozeKey = $derived(normalizeRuleKey($lastSelectedSnoozeRuleKey || '1h'));
  let fourthSnoozeKey = $derived(incrementSnoozeKey(thirdSnoozeKey));

  // Local autoclose action for details menus (mirrors SplitButton behavior)
  const autoclose = (node: HTMLDetailsElement) => {
    const close = (e: Event) => {
      const target = e.target as Element | null;
      if (!target) { node.open = false; return; }
      if (target.closest('summary')) return;
      const inside = node.contains(target);
      if (inside) {
        if (target.closest('.picker')) return;
        if (target.closest('button, [role="menuitem"], a[href]')) {
          node.open = false;
          return;
        }
        return;
      }
      node.open = false;
    };
    window.addEventListener('click', close, true);
    return { destroy() { window.removeEventListener('click', close, true); } };
  };

  let snoozeDetails: HTMLDetailsElement | null = null;

  function openSnoozeMenuAndShowPicker(): void {
    try {
      if (!snoozeDetails) return;
      snoozeDetails.open = true;
      // Date picker now embedded in menu; no native showPicker needed
    } catch {}
  }

  // Synchronize group slide across multiple rows and group collapse
  onMount(() => {
    function handleGroupSlide(ev: Event) {
      try {
        const e = ev as CustomEvent<{ action: 'archive' | 'delete' | 'snooze'; ids: string[]; ruleKey?: string }>;
        const ids = e.detail?.ids || [];
        const action = e.detail?.action;
        if (!action || !ids.includes(thread.threadId)) return;
        if (committed) return;
        const dir: 1 | -1 = action === 'delete' ? -1 : 1;
        void commitAction(action, { perform: false, suppressSnackbar: true, suppressReload: true, forceDirection: dir, ruleKey: e.detail?.ruleKey });
      } catch {}
    }
    function handleDisappear() {
      if (!committed || collapsing) return;
      animating = true;
      collapsing = true;
      setTimeout(() => { animating = false; }, 160);
    }
    window.addEventListener('jmail:groupSlide', handleGroupSlide as EventListener);
    window.addEventListener('jmail:disappearNow', handleDisappear);
    return () => { window.removeEventListener('jmail:groupSlide', handleGroupSlide as EventListener); window.removeEventListener('jmail:disappearNow', handleDisappear); };
  });
</script>

{#snippet defaultLeading()}
  <div class={`avatar ${unread ? 'unread' : ''}`} aria-hidden="true">{senderInitial}</div>
{/snippet}

{#snippet threadHeadline()}
  <span class="row-headline">
    <span class="title">
      {#if aiSubjectReady}
        <span class="ai-flag" aria-label="AI generated" title="AI generated">
          <Icon icon={iconSparkles} />
        </span>
      {/if}
      {threadDisplaySubject}
    </span>
  </span>
{/snippet}

{#snippet threadSupporting()}
  <div class="supporting">
    {#if userLabelsForThread.length}
      <div class="labels-wrap">
        {#each userLabelsForThread as l}
          <Chip variant="input" trailingIcon={iconX} onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); removeLabelInline(l.id, l.name || l.id); }}>{l.name || l.id}</Chip>
        {/each}
      </div>
    {/if}
    {#if thread.lastMsgMeta?.date}
      <span class="badge m3-font-label-small">{formatDateTime(thread.lastMsgMeta.date)}</span>
    {/if}
  </div>
{/snippet}

{#snippet trailing()}
  <div class="actions" style={`opacity:${dx === 0 ? 1 : 0}; pointer-events:${dx === 0 ? 'auto' : 'none'};`}>
    {#if isSnoozedThread(thread)}
      <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndUnsnooze(); }}>Unsnooze</Button>
    {/if}
    <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndArchive(); }}>Archive</Button>
    <Button variant="text" color="error" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndDelete(); }}>Delete</Button>
    <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); trySnooze(thirdSnoozeKey); }}>{thirdSnoozeKey}</Button>
    <div class="snooze-wrap" role="button" tabindex="0" data-no-row-nav onclick={(e) => { const t = e.target as Element; if (t?.closest('summary,button,input,select,textarea,a,[role="menu"],[role="menuitem"]')) { e.stopPropagation(); return; } e.preventDefault(); e.stopPropagation(); }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { const t = e.target as Element; if (t?.closest('summary,button,input,select,textarea,a,[role="menu"],[role="menuitem"]')) { e.stopPropagation(); return; } e.preventDefault(); e.stopPropagation(); } }}>
      <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); trySnooze(fourthSnoozeKey); }}>{fourthSnoozeKey}</Button>
      <div class="snooze-buttons">
        <details class="menu-toggle" bind:this={snoozeDetails} use:autoclose ontoggle={(e) => { const isOpen = (e.currentTarget as HTMLDetailsElement).open; snoozeMenuOpen = isOpen; }}>
          <summary aria-label="Snooze menu" aria-haspopup="menu" aria-expanded={snoozeMenuOpen} onpointerdown={(e: PointerEvent) => e.stopPropagation()} onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); const d = snoozeDetails || (e.currentTarget as HTMLElement).closest('details') as HTMLDetailsElement | null; if (!d) return; if (!d.open) { openSnoozeMenuAndShowPicker(); } else { d.open = false; } }}>
            <Button variant="text" iconType="full" aria-label="Snooze menu" class="expand-button">
              <Icon icon={iconExpand} />
            </Button>
          </summary>
          <div class="snooze-menu">
            <Menu>
              {#if mappedKeys.length > 0}
                <SnoozePanel onSelect={(rk) => { lastSelectedSnoozeRuleKey.set(normalizeRuleKey(rk)); trySnooze(rk); const d = snoozeDetails; if (d) d.open = false; }} />
              {:else}
                <div style="padding:0.5rem 0.75rem; max-width: 21rem;" class="m3-font-body-small">No snooze labels configured. Map them in Settings.</div>
              {/if}
            </Menu>
          </div>
        </details>
      </div>
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

<div class="row-container" bind:this={rowEl} style={`height:${collapsing ? '0px' : (rowHeightPx != null ? rowHeightPx + 'px' : 'auto')}; transition: ${collapsing ? 'height 160ms cubic-bezier(0,0,0.2,1), opacity 160ms cubic-bezier(0,0,0.2,1)' : 'none'}; opacity:${collapsing ? 0 : 1};`}>
<div class="swipe-wrapper" class:menu-open={snoozeMenuOpen}
     onpointerdown={onPointerDown}
     onpointermove={onPointerMove}
     onpointerup={onPointerUp}
     onpointercancel={onPointerCancel}
     bind:this={containerEl}
>
  <div class="bg" aria-hidden="true" style={`pointer-events:${Math.abs(dx) >= (width*0.2) ? 'auto' : 'none'}` }>
    {#if dx !== 0}
      {@const action = primaryFor(dx)}
      <div class={`fill ${dx > 0 ? 'fill-archive' : 'fill-delete'}`} style={`opacity:${0.3 + Math.min(1, Math.abs(dx)/(width*0.5)) * 0.7}`}></div>
      <div class={`affordance ${dx > 0 ? 'left' : 'right'}`} style={`opacity:${0.3 + Math.min(1, Math.abs(dx)/(width*0.5)) * 0.7}; transform: scale(${0.85 + Math.min(1, Math.abs(dx)/(width*0.5))*0.15});`}>
        <Icon icon={action === 'archive' ? iconArchive : iconDelete} />
      </div>
      <div class="tray" style={`opacity:${Math.max(0, Math.min(1, (Math.abs(dx)/(width*0.5) - 0.2) / 0.3))}; justify-content:center; pointer-events:${lastCommittedAction ? 'auto' : 'none'}` }>
        {#if lastCommittedAction}
          <Button variant="text" style={`color:${getUndoTextColor()}`} onclick={async (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); cancelGlobalDisappearTimer(); await undoLast(1); animating = true; dx = 0; committed = false; lastCommittedAction = null; setTimeout(() => { animating = false; }, 140); }}>
            <span>Undo {formatUndoLabel()}</span>
          </Button>
        {/if}
      </div>
    {/if}
  </div>
  <div class="fg" style={`transform: translateX(${dx}px); transition: ${animating ? 'transform 200ms cubic-bezier(0,0,0.2,1)' : 'none'};`} in:fade={{ duration: 180 }} out:fade={{ duration: 180 }}>
    <ListItem
      leading={onToggleSelected ? SN_selectionLeading : SN_defaultLeading}
      overline={senderDisplay}
      headlineSnippet={SN_threadHeadline}
      supportingSnippet={SN_threadSupporting}
      lines={3}
      unread={(thread.labelIds || []).includes('UNREAD')}
      href={`${base || ''}/viewer/${thread.threadId}`}
      trailing={SN_trailingWithDate}
    />
  </div>
</div>
</div>

<style>
  .row-container { will-change: height, opacity; }
  .swipe-wrapper {
    position: relative;
    overflow: hidden;
    min-width: 0;
  }
  .swipe-wrapper:has(:global(details[open])) {
    overflow: visible;
    pointer-events: none; /* prevent row beneath menu from catching clicks */
  }
  .swipe-wrapper:has(:global(details[open])) :global(details[open]) {
    pointer-events: auto; /* but allow interactions within the open menu */
  }
  /* Ensure anchor overlay doesn't capture clicks under menu */
  .swipe-wrapper:has(:global(details[open])) :global(a.m3-container) { pointer-events: none; }
  .bg {
    position: absolute;
    inset: 0;
    pointer-events: none;
    contain: strict;
  }
  .bg .fill { position:absolute; inset:0; opacity:0; transition: opacity 120ms linear; }
  .bg .fill.fill-archive { background: rgb(var(--m3-scheme-secondary-container)); }
  .bg .fill.fill-delete { background: rgb(var(--m3-scheme-error-container)); }
  .affordance { position:absolute; top:0; bottom:0; display:flex; align-items:center; gap:0.5rem; padding: 0 1rem; color: rgb(var(--m3-scheme-on-secondary-container)); }
  .affordance.right { right: 0; justify-content: flex-end; color: rgb(var(--m3-scheme-on-error-container)); }
  .affordance.left { left: 0; justify-content: flex-start; color: rgb(var(--m3-scheme-on-secondary-container)); }
  /* label removed from affordance to avoid duplication with trailing actions */
  .tray { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:0.25rem; opacity:0; pointer-events:none; flex-wrap: nowrap; }
  .tray :global(button) { min-width: 48px; min-height: 40px; }
  .tray :global(span) { white-space: nowrap; }
  .fg {
    position: relative;
    background: rgb(var(--m3-scheme-surface));
    min-width: 0;
  }
  .actions { display:flex; flex-direction: row; flex-wrap: wrap; gap:0.5rem; align-items:center; justify-content:flex-end; min-width: 0; }
  /* Keep trailing actions vertically centered even on 3-line rows */
  .actions { align-self: center; }
  /* Make text buttons in trailing actions more compact to reduce visual gap */
  .actions :global(.m3-container.text) { padding-inline: 0.625rem; height: 2.5rem; min-width: 0; }
  /* Allow line breaks inside button labels when space is tight */
  .actions :global(.m3-container.text span) { white-space: normal; }
  /* Ensure 30d and 1h actions can sit on the same line */
  .snooze-wrap { display:inline-flex; align-items:center; gap: 0.5rem; flex: 0 0 auto; flex-wrap: nowrap; }
  .snooze-menu :global(.m3-container) { padding: 0.75rem; max-width: 24rem; max-height: min(95vh, 44rem); }
  /* Separate snooze and toggle button styles */
  .snooze-buttons { display:inline-flex; align-items:center; position: relative; gap: 0.5rem; flex-wrap: nowrap; }
  .menu-toggle { position: relative; }
  .menu-toggle > :global(:not(summary)) { position: absolute !important; z-index: 10; right: 0; top: 100%; pointer-events: auto; }
  /* Reset native marker on summary for MD3 button inside */
  .menu-toggle > summary { list-style: none; }
  /* Slightly larger tap target for expand */
  .expand-button { min-width: 2.25rem; min-height: 2.25rem; }
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
  /* Avatar and headline/meta styling */
  .avatar {
    width: 2rem;
    height: 2rem;
    border-radius: 9999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 0.875rem;
    background: rgb(var(--m3-scheme-surface-variant));
    color: rgb(var(--m3-scheme-on-surface-variant));
    flex-shrink: 0;
  }
  .avatar.unread {
    background: rgb(var(--m3-scheme-primary));
    color: rgb(var(--m3-scheme-on-primary));
  }
  .row-headline {
    display: inline-flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
  }
  .row-headline .title {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: normal; /* Allow wrapping for multiline */
    font-weight: 500;
  }
  .row-headline .meta {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: rgb(var(--m3-scheme-on-surface-variant));
    white-space: nowrap;
  }
  .row-headline .meta :global(svg) { width: 1rem; height: 1rem; }
  .supporting { display: flex; align-items: center; gap: 0.5rem; }
  .labels-wrap { display:flex; gap: 0.25rem; flex-wrap: wrap; }
  .badge {
    display: inline-block;
    padding: 0.125rem 0.375rem;
    border-radius: var(--m3-util-rounding-extra-small);
    background: rgb(var(--m3-scheme-secondary-container));
    color: rgb(var(--m3-scheme-on-secondary-container));
    white-space: nowrap;
  }
</style>


