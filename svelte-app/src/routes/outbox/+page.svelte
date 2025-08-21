<script lang="ts">
  import { onMount } from 'svelte';
  import { getDB } from '$lib/db/indexeddb';
  import type { QueuedOp } from '$lib/types';
  import Button from '$lib/buttons/Button.svelte';
  import { syncNow } from '$lib/stores/queue';

  let ops: QueuedOp[] = $state([]);
  let loading = $state(true);

  async function load() {
    const db = await getDB();
    ops = (await db.getAll('ops')).sort((a, b) => a.createdAt - b.createdAt);
    loading = false;
  }

  onMount(load);

  async function retryAll() { await syncNow(); await load(); }
  async function clearSent() {
    const db = await getDB();
    const tx = db.transaction('ops', 'readwrite');
    // Only clear sendMessage ops that have lastError empty? For now, no-op. Keep all pending.
    await tx.done;
    await load();
  }
</script>

<h3>Outbox</h3>
{#if loading}
  <p>Loading…</p>
{:else}
  <div style="display:flex; gap:0.5rem; margin-bottom:0.5rem;">
    <Button variant="tonal" onclick={retryAll}>Retry all</Button>
  </div>
  {#if !ops.length}
    <p>No pending operations.</p>
  {:else}
    <ul style="list-style:none; padding:0; margin:0; display:grid; gap:0.5rem;">
      {#each ops as o}
        <li style="padding:0.75rem; border:1px solid var(--m3-outline-variant); border-radius:0.5rem;">
          <div style="display:flex; justify-content:space-between; gap:0.5rem;">
            <div>
              <strong>{o.op.type === 'sendMessage' ? 'Send message' : 'Modify labels'}</strong>
              <div class="m3-font-body-medium" style="color:rgb(var(--m3-scheme-on-surface-variant))">
                Attempts: {o.attempts} • Next: {new Date(o.nextAttemptAt).toLocaleTimeString()} {o.lastError ? `• Error: ${o.lastError}` : ''}
              </div>
            </div>
            <div>
              <Button variant="text" onclick={retryAll}>Retry</Button>
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
{/if}


