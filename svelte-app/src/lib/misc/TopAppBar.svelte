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
  import Dialog from '$lib/containers/Dialog.svelte';
  import iconInfo from '@ktibow/iconset-material-symbols/info';
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

  // Close overflow menu when clicking outside of it
  $effect(() => {
    function handleWindowClick(e: MouseEvent) {
      const d = overflowDetails;
      if (!d || !d.open) return;
      const target = e.target as Node | null;
      if (target && (d === target || d.contains(target))) return;
      d.open = false;
    }
    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  });

  // About dialog state and build info
  let showAbout = $state(false);
  const APP_VERSION: string = __APP_VERSION__;
  const BUILD_DATE: string = __BUILD_DATE__;
  const COMMIT_HASH: string = __COMMIT_HASH__;
</script>

<div class="topbar">
  <div class="left">
    <SplitButton variant="filled" x="inner" y="down" onclick={() => undoLast(1)}>
      {#snippet children()}
        <Icon icon={iconUndo} />
        <span class="label">Undo</span>
      {/snippet}
      {#snippet menu()}
        <Menu>
          <MenuItem onclick={() => undoLast(1)}>Undo last</MenuItem>
          <MenuItem onclick={() => undoLast(3)}>Undo last 3</MenuItem>
        </Menu>
      {/snippet}
    </SplitButton>

    <SplitButton variant="tonal" x="inner" y="down" onclick={() => redoLast(1)}>
      {#snippet children()}
        <Icon icon={iconRedo} />
        <span class="label">Redo</span>
      {/snippet}
      {#snippet menu()}
        <Menu>
          <MenuItem onclick={() => redoLast(1)}>Redo last</MenuItem>
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
        <MenuItem onclick={() => (showAbout = true)}>About</MenuItem>
      </Menu>
    </details>
  </div>

</div>

<Dialog bind:open={showAbout} headline="About" icon={iconInfo} closeOnClick={false}>
  {#snippet children()}
    <div style="display:grid; gap:0.25rem;">
      <div>Version: {APP_VERSION}</div>
      <div>Build: {COMMIT_HASH ? COMMIT_HASH.slice(0, 7) : BUILD_DATE}</div>
    </div>
  {/snippet}
  {#snippet buttons()}
    <Button variant="text" onclick={() => (showAbout = false)}>Close</Button>
  {/snippet}
</Dialog>

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


