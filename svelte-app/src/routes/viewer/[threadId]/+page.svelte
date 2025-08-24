<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { messages, threads } from "$lib/stores/threads";
  import { archiveThread, trashThread, spamThread, undoLast } from "$lib/queue/intents";
  import { snoozeThreadByRule, manualUnsnoozeThread, isSnoozedThread } from "$lib/snooze/actions";
  import { settings } from "$lib/stores/settings";
  import Button from "$lib/buttons/Button.svelte";
  import { show as showSnackbar } from "$lib/containers/snackbar";
  import Card from "$lib/containers/Card.svelte";
  import Divider from "$lib/utils/Divider.svelte";
  import LoadingIndicator from "$lib/forms/LoadingIndicator.svelte";
  import { getMessageFull, copyGmailDiagnosticsToClipboard } from "$lib/gmail/api";
  import { getThreadSummary } from "$lib/gmail/api";
  import { getDB } from "$lib/db/indexeddb";
  import { acquireTokenForScopes, SCOPES, fetchTokenInfo, signOut, acquireTokenInteractive } from "$lib/gmail/auth";
  import { aiSummarizeEmail, aiDraftReply, findUnsubscribeTarget, aiExtractUnsubscribeUrl } from "$lib/ai/providers";
  import { filters, deleteSavedFilter, type ThreadFilter } from "$lib/stores/filters";
  import FilterBar from "$lib/utils/FilterBar.svelte";
  import Menu from "$lib/containers/Menu.svelte";
  import MenuItem from "$lib/containers/MenuItem.svelte";
  import Icon from "$lib/misc/_icon.svelte";
  import iconBack from "@ktibow/iconset-material-symbols/chevron-left";
  import iconArrowDown from "@ktibow/iconset-material-symbols/arrow-downward";
  import iconArrowUp from "@ktibow/iconset-material-symbols/arrow-upward";
  const threadId = $page.params.threadId;
  const currentThread = $derived($threads.find((t) => t.threadId === threadId));
  function copyText(text: string) { navigator.clipboard.writeText(text); }
  let loadingMap: Record<string, boolean> = $state({});
  let errorMap: Record<string, string> = $state({});
  let autoTried: Record<string, boolean> = $state({});
  let threadLoading: boolean = $state(false);
  let threadError: string | null = $state(null);
  function formatDateTime(ts?: number | string): string {
    if (!ts) return '';
    const n = typeof ts === 'string' ? Number(ts) : ts;
    try {
      const date = new Date(n);
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
    } catch { return ''; }
  }
  async function copyDiagnostics(reason: string, mid?: string, error?: unknown) {
    try {
      const ids = currentThread?.messageIds || [];
      const msgSummaries = ids.map((id) => {
        const m = $messages[id];
        return m ? { id, hasBodyText: !!m.bodyText, hasBodyHtml: !!m.bodyHtml, hasSnippet: !!m.snippet, labelIds: m.labelIds } : { id, missing: true };
      });
      const payload = {
        viewer: {
          reason,
          page: 'viewer',
          at: new Date().toISOString(),
          location: typeof location !== 'undefined' ? location.href : undefined,
          threadId,
          currentThread: currentThread ? { messageIds: currentThread.messageIds?.length, labelIds: currentThread.labelIds?.length, lastMsgMeta: currentThread.lastMsgMeta } : null,
          requestedMid: mid,
          loadingMap,
          errorMap,
          messages: msgSummaries
        },
        error: error instanceof Error ? { name: error.name, message: error.message } : (error ? String(error) : undefined)
      };
      const ok = await copyGmailDiagnosticsToClipboard(payload);
      if (!ok) {
        // eslint-disable-next-line no-console
        console.log('[Viewer] Diagnostics (clipboard blocked):', payload);
      }
    } catch (_) {
      // best-effort only
    }
  }
  async function downloadMessage(mid: string) {
    if (loadingMap[mid]) return;
    loadingMap[mid] = true;
    try {
      const full = await getMessageFull(mid);
      messages.set({ ...$messages, [mid]: full });
      errorMap[mid] = '';
    } finally {
      loadingMap[mid] = false;
    }
    if (!$messages[mid]?.bodyText && !$messages[mid]?.bodyHtml) {
      // eslint-disable-next-line no-console
      console.error('[Viewer] Message did not load body; see diagnostics.', { mid });
      await copyDiagnostics('download_no_body', mid);
    }
  }

  async function grantAccess(mid?: string) {
    try {
      const info = await fetchTokenInfo();
      const hasBodyScopes = !!info?.scope && (info.scope.includes('gmail.readonly') || info.scope.includes('gmail.modify'));
      const ok = hasBodyScopes ? true : await acquireTokenForScopes(SCOPES, 'consent', 'viewer_grant_click');
      if (ok && mid) await downloadMessage(mid);
    } catch (_) {}
  }

  async function relogin(mid?: string) {
    try {
      await signOut();
      await acquireTokenInteractive('consent', 'viewer_relogin');
      if (mid) await downloadMessage(mid);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[Viewer] Re-login failed', e);
      void copyDiagnostics('viewer_relogin_failed', mid, e);
    }
  }

  // Fallback: if the thread is not present (e.g., deep link to an older thread), try to fetch a summary
  $effect(() => {
    if (currentThread || threadLoading) return;
    if (!threadId) return;
    (async () => {
      // Avoid triggering any auth flow on navigation: only fetch if we already have a token
      try {
        const info = await fetchTokenInfo();
        if (!info) return; // not authorized in this session; skip remote fetch
      } catch (_) { return; }
      threadLoading = true;
      threadError = null;
      try {
        const { thread, messages: metas } = await getThreadSummary(threadId);
        // Persist to DB and hydrate stores
        try {
          const db = await getDB();
          const txMsgs = db.transaction('messages', 'readwrite');
          for (const m of metas) await txMsgs.store.put(m);
          await txMsgs.done;
          const txThreads = db.transaction('threads', 'readwrite');
          await txThreads.store.put(thread);
          await txThreads.done;
        } catch (_) {}
        // Update stores
        threads.set([...(Array.isArray($threads) ? $threads : []), thread].reduce((acc, t) => {
          const idx = acc.findIndex((x) => x.threadId === t.threadId);
          if (idx >= 0) acc[idx] = t; else acc.push(t);
          return acc;
        }, [] as typeof $threads));
        const dict: Record<string, import('$lib/types').GmailMessage> = { ...$messages };
        for (const m of metas) dict[m.id] = m;
        messages.set(dict);
      } catch (e) {
        threadError = e instanceof Error ? e.message : String(e);
        // Best-effort: attach diagnostics
        void copyDiagnostics('viewer_thread_fallback_failed', undefined, e);
      } finally {
        threadLoading = false;
      }
    })();
  });

  // Auto-load the first message's full content (only if body scopes already granted)
  $effect(() => {
    if (!currentThread) return;
    const firstId = currentThread.messageIds?.[0];
    if (!firstId) return;
    const m = $messages[firstId];
    if (!m?.bodyText && !m?.bodyHtml && !loadingMap[firstId] && !autoTried[firstId]) {
      autoTried[firstId] = true;
      (async () => {
        // Check current token scopes; if body scopes aren't present, skip auto-fetch
        let hasBodyScopes = false;
        try {
          const info = await fetchTokenInfo();
          hasBodyScopes = !!info?.scope && (info.scope.includes('gmail.readonly') || info.scope.includes('gmail.modify'));
        } catch (_) {}
        if (!hasBodyScopes) return;
        loadingMap[firstId] = true;
        getMessageFull(firstId)
          .then((full) => { messages.set({ ...$messages, [firstId]: full }); errorMap[firstId] = ''; })
          .catch((e) => {
            errorMap[firstId] = e instanceof Error ? e.message : String(e);
            // eslint-disable-next-line no-console
            console.error('[Viewer] Failed to auto-load message', firstId, e);
            void copyDiagnostics('auto_load_failed', firstId, e);
            const msg = e instanceof Error ? e.message : String(e);
            if (typeof msg === 'string' && msg.toLowerCase().includes('permissions') || msg.toLowerCase().includes('scope')) {
              void copyDiagnostics('scope_after_upgrade_failed', firstId, e);
            }
          })
          .finally(() => { loadingMap[firstId] = false; });
      })();
    }
  });
  async function summarize(mid: string) {
    const m = $messages[mid];
    if (!m) return;
    try {
      const text = await aiSummarizeEmail(m.headers?.Subject || '', m.bodyText, m.bodyHtml);
      if (!text) {
        alert('No summary generated.');
        return;
      }
      navigator.clipboard.writeText(text);
      alert('Summary copied to clipboard.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Failed to summarize: ${msg}`);
    }
  }
  async function replyDraft(mid: string) {
    const m = $messages[mid]; if (!m) return;
    const draft = await aiDraftReply(m.headers?.Subject || '', m.bodyText, m.bodyHtml);
    navigator.clipboard.writeText(draft);
    alert('Reply draft copied to clipboard.');
  }
  async function unsubscribe(mid: string) {
    const m = $messages[mid]; if (!m) return;
    let target = findUnsubscribeTarget(m.headers, m.bodyHtml);
    if (!target) target = await aiExtractUnsubscribeUrl(m.headers?.Subject || '', m.bodyText, m.bodyHtml);
    if (target) {
      const ok = confirm(`Open unsubscribe target?\n${target}`);
      if (ok) window.open(target, '_blank');
    } else {
      alert('No unsubscribe target found.');
    }
  }
  async function createTask(mid: string) {
    const m = $messages[mid]; if (!m) return;
    const link = `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`;
    const line = `- [ ] ${m.headers?.Subject || 'Email'}  (${link})`;
    try {
      // Desktop: copy; user can paste into their task file
      await navigator.clipboard.writeText(line);
      // Verify clipboard actually contains the line; if read is blocked or mismatch, fallback to showing the text
      try {
        const readBack = await navigator.clipboard.readText();
        if (readBack === line) {
          alert('Task line copied to clipboard.');
        } else {
          alert(line);
        }
      } catch (_) {
        // If we cannot read the clipboard (permission), show the line for manual copy
        alert(line);
      }
    } catch { alert(line); }
  }
  async function loadForEdit(filter: ThreadFilter) {
    // This function is not yet implemented in FilterBar, so we'll just alert for now
    alert(`Load filter "${filter.name}" for editing.`);
    // In a real app, you'd set the filter's state in FilterBar
  }
  async function onDeleteSavedFilter(id: string) {
    if (confirm(`Are you sure you want to delete filter with ID "${id}"? This action cannot be undone.`)) {
      await deleteSavedFilter(id);
      showSnackbar({ message: 'Filter deleted', closable: true });
    }
  }
  if (typeof window !== 'undefined') {
    (window as any).__copyViewerDiagnostics = async () => { await copyDiagnostics('viewer_toolbar_copy'); };
  }

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function scrollToBottom() {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
}

</script>

{#if currentThread}
  <div style="display:flex; flex-direction:column; gap:0.75rem; max-width:64rem; margin:0 auto;">
    <Card variant="elevated">
      <h2 class="m3-font-title-large" style="margin:0; display:flex; flex-wrap:wrap; align-items:baseline; gap:0.5rem;">
        <span style="overflow-wrap:anywhere; word-break:break-word;">{currentThread.lastMsgMeta.subject}</span>
        {#if currentThread.lastMsgMeta.from}
          <span class="from">{currentThread.lastMsgMeta.from}</span>
        {/if}
        {#if currentThread.lastMsgMeta?.date}
          <span class="badge">{formatDateTime(currentThread.lastMsgMeta.date)}</span>
        {/if}
      </h2>
    </Card>

    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <Button variant="text" onclick={() => relogin(currentThread.messageIds?.[0])}>Re-login</Button>
      <Button variant="text" onclick={() => archiveThread(currentThread.threadId).then(()=> { showSnackbar({ message: 'Archived', actions: { Undo: () => undoLast(1) } }); goto('/inbox'); })}>Archive</Button>
      <Button variant="text" color="error" onclick={() => trashThread(currentThread.threadId).then(()=> { showSnackbar({ message: 'Deleted', actions: { Undo: () => undoLast(1) } }); goto('/inbox'); })}>Delete</Button>
      <Button variant="text" onclick={() => spamThread(currentThread.threadId).then(()=> showSnackbar({ message: 'Marked as spam', actions: { Undo: () => undoLast(1) } }))}>Spam</Button>
      {#if isSnoozedThread(currentThread)}
        <Button variant="text" onclick={() => manualUnsnoozeThread(currentThread.threadId).then(()=> showSnackbar({ message: 'Unsnoozed', actions: { Undo: () => undoLast(1) } }))}>Unsnooze</Button>
      {/if}
      {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='10m' && $settings.labelMapping[k])}
        <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '10m').then(()=> showSnackbar({ message: 'Snoozed 10m', actions: { Undo: () => undoLast(1) } }))}>10m</Button>
      {/if}
      {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='3h' && $settings.labelMapping[k])}
        <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '3h').then(()=> showSnackbar({ message: 'Snoozed 3h', actions: { Undo: () => undoLast(1) } }))}>3h</Button>
      {/if}
      {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='1d' && $settings.labelMapping[k])}
        <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '1d').then(()=> showSnackbar({ message: 'Snoozed 1d', actions: { Undo: () => undoLast(1) } }))}>1d</Button>
      {/if}
      <Button variant="text" onclick={() => copyText(currentThread.lastMsgMeta.subject || '')}>Copy Subject</Button>
      {#if currentThread.messageIds?.length}
        {@const mid = currentThread.messageIds[currentThread.messageIds.length-1]}
        <Button variant="text" onclick={() => unsubscribe(mid)}>Unsubscribe</Button>
        <Button variant="text" onclick={() => summarize(mid)}>Summarize</Button>
        <Button variant="text" onclick={() => replyDraft(mid)}>Reply (AI) → Clipboard</Button>
        <Button variant="text" onclick={() => createTask(mid)}>Create Task</Button>
      {/if}
      <Button variant="text" iconType="left" onclick={scrollToBottom} aria-label="Scroll to bottom" style="margin-left:auto">
        {#snippet children()}
          <Icon icon={iconArrowDown} />
          <span class="label">Bottom</span>
        {/snippet}
      </Button>
    </div>

    <Divider />

    <div class="messages">
      {#each currentThread.messageIds as mid, idx}
        {@const m = $messages[mid]}
        <Card variant="outlined">
          {#if idx === 0}
            {#if loadingMap[mid]}
              <LoadingIndicator size={24} />
            {:else if errorMap[mid]}
              <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-error))">Failed to load message: {errorMap[mid]}</p>
              <div style="display:flex; justify-content:flex-end; align-items:center; gap:0.5rem; margin-top:0.5rem;">
                <Button variant="text" onclick={() => copyDiagnostics('viewer_manual_copy', mid)}>Copy diagnostics</Button>
                <Button variant="text" onclick={() => grantAccess(mid)}>Grant access</Button>
                <Button variant="text" onclick={() => relogin(mid)}>Re-login</Button>
                <Button variant="text" onclick={() => downloadMessage(mid)}>Retry</Button>
              </div>
            {:else if m?.bodyHtml}
              {#if m?.internalDate}
                <p class="m3-font-body-small" style="margin:0.25rem 0; color:rgb(var(--m3-scheme-on-surface-variant))">{formatDateTime(m.internalDate)}</p>
              {/if}
              <div class="html-body" style="white-space:normal; overflow-wrap:anywhere;">{@html m.bodyHtml}</div>
            {:else if m?.bodyText}
              {#if m?.internalDate}
                <p class="m3-font-body-small" style="margin:0.25rem 0; color:rgb(var(--m3-scheme-on-surface-variant))">{formatDateTime(m.internalDate)}</p>
              {/if}
              <pre style="white-space:pre-wrap">{m.bodyText}</pre>
            {:else}
              {#if m?.snippet}
                <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">{m.snippet}</p>
              {/if}
              <div style="display:flex; justify-content:flex-end; align-items:center; gap:0.5rem; margin-top:0.5rem;">
                <Button variant="text" onclick={() => copyDiagnostics('viewer_manual_copy', mid)}>Copy diagnostics</Button>
                <Button variant="text" onclick={() => grantAccess(mid)}>Grant access</Button>
                <Button variant="text" onclick={() => relogin(mid)}>Re-login</Button>
                <Button variant="text" onclick={() => downloadMessage(mid)}>Download message</Button>
              </div>
            {/if}
          {:else}
            {#if m?.bodyHtml || m?.bodyText}
              {#if m?.internalDate}
                <p class="m3-font-body-small" style="margin:0.25rem 0; color:rgb(var(--m3-scheme-on-surface-variant))">{formatDateTime(m.internalDate)}</p>
              {/if}
              {#if m?.bodyHtml}
                <div class="html-body" style="white-space:normal; overflow-wrap:anywhere;">{@html m.bodyHtml}</div>
              {:else}
                <pre style="white-space:pre-wrap">{m.bodyText}</pre>
              {/if}
            {:else}
              {#if m?.snippet}
                <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">{m.snippet}</p>
              {/if}
              <div style="display:flex; justify-content:flex-end; align-items:center; gap:0.5rem; margin-top:0.5rem;">
                {#if loadingMap[mid]}
                  <LoadingIndicator size={24} />
                {:else}
                  <Button variant="text" onclick={() => copyDiagnostics('viewer_manual_copy', mid)}>Copy diagnostics</Button>
                  <Button variant="text" onclick={() => grantAccess(mid)}>Grant access</Button>
                  <Button variant="text" onclick={() => relogin(mid)}>Re-login</Button>
                  <Button variant="text" onclick={() => downloadMessage(mid)}>Download message</Button>
                {/if}
              </div>
            {/if}
          {/if}
        </Card>
      {/each}
    </div>

    <Divider inset />

    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <Button variant="text" onclick={() => relogin(currentThread.messageIds?.[0])}>Re-login</Button>
      <Button variant="text" onclick={() => archiveThread(currentThread.threadId).then(()=> { showSnackbar({ message: 'Archived', actions: { Undo: () => undoLast(1) } }); goto('/inbox'); })}>Archive</Button>
      <Button variant="text" color="error" onclick={() => trashThread(currentThread.threadId).then(()=> { showSnackbar({ message: 'Deleted', actions: { Undo: () => undoLast(1) } }); goto('/inbox'); })}>Delete</Button>
      <Button variant="text" onclick={() => spamThread(currentThread.threadId).then(()=> showSnackbar({ message: 'Marked as spam', actions: { Undo: () => undoLast(1) } }))}>Spam</Button>
      {#if isSnoozedThread(currentThread)}
        <Button variant="text" onclick={() => manualUnsnoozeThread(currentThread.threadId).then(()=> showSnackbar({ message: 'Unsnoozed', actions: { Undo: () => undoLast(1) } }))}>Unsnooze</Button>
      {/if}
      {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='10m' && $settings.labelMapping[k])}
        <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '10m').then(()=> showSnackbar({ message: 'Snoozed 10m', actions: { Undo: () => undoLast(1) } }))}>10m</Button>
      {/if}
      {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='3h' && $settings.labelMapping[k])}
        <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '3h').then(()=> showSnackbar({ message: 'Snoozed 3h', actions: { Undo: () => undoLast(1) } }))}>3h</Button>
      {/if}
      {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='1d' && $settings.labelMapping[k])}
        <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '1d').then(()=> showSnackbar({ message: 'Snoozed 1d', actions: { Undo: () => undoLast(1) } }))}>1d</Button>
      {/if}
      <Button variant="text" onclick={() => copyText(currentThread.lastMsgMeta.subject || '')}>Copy Subject</Button>
      {#if currentThread.messageIds?.length}
        {@const mid = currentThread.messageIds[currentThread.messageIds.length-1]}
        <Button variant="text" onclick={() => unsubscribe(mid)}>Unsubscribe</Button>
        <Button variant="text" onclick={() => summarize(mid)}>Summarize</Button>
        <Button variant="text" onclick={() => replyDraft(mid)}>Reply (AI) → Clipboard</Button>
        <Button variant="text" onclick={() => createTask(mid)}>Create Task</Button>
      {/if}
    </div>
    <Divider />

    <h3 class="m3-font-title-medium" style="margin:0.5rem 0 0.25rem;">Create Filter from this Thread</h3>
    <FilterBar thread={currentThread} />

    <details class="manage-filters">
      <summary>Manage Saved Filters</summary>
      <Menu>
        {#each $filters.saved as f}
          <MenuItem onclick={() => loadForEdit(f)}>{f.name}</MenuItem>
          <MenuItem onclick={() => onDeleteSavedFilter(f.id)}>Delete</MenuItem>
        {/each}
      </Menu>
    </details>

    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">
      <div>
        <Button variant="text" iconType="left" onclick={() => goto('/inbox')} aria-label="Back to inbox">
          {#snippet children()}
            <Icon icon={iconBack} />
            <span class="label">Back to inbox</span>
          {/snippet}
        </Button>
      </div>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        <Button variant="text" iconType="left" onclick={scrollToTop} aria-label="Scroll to top">
          {#snippet children()}
            <Icon icon={iconArrowUp} />
            <span class="label">Top</span>
          {/snippet}
        </Button>
        
      </div>
    </div>
  </div>
{:else}
  {#if threadLoading}
    <div style="display:flex; justify-content:center; padding:1rem;"><LoadingIndicator size={24} /></div>
  {:else}
    <p>Thread not loaded.</p>
    {#if threadError}
      <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-error))">{threadError}</p>
    {/if}
  {/if}
{/if}

<!-- page options moved to +page.ts -->

<style>
  .messages {
    min-width: 0;
  }
  .from {
    color: rgb(var(--m3-scheme-on-surface-variant));
    font-weight: 400;
  }
  .badge {
    display: inline-block;
    padding: 0.125rem 0.375rem;
    border-radius: var(--m3-util-rounding-extra-small);
    background: rgb(var(--m3-scheme-secondary-container));
    color: rgb(var(--m3-scheme-on-secondary-container));
    white-space: nowrap;
  }
  /* Ensure HTML emails are responsive and wrap on narrow screens */
  .html-body {
    min-width: 0;
    max-width: 100%;
    overflow-x: hidden;
    word-break: break-word;
  }
  :global(.html-body *), :global(.html-body *::before), :global(.html-body *::after) {
    box-sizing: border-box;
  }
  :global(.html-body table) {
    width: 100% !important;
    max-width: 100% !important;
    table-layout: fixed !important;
    border-collapse: collapse;
  }
  :global(.html-body td), :global(.html-body th) {
    word-break: break-word;
  }
  :global(.html-body pre), :global(.html-body code) {
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  :global(.html-body img), :global(.html-body svg), :global(.html-body video), :global(.html-body iframe), :global(.html-body canvas) {
    max-width: 100% !important;
    height: auto !important;
  }
</style>

