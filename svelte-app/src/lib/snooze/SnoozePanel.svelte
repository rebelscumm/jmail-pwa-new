<script lang="ts">
  import type { Snippet } from 'svelte';
  import { get } from 'svelte/store';
  import { settings } from '$lib/stores/settings';
  import { resolveRule } from '$lib/snooze/rules';

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

  const quick = ['10m','30m','1h','2h','3h'];
  const hours = ['1h','2h','3h','4h','5h','6h','7h'];
  const days = Array.from({ length: 30 }, (_, i) => `${i+1}d`);
  const weekdays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const times = ['6am','2pm','7pm'];
</script>

<div class="panel">
  <div class="tabs">
    {#each ['Quick','Hours','Days','Weekdays','Times','Custom'] as t}
      <button class:active={activeTab===t} on:click={() => activeTab = t as any}>{t}</button>
    {/each}
  </div>

  {#if activeTab==='Quick'}
    <div class="grid">{#each quick as k}<button on:click={() => pick(k)}>{k}</button>{/each}</div>
  {:else if activeTab==='Hours'}
    <div class="grid">{#each hours as k}<button on:click={() => pick(k)}>{k}</button>{/each}</div>
  {:else if activeTab==='Days'}
    <div class="grid">{#each days as k}<button on:click={() => pick(k)}>{k}</button>{/each}</div>
  {:else if activeTab==='Weekdays'}
    <div class="grid">{#each weekdays as k}<button on:click={() => pick(k)}>{k}</button>{/each}</div>
  {:else if activeTab==='Times'}
    <div class="grid">{#each times as k}<button on:click={() => pick(k)}>{k}</button>{/each}</div>
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
  .tabs > button { padding:0.25rem 0.5rem; border-radius:0.75rem; border:1px solid var(--m3-outline-variant); background:transparent; }
  .tabs > button.active { background: rgb(var(--m3-scheme-secondary-container)); color: rgb(var(--m3-scheme-on-secondary-container)); }
  .grid { display:grid; grid-template-columns: repeat(5, 1fr); gap:0.25rem; }
  .grid > button { padding:0.25rem 0.5rem; border-radius:0.75rem; border:1px solid var(--m3-outline-variant); background:transparent; }
  .preview { font-size:0.875rem; color: rgb(var(--m3-scheme-on-surface-variant)); }
</style>


