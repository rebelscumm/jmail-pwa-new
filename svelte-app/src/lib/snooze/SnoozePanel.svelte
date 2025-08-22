<script lang="ts">
  import type { Snippet } from 'svelte';
  import { get } from 'svelte/store';
  import { settings } from '$lib/stores/settings';
  import { resolveRule } from '$lib/snooze/rules';
  import Chip from '$lib/forms/Chip.svelte';

  export let onSelect: (ruleKey: string) => void;

  let activeTab: 'Quick' | 'Hours' | 'Days' | 'Weekdays' | 'Times' | 'Custom' = 'Quick';
  let preview: string = '';
  let selectedRule: string | null = null;

  function computePreview(ruleKey: string) {
    selectedRule = ruleKey;
    const s = get(settings);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const due = resolveRule(ruleKey, zone, { anchorHour: s.anchorHour, roundMinutes: s.roundMinutes });
    if (!due) { preview = 'Persistent bucket'; return; }
    const dt = new Date(due);
    preview = dt.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
  }

  function pick(ruleKey: string) {
    computePreview(ruleKey);
    onSelect(ruleKey);
  }

  const quickAll = ['10m','30m','1h','2h','3h'];
  const hoursAll = ['1h','2h','3h','4h','5h','6h','7h'];
  const daysAll = Array.from({ length: 30 }, (_, i) => `${i+1}d`);
  const weekdaysAll = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const timesAll = ['6am','2pm','7pm'];

  $: mapped = new Set(Object.keys($settings.labelMapping || {}).filter((k) => $settings.labelMapping[k]));
  function onlyMapped(list: string[]): string[] { return list.filter((k) => mapped.has(k)); }
  $: quick = onlyMapped(quickAll);
  $: hours = onlyMapped(hoursAll);
  $: days = onlyMapped(daysAll);
  $: weekdays = onlyMapped(weekdaysAll);
  $: times = onlyMapped(timesAll);
</script>

<div class="panel">
  <div class="tabs">
    {#each ['Quick','Hours','Days','Weekdays','Times','Custom'] as t}
      <Chip
        variant="general"
        selected={activeTab === t}
        onclick={() => (activeTab = t as any)}
      >{t}</Chip>
    {/each}
  </div>

  {#if activeTab==='Quick'}
    <div class="grid">{#each quick as k}<Chip variant="assist" onclick={() => pick(k)}>{k}</Chip>{/each}</div>
  {:else if activeTab==='Hours'}
    <div class="grid">{#each hours as k}<Chip variant="assist" onclick={() => pick(k)}>{k}</Chip>{/each}</div>
  {:else if activeTab==='Days'}
    <div class="grid">{#each days as k}<Chip variant="assist" onclick={() => pick(k)}>{k}</Chip>{/each}</div>
  {:else if activeTab==='Weekdays'}
    <div class="grid">{#each weekdays as k}<Chip variant="assist" onclick={() => pick(k)}>{k}</Chip>{/each}</div>
  {:else if activeTab==='Times'}
    <div class="grid">{#each times as k}<Chip variant="assist" onclick={() => pick(k)}>{k}</Chip>{/each}</div>
  {:else}
    <div>
      <small>Use label buckets or manual mapping in Settings for custom labels.</small>
    </div>
  {/if}

  {#if selectedRule}
    <div class="preview">Next: {preview}</div>
  {/if}
</div>

<style>
  .panel { display:flex; flex-direction:column; gap:0.5rem; padding:0.5rem; min-width: 18rem; }
  .tabs { display:flex; flex-wrap:wrap; gap:0.25rem; }
  /* Using MD3 Chip components for tabs; no extra styles needed beyond spacing */
  .grid { display:grid; grid-template-columns: repeat(5, 1fr); gap:0.25rem; }
  /* Grid contains MD3 assist chips */
  .preview { font-size:0.875rem; color: rgb(var(--m3-scheme-on-surface-variant)); }
</style>


