<script lang="ts">
  import type { Snippet } from 'svelte';
  import { get } from 'svelte/store';
  import { settings } from '$lib/stores/settings';
  import { resolveRule, normalizeRuleKey } from '$lib/snooze/rules';
  import Chip from '$lib/forms/Chip.svelte';
  import MenuItem from '$lib/containers/MenuItem.svelte';
  import DatePickerDocked from '$lib/forms/DatePickerDocked.svelte';

  const { onSelect, active = false } = $props<{ onSelect: (ruleKey: string) => void, active?: boolean }>();

  let activeTab = $state<'Quick' | 'Hours' | 'Days' | 'Weekdays' | 'Times' | 'Custom'>('Quick');
  let preview = $state<string>('');
  let selectedRule = $state<string | null>(null);
  let el: HTMLElement | null = null;

  function computePreview(ruleKey: string) {
    selectedRule = ruleKey;
    const s = get(settings);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const due = resolveRule(ruleKey, zone, { anchorHour: s.anchorHour, roundMinutes: s.roundMinutes });
    if (!due) { preview = 'Persistent bucket'; return; }
    const dt = new Date(due);
    preview = dt.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
  }

  function pick(ruleKey: string, event?: Event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
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
  const mapped = $derived(new Set(Object.keys($settings.labelMapping || {}).filter((k) => $settings.labelMapping[k]).map((k) => normalizeRuleKey(k))));
  
  function isMappedDisplay(label: string): boolean {
    try { return mapped.has(normalizeRuleKey(displayToRule[label])); } catch { return false; }
  }

  // Compute visible labels and their shortcuts
  const visibleLabelsWithShortcuts = $derived.by(() => {
    const visible = orderedLabels.filter(isMappedDisplay);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    return visible.map((label, index) => {
      let key = '';
      if (index < 9) {
        key = (index + 1).toString();
      } else if (index === 9) {
        key = '0';
      } else {
        const charCode = index - 10;
        if (charCode < alphabet.length) {
          key = alphabet[charCode];
        }
      }
      return { label, rule: displayToRule[label], key };
    });
  });

  function handleKeydown(e: KeyboardEvent) {
    if (!active) return;
    // Check if element is visible
    if (el && el.offsetParent === null) return;
    // Don't trigger if user is typing in an input
    if (e.target && (e.target as HTMLElement).tagName === 'INPUT') return;
    
    // Check for number keys or letters
    const k = e.key.toUpperCase();
    const match = visibleLabelsWithShortcuts.find(item => item.key === k);
    if (match) {
      e.preventDefault();
      e.stopPropagation();
      pick(match.rule);
    }
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

  function isValidDate(iso: string): boolean {
    const n = daysFromToday(iso);
    return n >= 1 && n <= 30;
  }

  function onDateChosen(iso: string): void {
    const n = daysFromToday(iso);
    if (n < 1 || n > 30) return;
    pick(`${n}d`);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="panel" role="menu" aria-label="Snooze options" bind:this={el}>
  <div class="tabs" role="group" aria-label="Snooze presets">
    <div class="grid" role="group" aria-label="Snooze presets">
      {#each visibleLabelsWithShortcuts as { label, rule, key }}
        <Chip variant="assist" onclick={(e: Event) => pick(rule, e)} aria-label={`Snooze ${label} (Shortcut: ${key})`}>
          <span class="chip-content">
            {label}
            {#if active && key}
              <span class="shortcut-key" aria-hidden="true">{key}</span>
            {/if}
          </span>
        </Chip>
      {/each}
    </div>
  </div>

  <div class="picker" role="group" aria-label="Pick a date">
    <DatePickerDocked
      clearable={false}
      date={''}
      dateValidator={isValidDate}
      autoOk={true}
      close={() => {}}
      setDate={onDateChosen}
    />
  </div>

  {#if selectedRule}
    <div class="preview">Next: {preview}</div>
  {/if}
</div>

<style>
  .panel { display:flex; flex-direction:column; gap:0.75rem; padding:0.5rem; min-width: 21rem; }
  .tabs { padding: 0 0.25rem; }
  .grid { display:flex; flex-wrap: wrap; gap:0.5rem; align-items:flex-start; }
  .picker { display:flex; align-items:center; justify-content:center; padding: 0.25rem 0.25rem; position: relative; z-index: 10002; border: 0; pointer-events: auto; }
  /* Grid contains MD3 assist chips */
  .preview { font-size:0.875rem; color: rgb(var(--m3-scheme-on-surface-variant)); }
  
  .chip-content {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  
  .shortcut-key {
    font-size: 0.75rem;
    color: rgb(var(--m3-scheme-primary));
    background-color: rgb(var(--m3-scheme-primary-container));
    color: rgb(var(--m3-scheme-on-primary-container));
    border-radius: 4px;
    padding: 0 4px;
    font-weight: 500;
    min-width: 1.2ch;
    text-align: center;
    line-height: 1.4;
  }

  @media (max-width: 480px) {
    .panel { min-width: min(100vw - 1rem, 21rem); }
    /* Hide shortcuts on mobile/touch if preferred, though prompts says "when... pressed on a desktop". 
       Since we don't have reliable device detection, checking active prop (controlled by open state) is good enough.
       Shortcuts can be visible on mobile too, they just won't be usable without a keyboard.
    */
  }
</style>
