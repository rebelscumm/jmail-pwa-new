<script lang="ts">
  import { syncState } from '$lib/stores/queue';
  import { undoLast, redoLast } from '$lib/queue/intents';
  import Button from '$lib/buttons/Button.svelte';
  import SplitButton from '$lib/buttons/SplitButton.svelte';
  import TextField from '$lib/forms/TextField.svelte';
  import Menu from '$lib/containers/Menu.svelte';
  import MenuItem from '$lib/containers/MenuItem.svelte';
  import Icon from '$lib/misc/_icon.svelte';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { copyGmailDiagnosticsToClipboard } from '$lib/gmail/api';
  import iconSearch from '@ktibow/iconset-material-symbols/search';
  import iconMore from '@ktibow/iconset-material-symbols/more-vert';
  import iconUndo from '@ktibow/iconset-material-symbols/undo';
  import iconRedo from '@ktibow/iconset-material-symbols/redo';
  import iconSync from '@ktibow/iconset-material-symbols/sync';
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

  // Compute and auto-update relative last sync label
  let nowMs = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => { nowMs = Date.now(); }, 30000);
    return () => clearInterval(id);
  });
  function formatLastSyncLabel(lastUpdatedAt: number): string {
    if (!lastUpdatedAt) return 'Never';
    const diffMs = nowMs - lastUpdatedAt;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
    const seconds = Math.round(diffMs / 1000);
    if (Math.abs(seconds) < 60) return rtf.format(-seconds, 'second');
    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return rtf.format(-hours, 'hour');
    const days = Math.round(hours / 24);
    return rtf.format(-days, 'day');
  }
  $inspect(formatLastSyncLabel);

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
    <Button variant="outlined" iconType="left" onclick={doSync} aria-label={`Sync now — last synced ${formatLastSyncLabel($syncState.lastUpdatedAt)}`} title={$syncState.lastError ? `Error: ${$syncState.lastError} — click to sync` : `Last synced ${formatLastSyncLabel($syncState.lastUpdatedAt)}`}>
      <Icon icon={iconSync} />
      Last sync {formatLastSyncLabel($syncState.lastUpdatedAt)}
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


