<script lang="ts">
  import { onMount } from 'svelte';
  import { getDB } from '$lib/db/indexeddb';
  import { listLabels } from '$lib/gmail/api';
  import type { GmailLabel } from '$lib/types';
  import { loadSettings, saveLabelMapping, settings, seedDefaultMapping, updateAppSettings } from '$lib/stores/settings';
  import { normalizeRuleKey } from '$lib/snooze/rules';
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
  // Human-friendly mapping UI state
  let uiMapping: Record<string, string> = {};
  const quickKeys = ['10m','30m','1h','2h','3h'];
  const hourKeys = ['1h','2h','3h','4h','5h','6h','7h'];
  const dayKeys = Array.from({ length: 30 }, (_, i) => `${i+1}d`);
  const weekdayKeys = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const timeKeys = ['6am','2pm','7pm'];
  const persistentKeys = ['Desktop','long-term'];
  $: ruleKeys = [ ...new Set([ ...quickKeys, ...hourKeys, ...dayKeys, ...weekdayKeys, ...timeKeys, ...persistentKeys ]) ];

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
    uiMapping = { ...s.labelMapping };

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

  async function saveUiMapping() {
    // Validate IDs
    const known = new Set(labels.map((l) => l.id));
    for (const [k, v] of Object.entries(uiMapping)) {
      if (v && !known.has(v)) throw new Error(`Unknown label id for ${k}: ${v}`);
    }
    await saveLabelMapping(uiMapping);
    mappingJson = JSON.stringify(uiMapping, null, 2);
    info = 'Saved!';
  }

  function autoMapFromLabelNames() {
    if (!labels.length) {
      info = 'No labels loaded. Click Refresh first.';
      console.info('[AutoMap] No labels loaded.');
      return;
    }
    const before = { ...uiMapping };
    const next: Record<string, string> = { ...uiMapping };
    let applied = 0;
    const appliedPairs: Array<{ key: string; id: string; name: string }> = [];
    for (const l of labels) {
      const key = normalizeRuleKey(l.name);
      if (ruleKeys.includes(key) && !next[key]) {
        next[key] = l.id;
        applied++;
        appliedPairs.push({ key, id: l.id, name: l.name });
      }
    }
    uiMapping = next;
    mappingJson = JSON.stringify(uiMapping, null, 2);
    info = applied ? `Auto-mapped ${applied} label(s).` : 'No matches found to auto-map.';
    console.info('[AutoMap] Result', { applied, appliedPairs, ruleKeys, before, after: next });
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
  }

  function copyAutoMapDiagnostics() {
    const rows = labels.map((l) => ({ id: l.id, name: l.name, type: l.type, normalized: normalizeRuleKey(l.name) }));
    const preview: Record<string, string> = { ...uiMapping };
    for (const l of labels) {
      const key = normalizeRuleKey(l.name);
      if (ruleKeys.includes(key) && !preview[key]) preview[key] = l.id;
    }
    const diag = {
      labelsCount: labels.length,
      ruleKeys,
      labels: rows,
      mappingBefore: uiMapping,
      mappingAfterPreview: preview
    };
    const text = JSON.stringify(diag, null, 2);
    console.info('[AutoMap] Diagnostics', diag);
    navigator.clipboard.writeText(text);
    info = 'Diagnostics copied to clipboard.';
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

<h3>Snooze Mapping (UI)</h3>
<div style="display:flex; gap:1rem; flex-wrap:wrap;">
  <div>
    <h4 class="m3-font-title-small" style="margin:0 0 0.25rem 0">Quick</h4>
    {#each quickKeys as k}
      <div style="display:flex; align-items:center; gap:0.5rem; margin:0.125rem 0;">
        <code style="min-width:3rem; display:inline-block;">{k}</code>
        <select bind:value={uiMapping[k]}>
          <option value="">— Unmapped —</option>
          {#each labels as l}
            <option value={l.id}>{l.name}</option>
          {/each}
        </select>
      </div>
    {/each}
  </div>
  <div>
    <h4 class="m3-font-title-small" style="margin:0 0 0.25rem 0">Hours</h4>
    {#each hourKeys as k}
      <div style="display:flex; align-items:center; gap:0.5rem; margin:0.125rem 0;">
        <code style="min-width:3rem; display:inline-block;">{k}</code>
        <select bind:value={uiMapping[k]}>
          <option value="">— Unmapped —</option>
          {#each labels as l}
            <option value={l.id}>{l.name}</option>
          {/each}
        </select>
      </div>
    {/each}
  </div>
  <div>
    <h4 class="m3-font-title-small" style="margin:0 0 0.25rem 0">Days</h4>
    {#each dayKeys as k}
      <div style="display:flex; align-items:center; gap:0.5rem; margin:0.125rem 0;">
        <code style="min-width:3rem; display:inline-block;">{k}</code>
        <select bind:value={uiMapping[k]}>
          <option value="">— Unmapped —</option>
          {#each labels as l}
            <option value={l.id}>{l.name}</option>
          {/each}
        </select>
      </div>
    {/each}
  </div>
  <div>
    <h4 class="m3-font-title-small" style="margin:0 0 0.25rem 0">Weekdays</h4>
    {#each weekdayKeys as k}
      <div style="display:flex; align-items:center; gap:0.5rem; margin:0.125rem 0;">
        <code style="min-width:5rem; display:inline-block;">{k}</code>
        <select bind:value={uiMapping[k]}>
          <option value="">— Unmapped —</option>
          {#each labels as l}
            <option value={l.id}>{l.name}</option>
          {/each}
        </select>
      </div>
    {/each}
  </div>
  <div>
    <h4 class="m3-font-title-small" style="margin:0 0 0.25rem 0">Times</h4>
    {#each timeKeys as k}
      <div style="display:flex; align-items:center; gap:0.5rem; margin:0.125rem 0;">
        <code style="min-width:3rem; display:inline-block;">{k}</code>
        <select bind:value={uiMapping[k]}>
          <option value="">— Unmapped —</option>
          {#each labels as l}
            <option value={l.id}>{l.name}</option>
          {/each}
        </select>
      </div>
    {/each}
  </div>
  <div>
    <h4 class="m3-font-title-small" style="margin:0 0 0.25rem 0">Other</h4>
    {#each persistentKeys as k}
      <div style="display:flex; align-items:center; gap:0.5rem; margin:0.125rem 0;">
        <code style="min-width:5rem; display:inline-block;">{k}</code>
        <select bind:value={uiMapping[k]}>
          <option value="">— Unmapped —</option>
          {#each labels as l}
            <option value={l.id}>{l.name}</option>
          {/each}
        </select>
      </div>
    {/each}
  </div>
</div>
<div style="margin-top:0.5rem; display:flex; gap:0.5rem; align-items:center;">
  <button on:click={autoMapFromLabelNames}>Auto-map from label names</button>
  <button on:click={saveUiMapping}>Save Mapping (UI)</button>
  <button on:click={copyAutoMapDiagnostics}>Copy auto-map diagnostics</button>
  <small>Only mapped snoozes are shown elsewhere in the app.</small>
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