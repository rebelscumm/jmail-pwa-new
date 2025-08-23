<script lang="ts">
  import { onMount } from 'svelte';
  import { onDestroy } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { getDB } from '$lib/db/indexeddb';
  import { listLabels } from '$lib/gmail/api';
  import type { GmailLabel } from '$lib/types';
  import { loadSettings, saveLabelMapping, settings, seedDefaultMapping, updateAppSettings } from '$lib/stores/settings';
  import { normalizeRuleKey } from '$lib/snooze/rules';
  import type { AppSettings } from '$lib/stores/settings';
  import { createBackup, listBackups, pruneOldBackups, restoreBackup } from '$lib/db/backups';
  import Card from '$lib/containers/Card.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import TextField from '$lib/forms/TextField.svelte';
  import TextFieldOutlined from '$lib/forms/TextFieldOutlined.svelte';
  import TextFieldOutlinedMultiline from '$lib/forms/TextFieldOutlinedMultiline.svelte';
  import Checkbox from '$lib/forms/Checkbox.svelte';
  import Switch from '$lib/forms/Switch.svelte';
  import Tabs from '$lib/nav/Tabs.svelte';
  import Radio from '$lib/forms/RadioAnim2.svelte';
  import { goto } from '$app/navigation';

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
  let _trailingRefreshDelayMs = 5000;
  let _trailingSlideOutDurationMs = 260;
  let importMappingInput: HTMLInputElement | null = null;
  let _swipeRightPrimary: 'archive' | 'delete' = 'archive';
  let _swipeLeftPrimary: 'archive' | 'delete' = 'delete';
  let _confirmDelete = false;
  let _swipeCommitVelocityPxPerSec = 1000;
  let _swipeDisappearMs = 5000;
  let backups: { key: string; createdAt: number }[] = [];
  // Human-friendly mapping UI state
  let uiMapping: Record<string, string> = {};
  const quickKeys = ['10m','30m','1h','2h','3h'];
  const hourKeys = ['1h','2h','3h','4h','5h','6h','7h'];
  const dayKeys = Array.from({ length: 30 }, (_, i) => `${i+1}d`);
  const weekdayKeys = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const timeKeys = ['6am','2pm','7pm'];
  const persistentKeys = ['Desktop','long-term'];
  let ruleKeys: string[] = $derived(() => [
    ...new Set([
      ...quickKeys,
      ...hourKeys,
      ...dayKeys,
      ...weekdayKeys,
      ...timeKeys,
      ...persistentKeys,
    ])
  ]);


  // Tabs
  let currentTab: 'app' | 'mapping' | 'backups' = 'app';
  const tabItems = [
    { name: 'App', value: 'app' },
    { name: 'Label Mapping', value: 'mapping' },
    { name: 'Backups', value: 'backups' }
  ];

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
    _trailingRefreshDelayMs = Number(s.trailingRefreshDelayMs || 5000);
    _trailingSlideOutDurationMs = Number((s as any).trailingSlideOutDurationMs || 260);
    _swipeRightPrimary = (s.swipeRightPrimary || 'archive') as any;
    _swipeLeftPrimary = (s.swipeLeftPrimary || 'delete') as any;
    _confirmDelete = !!s.confirmDelete;
    _swipeCommitVelocityPxPerSec = Number(s.swipeCommitVelocityPxPerSec || 1000);
    _swipeDisappearMs = Number(s.swipeDisappearMs || 5000);
    mappingJson = JSON.stringify(s.labelMapping, null, 2);
    uiMapping = { ...s.labelMapping };

    const db = await getDB();
    const tx = db.transaction('labels');
    labels = await tx.store.getAll();
    backups = await listBackups();
  });

  // Track dirty state for guards
  let initialLoaded = $state(false);
  let isDirty = $derived(() => {
    // Compare current UI state against $settings where possible
    const s = $settings as AppSettings;
    if (!initialLoaded || !s) return false;
    try {
      const mappingChanged = mappingJson.trim() !== JSON.stringify(s.labelMapping, null, 2).trim();
      const uiMappingChanged = JSON.stringify(uiMapping) !== JSON.stringify(s.labelMapping);
      const appChanged = (
        _anchorHour !== s.anchorHour ||
        _roundMinutes !== s.roundMinutes ||
        _unreadOnUnsnooze !== !!s.unreadOnUnsnooze ||
        _notifEnabled !== !!s.notifEnabled ||
        _aiProvider !== (s.aiProvider || 'openai') ||
        _aiApiKey !== (s.aiApiKey || '') ||
        _aiModel !== (s.aiModel || '') ||
        _aiPageFetchOptIn !== !!s.aiPageFetchOptIn ||
        _taskFilePath !== (s.taskFilePath || '') ||
        Number(_trailingRefreshDelayMs || 0) !== Number(s.trailingRefreshDelayMs || 5000) ||
        Number(_trailingSlideOutDurationMs || 0) !== Number((s as any).trailingSlideOutDurationMs || 260) ||
        (_swipeRightPrimary as any) !== (s.swipeRightPrimary || 'archive') ||
        (_swipeLeftPrimary as any) !== (s.swipeLeftPrimary || 'delete') ||
        !!_confirmDelete !== !!s.confirmDelete ||
        Number(_swipeCommitVelocityPxPerSec || 1000) !== Number(s.swipeCommitVelocityPxPerSec || 1000) ||
        Number(_swipeDisappearMs || 5000) !== Number(s.swipeDisappearMs || 800)
      );
      return mappingChanged || uiMappingChanged || appChanged;
    } catch { return false; }
  });

  $effect(() => { if ($settings) initialLoaded = true; });

  // SvelteKit navigation guard
  let removeBeforeUnload: (() => void) | null = null;
  const removeBeforeNavigate = beforeNavigate((nav) => {
    if (!isDirty) return;
    const msg = 'You have unsaved changes. Discard them?';
    if (!confirm(msg)) {
      nav.cancel();
      return;
    }
  });

  // Browser unload guard
  $effect(() => {
    if (isDirty) {
      const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
      window.addEventListener('beforeunload', handler);
      removeBeforeUnload = () => window.removeEventListener('beforeunload', handler);
    } else if (removeBeforeUnload) {
      removeBeforeUnload();
      removeBeforeUnload = null;
    }
  });

  onDestroy(() => {
    try { removeBeforeNavigate(); } catch {}
    try { if (removeBeforeUnload) removeBeforeUnload(); } catch {}
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
    await updateAppSettings({ anchorHour: _anchorHour, roundMinutes: _roundMinutes, unreadOnUnsnooze: _unreadOnUnsnooze, notifEnabled: _notifEnabled, aiProvider: _aiProvider, aiApiKey: _aiApiKey, aiModel: _aiModel, aiPageFetchOptIn: _aiPageFetchOptIn, taskFilePath: _taskFilePath, trailingRefreshDelayMs: Math.max(0, Number(_trailingRefreshDelayMs || 0)), trailingSlideOutDurationMs: Math.max(0, Number(_trailingSlideOutDurationMs || 0)), swipeRightPrimary: _swipeRightPrimary, swipeLeftPrimary: _swipeLeftPrimary, confirmDelete: _confirmDelete, swipeCommitVelocityPxPerSec: Math.max(100, Number(_swipeCommitVelocityPxPerSec || 1000)), swipeDisappearMs: Math.max(100, Number(_swipeDisappearMs || 800)) });
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

  async function saveAll() {
    if (currentTab === 'app') {
      await saveAppSettings();
    } else if (currentTab === 'mapping') {
      await saveMapping();
    } else {
      info = 'Nothing to save on Backups tab.';
    }
  }

  async function saveAndExit() {
    await saveAll();
    goto('/inbox');
  }

  function closeWithoutSaving() {
    goto('/inbox');
  }
</script>

<Tabs items={tabItems} bind:tab={currentTab} secondary />
<div style="margin-top:0.5rem; display:flex; gap:0.5rem; justify-content:flex-end;">
  <Button variant="filled" onclick={saveAll}>Save</Button>
  <Button variant="filled" onclick={saveAndExit}>Save & Exit</Button>
  <Button variant="text" onclick={closeWithoutSaving}>Close</Button>
</div>

{#if currentTab === 'app'}
  <h3 style="margin-top:1rem;">App Settings</h3>
  <Card variant="outlined">
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap:0.75rem; align-items:center;">
      <TextFieldOutlined label="Anchor hour (0-23)" type="number" min="0" max="23" bind:value={(_anchorHour as any)} />
      <TextFieldOutlined label="Round minutes (1-60)" type="number" min="1" max="60" step="1" bind:value={(_roundMinutes as any)} />
      <TextFieldOutlined label="Trailing refresh delay (ms)" type="number" min="0" step="100" bind:value={(_trailingRefreshDelayMs as any)} />
      <TextFieldOutlined label="Slide-out duration on refresh (ms)" type="number" min="0" step="20" bind:value={(_trailingSlideOutDurationMs as any)} />
      <label style="display:flex; align-items:center; gap:0.5rem;">
        <Checkbox>
          <input type="checkbox" bind:checked={_unreadOnUnsnooze} />
        </Checkbox>
        <span class="m3-font-body-medium">Unread on unsnooze</span>
      </label>
      <label style="display:flex; align-items:center; gap:0.5rem;">
        <Switch bind:checked={_notifEnabled} />
        <span class="m3-font-body-medium">Notifications enabled</span>
      </label>
      <div>
        <div class="m3-font-body-medium" style="margin-bottom:0.25rem;">Swipe right primary</div>
        <div style="display:flex; gap:1rem; align-items:center;">
          <label style="display:flex; align-items:center; gap:0.5rem;">
            <Radio>
              <input type="radio" name="swipeRightPrimary" value="archive" bind:group={_swipeRightPrimary} />
            </Radio>
            <span class="m3-font-body-medium">Archive</span>
          </label>
          <label style="display:flex; align-items:center; gap:0.5rem;">
            <Radio>
              <input type="radio" name="swipeRightPrimary" value="delete" bind:group={_swipeRightPrimary} />
            </Radio>
            <span class="m3-font-body-medium">Delete</span>
          </label>
        </div>
      </div>
      <div>
        <div class="m3-font-body-medium" style="margin-bottom:0.25rem;">Swipe left primary</div>
        <div style="display:flex; gap:1rem; align-items:center;">
          <label style="display:flex; align-items:center; gap:0.5rem;">
            <Radio>
              <input type="radio" name="swipeLeftPrimary" value="archive" bind:group={_swipeLeftPrimary} />
            </Radio>
            <span class="m3-font-body-medium">Archive</span>
          </label>
          <label style="display:flex; align-items:center; gap:0.5rem;">
            <Radio>
              <input type="radio" name="swipeLeftPrimary" value="delete" bind:group={_swipeLeftPrimary} />
            </Radio>
            <span class="m3-font-body-medium">Delete</span>
          </label>
        </div>
      </div>
      <div>
        <TextFieldOutlined label="Commit velocity (px/s)" type="number" min="200" step="50" bind:value={(_swipeCommitVelocityPxPerSec as any)} />
      </div>
      <div>
        <TextFieldOutlined label="Swipe disappear (ms)" type="number" min="100" step="50" bind:value={(_swipeDisappearMs as any)} />
      </div>
      <label style="display:flex; align-items:center; gap:0.5rem;">
        <Checkbox>
          <input type="checkbox" bind:checked={_confirmDelete} />
        </Checkbox>
        <span class="m3-font-body-medium">Confirm before delete</span>
      </label>
    </div>
    <fieldset style="margin-top:0.75rem; border:1px solid var(--m3-outline-variant); padding:0.5rem; border-radius:0.5rem;">
      <legend>AI</legend>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap:0.75rem; align-items:center;">
        <div>
          <div class="m3-font-body-medium" style="margin-bottom:0.25rem;">Provider</div>
          <div style="display:flex; gap:1rem; align-items:center;">
            <label style="display:flex; align-items:center; gap:0.5rem;">
              <Radio>
                <input type="radio" name="aiProvider" value="openai" bind:group={_aiProvider} />
              </Radio>
              <span class="m3-font-body-medium">OpenAI</span>
            </label>
            <label style="display:flex; align-items:center; gap:0.5rem;">
              <Radio>
                <input type="radio" name="aiProvider" value="anthropic" bind:group={_aiProvider} />
              </Radio>
              <span class="m3-font-body-medium">Anthropic</span>
            </label>
            <label style="display:flex; align-items:center; gap:0.5rem;">
              <Radio>
                <input type="radio" name="aiProvider" value="gemini" bind:group={_aiProvider} />
              </Radio>
              <span class="m3-font-body-medium">Gemini</span>
            </label>
          </div>
        </div>
        <TextFieldOutlined label="API Key" type="password" bind:value={_aiApiKey} placeholder="sk-..." />
        <TextFieldOutlined label="Model" bind:value={_aiModel} placeholder="gpt-4o-mini / claude-3-haiku / gemini-1.5-flash" />
        <label style="display:flex; align-items:center; gap:0.5rem;">
          <Checkbox>
            <input type="checkbox" bind:checked={_aiPageFetchOptIn} />
          </Checkbox>
          <span class="m3-font-body-medium">Allow page fetch for link-only emails</span>
        </label>
      </div>
    </fieldset>
    <fieldset style="margin-top:0.75rem; border:1px solid var(--m3-outline-variant); padding:0.5rem; border-radius:0.5rem;">
      <legend>Tasks</legend>
      <TextFieldOutlined label="Desktop: task file path" bind:value={_taskFilePath} placeholder="C:\\path\\to\\tasks.md" />
    </fieldset>
    <div style="margin-top:0.75rem; display:flex; gap:0.5rem; justify-content:flex-end;">
      <Button variant="filled" onclick={saveAppSettings}>Save Settings</Button>
    </div>
  </Card>
{/if}

{#if currentTab === 'mapping'}
  <h3 style="margin-top:1rem;">Label Mapping</h3>
  <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom:0.5rem;">
    <Button variant="outlined" onclick={discoverLabels}>Refresh labels</Button>
    <span class="m3-font-body-medium">{labels.length} labels cached</span>
  </div>
  <TextFieldOutlinedMultiline label="Mapping (JSON)" bind:value={mappingJson} />
  <div style="margin-top:0.5rem; display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
    <Button variant="filled" onclick={saveMapping}>Save</Button>
    <span>{info}</span>
    <Button variant="text" onclick={() => navigator.clipboard.writeText(mappingJson)}>Copy</Button>
    <Button variant="outlined" onclick={() => importMappingInput?.click()}>Import JSON</Button>
    <input bind:this={importMappingInput} type="file" accept="application/json" style="display:none" on:change={(e)=>{
      const input = e.currentTarget as HTMLInputElement;
      const file=input.files?.[0]; if(!file) return; file.text().then((t: string)=>mappingJson=t);
      // reset value so selecting same file again still triggers change
      input.value = '';
    }} />
    <Button variant="outlined" onclick={seedMapping}>Seed defaults</Button>
  </div>

  <h3 style="margin-top:1rem;">Snooze Mapping (UI)</h3>
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
  <div style="margin-top:0.5rem; display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
    <Button variant="outlined" onclick={autoMapFromLabelNames}>Auto-map from label names</Button>
    <Button variant="filled" onclick={saveUiMapping}>Save Mapping (UI)</Button>
    <Button variant="text" onclick={copyAutoMapDiagnostics}>Copy auto-map diagnostics</Button>
    <small>Only mapped snoozes are shown elsewhere in the app.</small>
  </div>
{/if}

{#if currentTab === 'backups'}
  <h3 style="margin-top:1rem;">Backups</h3>
  <Card variant="outlined">
    <div style="display:flex; gap:0.5rem; align-items:center; margin-bottom:0.5rem;">
      <Button variant="outlined" onclick={makeBackup}>Create backup</Button>
    </div>
    <ul style="margin:0; padding-left:1rem;">
      {#each backups as b}
        <li style="margin:0.25rem 0; display:flex; align-items:center; gap:0.5rem;">
          <code>{b.key}</code> — {new Date(b.createdAt).toLocaleString()}
          <Button variant="text" onclick={() => restore(b.key)}>Restore</Button>
        </li>
      {/each}
      {#if !backups.length}
        <li>No backups yet.</li>
      {/if}
    </ul>
  </Card>
{/if}