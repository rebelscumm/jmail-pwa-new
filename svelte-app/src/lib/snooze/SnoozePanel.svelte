<script lang="ts">
  import type { Snippet } from 'svelte';
  import { get } from 'svelte/store';
  import { settings } from '$lib/stores/settings';
  import { resolveRule, normalizeRuleKey } from '$lib/snooze/rules';
  import Chip from '$lib/forms/Chip.svelte';
  import DatePickerDocked from '$lib/forms/DatePickerDocked.svelte';

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

  // Exact list and labels requested; map display labels to rule keys
  const displayToRule: Record<string, string> = {
    '1h': '1h', '2h': '2h', '3h': '3h',
    '2p': '2pm', '6a': '6am', '7p': '7pm',
    '2d': '2d', '4d': '4d', 'Mon': 'Monday', 'Fri': 'Friday',
    '7d': '7d', '14d': '14d', '30d': '30d'
  };
  const orderedLabels: string[] = ['1h','2h','3h','2p','6a','7p','2d','4d','Mon','Fri','7d','14d','30d'];
  $: mapped = new Set(Object.keys($settings.labelMapping || {}).filter((k) => $settings.labelMapping[k]).map((k) => normalizeRuleKey(k)));
  function isMappedDisplay(label: string): boolean {
    try { return mapped.has(normalizeRuleKey(displayToRule[label])); } catch { return false; }
  }

  function daysFromToday(dateStr: string): number {
    try {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const chosen = new Date(dateStr + 'T00:00:00');
      const diffMs = chosen.getTime() - startOfToday.getTime();
      return Math.round(diffMs / 86400000);
    } catch {
      return 0;
    }
  }

  const tomorrowStr = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
</script>

<div class="panel" role="menu" aria-label="Snooze options">
  <div class="tabs" role="group" aria-label="Snooze presets">
    <div class="grid" role="group" aria-label="Snooze presets">
      {#each orderedLabels as label}
        {#if isMappedDisplay(label)}
          <Chip variant="assist" onclick={() => pick(displayToRule[label])} aria-label={`Snooze ${label}`}>{label}</Chip>
        {/if}
      {/each}
    </div>
  </div>

  <div class="calendar" role="group" aria-label="Pick a date">
    <DatePickerDocked
      date={tomorrowStr}
      clearable={false}
      dateValidator={(date) => {
        const n = daysFromToday(date);
        return n >= 1 && n <= 30;
      }}
      close={() => { /* menu stays open; parent handles closing on action */ }}
      setDate={(d) => {
        const n = daysFromToday(d);
        if (n >= 1 && n <= 30) pick(`${n}d`);
      }}
    />
  </div>

  {#if selectedRule}
    <div class="preview">Next: {preview}</div>
  {/if}
</div>

<style>
  .panel { display:flex; flex-direction:column; gap:0.75rem; padding:0.5rem; min-width: 18rem; }
  .tabs { padding: 0 0.25rem; }
  .grid { display:flex; flex-wrap: wrap; gap:0.5rem; align-items:flex-start; }
  .calendar { display:flex; align-items:center; justify-content:center; }
  /* Grid contains MD3 assist chips */
  .preview { font-size:0.875rem; color: rgb(var(--m3-scheme-on-surface-variant)); }
  @media (max-width: 480px) {
    .panel { min-width: min(100vw - 1rem, 18rem); }
  }
</style>


