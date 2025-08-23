<script lang="ts">
  import { syncState } from '$lib/stores/queue';
  import { undoLast, redoLast, getUndoHistory, getRedoHistory } from '$lib/queue/intents';
  import Button from '$lib/buttons/Button.svelte';
  import SplitButton from '$lib/buttons/SplitButton.svelte';
  import TextField from '$lib/forms/TextField.svelte';
  import Menu from '$lib/containers/Menu.svelte';
  import MenuItem from '$lib/containers/MenuItem.svelte';
  import Chip from '$lib/forms/Chip.svelte';
  import Icon from '$lib/misc/_icon.svelte';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { copyGmailDiagnosticsToClipboard } from '$lib/gmail/api';
  import Dialog from '$lib/containers/Dialog.svelte';
  import { appVersion, buildId } from '$lib/utils/version';
  import { signOut, acquireTokenInteractive, resolveGoogleClientId, initAuth } from '$lib/gmail/auth';
  import iconSearch from '@ktibow/iconset-material-symbols/search';
  import iconMore from '@ktibow/iconset-material-symbols/more-vert';
  import iconInfo from '@ktibow/iconset-material-symbols/info';
  import iconUndo from '@ktibow/iconset-material-symbols/undo';
  import iconRedo from '@ktibow/iconset-material-symbols/redo';
  import iconSync from '@ktibow/iconset-material-symbols/sync';
  import iconSettings from '@ktibow/iconset-material-symbols/settings';
  import iconBackup from '@ktibow/iconset-material-symbols/backup';
  import iconRefresh from '@ktibow/iconset-material-symbols/refresh';
  import iconLogout from '@ktibow/iconset-material-symbols/logout';
  import iconBack from '@ktibow/iconset-material-symbols/chevron-left';
  import iconCopy from '@ktibow/iconset-material-symbols/content-copy-outline';
  let { onSyncNow, backHref, backLabel }: { onSyncNow?: () => void; backHref?: string; backLabel?: string } = $props();
  let overflowDetails: HTMLDetailsElement;
  let aboutOpen = $state(false);
  function toggleOverflow(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const d = overflowDetails || (e.currentTarget as HTMLElement).closest('details') as HTMLDetailsElement | null;
    if (d) d.open = !d.open;
  }
  async function doSync() {
    try {
      showSnackbar({ message: 'Syncing…' });
    } catch {}
    try {
      const { syncNow } = await import('$lib/stores/queue');
      await syncNow();
      // After flushing, immediately clear any trailing holds and reload inbox cache
      try {
        const { clearAllHolds } = await import('$lib/stores/holds');
        clearAllHolds();
      } catch {}
      try {
        const mod = await import('../../routes/inbox/+page.svelte');
        if (typeof (mod as any).reloadFromCache === 'function') await (mod as any).reloadFromCache();
      } catch {}
    } catch {}
    try {
      // Ask pages (e.g., inbox) to re-hydrate from server
      window.dispatchEvent(new CustomEvent('jmail:refresh'));
      showSnackbar({ message: 'Sync complete', timeout: 2500 });
    } catch {}
    onSyncNow && onSyncNow();
  }

  function handleBack() {
    try {
      const canGoBack = typeof document !== 'undefined' && document.referrer && history.length > 1;
      if (canGoBack) {
        history.back();
        return;
      }
    } catch {}
    if (backHref) {
      location.href = backHref;
    }
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

  function formatLastSync(ts?: number): string {
    if (!ts) return '';
    try {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'Just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    } catch {
      return '';
    }
  }

  // Undo/Redo history state
  type HistItem = { id: string; createdAt: number; threadId: string; type: string; description: string };
  let undoItems: HistItem[] = $state([]);
  let redoItems: HistItem[] = $state([]);
  async function refreshUndo() { try { undoItems = await getUndoHistory(10); } catch {} }
  async function refreshRedo() { try { redoItems = await getRedoHistory(10); } catch {} }
  async function doUndo(n: number) {
    await undoLast(n);
    await Promise.all([refreshUndo(), refreshRedo()]);
  }
  async function doRedo(n: number) {
    await redoLast(n);
    await Promise.all([refreshUndo(), refreshRedo()]);
  }
  async function doRelogin() {
    try {
      await signOut();
      const cid = resolveGoogleClientId() || '';
      if (cid) { try { await initAuth(cid); } catch (_) {} }
      await acquireTokenInteractive('consent', 'topbar_relogin');
      location.href = '/inbox';
    } catch (e) {
      showSnackbar({ message: `Re-login failed: ${e instanceof Error ? e.message : e}`, closable: true });
    }
  }
  async function doCopyDiagnostics() {
    try {
      const w = typeof window !== 'undefined' ? (window as any) : undefined;
      if (w) {
        if (typeof w.__copyPageDiagnostics === 'function') {
          await w.__copyPageDiagnostics();
          showSnackbar({ message: 'Diagnostics copied', closable: true });
          return;
        }
        if (typeof w.__copyViewerDiagnostics === 'function') {
          await w.__copyViewerDiagnostics();
          showSnackbar({ message: 'Diagnostics copied', closable: true });
          return;
        }
      }
    } catch (_) {}
    const ok = await copyGmailDiagnosticsToClipboard({ reason: 'topbar_manual_copy' });
    showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
  }
</script>

<div class="topbar">
  <div class="left">
    {#if backHref}
      <Button variant="text" iconType="full" aria-label={backLabel || 'Back'} onclick={handleBack}>
        <Icon icon={iconBack} />
      </Button>
    {/if}
  </div>
  <div class="right">
    <SplitButton variant="filled" x="inner" y="down" onclick={() => doUndo(1)} on:toggle={(e) => { if (e.detail) refreshUndo(); }}>
      {#snippet children()}
        <Icon icon={iconUndo} />
        <span class="label">Undo</span>
      {/snippet}
      {#snippet menu()}
        <div class="history-menu">
          <Menu>
            {#if undoItems.length}
              {#each undoItems as it, idx}
                <MenuItem onclick={() => doUndo(idx + 1)}>{it.description}</MenuItem>
              {/each}
            {:else}
              <MenuItem disabled={true} onclick={() => {}}>No actions to undo</MenuItem>
            {/if}
          </Menu>
        </div>
      {/snippet}
    </SplitButton>

    <SplitButton variant="tonal" x="inner" y="down" onclick={() => doRedo(1)} on:toggle={(e) => { if (e.detail) refreshRedo(); }}>
      {#snippet children()}
        <Icon icon={iconRedo} />
        <span class="label">Redo</span>
      {/snippet}
      {#snippet menu()}
        <div class="history-menu">
          <Menu>
            {#if redoItems.length}
              {#each redoItems as it, idx}
                <MenuItem onclick={() => doRedo(idx + 1)}>{it.description}</MenuItem>
              {/each}
            {:else}
              <MenuItem disabled={true} onclick={() => {}}>No actions to redo</MenuItem>
            {/if}
          </Menu>
        </div>
      {/snippet}
    </SplitButton>

    <div class="search-field">
      <TextField label="Search" leadingIcon={iconSearch} bind:value={search} enter={() => { import('$lib/stores/search').then(m => m.searchQuery.set(search)); }} trailing={{ icon: iconSearch, onclick: () => { import('$lib/stores/search').then(m => m.searchQuery.set(search)); } }} />
    </div>
    <Button variant="outlined" iconType="left" onclick={doSync}>
      {#snippet children()}
        <Icon icon={iconSync} />
        {#if $syncState.pendingOps > 0}
          <span class="label">{$syncState.pendingOps} pending</span>
        {:else}
          <span class="last-sync m3-font-label-small">{formatLastSync($syncState.lastUpdatedAt)}</span>
        {/if}
      {/snippet}
    </Button>
    <details class="overflow" bind:this={overflowDetails}>
      <summary aria-label="More actions" class="summary-btn" onclick={toggleOverflow}>
        <Button variant="text" iconType="full" aria-label="More actions">
          <Icon icon={iconMore} />
        </Button>
      </summary>
      <Menu>
        <MenuItem icon={iconSettings} onclick={() => (location.href = '/settings')}>Settings</MenuItem>
        <MenuItem icon={iconBackup} onclick={async()=>{ const m = await import('$lib/db/backups'); await m.createBackup(); await m.pruneOldBackups(4); }}>Create backup</MenuItem>
        <MenuItem icon={iconRefresh} onclick={() => { const u = new URL(window.location.href); u.searchParams.set('refresh', '1'); location.href = u.toString(); }}>Force update</MenuItem>
        <MenuItem icon={iconCopy} onclick={doCopyDiagnostics}>Copy diagnostics</MenuItem>
        <MenuItem icon={iconLogout} onclick={doRelogin}>Re-login</MenuItem>
        <MenuItem icon={iconInfo} onclick={() => { aboutOpen = true; }}>About</MenuItem>
      </Menu>
    </details>
    <Dialog icon={iconInfo} headline="About" bind:open={aboutOpen} closeOnClick={false}>
      {#snippet children()}
        <div class="about">
          <div class="row"><span class="k">Version</span><span class="v">{appVersion}</span></div>
          <div class="row"><span class="k">Build</span><span class="v">{buildId}</span></div>
        </div>
      {/snippet}
      {#snippet buttons()}
        <Button variant="text" onclick={() => (aboutOpen = false)}>Close</Button>
      {/snippet}
    </Dialog>
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
  .right { flex-wrap: wrap; min-width: 0; }
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
  .last-sync { color: rgb(var(--m3-scheme-on-surface-variant)); margin-inline-start: 0; }
  .about { display:flex; flex-direction:column; gap:0.5rem; }
  .about .row { display:flex; justify-content:space-between; gap:1rem; }
  .about .k { color: rgb(var(--m3-scheme-on-surface-variant)); }
  .about .v { color: rgb(var(--m3-scheme-on-surface)); font-variant-numeric: tabular-nums; }
  /* Make Undo/Redo dropdowns wider to accommodate longer text */
  .history-menu :global(.m3-container) { max-width: 28rem; }
</style>


