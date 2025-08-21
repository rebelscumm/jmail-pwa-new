<script lang="ts">
  import { syncState } from '$lib/stores/queue';
  import { undoLast, redoLast } from '$lib/queue/intents';
  export let onSyncNow: (() => void) | undefined;
  async function doSync() {
    try {
      const { syncNow } = await import('$lib/stores/queue');
      await syncNow();
    } catch {}
    onSyncNow && onSyncNow();
  }
</script>

<div class="topbar">
  <div class="left">
    <div class="split">
      <button type="button" class="primary" on:click={() => undoLast(1)}>Undo</button>
      <details>
        <summary title="More undo actions">▼</summary>
        <div class="menu">
          <button type="button" on:click={() => undoLast(1)}>Undo last</button>
          <button type="button" on:click={() => undoLast(3)}>Undo last 3</button>
        </div>
      </details>
    </div>
    <div class="split">
      <button type="button" class="primary" on:click={() => redoLast(1)}>Redo</button>
      <details>
        <summary title="More redo actions">▼</summary>
        <div class="menu">
          <button type="button" on:click={() => redoLast(1)}>Redo last</button>
        </div>
      </details>
    </div>
  </div>
  <div class="right">
    <input class="search" placeholder="Search" on:input={(e)=>import('$lib/stores/search').then(m=>m.searchQuery.set((e.currentTarget as HTMLInputElement).value))} />
    <span class="chip" title={$syncState.lastError || ''}>
      {$syncState.pendingOps ? `${$syncState.pendingOps} pending` : 'Synced'}
    </span>
    <button type="button" class="secondary" on:click={doSync}>Sync now</button>
    <details class="overflow">
      <summary aria-label="More actions">⋮</summary>
      <div class="menu">
        <a href="/settings">Settings</a>
        <button type="button" on:click={doSync}>Sync now</button>
        <button type="button" on:click={async()=>{ const m = await import('$lib/db/backups'); await m.createBackup(); await m.pruneOldBackups(4); }}>Create backup</button>
        <button type="button" on:click={async()=>{ const m = await import('$lib/queue/ops'); await m.pruneDuplicateOps(); }}>Deduplicate</button>
      </div>
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
  }
  .left, .right { display: flex; align-items: center; gap: 0.5rem; }
  .split { display:flex; align-items:center; }
  .split > button.primary { height:2.5rem; padding:0 1rem; border-radius:1.25rem; border:1px solid var(--m3-outline-variant); background: rgb(var(--m3-scheme-primary)); color: rgb(var(--m3-scheme-on-primary)); }
  .split > details > summary { height:2.5rem; padding:0 0.75rem; border-radius:1.25rem; border:1px solid var(--m3-outline-variant); cursor:pointer; }
  .split > details[open] > .menu { position:absolute; margin-top:0.25rem; background: rgb(var(--m3-scheme-surface)); border:1px solid var(--m3-outline-variant); border-radius:0.5rem; padding:0.25rem; display:flex; flex-direction:column; gap:0.25rem; }
  .split .menu > button { padding:0.5rem 0.75rem; border-radius:0.5rem; border:none; background:transparent; text-align:left; }
  .chip {
    border: 1px solid var(--m3-outline);
    border-radius: 999px;
    padding: 0.25rem 0.5rem;
    font-size: 0.875rem;
  }
  .secondary { height:2.5rem; padding:0 1rem; border-radius:1.25rem; border:1px solid var(--m3-outline-variant); background: transparent; color: rgb(var(--m3-scheme-primary)); }
  .search { height:2.5rem; padding:0 0.75rem; border-radius:1.25rem; border:1px solid var(--m3-outline-variant); background: transparent; }
  .overflow { position:relative; }
  .overflow > summary { cursor:pointer; height:2.5rem; padding:0 0.75rem; border-radius:1.25rem; border:1px solid var(--m3-outline-variant); }
  .overflow[open] .menu { position:absolute; right:0; margin-top:0.25rem; background: rgb(var(--m3-scheme-surface)); border:1px solid var(--m3-outline-variant); border-radius:0.5rem; padding:0.5rem; display:flex; flex-direction:column; gap:0.25rem; min-width: 12rem; }
  .overflow .menu > a, .overflow .menu > button { text-align:left; border:none; background:transparent; padding:0.375rem 0.5rem; border-radius:0.375rem; }
</style>


