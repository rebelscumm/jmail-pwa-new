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
  import CalendarPopover from '$lib/snooze/CalendarPopover.svelte';
  import { lastSelectedSnoozeRuleKey } from '$lib/stores/snooze';
  import Icon from '$lib/misc/_icon.svelte';
  import iconGmail from '$lib/icons/gmail';
  import Layer from '$lib/misc/Layer.svelte';
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
  import iconInfo from '@ktibow/iconset-material-symbols/info';
  import iconOpenInNew from '@ktibow/iconset-material-symbols/open-in-new';
  import { getPrecomputeSummary } from '$lib/ai/precompute';
  import RecipientBadges from '$lib/utils/RecipientBadges.svelte';
  import { messages as messagesStore } from '$lib/stores/threads';
  import { openGmailPopup } from '$lib/utils/gmail-links';
  import iconUnsubscribe from '@ktibow/iconset-material-symbols/unsubscribe';
  import { findUnsubscribeTarget, aiExtractUnsubscribeUrl, getFriendlyAIErrorMessage } from '$lib/ai/providers';
  import { getMessageFull } from '$lib/gmail/api';
  import iconTask from '@ktibow/iconset-material-symbols/task-alt';

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
  // Consider a summary "ready" for UI purposes if we have any cached summary text.
  // This ensures the UI will prefer showing a previously computed summary while
  // a newer summary (different version) is being recomputed in the background.
  // Consider a summary "ready" for UI purposes if we have any cached summary text.
  // We will never treat a cached summary as missing; prefer cached summaries to
  // avoid rerunning AI in the background.
  const aiSummaryReady = $derived((() => {
    try {
      const s = thread.summary as string | undefined;
      return !!(s && String(s).trim());
    } catch { return false; }
  })());

  // Stale indicator: true when a cached summary exists but its version differs
  // from the current app summary schema/version and the cached summary does
  // not appear up-to-date for the current thread content. If the cached
  // summary is present and the content appears unchanged since it was
  // generated, prefer the cached summary (treat as not stale) even if the
  // configured AI summary version has incremented. This mirrors the
  // precompute/explain logic used elsewhere.
  const aiSummaryStale = $derived((() => {
    try {
      // Without versioning, a summary is considered stale only if the
      // content has changed since it was generated (bodyHash/summaryUpdatedAt)
      try {
        if (!thread.summary) return false;
        const bodyHash = (thread as any).bodyHash;
        const summaryUpdatedAt = (thread as any).summaryUpdatedAt || 0;
        const lastMsgDate = thread.lastMsgMeta?.date || 0;
        // If there's no bodyHash/updatedAt info, be conservative and mark not stale
        if (!bodyHash || !summaryUpdatedAt) return false;
        // If the last message is newer than the summary update, treat as stale
        return lastMsgDate > summaryUpdatedAt;
      } catch { return false; }
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
    // Set flag to prevent navigation during snooze
    isSnoozing = true;
    
    // Close snooze menu immediately to prevent any navigation from details closing
    if (snoozeDetails) snoozeDetails.open = false;
    
    // Check current route - if we're viewing this thread, navigate to inbox first
    // This prevents "thread not loaded" message after snoozing
    const shouldNavigateToInbox = (() => {
      if (typeof window === 'undefined' || typeof location === 'undefined') return false;
      try {
        const currentPath = location.pathname;
        const viewerPath = `/viewer/${thread.threadId}`;
        return currentPath.includes(viewerPath);
      } catch {
        return false;
      }
    })();
    
    // Navigate to inbox immediately if we're viewing the thread (before optimistic updates)
    if (shouldNavigateToInbox) {
      (async () => {
        try {
          const { goto } = await import('$app/navigation');
          goto('/inbox').catch(() => {
            try { location.href = '/inbox'; } catch {}
          });
        } catch {
          try { location.href = '/inbox'; } catch {}
        }
      })();
    }
    
    // Perform snooze operation (may complete after navigation)
    try {
      await animateAndSnooze(k, 'Snoozed');
    } finally {
      // Clear flag after a short delay to allow any pending navigation attempts to be blocked
      setTimeout(() => { isSnoozing = false; }, 100);
    }
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
  
  // Get the first message for recipient info
  const firstMessage = $derived((() => {
    const firstId = thread.messageIds?.[0];
    return firstId ? $messagesStore[firstId] : null;
  })());

  // Get the last message for unsubscribe detection
  const lastMessage = $derived((() => {
    const messageIds = thread.messageIds || [];
    const lastId = messageIds.length > 0 ? messageIds[messageIds.length - 1] : null;
    return lastId ? $messagesStore[lastId] : null;
  })());

  // Check if thread has unsubscribe capability (quick check via headers)
  const hasUnsubscribeCapability = $derived((() => {
    const msg = lastMessage;
    if (!msg?.headers) return false;
    // Check for List-Unsubscribe header
    const listUnsub = msg.headers['List-Unsubscribe'] || msg.headers['list-unsubscribe'] || msg.headers['List-Unsubscribe-Post'] || msg.headers['list-unsubscribe-post'];
    if (listUnsub) return true;
    // If we have bodyHtml, check for unsubscribe links
    if (msg.bodyHtml) {
      const quickCheck = findUnsubscribeTarget(msg.headers, msg.bodyHtml);
      if (quickCheck) return true;
    }
    return false;
  })());

  let extractingUnsub = $state(false);

  async function removeLabelInline(labelId: string, labelName?: string): Promise<void> {
    try {
      await queueThreadModify(thread.threadId, [], [labelId], { optimisticLocal: true });
      await recordIntent(thread.threadId, { type: 'removeLabel', addLabelIds: [], removeLabelIds: [labelId] }, { addLabelIds: [labelId], removeLabelIds: [] });
      showSnackbar({ message: `Removed label${labelName ? ` "${labelName}"` : ''}`, actions: { Undo: () => undoLast(1) }, timeout: 4000 });
    } catch {
      showSnackbar({ message: 'Failed to remove label' });
    }
  }

  async function handleUnsubscribe(e: MouseEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    if (extractingUnsub) return;
    const messageIds = thread.messageIds || [];
    const lastId = messageIds.length > 0 ? messageIds[messageIds.length - 1] : null;
    if (!lastId) {
      showSnackbar({ message: 'No message found', closable: true });
      return;
    }
    extractingUnsub = true;
    try {
      showSnackbar({ message: 'Looking for unsubscribe link…' });
      // Get full message if not already available
      let msg = $messagesStore[lastId];
      if (!msg?.bodyHtml && !msg?.bodyText) {
        try {
          msg = await getMessageFull(lastId);
        } catch (err) {
          showSnackbar({ message: 'Could not load message', closable: true });
          return;
        }
      }
      if (!msg) {
        showSnackbar({ message: 'Message not found', closable: true });
        return;
      }
      // Try to find unsubscribe target
      let target = findUnsubscribeTarget(msg.headers, msg.bodyHtml);
      if (!target && msg.bodyHtml) {
        // Try AI extraction as fallback
        try {
          target = await aiExtractUnsubscribeUrl(msg.headers?.Subject || '', msg.bodyText, msg.bodyHtml);
        } catch (aiErr) {
          // AI extraction failed, but we'll show the error below if no target found
        }
      }
      if (target) {
        // Show snackbar with action buttons instead of browser confirm
        showSnackbar({
          message: `Unsubscribe link found: ${target.length > 60 ? target.substring(0, 60) + '…' : target}`,
          actions: {
            Open: () => {
              window.open(target, '_blank');
              showSnackbar({ message: 'Opened unsubscribe link', closable: true });
            }
          },
          closable: true,
          timeout: 10000
        });
      } else {
        showSnackbar({ message: 'No unsubscribe link found', closable: true, timeout: 5000 });
      }
    } catch (e) {
      const { message } = getFriendlyAIErrorMessage(e, 'Unsubscribe');
      showSnackbar({
        message,
        closable: true,
        timeout: 6000
      });
    } finally {
      extractingUnsub = false;
    }
  }

  async function handleCreateTask(e: MouseEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    const link = `https://mail.google.com/mail/u/0/#inbox/${thread.threadId}`;
    const subject = threadDisplaySubject;
    const line = `[${subject}](${link})`;
    try {
      // Desktop: copy; user can paste into their task file
      await navigator.clipboard.writeText(line);
      // Verify clipboard actually contains the line; if read is blocked or mismatch, fallback to showing the text
      try {
        const readBack = await navigator.clipboard.readText();
        if (readBack === line) {
          showSnackbar({ message: 'Task line copied to clipboard.', closable: true });
        } else {
          showSnackbar({ message: line, closable: true });
        }
      } catch (_) {
        // If we cannot read the clipboard (permission), show the line for manual copy
        showSnackbar({ message: line, closable: true });
      }
    } catch {
      showSnackbar({ message: line, closable: true });
    }
  }

  async function explainAiMissing(e: Event): Promise<void> {
    try {
      e.preventDefault?.();
      e.stopPropagation?.();
      const status = (thread as any).summaryStatus || 'none';
      // legacy aiSummaryVersion removed; no-op
      const nowVersion = undefined as any;
      // legacy summaryVersion removed; ignore
      const threadVersion = 0;
      const bodyHash = (thread as any).bodyHash;
      const summaryUpdatedAt = (thread as any).summaryUpdatedAt || 0;
      const lastMsgDate = thread.lastMsgMeta?.date || 0;
      const contentUnchanged = !!bodyHash && summaryUpdatedAt && lastMsgDate <= summaryUpdatedAt;

      const anchor = e.currentTarget as HTMLElement | undefined;

      // Quick short-circuit cases first
      if (status === 'pending') {
        // If a cached summary exists, prefer to present that information and
        // avoid implying the app will overwrite it. This prevents confusing
        // tooltips when lingering `pending` markers remain in the DB.
        if (thread.summary && String(thread.summary).trim()) {
          let txt = 'Cached AI summary is available and will be used.';
          if (summaryUpdatedAt) txt += `\nCached summary last updated: ${formatDateTime(summaryUpdatedAt)}`;
          // Include when the pending marker was set for transparency, but do not
          // suggest the cached summary will be replaced automatically.
          const pendingSince = (thread as any).summaryPendingAt || ((thread as any).summaryUpdatedAt === summaryUpdatedAt && (thread as any).summaryStatus === 'pending' ? (thread as any).summaryUpdatedAt : (thread as any).aiSubjectUpdatedAt) || 0;
          if (pendingSince) txt += `\nBackground recompute started: ${formatDateTime(pendingSince)}`;
          showTooltip(txt, 8000, e.currentTarget as HTMLElement);
          return;
        }
        // Fallback message when there's no cached summary
        let txt = 'AI summary is being recomputed in the background.';
        if (summaryUpdatedAt) txt += `\nCached summary last updated: ${formatDateTime(summaryUpdatedAt)}`;
        const pendingSince = (thread as any).summaryPendingAt || ((thread as any).summaryUpdatedAt === summaryUpdatedAt && (thread as any).summaryStatus === 'pending' ? (thread as any).summaryUpdatedAt : (thread as any).aiSubjectUpdatedAt) || 0;
        if (pendingSince) txt += `\nRecompute started: ${formatDateTime(pendingSince)}`;
        txt += `\nCached summary present: ${!!thread.summary}`;
        if (thread.summary && String(thread.summary).trim()) txt += `\nContent has changed since cached summary: ${!contentUnchanged ? 'yes' : 'no'}`;
        showTooltip(txt, 8000, e.currentTarget as HTMLElement);
        return;
      }
      if (status === 'error') {
        let txt = 'AI summary generation failed. Open the thread and click Summarize to retry.';
        showTooltip(txt, 8000, e.currentTarget as HTMLElement);
        return;
      }

      // Build a list of applicable troubleshooting reasons for this thread
      const applicable: string[] = [];
      try {
        // Global precompute summary (errors/warns, activity)
        const preSummary = getPrecomputeSummary();
        if ((preSummary && (preSummary.errors || 0) > 0)) applicable.push('Errors occurred during precompute; check precompute logs for details.');
        // Precompute disabled
        if (!$settings?.precomputeSummaries) applicable.push('Background precompute is disabled in Settings.');

        // Thread-level checks
        const labels = thread.labelIds || [];
        const inInbox = labels.includes('INBOX');
        const inSpamOrTrash = labels.includes('SPAM') || labels.includes('TRASH');
        if (!inInbox || inSpamOrTrash) applicable.push('This thread is not visible in INBOX (it may be in SPAM or TRASH or filtered by Gmail).');

        // Missing or stale cached summary
        if (!thread.summary || !String(thread.summary).trim()) applicable.push('No cached AI summary exists for this thread.');
        if (summaryUpdatedAt && lastMsgDate && lastMsgDate > summaryUpdatedAt) applicable.push('Local cached summary appears stale compared to the last message; sync with Gmail to refresh thread data.');

        // Body availability / scopes: prefer detecting cached message bodies before
        // assuming missing Gmail scopes. If we don't have a thread-level bodyHash,
        // check the local messages store for a cached full message body first.
        if (!bodyHash) {
          try {
            const lastId = (thread.messageIds && thread.messageIds.length) ? thread.messageIds[thread.messageIds.length - 1] : null;
            let foundCachedBody = false;
            if (lastId) {
              try {
                const { getDB } = await import('$lib/db/indexeddb');
                const db = await getDB();
                const cached = await db.get('messages', lastId);
                if (cached && (cached.bodyText || cached.bodyHtml)) foundCachedBody = true;
              } catch (_) {
                // ignore DB errors and fall back to token checks below
              }
            }
            if (!foundCachedBody) {
              try {
                const { fetchTokenInfo } = await import('$lib/gmail/auth');
                try {
                  const info = await fetchTokenInfo();
                  const hasBodyScopes = !!info?.scope && (info.scope.includes('gmail.readonly') || info.scope.includes('gmail.modify'));
                  if (!hasBodyScopes) {
                    applicable.push('Missing Gmail read/modify scopes: the app may not have access to full message bodies.');
                  } else {
                    applicable.push('Message bodies appear unavailable for this thread (could not fetch full message).');
                  }
                } catch (_) {
                  applicable.push('Unable to determine Gmail token scopes; message bodies may be unavailable.');
                }
              } catch (_) {
                applicable.push('Message bodies may be unavailable or token info could not be read.');
              }
            }
          } catch (_) {}
        }

        // Previous per-thread failures
        if ((thread as any).summaryStatus === 'error' || (thread as any).aiSubjectStatus === 'error') applicable.push('Previous AI summary generation for this thread failed.');
      } catch (_) {}

      // If version mismatch and cached summary exists, explain and list applicable reasons
      // If we have a cached summary, explain its freshness using timestamps
      if (thread.summary && String(thread.summary).trim()) {
        let txt = 'Cached AI summary available.';
        txt += `\nCached summary status: ${(thread as any).summaryStatus || 'none'}`;
        if (summaryUpdatedAt) txt += `\nCached summary last updated: ${formatDateTime(summaryUpdatedAt)}`;
        if (lastMsgDate) txt += `\nLast message date: ${formatDateTime(lastMsgDate)}`;
        if (summaryUpdatedAt && lastMsgDate && lastMsgDate > summaryUpdatedAt) txt += `\nNote: cached summary appears stale relative to last message.`;
        if (applicable.length) txt += '\n\nApplicable reasons:\n' + applicable.map((r) => `- ${r}`).join('\n');
        showTooltip(txt, 10000, e.currentTarget as HTMLElement);
        return;
      }

      // If version mismatch and no cached summary, attempt to start background precompute
      // No cached summary: explain reasons and start precompute. Include timestamps where available
      if (!(thread.summary && String(thread.summary).trim())) {
        let txt = `No cached AI summary is available for this thread. Starting background precompute to generate missing summaries.`;
        // Keep a short history only: show cached summary timestamp (if any) and last message date
        if (summaryUpdatedAt) txt += `\nLast cached summary update: ${formatDateTime(summaryUpdatedAt)}`;
        if (lastMsgDate) txt += `\nLast message date: ${formatDateTime(lastMsgDate)}`;
        if (applicable.length) txt += '\n\nApplicable reasons:\n' + applicable.map((r) => `- ${r}`).join('\n');
        showTooltip(txt, 9000, anchor);
        try {
          const mod = await import('$lib/ai/precompute');
          void (mod as any).precomputeNow(25);
        } catch (_) {
          showTooltip('Failed to start background precompute. Open Settings and ensure an AI API key is configured.', 8000, anchor);
        }
        return;
      }

      // Default case: show reasons and action
      let txt = 'No AI summary available. Open the thread and click Summarize to generate one.';
      if (applicable.length) txt += '\n\nApplicable reasons:\n' + applicable.map((r) => `- ${r}`).join('\n');
      showTooltip(txt, 9000, e.currentTarget as HTMLElement);
      return;
    } catch (_) {}
  }

  // Tooltip state and helpers (render tooltip as a fixed element appended to document.body
  // so it won't be clipped by the row container)
  import { onDestroy } from 'svelte';
  let tooltipText = $state('');
  let tooltipTimer: number | null = $state(null);
  let tooltipEl: HTMLElement | null = null;

  function createTooltipElement(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'thread-tooltip';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.position = 'fixed';
    el.style.zIndex = '40';
    // Make tooltip opaque and match previous tooltip visuals.
    // Use CSS variables where possible but force opaque rendering and disable blending/backdrop
    el.style.setProperty('background-color', 'rgb(var(--m3-scheme-surface))');
    el.style.setProperty('color', 'rgb(var(--m3-scheme-on-surface))');
    el.style.setProperty('border', '1px solid rgb(var(--m3-scheme-outline))');
    el.style.setProperty('padding', '0.5rem 0.75rem');
    el.style.setProperty('border-radius', '0.375rem');
    el.style.setProperty('font-size', '0.75rem');
    el.style.setProperty('white-space', 'pre-wrap');
    el.style.setProperty('box-shadow', 'var(--m3-util-elevation-2)');
    // Force opaque and normal blending to avoid translucency from theme or backdrop
    el.style.setProperty('opacity', '1');
    el.style.setProperty('backdrop-filter', 'none');
    el.style.setProperty('mix-blend-mode', 'normal');
    el.style.setProperty('pointer-events', 'auto');
    el.style.boxSizing = 'border-box';
    document.body.appendChild(el);
    return el;
  }

  function positionTooltipForAnchor(anchor: HTMLElement, el: HTMLElement) {
    try {
      const rect = anchor.getBoundingClientRect();
      const margin = 6;
      // Prefer placing just below the anchor, but keep inside viewport
      const top = Math.min(window.innerHeight - 8, rect.bottom + margin);
      let left = rect.left;
      // Ensure tooltip doesn't overflow to the right
      const maxW = Math.min(352, window.innerWidth - 16);
      el.style.maxWidth = maxW + 'px';
      // If left + maxW would overflow, shift left
      if (left + maxW + 8 > window.innerWidth) left = Math.max(8, window.innerWidth - maxW - 8);
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    } catch {}
  }

  function showTooltip(text: string, ms = 6000, anchor?: HTMLElement) {
    try {
      tooltipText = text;
      if (!tooltipEl) tooltipEl = createTooltipElement();
      tooltipEl.textContent = text;
      if (anchor) positionTooltipForAnchor(anchor, tooltipEl);
      // start timer
      if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
      tooltipTimer = setTimeout(() => { try { if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; } tooltipTimer = null; } catch {} }, ms) as unknown as number;
    } catch (_) {}
  }

  function hideTooltip() {
    try {
      if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
      if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
    } catch (_) {}
  }

  onDestroy(() => { try { if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; } } catch {} });

  function formatDateTime(ts?: number): string {
    if (!ts) return '';
    try {
      const date = new Date(ts);
      const today = new Date();
      const timeStr = date.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' });

      // Compute days difference (positive for past dates)
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const diffDays = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86400000);

      // Handle today/yesterday as before
      if (diffDays === 0) return `Today, ${timeStr}`;
      if (diffDays === 1) return `Yesterday, ${timeStr}`;

      // Build rough relative prefix
      let relative = '';
      if (diffDays < 7) {
        relative = `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
      } else if (diffDays < 30) {
        const weeks = Math.floor(diffDays / 7);
        relative = `${weeks} week${weeks === 1 ? '' : 's'} ago`;
      } else {
        const months = Math.round(diffDays / 30);
        relative = `${months} month${months === 1 ? '' : 's'} ago`;
      }

      const full = date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
      return `${relative}, ${full}`;
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
  // Compute plain reactive string labels so the template always receives text
  // (some derived helpers can produce values that aren't plain strings at
  // render time, causing empty children). Keep safe fallbacks.
  let thirdSnoozeKey = $state('1h');
  let fourthSnoozeKey = $state('2h');
  $effect(() => {
    try {
      thirdSnoozeKey = normalizeRuleKey($lastSelectedSnoozeRuleKey || '1h');
    } catch {
      thirdSnoozeKey = '1h';
    }
    try {
      fourthSnoozeKey = incrementSnoozeKey(thirdSnoozeKey || '1h');
    } catch {
      fourthSnoozeKey = '2h';
    }
  });

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
  let isSnoozing = $state(false); // Flag to prevent navigation during snooze

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
    function handleKeyboardAction(ev: Event) {
      try {
        const e = ev as CustomEvent<{ action: 'archive' | 'delete'; threadId: string }>;
        const targetThreadId = e.detail?.threadId;
        const action = e.detail?.action;
        if (!targetThreadId || targetThreadId !== thread.threadId || !action) return;
        if (committed) return;
        // Perform the full action with slide animation
        if (action === 'archive') {
          void animateAndArchive();
        } else if (action === 'delete') {
          void animateAndDelete();
        }
      } catch {}
    }
    function handleKeyboardSnooze(ev: Event) {
      try {
        const e = ev as CustomEvent<{ threadId: string; ruleKey: string }>;
        const targetThreadId = e.detail?.threadId;
        const ruleKey = e.detail?.ruleKey;
        if (!targetThreadId || targetThreadId !== thread.threadId || !ruleKey) return;
        if (committed) return;
        // Perform snooze action with slide animation
        void animateAndSnooze(ruleKey);
      } catch {}
    }
    function handleOpenSnoozeMenu(ev: Event) {
      try {
        const e = ev as CustomEvent<{ threadId: string }>;
        const targetThreadId = e.detail?.threadId;
        if (!targetThreadId || targetThreadId !== thread.threadId) return;
        // Open the snooze menu for this thread
        openSnoozeMenuAndShowPicker();
      } catch {}
    }
    function handleDisappear() {
      if (!committed || collapsing) return;
      animating = true;
      collapsing = true;
      setTimeout(() => { animating = false; }, 160);
    }
    window.addEventListener('jmail:groupSlide', handleGroupSlide as EventListener);
    window.addEventListener('jmail:keyboardAction', handleKeyboardAction as EventListener);
    window.addEventListener('jmail:keyboardSnooze', handleKeyboardSnooze as EventListener);
    window.addEventListener('jmail:openSnoozeMenu', handleOpenSnoozeMenu as EventListener);
    window.addEventListener('jmail:disappearNow', handleDisappear);
    return () => { 
      window.removeEventListener('jmail:groupSlide', handleGroupSlide as EventListener); 
      window.removeEventListener('jmail:keyboardAction', handleKeyboardAction as EventListener);
      window.removeEventListener('jmail:keyboardSnooze', handleKeyboardSnooze as EventListener);
      window.removeEventListener('jmail:openSnoozeMenu', handleOpenSnoozeMenu as EventListener);
      window.removeEventListener('jmail:disappearNow', handleDisappear); 
    };
  });
</script>

{#snippet defaultLeading()}
  <div class="leading-wrap">
    <div class={`avatar ${unread ? 'unread' : ''}`} aria-hidden="true">{senderInitial}</div>
    {#if Array.isArray(thread.messageIds) && (thread.messageIds || []).length > 1}
      <div class="msg-count" aria-hidden="true">{(thread.messageIds || []).length}</div>
    {/if}
  </div>
{/snippet}

{#snippet threadHeadline()}
  <span class="row-headline">
    <span class="title">
      <span class="meta">
        {#if aiSubjectReady}
          <span class={`ai-flag ${aiSummaryStale ? 'stale' : ''}`} aria-label={aiSummaryStale ? 'AI subject stale' : 'AI subject available'} title={aiSummaryStale ? 'AI subject stale' : 'AI subject available'}>
            <Icon icon={iconSparkles} />
          </span>
        {:else}
          <span class="ai-missing" role="button" tabindex="0" aria-label="AI summary unavailable" title="AI summary unavailable" onpointerenter={() => { /* noop for hover */ }} onclick={(e) => { e.preventDefault(); e.stopPropagation(); explainAiMissing(e); }} onkeydown={(e) => { if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') { e.preventDefault(); e.stopPropagation(); explainAiMissing(e); } }} onfocusin={() => { /* noop */ }}>
            <Icon icon={iconInfo} />
          </span>
        {/if}
      </span>
      {threadDisplaySubject}
      <!-- Tooltip is rendered as a fixed element attached to document.body -->
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
    {#if firstMessage?.headers}
      <RecipientBadges 
        to={firstMessage.headers.To || firstMessage.headers.to || ''} 
        cc={firstMessage.headers.Cc || firstMessage.headers.cc || ''} 
        bcc={firstMessage.headers.Bcc || firstMessage.headers.bcc || ''} 
        maxDisplayCount={3}
        compact={true} 
      />
    {/if}
    {#if thread.lastMsgMeta?.date}
      <span class="badge m3-font-label-small">{formatDateTime(thread.lastMsgMeta.date)}</span>
    {/if}
  </div>
{/snippet}

{#snippet trailing()}
  <div class="actions" style={`opacity:${dx === 0 ? 1 : 0}; pointer-events:${dx === 0 ? 'auto' : 'none'};`}>
    <Button variant="text" iconType="full" aria-label="Open in Gmail" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); openGmailPopup(thread.threadId); }}>
      <Icon icon={iconGmail} width="1rem" height="1rem" />
    </Button>
    {#if hasUnsubscribeCapability}
      <Button variant="text" iconType="full" aria-label="Unsubscribe" onclick={handleUnsubscribe} disabled={extractingUnsub} title={extractingUnsub ? 'Finding unsubscribe link…' : 'Unsubscribe'}>
        <Icon icon={iconUnsubscribe} width="1rem" height="1rem" />
      </Button>
    {/if}
    <Button variant="text" iconType="full" aria-label="Create Task" onclick={handleCreateTask} title="Create Task">
      <Icon icon={iconTask} width="1rem" height="1rem" />
    </Button>
    {#if isSnoozedThread(thread)}
      <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndUnsnooze(); }}>Unsnooze</Button>
    {/if}
    <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndArchive(); }}>Archive</Button>
    <Button variant="text" color="error" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); animateAndDelete(); }}>Delete</Button>
    <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); trySnooze(thirdSnoozeKey); }}>
      <span class="snooze-label">{thirdSnoozeKey}</span>
    </Button>
    <div class="snooze-wrap" role="button" tabindex="0" data-no-row-nav onclick={(e) => { const t = e.target as Element; if (t?.closest('summary,button,input,select,textarea,a,[role="menu"],[role="menuitem"]')) { e.stopPropagation(); return; } e.preventDefault(); e.stopPropagation(); }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { const t = e.target as Element; if (t?.closest('summary,button,input,select,textarea,a,[role="menu"],[role="menuitem"]')) { e.stopPropagation(); return; } e.preventDefault(); e.stopPropagation(); } }}>
      <Button variant="text" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); trySnooze(fourthSnoozeKey); }}>
        <span class="snooze-label">{fourthSnoozeKey}</span>
      </Button>
      <div class="snooze-buttons">
        <details class="menu-toggle" bind:this={snoozeDetails} use:autoclose ontoggle={(e) => { const isOpen = (e.currentTarget as HTMLDetailsElement).open; snoozeMenuOpen = isOpen; }}>
          <summary aria-label="Snooze menu" aria-haspopup="menu" aria-expanded={snoozeMenuOpen} 
            onpointerdown={(e: PointerEvent) => e.stopPropagation()} 
            ontouchstart={(e: TouchEvent) => e.stopPropagation()}
            onclick={(e: MouseEvent) => { 
              try {
                e.preventDefault(); 
                e.stopPropagation(); 
                
                const d = snoozeDetails || (e.currentTarget as HTMLElement).closest('details') as HTMLDetailsElement | null;
                if (!d) return;
                
                // Android-friendly toggle with multiple attempts
                const isAndroid = /Android/i.test(navigator.userAgent);
                const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
                
                if (isAndroid || isPWA) {
                  // For Android, try multiple approaches
                  try {
                    if (!d.open) {
                      d.open = true;
                      // Force a reflow to ensure the change takes effect
                      d.offsetHeight;
                      openSnoozeMenuAndShowPicker();
                    } else {
                      d.open = false;
                      d.offsetHeight;
                    }
                    return;
                  } catch (e1) {
                    console.log('[ThreadListRow] Primary Android toggle failed:', e1);
                  }
                  
                  // Fallback: Use setTimeout to defer the toggle
                  try {
                    setTimeout(() => {
                      if (!d.open) {
                        openSnoozeMenuAndShowPicker();
                      } else {
                        d.open = false;
                      }
                    }, 16);
                    return;
                  } catch (e2) {
                    console.log('[ThreadListRow] Deferred Android toggle failed:', e2);
                  }
                }
                
                // Standard behavior
                if (!d.open) { 
                  openSnoozeMenuAndShowPicker(); 
                } else { 
                  d.open = false; 
                } 
              } catch (e) {
                console.error('[ThreadListRow] Snooze menu toggle failed:', e);
                // Emergency fallback
                try {
                  const d = snoozeDetails;
                  if (d) d.open = !d.open;
                } catch {}
              }
            }}>
            <!-- Render MD3-styled container directly in summary (avoid nested button) -->
            <span class="m3-container m3-font-label-large text icon-full expand-button outlined" title="Snooze options">
              <Layer />
              <Icon icon={iconExpand} />
            </span>
          </summary>
          <div class="snooze-menu" onpointerdown={(e: PointerEvent) => { e.preventDefault(); e.stopPropagation(); }} ontouchstart={(e: TouchEvent) => { e.preventDefault(); e.stopPropagation(); }}>
            <Menu>
              {#if mappedKeys.length > 0}
                <CalendarPopover onSelect={(rk) => { 
                  lastSelectedSnoozeRuleKey.set(normalizeRuleKey(rk)); 
                  // Set flag immediately to prevent any navigation
                  isSnoozing = true;
                  // Close menu
                  const d = snoozeDetails; 
                  if (d) d.open = false; 
                  // Perform snooze - flag will prevent navigation
                  trySnooze(rk).finally(() => {
                    // Clear flag after a delay to allow UI to settle
                    setTimeout(() => { isSnoozing = false; }, 200);
                  });
                }} />
              {:else}
                <div style="padding:0.5rem 0.75rem; max-width: 21rem;" class="m3-font-body-small">No snooze labels configured. Map them in Settings.</div>
              {/if}
            </Menu>
          </div>
        </details>
        <!-- debug removed -->
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
      onclick={(e: MouseEvent) => {
        // Prevent navigation if we're currently snoozing
        if (isSnoozing) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }}
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
  /* Hide the menu content when closed to avoid it leaking into the row layout. */
  .menu-toggle > :global(:not(summary)) { display: none; }
  /* When the details element is open, display/position the popover as an overlay. */
  .menu-toggle[open] > :global(:not(summary)) { display: block; position: fixed !important; z-index: 10; left: 50%; top: 0; pointer-events: auto; transform: translateX(-50%); margin-top: 1rem; }
  /* Reset native marker on summary for MD3 button inside */
  .menu-toggle > summary {
    list-style: none;
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  /* Slightly larger tap target for expand */
  .expand-button { min-width: 2.25rem; min-height: 2.25rem; display:inline-flex; align-items:center; justify-content:center; padding:0.25rem; border-radius:var(--m3-util-rounding-medium); }
  /* Outlined variant for just the expand button */
  .expand-button.outlined {
    outline: 1px solid rgb(var(--m3-scheme-outline-variant));
    background: rgb(var(--m3-scheme-surface));
  }
  .expand-button.outlined > :global(svg) { color: rgb(var(--m3-scheme-on-surface-variant)); }
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
  .leading-wrap { position: relative; display: inline-flex; align-items: center; gap: 0.375rem; }
  .msg-count {
    position: absolute;
    left: 0.15rem;
    bottom: -0.35rem;
    min-width: 1.2rem;
    height: 1.2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.625rem;
    color: rgb(var(--m3-scheme-surface-variant));
    background: rgba(0,0,0,0); /* keep background transparent to remain discreet */
    opacity: 0.65;
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
  .ai-missing { margin-left: 0.25rem; color: rgb(var(--m3-scheme-on-surface-variant)); display: inline-flex; align-items: center; }
  .ai-missing :global(svg) { width: 1rem; height: 1rem; }
  .ai-flag { margin-left: 0.25rem; display:inline-flex; align-items:center; }
  .ai-flag.stale { color: rgb(var(--m3-scheme-on-surface)); filter: grayscale(60%); opacity: 0.9; }
  .tooltip {
    position: absolute;
    z-index: 40;
    background: rgb(var(--m3-scheme-surface));
    color: rgb(var(--m3-scheme-on-surface));
    border: 1px solid rgb(var(--m3-scheme-outline));
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    max-width: 22rem;
    white-space: pre-wrap;
    box-shadow: var(--m3-util-elevation-2);
  }
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


