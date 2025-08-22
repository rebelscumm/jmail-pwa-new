<script lang="ts">
  import { page } from "$app/stores";
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
  import { acquireTokenForScopes } from "$lib/gmail/auth";
  import { aiSummarizeEmail, aiDraftReply, findUnsubscribeTarget, aiExtractUnsubscribeUrl } from "$lib/ai/providers";
  const threadId = $page.params.threadId;
  const currentThread = $derived($threads.find((t) => t.threadId === threadId));
  function copyText(text: string) { navigator.clipboard.writeText(text); }
  let loadingMap: Record<string, boolean> = $state({});
  let errorMap: Record<string, string> = $state({});
  function formatDateTime(ts?: number | string): string {
    if (!ts) return '';
    const n = typeof ts === 'string' ? Number(ts) : ts;
    try {
      return new Date(n).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
      const scopes = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify'
      ].join(' ');
      const ok = await acquireTokenForScopes(scopes, 'consent');
      if (ok && mid) {
        await downloadMessage(mid);
      }
    } catch (_) {
      // ignore; user can retry
    }
  }

  // Auto-load the first message's full content
  $effect(() => {
    if (!currentThread) return;
    const firstId = currentThread.messageIds?.[0];
    if (!firstId) return;
    const m = $messages[firstId];
    if (!m?.bodyText && !m?.bodyHtml && !loadingMap[firstId]) {
      loadingMap[firstId] = true;
      getMessageFull(firstId)
        .then((full) => { messages.set({ ...$messages, [firstId]: full }); errorMap[firstId] = ''; })
        .catch((e) => {
          errorMap[firstId] = e instanceof Error ? e.message : String(e);
          // eslint-disable-next-line no-console
          console.error('[Viewer] Failed to auto-load message', firstId, e);
          void copyDiagnostics('auto_load_failed', firstId, e);
        })
        .finally(() => { loadingMap[firstId] = false; });
    }
  });
  async function summarize(mid: string) {
    const m = $messages[mid];
    if (!m) return;
    const text = await aiSummarizeEmail(m.headers?.Subject || '', m.bodyText, m.bodyHtml);
    navigator.clipboard.writeText(text);
    alert('Summary copied to clipboard.');
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
      alert('Task line copied to clipboard.');
    } catch { alert(line); }
  }
</script>

{#if currentThread}
  <div style="display:flex; flex-direction:column; gap:0.75rem; max-width:64rem; margin:0 auto;">
    <Card variant="elevated">
      <h2 class="m3-font-title-large" style="margin:0;">{currentThread.lastMsgMeta.subject}</h2>
      <p class="m3-font-body-medium" style="margin:0.25rem 0 0 0; color:rgb(var(--m3-scheme-on-surface-variant))">{currentThread.lastMsgMeta.from}</p>
      {#if currentThread.lastMsgMeta?.date}
        <p class="m3-font-body-small" style="margin:0.25rem 0 0 0; color:rgb(var(--m3-scheme-on-surface-variant))">{formatDateTime(currentThread.lastMsgMeta.date)}</p>
      {/if}
    </Card>

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
      <Button variant="text" onclick={() => copyDiagnostics('viewer_toolbar_copy')}>Copy diagnostics</Button>
      <Button variant="text" onclick={() => archiveThread(currentThread.threadId).then(()=> showSnackbar({ message: 'Archived', actions: { Undo: () => undoLast(1) } }))}>Archive</Button>
      <Button variant="text" color="error" onclick={() => trashThread(currentThread.threadId).then(()=> showSnackbar({ message: 'Deleted', actions: { Undo: () => undoLast(1) } }))}>Delete</Button>
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
  </div>
{:else}
  <p>Thread not loaded.</p>
{/if}

<script module lang="ts">
  export const prerender = false;
  export const ssr = false;
  export const csr = true;
  export const trailingSlash = 'ignore';
  export const csrHash = true;
</script>

<style>
  .messages {
    min-width: 0;
  }
</style>

