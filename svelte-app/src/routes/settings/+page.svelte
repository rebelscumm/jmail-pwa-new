<script lang="ts">
  import { onMount } from 'svelte';
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { beforeNavigate } from '$app/navigation';
  import { getDB } from '$lib/db/indexeddb';
  import { listLabels } from '$lib/gmail/api';
  import type { GmailLabel } from '$lib/types';
  import { loadSettings, saveLabelMapping, settings, seedDefaultMapping, updateAppSettings } from '$lib/stores/settings';
  import { normalizeRuleKey } from '$lib/snooze/rules';
  import type { AppSettings } from '$lib/stores/settings';
  import { createBackup, listBackups, pruneOldBackups, restoreBackup } from '$lib/db/backups';
  import Card from '$lib/containers/Card.svelte';
  import Dialog from '$lib/containers/Dialog.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import TextField from '$lib/forms/TextField.svelte';
  import TextFieldOutlined from '$lib/forms/TextFieldOutlined.svelte';
  import TextFieldOutlinedMultiline from '$lib/forms/TextFieldOutlinedMultiline.svelte';
  import Checkbox from '$lib/forms/Checkbox.svelte';
  import Switch from '$lib/forms/Switch.svelte';
  import Tabs from '$lib/nav/Tabs.svelte';
  import Radio from '$lib/forms/RadioAnim2.svelte';
  import { goto } from '$app/navigation';
  import ActionBar from '$lib/buttons/ActionBar.svelte';
  import { precomputeNow } from '$lib/ai/precompute';

  let labels = $state<GmailLabel[]>([]);
  let mappingJson = $state('');
  let info = $state('');
  let _anchorHour = $state(5);
  let _roundMinutes = $state(5);
  let _unreadOnUnsnooze = $state(true);
  let _notifEnabled = $state(false);
  let _aiProvider = $state<AppSettings['aiProvider']>('openai');
  let _aiApiKey = $state('');
  let _aiModel = $state('');
  let _aiSummaryModel = $state('');
  let _aiDraftModel = $state('');
  let _aiPageFetchOptIn = $state(false);
  let _aiKeyVisible = $state(false);
  let _taskFilePath = $state('');
  let _trailingRefreshDelayMs = $state(5000);
  let _trailingSlideOutDurationMs = $state(260);
  // AI precompute
  let _precomputeSummaries = $state(false);
  let _precomputeUseBatch = $state(true);
  let _precomputeUseContextCache = $state(true);
  // If true, auto-run a nightly/initial backfill when missing summaries detected
  // Defaults to ON
  let _precomputeAutoRun = $state(true);
  // legacy summary version removed; keep UI element but hidden
  let _aiSummaryVersion = $state(1);
  // If true, precompute will honor version mismatches and force recompute across inbox
  // when aiSummaryVersion changes. Default is false to avoid mass recompute without user intent.
  let _forceRecomputeOnVersionBump = $state(false);
  let _precomputeInfo = $state('');
  let _quotaView = $state('No quota events recorded.');
  let importMappingInput = $state<HTMLInputElement | null>(null);
  let _swipeRightPrimary = $state<'archive' | 'delete'>('archive');
  let _swipeLeftPrimary = $state<'archive' | 'delete'>('delete');
  let _confirmDelete = $state(false);
  let _swipeCommitVelocityPxPerSec = $state(1000);
  let _swipeDisappearMs = $state(5000);
  let backups = $state<Array<{ key: string; createdAt: number }>>([]);
  // Human-friendly mapping UI state
  let uiMapping = $state<Record<string, string>>({});
  const quickKeys = ['10m','30m','1h','2h','3h'];
  const hourKeys = ['1h','2h','3h','4h','5h','6h','7h'];
  const dayKeys = Array.from({ length: 30 }, (_, i) => `${i+1}d`);
  const weekdayKeys = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const timeKeys = ['6am','2pm','7pm'];
  const persistentKeys = ['Desktop','long-term'];
  const ruleKeys = [ ...new Set([ ...quickKeys, ...hourKeys, ...dayKeys, ...weekdayKeys, ...timeKeys, ...persistentKeys ]) ];
  let _fontScalePercent = $state(100);
  let _inboxPageSize = $state(100);
  let _pullForwardCount = $state(3);
  
  // Authentication settings
  let _suppressAuthPopups = $state(false);
  let _authPopupCooldownSeconds = $state(30);

  // Tabs
  let currentTab = $state<'app' | 'api' | 'auth' | 'mapping' | 'backups'>('app');
  const tabItems = [
    { name: 'App', value: 'app' },
    { name: 'API', value: 'api' },
    { name: 'Authentication', value: 'auth' },
    { name: 'Label Mapping', value: 'mapping' },
    { name: 'Backups', value: 'backups' }
  ];

  onMount(async () => {
    try {
      console.log('[Settings] Starting initialization...');
      await loadSettings();
      console.log('[Settings] Settings loaded successfully');
      
      const s = get(settings) as AppSettings;
      _anchorHour = s.anchorHour;
      _roundMinutes = s.roundMinutes;
      _unreadOnUnsnooze = s.unreadOnUnsnooze;
      _notifEnabled = !!s.notifEnabled;
      _aiProvider = s.aiProvider || 'openai';
      _aiApiKey = s.aiApiKey || '';
      _aiModel = s.aiModel || '';
      _aiSummaryModel = s.aiSummaryModel || '';
      _aiDraftModel = s.aiDraftModel || '';
      _aiPageFetchOptIn = !!s.aiPageFetchOptIn;
      _taskFilePath = s.taskFilePath || '';
      _trailingRefreshDelayMs = Number(s.trailingRefreshDelayMs || 5000);
      _trailingSlideOutDurationMs = Number((s as any).trailingSlideOutDurationMs || 260);
      _inboxPageSize = Number(s.inboxPageSize || 100);
      _precomputeSummaries = !!(s as any).precomputeSummaries;
      _precomputeUseBatch = (s as any).precomputeUseBatch !== false;
      _precomputeUseContextCache = (s as any).precomputeUseContextCache !== false;
      _precomputeAutoRun = !!(s as any).precomputeAutoRun;
      _aiSummaryVersion = Number((s as any).aiSummaryVersion || 1);
      _forceRecomputeOnVersionBump = !!(s as any).forceRecomputeOnVersionBump;
      _swipeRightPrimary = (s.swipeRightPrimary || 'archive') as any;
      _swipeLeftPrimary = (s.swipeLeftPrimary || 'delete') as any;
      _confirmDelete = !!s.confirmDelete;
      _swipeCommitVelocityPxPerSec = Number(s.swipeCommitVelocityPxPerSec || 1000);
      _swipeDisappearMs = Number(s.swipeDisappearMs || 5000);
      mappingJson = JSON.stringify(s.labelMapping, null, 2);
      uiMapping = { ...s.labelMapping };
      _fontScalePercent = Number((s as any).fontScalePercent || 100);
      _suppressAuthPopups = !!(s as any).suppressAuthPopups;
      _authPopupCooldownSeconds = Number((s as any).authPopupCooldownSeconds || 30);
      _pullForwardCount = Number((s as any).pullForwardCount || 3);

      // Check URL parameters for tab selection
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const tabParam = urlParams.get('tab');
        if (tabParam && ['app', 'api', 'auth', 'mapping', 'backups'].includes(tabParam)) {
          currentTab = tabParam as any;
        }
      } catch (_) {}

      console.log('[Settings] Loading database data...');
      const db = await getDB();
      const tx = db.transaction('labels');
      labels = await tx.store.getAll();
      backups = await listBackups();
      console.log('[Settings] Database data loaded successfully');
      
      // Mark initialLoaded only after we've populated local state from $settings
      initialLoaded = true;
      console.log('[Settings] Initialization complete, initialLoaded set to true');
    } catch (error) {
      console.error('[Settings] Initialization failed:', error);
      // Even if there's an error, set initialLoaded to true so the page shows
      // This allows users to at least see the settings page even if some data failed to load
      initialLoaded = true;
      info = `Initialization error: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  // Track dirty state for guards
  let initialLoaded = $state(false);
  let suppressGuards = $state(false);
  
  // MD3-compliant discard confirmation dialog state
  let showDiscardDialog = $state(false);
  let pendingNavigation = $state<{ cancel: () => void } | null>(null);
  
  let isDirty = $derived((): boolean => {
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
        _aiProvider !== (s.aiProvider || 'gemini') ||
        _aiApiKey !== (s.aiApiKey || '') ||
        _aiModel !== (s.aiModel || '') ||
        _aiSummaryModel !== (s.aiSummaryModel || '') ||
        _aiDraftModel !== (s.aiDraftModel || '') ||
        _aiPageFetchOptIn !== !!s.aiPageFetchOptIn ||
        _taskFilePath !== (s.taskFilePath || '') ||
        Number(_trailingRefreshDelayMs || 5000) !== Number(s.trailingRefreshDelayMs || 5000) ||
        Number(_trailingSlideOutDurationMs || 260) !== Number((s as any).trailingSlideOutDurationMs || 260) ||
        (_swipeRightPrimary as any) !== (s.swipeRightPrimary || 'archive') ||
        (_swipeLeftPrimary as any) !== (s.swipeLeftPrimary || 'delete') ||
        !!_confirmDelete !== !!s.confirmDelete ||
        Number(_swipeCommitVelocityPxPerSec || 1000) !== Number(s.swipeCommitVelocityPxPerSec || 1000) ||
        Number(_swipeDisappearMs || 5000) !== Number(s.swipeDisappearMs || 5000)
      );
      return mappingChanged || uiMappingChanged || appChanged || (Number(_fontScalePercent || 100) !== Number((s as any).fontScalePercent || 100));
    } catch { return false; }
  });

  // initialLoaded is set after settings are fully loaded in onMount

  // SvelteKit navigation guard
  let removeBeforeUnload: (() => void) | null = null;
  const removeBeforeNavigate = beforeNavigate((nav) => {
    if (suppressGuards || !(isDirty as unknown as boolean)) return;
    // Cancel navigation and show MD3 dialog for user confirmation
    nav.cancel();
    pendingNavigation = nav;
    showDiscardDialog = true;
  });
  
  function handleDiscardConfirm() {
    showDiscardDialog = false;
    suppressGuards = true;
    // Navigate after confirming discard
    goto('/inbox');
  }
  
  function handleDiscardCancel() {
    showDiscardDialog = false;
    pendingNavigation = null;
  }

  // Browser unload guard
  $effect(() => {
    if ((isDirty as unknown as boolean) && !suppressGuards) {
      const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
      window.addEventListener('beforeunload', handler);
      removeBeforeUnload = () => window.removeEventListener('beforeunload', handler);
    } else if (removeBeforeUnload) {
      removeBeforeUnload();
      removeBeforeUnload = null;
    }
  });

  onDestroy(() => {
    // no-op; navigation guard auto-disposes on page unload
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
    await updateAppSettings({ anchorHour: _anchorHour, roundMinutes: _roundMinutes, unreadOnUnsnooze: _unreadOnUnsnooze, notifEnabled: _notifEnabled, aiProvider: _aiProvider, aiApiKey: _aiApiKey, aiModel: _aiModel, aiSummaryModel: _aiSummaryModel, aiDraftModel: _aiDraftModel, aiPageFetchOptIn: _aiPageFetchOptIn, taskFilePath: _taskFilePath, trailingRefreshDelayMs: Math.max(0, Number(_trailingRefreshDelayMs || 0)), trailingSlideOutDurationMs: Math.max(0, Number(_trailingSlideOutDurationMs || 0)), swipeRightPrimary: _swipeRightPrimary, swipeLeftPrimary: _swipeLeftPrimary, confirmDelete: _confirmDelete, swipeCommitVelocityPxPerSec: Math.max(100, Number(_swipeCommitVelocityPxPerSec || 1000)), swipeDisappearMs: Math.max(100, Number(_swipeDisappearMs || 800)), fontScalePercent: Math.max(50, Math.min(200, Number(_fontScalePercent || 100))), precomputeSummaries: _precomputeSummaries, precomputeUseBatch: _precomputeUseBatch, precomputeUseContextCache: _precomputeUseContextCache, inboxPageSize: Math.max(10, Number(_inboxPageSize || 100)), suppressAuthPopups: _suppressAuthPopups, authPopupCooldownSeconds: Math.max(5, Number(_authPopupCooldownSeconds || 30)), pullForwardCount: Math.max(1, Math.min(10, Number(_pullForwardCount || 3))) });
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
    if (currentTab === 'app' || currentTab === 'api' || currentTab === 'auth') {
      await saveAppSettings();
    } else if (currentTab === 'mapping') {
      await saveMapping();
    } else {
      info = 'Nothing to save on Backups tab.';
    }
  }

  async function runPrecomputeNow() {
    try {
      _precomputeInfo = 'Starting…';
      await precomputeNow(12);
      _precomputeInfo = 'Precompute tick queued.';
    } catch (e: unknown) {
      _precomputeInfo = e instanceof Error ? e.message : String(e);
    }
  }

  async function copyPrecomputeStats() {
    try {
      const db = await getDB();
      const threads = await db.getAll('threads');
      const counts = threads.reduce((acc: Record<string, number>, t: any) => {
        const s = t?.summaryStatus || 'none';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      const payload = {
        at: new Date().toISOString(),
        totalThreads: threads.length,
        summary: counts,
        sample: threads.slice(0, 5).map((t: any) => ({ id: t.threadId, status: t.summaryStatus, updatedAt: t.summaryUpdatedAt }))
      };
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      _precomputeInfo = 'Stats copied to clipboard.';
    } catch (e: unknown) {
      _precomputeInfo = e instanceof Error ? e.message : String(e);
    }
  }

  async function refreshQuotaState() {
    try {
      const db = await getDB();
      const saved = await db.get('settings', 'aiQuotaState');
      if (!saved) { _quotaView = 'No quota events recorded.'; return; }
      const lines: string[] = [];
      for (const k of Object.keys(saved)) {
        const s: any = (saved as any)[k] || {};
        lines.push(`${k}: last429At=${s.last429At ? new Date(s.last429At).toLocaleString() : 'none'} failCount=${s.failCount || 0} backoffMs=${s.backoffMs || 0}`);
      }
      _quotaView = lines.join('\n');
    } catch (e) {
      _quotaView = `Failed to load quota state: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function clearQuotaState() {
    try {
      const db = await getDB();
      await db.put('settings', {}, 'aiQuotaState');
      _quotaView = 'Cleared.';
    } catch (e) {
      _quotaView = `Failed to clear quota state: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function saveAndExit() {
    try {
      await saveAll();
      suppressGuards = true;
      try { if (removeBeforeUnload) { removeBeforeUnload(); removeBeforeUnload = null; } } catch {}
      goto('/inbox');
    } catch (e: unknown) {
      suppressGuards = false;
      info = e instanceof Error ? e.message : String(e);
    }
  }

  function closeWithoutSaving() {
    goto('/inbox');
  }
</script>

{#if !initialLoaded}
  <div style="display: flex; justify-content: center; align-items: center; min-height: 200px;">
    <div style="text-align: center;">
      <div style="margin-bottom: 1rem;">Loading settings...</div>
      {#if info}
        <div style="color: rgb(var(--m3-scheme-error)); font-size: 0.875rem;">{info}</div>
      {/if}
    </div>
  </div>
{:else}
<Tabs items={tabItems} bind:tab={currentTab} secondary />
<ActionBar onSave={saveAll} onSaveAndExit={saveAndExit} onClose={closeWithoutSaving} />
{/if}

{#if initialLoaded && currentTab === 'app'}
  <h3 style="margin-top:1rem;">App Settings</h3>
  <Card variant="outlined">
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap:0.75rem; align-items:center;">
      <TextFieldOutlined label="Anchor hour (0-23)" type="number" min="0" max="23" bind:value={(_anchorHour as any)} />
      <TextFieldOutlined label="Round minutes (1-60)" type="number" min="1" max="60" step="1" bind:value={(_roundMinutes as any)} />
      <TextFieldOutlined label="Trailing refresh delay (ms)" type="number" min="0" step="100" bind:value={(_trailingRefreshDelayMs as any)} />
      <TextFieldOutlined label="Slide-out duration on refresh (ms)" type="number" min="0" step="20" bind:value={(_trailingSlideOutDurationMs as any)} />
      <TextFieldOutlined label="Inbox page size (messages per load)" type="number" min="10" step="10" bind:value={(_inboxPageSize as any)} />
      <TextFieldOutlined label="Pull forward count (emails when inbox empty)" type="number" min="1" max="10" step="1" bind:value={(_pullForwardCount as any)} />
      <div style="display:flex; gap:0.5rem; align-items:center;">
        <TextFieldOutlined label="Font size (%)" type="number" min="50" max="200" step="1" bind:value={(_fontScalePercent as any)} />
        <Button variant="outlined" onclick={() => (_fontScalePercent = Math.max(50, Math.min(200, Number(_fontScalePercent || 0) - 1)))}>-1%</Button>
        <Button variant="outlined" onclick={() => (_fontScalePercent = Math.max(50, Math.min(200, Number(_fontScalePercent || 0) + 1)))}>+1%</Button>
      </div>
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
      <legend>Tasks</legend>
      <TextFieldOutlined label="Desktop: task file path" bind:value={_taskFilePath} placeholder="C:\\path\\to\\tasks.md" />
    </fieldset>
    <div style="margin-top:0.75rem; display:flex; gap:0.5rem; justify-content:flex-end;">
      <Button variant="filled" onclick={saveAppSettings}>Save Settings</Button>
    </div>
  </Card>
{/if}

{#if initialLoaded && currentTab === 'api'}
  <h3 style="margin-top:1rem;">API Keys & Models</h3>
  <Card variant="outlined">
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
      <div style="display:flex; gap:0.5rem; align-items:center;">
        <TextFieldOutlined label="API Key" type={_aiKeyVisible ? 'text' : 'password'} bind:value={_aiApiKey} placeholder="OpenAI / Anthropic / Google API key" />
        <Button variant="outlined" onclick={() => (_aiKeyVisible = !_aiKeyVisible)}>{_aiKeyVisible ? 'Hide' : 'View'}</Button>
      </div>
      {#if !_aiApiKey}
        <div style="grid-column: 1 / -1; margin-left: 2rem; color: rgb(var(--m3-scheme-error)); font-size: 0.875rem;">
          ⚠️ AI API key is required for precompute functionality and AI features.
        </div>
      {/if}
      <TextFieldOutlined label="Default model (fallback)" bind:value={_aiModel} placeholder="gpt-4o-mini / claude-3-haiku / gemini-1.5-flash" />
      <TextFieldOutlined label="Summary model" bind:value={_aiSummaryModel} placeholder="gemini-2.5-flash-lite (default)" />
      <TextFieldOutlined label="Draft model" bind:value={_aiDraftModel} placeholder="gemini-2.5-pro (default)" />
      <label style="display:flex; align-items:center; gap:0.5rem;">
        <Checkbox>
          <input type="checkbox" bind:checked={_aiPageFetchOptIn} />
        </Checkbox>
        <span class="m3-font-body-medium">Allow page fetch for link-only emails</span>
      </label>
      <div style="grid-column: 1 / -1; height:1px; background:var(--m3-outline-variant); margin:0.25rem 0;"></div>
      <label style="display:flex; align-items:center; gap:0.5rem;">
        <Switch bind:checked={_precomputeSummaries} />
        <span class="m3-font-body-medium">Precompute summaries (background)</span>
      </label>
      <div style="grid-column: 1 / -1; margin-left: 2rem; color: rgb(var(--m3-scheme-on-surface-variant)); font-size: 0.875rem;">
        When enabled, AI summaries and subjects will be generated automatically in the background for inbox threads.
        This requires an AI API key to be configured above.
      </div>
      <label style="display:flex; align-items:center; gap:0.5rem;">
        <Checkbox>
          <input type="checkbox" bind:checked={_precomputeUseBatch} />
        </Checkbox>
        <span class="m3-font-body-medium">Use Gemini Batch Mode for nightly backfill (½ price)</span>
      </label>
      <label style="display:flex; align-items:center; gap:0.5rem;">
        <Switch bind:checked={_precomputeAutoRun} />
        <span class="m3-font-body-medium">Auto-run nightly/initial backfill (default ON)</span>
      </label>
      <div style="grid-column: 1 / -1; margin-top:0.5rem; padding:0.5rem; border:1px dashed var(--m3-outline-variant); border-radius:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;"><div class="m3-font-body-medium">Quota & Rate-limit dashboard</div><div><Button variant="outlined" onclick={refreshQuotaState}>Refresh quota state</Button> <Button variant="text" onclick={clearQuotaState}>Clear quota state</Button></div></div>
        <div style="color: rgb(var(--m3-scheme-on-surface-variant)); font-size:0.875rem; margin-bottom:0.5rem;">Shows recent provider rate-limit/backoff events persisted across sessions.</div>
        <div style="font-family:monospace; white-space:pre-wrap; max-height:12vh; overflow:auto; border:1px solid rgb(var(--m3-scheme-outline)); padding:0.5rem; border-radius:6px; background:rgb(var(--m3-scheme-surface-container-lowest));">{_quotaView}</div>
      </div>
      <label style="display:flex; align-items:center; gap:0.5rem;">
        <Checkbox>
          <input type="checkbox" bind:checked={_precomputeUseContextCache} />
        </Checkbox>
        <span class="m3-font-body-medium">Use Context Caching (style/signatures)</span>
      </label>
      <TextFieldOutlined label="Summary version" type="number" min="1" step="1" bind:value={(_aiSummaryVersion as any)} />
    </div>
    <div style="margin-top:0.75rem; display:flex; gap:0.5rem; justify-content:flex-end;">
      <Button variant="filled" onclick={saveAppSettings}>Save API Settings</Button>
      <Button variant="outlined" onclick={runPrecomputeNow}>Run precompute (quick)</Button>
      <Button variant="text" onclick={copyPrecomputeStats}>Copy precompute stats</Button>
      {#if _precomputeInfo}
        <span class="m3-font-body-small">{_precomputeInfo}</span>
      {/if}
    </div>
    {#if !_precomputeSummaries}
      <div style="grid-column: 1 / -1; margin-top: 0.5rem; padding: 0.75rem; background: rgb(var(--m3-scheme-surface-container-lowest)); border-radius: 0.5rem; border: 1px solid rgb(var(--m3-scheme-outline-variant));">
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
          <span style="color: rgb(var(--m3-scheme-error));">⚠️</span>
          <span class="m3-font-title-small" style="color: rgb(var(--m3-scheme-error));">Precompute is disabled</span>
        </div>
        <div style="color: rgb(var(--m3-scheme-on-surface-variant)); font-size: 0.875rem;">
          Enable the "Precompute summaries" switch above to start generating AI summaries and subjects automatically.
          You can also use the "Run Precompute" button in the top app bar overflow menu for manual processing.
        </div>
      </div>
    {/if}
  </Card>
{/if}

{#if initialLoaded && currentTab === 'auth'}
  <h3 style="margin-top:1rem;">Authentication Settings</h3>
  <Card variant="outlined">
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap:0.75rem; align-items:center;">
      <label style="display:flex; align-items:center; gap:0.5rem;">
        <Switch bind:checked={_suppressAuthPopups} />
        <span class="m3-font-body-medium">Suppress authentication popups</span>
      </label>
      <TextFieldOutlined 
        label="Popup cooldown (seconds)" 
        type="number" 
        min="5" 
        max="300" 
        step="5" 
        bind:value={(_authPopupCooldownSeconds as any)}
        disabled={!_suppressAuthPopups}
      />
    </div>
    <div style="margin-top:0.75rem; padding-top:0.75rem; border-top: 1px solid rgb(var(--m3-scheme-outline-variant));">
      <div class="m3-font-body-small" style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom:0.5rem;">
        <strong>About authentication popups:</strong><br/>
        Google authorization popups appear when your access token expires (typically every hour) or when the app needs additional permissions to read message content. 
        Enabling "Suppress authentication popups" will add rate limiting to prevent excessive popups, but may temporarily prevent access to some features when authentication is required.
      </div>
      <div class="m3-font-body-small" style="color: rgb(var(--m3-scheme-on-surface-variant));">
        <strong>Cooldown period:</strong> Minimum time between authentication popups. Higher values reduce interruptions but may delay access to features requiring authentication.
      </div>
    </div>
    <div style="margin-top:0.75rem; display:flex; gap:0.5rem; justify-content:flex-end;">
      <Button variant="filled" onclick={saveAppSettings}>Save Authentication Settings</Button>
    </div>
  </Card>
{/if}

{#if initialLoaded && currentTab === 'mapping'}
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
    <input bind:this={importMappingInput} type="file" accept="application/json" style="display:none" onchange={(e)=>{
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

{#if initialLoaded && currentTab === 'backups'}
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
  
  <h3 style="margin-top:1.5rem;">Diagnostics & Troubleshooting</h3>
  <Card variant="outlined">
    <div style="display:flex; gap:0.5rem; align-items:center; margin-bottom:0.5rem;">
      <Button 
        variant="outlined"
        onclick={async () => {
          try {
            // Android-friendly navigation to diagnostics page
            const isAndroid = /Android/i.test(navigator.userAgent);
            const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
            
            if (isAndroid || isPWA) {
              // Try multiple navigation methods for Android
              try {
                window.open('/diagnostics', '_self');
                return;
              } catch (e) {
                console.log('[Settings] window.open failed for diagnostics:', e);
                try {
                  history.pushState(null, '', '/diagnostics');
                  window.location.reload();
                  return;
                } catch (e2) {
                  console.log('[Settings] pushState failed for diagnostics:', e2);
                }
              }
            }
            
            // Default navigation
            location.href = '/diagnostics';
          } catch (e) {
            console.error('[Settings] All diagnostics navigation methods failed:', e);
            info = 'Navigation failed. Try typing /diagnostics in your address bar.';
          }
        }}
      >
        Open Full Diagnostics Page
      </Button>
    </div>
    <p style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant)); font-size:0.875rem;">
      Access comprehensive diagnostics including Android-specific troubleshooting for overflow menu and snooze button issues.
    </p>
  </Card>
{/if}

<!-- MD3-compliant Discard Changes Confirmation Dialog -->
<Dialog
  bind:open={showDiscardDialog}
  headline="Discard changes?"
  closeOnEsc={true}
  closeOnClick={false}
>
  {#snippet children()}
    <p style="margin: 0;">
      You have unsaved changes. Are you sure you want to leave without saving?
    </p>
  {/snippet}
  {#snippet buttons()}
    <Button variant="text" onclick={handleDiscardCancel}>Keep editing</Button>
    <Button variant="filled" onclick={handleDiscardConfirm}>Discard</Button>
  {/snippet}
</Dialog>