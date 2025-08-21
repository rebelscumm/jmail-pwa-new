<script lang="ts">
  import { onMount } from 'svelte';
  import { getDB } from '$lib/db/indexeddb';
  import { listLabels } from '$lib/gmail/api';
  import type { GmailLabel } from '$lib/types';
  import { loadSettings, saveLabelMapping, settings, seedDefaultMapping, updateAppSettings } from '$lib/stores/settings';
  import type { AppSettings } from '$lib/stores/settings';
  import { createBackup, listBackups, pruneOldBackups, restoreBackup } from '$lib/db/backups';

  let labels: GmailLabel[] = [];
  let mappingJson = '';
  let info = '';
  let _anchorHour = 5;
  let _roundMinutes = 5;
  let _unreadOnUnsnooze = true;
  let _notifEnabled = false;
  let _aiProvider: AppSettings['aiProvider'] = 'openai';
  let _aiApiKey = '';
  let _aiModel = '';
  let _aiPageFetchOptIn = false;
  let _taskFilePath = '';
  let backups: { key: string; createdAt: number }[] = [];

  onMount(async () => {
    await loadSettings();
    const s = $settings as AppSettings;
    _anchorHour = s.anchorHour;
    _roundMinutes = s.roundMinutes;
    _unreadOnUnsnooze = s.unreadOnUnsnooze;
    _notifEnabled = !!s.notifEnabled;
    _aiProvider = s.aiProvider || 'openai';
    _aiApiKey = s.aiApiKey || '';
    _aiModel = s.aiModel || '';
    _aiPageFetchOptIn = !!s.aiPageFetchOptIn;
    _taskFilePath = s.taskFilePath || '';
    mappingJson = JSON.stringify(s.labelMapping, null, 2);

    const db = await getDB();
    const tx = db.transaction('labels');
    labels = await tx.store.getAll();
    backups = await listBackups();
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
    } catch (e: unknown) {
      info = e instanceof Error ? e.message : String(e);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
  }

  async function seedMapping() {
    const mapping = seedDefaultMapping();
    mappingJson = JSON.stringify(mapping, null, 2);
    await saveLabelMapping(mapping);
    info = 'Seeded default keys. Map them to your label IDs.';
  }

  async function saveAppSettings() {
    await updateAppSettings({ anchorHour: _anchorHour, roundMinutes: _roundMinutes, unreadOnUnsnooze: _unreadOnUnsnooze, notifEnabled: _notifEnabled, aiProvider: _aiProvider, aiApiKey: _aiApiKey, aiModel: _aiModel, aiPageFetchOptIn: _aiPageFetchOptIn, taskFilePath: _taskFilePath });
    if (_notifEnabled && 'Notification' in window) {
      const p = await Notification.requestPermission();
      if (p !== 'granted') {
        info = 'Notifications not granted by browser.';
      }
    }
    info = 'Settings saved!';
  }

  async function makeBackup() {
    const snap = await createBackup();
    await pruneOldBackups(4);
    backups = await listBackups();
    info = `Backup ${snap.key} created.`;
  }

  async function restore(key: string) {
    await restoreBackup(key);
    info = `Restored ${key}.`;
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
  <input type="file" accept="application/json" on:change={(e)=>{
    const input = e.currentTarget as HTMLInputElement;
    const file=input.files?.[0]; if(!file) return; file.text().then((t: string)=>mappingJson=t);
  }} />
  <button on:click={seedMapping}>Seed defaults</button>
</div>

<h3>App Settings</h3>
<div>
  <label>Anchor hour <input type="number" min="0" max="23" bind:value={_anchorHour} /></label>
  <label>Round minutes <input type="number" min="1" max="60" step="1" bind:value={_roundMinutes} /></label>
  <label><input type="checkbox" bind:checked={_unreadOnUnsnooze} /> Unread on unsnooze</label>
  <label><input type="checkbox" bind:checked={_notifEnabled} /> Notifications enabled</label>
  <fieldset style="border:1px solid var(--m3-outline-variant); padding:0.5rem; border-radius:0.5rem;">
    <legend>AI</legend>
    <label>Provider
      <select bind:value={_aiProvider}>
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
        <option value="gemini">Gemini</option>
      </select>
    </label>
    <label>API Key <input type="password" bind:value={_aiApiKey} placeholder="sk-..." /></label>
    <label>Model <input bind:value={_aiModel} placeholder="gpt-4o-mini / claude-3-haiku / gemini-1.5-flash" /></label>
    <label><input type="checkbox" bind:checked={_aiPageFetchOptIn} /> Allow page fetch for link-only emails</label>
  </fieldset>
  <fieldset style="border:1px solid var(--m3-outline-variant); padding:0.5rem; border-radius:0.5rem;">
    <legend>Tasks</legend>
    <label>Desktop: task file path <input bind:value={_taskFilePath} placeholder="C:\\path\\to\\tasks.md" /></label>
  </fieldset>
  <button on:click={saveAppSettings}>Save Settings</button>
</div>

<h3>Backups</h3>
<div>
  <button on:click={makeBackup}>Create backup</button>
  <ul>
    {#each backups as b}
      <li>
        <code>{b.key}</code> — {new Date(b.createdAt).toLocaleString()}
        <button on:click={() => restore(b.key)}>Restore</button>
      </li>
    {/each}
    {#if !backups.length}
      <li>No backups yet.</li>
    {/if}
  </ul>
</div>