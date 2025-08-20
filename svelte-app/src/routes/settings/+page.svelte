<script lang="ts">
  import { onMount } from 'svelte';
  import { getDB } from '$lib/db/indexeddb';
  import { listLabels } from '$lib/gmail/api';
  import type { GmailLabel } from '$lib/types';
  import { loadSettings, saveLabelMapping, settings } from '$lib/stores/settings';

  let labels: GmailLabel[] = [];
  let mappingJson = '';
  let info = '';
  let anchorHour = 5;
  let roundMinutes = 5;
  let unreadOnUnsnooze = true;

  onMount(async () => {
    await loadSettings();
    const s = $settings as any;
    anchorHour = s.anchorHour;
    roundMinutes = s.roundMinutes;
    unreadOnUnsnooze = s.unreadOnUnsnooze;
    mappingJson = JSON.stringify(s.labelMapping, null, 2);

    const db = await getDB();
    const tx = db.transaction('labels');
    labels = await tx.store.getAll();
  });

  async function discoverLabels() {
    const db = await getDB();
    const remote = await listLabels();
    const tx = db.transaction('labels', 'readwrite');
    for (const l of remote) await tx.store.put(l);
    await tx.done;
    labels = remote;
  }

  async function saveMapping() {
    try {
      const parsed = JSON.parse(mappingJson) as Record<string, string>;
      const known = new Set(labels.map((l) => l.id));
      for (const [k, v] of Object.entries(parsed)) {
        if (!known.has(v)) throw new Error(`Unknown label id for ${k}: ${v}`);
      }
      await saveLabelMapping(parsed);
      info = 'Saved!';
    } catch (e: any) {
      info = String(e?.message || e);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
  }
</script>

<h3>Labels</h3>
<button on:click={discoverLabels}>Refresh</button>
<ul>
  {#each labels as l}
    <li>
      <code>{l.name}</code> — <small>{l.id} ({l.type})</small>
      <button on:click={() => copy(`${l.name}: ${l.id}`)}>Copy</button>
    </li>
  {/each}
  {#if !labels.length}
    <li>No labels cached yet.</li>
  {/if}
  </ul>

<h3>Label Mapping</h3>
<textarea bind:value={mappingJson} rows={10} style="width:100%"></textarea>
<div>
  <button on:click={saveMapping}>Save</button>
  <span>{info}</span>
  <button on:click={() => navigator.clipboard.writeText(mappingJson)}>Copy</button>
  <input type="file" accept="application/json" on:change={(e:any)=>{
    const file=e.currentTarget.files?.[0]; if(!file) return; file.text().then(t=>mappingJson=t);
  }} />
</div>