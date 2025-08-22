<script lang="ts">
  import { syncState } from '$lib/stores/queue';
  import { undoLast, redoLast } from '$lib/queue/intents';
  import Button from '$lib/buttons/Button.svelte';
  import SplitButton from '$lib/buttons/SplitButton.svelte';
  import TextField from '$lib/forms/TextField.svelte';
  import Menu from '$lib/containers/Menu.svelte';
  import MenuItem from '$lib/containers/MenuItem.svelte';
  import Chip from '$lib/forms/Chip.svelte';
  import Icon from '$lib/misc/_icon.svelte';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { copyGmailDiagnosticsToClipboard } from '$lib/gmail/api';
  import iconSearch from '@ktibow/iconset-material-symbols/search';
  import iconMore from '@ktibow/iconset-material-symbols/more-vert';
  import iconUndo from '@ktibow/iconset-material-symbols/undo';
  import iconRedo from '@ktibow/iconset-material-symbols/redo';
  import iconSync from '@ktibow/iconset-material-symbols/sync';
  import { getDB } from '$lib/db/indexeddb';
  let { onSyncNow }: { onSyncNow?: () => void } = $props();
  let overflowDetails: HTMLDetailsElement;
  function toggleOverflow(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const d = overflowDetails || (e.currentTarget as HTMLElement).closest('details') as HTMLDetailsElement | null;
    if (d) d.open = !d.open;
  }
  async function doSync() {
    try {
      const { syncNow } = await import('$lib/stores/queue');
      await syncNow();
    } catch {}
    onSyncNow && onSyncNow();
  }

  let search = $state('');
  $effect(() => {
    import('$lib/stores/search').then(m => m.searchQuery.set(search));
  });

  // Show snackbar when a new queue error surfaces; allow copying diagnostics
  let lastShownError: string | undefined = $state();
  $effect(() => {
    const err = $syncState.lastError;
    if (err && err !== lastShownError) {
      lastShownError = err;
      showSnackbar({
        message: err,
        actions: {
          Copy: async () => {
            const ok = await copyGmailDiagnosticsToClipboard({
              reason: 'sync_error',
              lastError: err,
              pendingOps: $syncState.pendingOps,
              lastUpdatedAt: $syncState.lastUpdatedAt
            });
            showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
          }
        },
        closable: true,
        timeout: 6000
      });
    }
  });

  async function onPendingChipClick() {
    if ($syncState.lastError) {
      const ok = await copyGmailDiagnosticsToClipboard({
        reason: 'user_clicked_pending_chip',
        lastError: $syncState.lastError,
        pendingOps: $syncState.pendingOps,
        lastUpdatedAt: $syncState.lastUpdatedAt
      });
      showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
    }
  }

  type JournalEntry = {
    id: string;
    createdAt: number;
    threadId: string;
    intent: { type: string; addLabelIds: string[]; removeLabelIds: string[]; ruleKey?: string };
    inverse: { addLabelIds: string[]; removeLabelIds: string[] };
  };
  type HistoryItem = { label: string };
  let actionHistory: HistoryItem[] = $state([]);
  function ellipsize(text: string, max = 48): string {
    if (!text) return '';
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }
  function describeIntent(e: JournalEntry, subject: string): string {
    const s = ellipsize(subject || '(no subject)');
    switch (e.intent.type) {
      case 'archive': return `Archived · ${s}`;
      case 'trash': return `Deleted · ${s}`;
      case 'spam': return `Marked as spam · ${s}`;
      case 'markRead': return `Marked as read · ${s}`;
      case 'markUnread': return `Marked as unread · ${s}`;
      case 'snooze': return `Snoozed ${e.intent.ruleKey || ''} · ${s}`.trim();
      case 'unsnooze': return `Unsnoozed · ${s}`;
      default: return `${e.intent.type} · ${s}`;
    }
  }
  async function loadRecentHistory(limit = 20) {
    try {
      const db = await getDB();
      const all = await db.getAllFromIndex('journal', 'by_createdAt');
      const latest = all.slice(-limit).reverse() as JournalEntry[];
      const out: HistoryItem[] = [];
      for (const e of latest) {
        const thread = await db.get('threads', e.threadId);
        const subj = (thread && (thread as any).lastMsgMeta?.subject) || '';
        out.push({ label: describeIntent(e, subj) });
      }
      actionHistory = out;
    } catch {}
  }
</script>

<div class="topbar">
  <div class="left">
    <SplitButton variant="filled" x="inner" y="down" onclick={() => undoLast(1)} on:toggle={(e) => { if (e.detail) { loadRecentHistory(); } }}>
      {#snippet children()}
        <Icon icon={iconUndo} />
        <span class="label">Undo</span>
      {/snippet}
      {#snippet menu()}
        <Menu>
          {#if actionHistory.length}
            {#each actionHistory as item, idx}
              <MenuItem onclick={() => undoLast(idx + 1)}>{item.label}</MenuItem>
            {/each}
          {:else}
            <MenuItem disabled onclick={() => {}} >No actions to undo</MenuItem>
          {/if}
        </Menu>
      {/snippet}
    </SplitButton>

    <SplitButton variant="tonal" x="inner" y="down" onclick={() => redoLast(1)} on:toggle={(e) => { if (e.detail) { loadRecentHistory(); } }}>
      {#snippet children()}
        <Icon icon={iconRedo} />
        <span class="label">Redo</span>
      {/snippet}
      {#snippet menu()}
        <Menu>
          {#if actionHistory.length}
            {#each actionHistory as item, idx}
              <MenuItem onclick={() => redoLast(idx + 1)}>{item.label}</MenuItem>
            {/each}
          {:else}
            <MenuItem disabled onclick={() => {}} >No actions to redo</MenuItem>
          {/if}
        </Menu>
      {/snippet}
    </SplitButton>
  </div>
  <div class="right">
    <div class="search-field">
      <TextField label="Search" leadingIcon={iconSearch} bind:value={search} />
    </div>
    <Chip variant="assist" elevated={$syncState.pendingOps > 0} title={$syncState.lastError ? `Error: ${$syncState.lastError} — click to copy diagnostics` : ''} onclick={onPendingChipClick}>
      {$syncState.pendingOps ? `${$syncState.pendingOps} pending` : 'Synced'}
    </Chip>
    <Button variant="outlined" iconType="left" onclick={doSync} aria-label="Sync now">
      <Icon icon={iconSync} />
      Sync now
    </Button>
    <details class="overflow" bind:this={overflowDetails}>
      <summary aria-label="More actions" class="summary-btn" onclick={toggleOverflow}>
        <Button variant="text" iconType="full" aria-label="More actions">
          <Icon icon={iconMore} />
        </Button>
      </summary>
      <Menu>
        <MenuItem onclick={() => (location.href = '/settings')}>Settings</MenuItem>
        <MenuItem onclick={doSync}>Sync now</MenuItem>
        <MenuItem onclick={async()=>{ const m = await import('$lib/db/backups'); await m.createBackup(); await m.pruneOldBackups(4); }}>Create backup</MenuItem>
        <MenuItem onclick={async()=>{ const m = await import('$lib/queue/ops'); await m.pruneDuplicateOps(); }}>Deduplicate</MenuItem>
      </Menu>
    </details>
  </div>
</div>

<style>
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.25rem 0;
    flex-wrap: wrap;
  }
  .left, .right { display: flex; align-items: center; gap: 0.5rem; }
  .label { margin-inline-start: 0.25rem; }
  .search-field { flex: 1 1 12rem; min-width: 0; }
  .search-field :global(.m3-container) {
    min-width: 12rem;
    width: 100%;
  }
  .overflow { position:relative; }
  .overflow > summary { list-style: none; }
  .summary-btn { cursor: pointer; }
  .overflow[open] > :global(.m3-container) { position:absolute; right:0; margin-top:0.25rem; }
</style>


