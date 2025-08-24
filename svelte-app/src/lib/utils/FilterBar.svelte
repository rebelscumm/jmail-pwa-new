<script lang="ts">
  import TextFieldOutlined from '$lib/forms/TextFieldOutlined.svelte';
  import Checkbox from '$lib/forms/Checkbox.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import Chip from '$lib/forms/Chip.svelte';
  import Menu from '$lib/containers/Menu.svelte';
  import MenuItem from '$lib/containers/MenuItem.svelte';
  import { filters, saveActiveFilter, upsertSavedFilter, deleteSavedFilter, type ThreadFilter } from '$lib/stores/filters';
  import { labels as labelsStore } from '$lib/stores/labels';
  import ChipChooser from '$lib/utils/ChipChooser.svelte';
  import { show as showSnackbar } from '$lib/containers/snackbar';

  let { thread = null }: { thread: import('$lib/types').GmailThread | null } = $props();

  $effect(() => {
    if (thread) {
      draft.subjectIncludes = thread.lastMsgMeta.subject || '';
      draft.senderIncludes = thread.lastMsgMeta.from || '';
      draft.labelIds = thread.labelIds || [];
      // etc.
    }
  });

  let draft: ThreadFilter = $state({ subjectIncludes: '', senderIncludes: '', labelIds: [], unreadOnly: false, action: 'none', autoApply: false });
  let saveName = $state('');
  let savedDetails: HTMLDetailsElement;
  let actionDetails: HTMLDetailsElement;

  function toggleSaved(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (savedDetails) savedDetails.open = !savedDetails.open;
  }
  function toggleAction(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (actionDetails) actionDetails.open = !actionDetails.open;
  }

  // Close menus when clicking outside
  $effect(() => {
    function handleWindowClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (savedDetails && savedDetails.open) {
        if (target && (savedDetails === target || savedDetails.contains(target))) {
          // inside
        } else {
          savedDetails.open = false;
        }
      }
      if (actionDetails && actionDetails.open) {
        if (target && (actionDetails === target || actionDetails.contains(target))) {
          // inside
        } else {
          actionDetails.open = false;
        }
      }
    }
    window.addEventListener('click', handleWindowClick);
    return () => {
      window.removeEventListener('click', handleWindowClick);
    };
  });

  function resetDraft() {
    draft = { subjectIncludes: '', senderIncludes: '', labelIds: [], unreadOnly: false, action: 'none', autoApply: false };
  }
  function applyDraft() {
    saveActiveFilter({ ...draft });
    try {
      const parts: string[] = [];
      if (draft.subjectIncludes) parts.push(`subject: “${draft.subjectIncludes}”`);
      if (draft.senderIncludes) parts.push(`from: “${draft.senderIncludes}”`);
      if (draft.unreadOnly) parts.push('unread');
      if ((draft.labelIds || []).length) parts.push(`labels: ${(draft.labelIds || []).length}`);
      showSnackbar({ message: `Filter applied${parts.length ? ' • ' + parts.join(', ') : ''}` });
    } catch {}
  }
  async function saveDraft() {
    const name = (saveName || '').trim();
    if (!name) return;
    await upsertSavedFilter({ ...draft, name });
    saveName = '';
    try { showSnackbar({ message: `Saved filter “${name}”` }); } catch {}
  }
  function loadSaved(f: ThreadFilter) {
    draft = { subjectIncludes: f.subjectIncludes, senderIncludes: f.senderIncludes, labelIds: f.labelIds, unreadOnly: f.unreadOnly, action: f.action, autoApply: f.autoApply };
    applyDraft();
    try { if (savedDetails && savedDetails.open) savedDetails.open = false; } catch {}
  }
  async function removeSaved(id?: string) {
    if (!id) return;
    await deleteSavedFilter(id);
    try { showSnackbar({ message: 'Deleted saved filter' }); } catch {}
    try { if (savedDetails && savedDetails.open) savedDetails.open = false; } catch {}
  }

  const labelOptions = $derived(($labelsStore || []).map((l) => ({ label: l.name || l.id, value: l.id })));
</script>

<div class="bar">
  <details class="saved" bind:this={savedDetails}>
    <summary class="summary-btn" onclick={toggleSaved}>
      <Button variant="outlined">Saved filters</Button>
    </summary>
    <Menu>
      {#if ($filters.saved || []).length === 0}
        <div style="padding:0.5rem 0.75rem; max-width: 21rem;" class="m3-font-body-small">No saved filters yet.</div>
      {:else}
        {#each $filters.saved as f}
          <MenuItem onclick={() => loadSaved(f)}>{f.name}{f.autoApply ? ' • Auto' : ''}{f.action && f.action !== 'none' ? ` • ${f.action}` : ''}</MenuItem>
          <MenuItem onclick={() => removeSaved(f.id)}>Delete “{f.name}”</MenuItem>
          <hr />
        {/each}
      {/if}
    </Menu>
  </details>

  <TextFieldOutlined label="Subject contains" value={draft.subjectIncludes || ''} oninput={(e: Event) => draft.subjectIncludes = (e.currentTarget as HTMLInputElement).value} style="min-width:12rem;" />
  <TextFieldOutlined label="Sender contains" value={draft.senderIncludes || ''} oninput={(e: Event) => draft.senderIncludes = (e.currentTarget as HTMLInputElement).value} style="min-width:12rem;" />

  <label class="check">
    <Checkbox>
      <input type="checkbox" checked={!!draft.unreadOnly} onchange={(e: Event) => draft.unreadOnly = (e.currentTarget as HTMLInputElement).checked} />
    </Checkbox>
    <span>Unread only</span>
  </label>

  <details class="action" bind:this={actionDetails}>
    <summary class="summary-btn" onclick={toggleAction}>
      <Button variant="outlined">Action: {draft.action || 'none'}</Button>
    </summary>
    <Menu>
      <MenuItem onclick={() => { draft.action = 'none'; try { if (actionDetails && actionDetails.open) actionDetails.open = false; } catch {} }}>None</MenuItem>
      <MenuItem onclick={() => { draft.action = 'archive'; try { if (actionDetails && actionDetails.open) actionDetails.open = false; } catch {} }}>Archive</MenuItem>
      <MenuItem onclick={() => { draft.action = 'delete'; try { if (actionDetails && actionDetails.open) actionDetails.open = false; } catch {} }}>Delete</MenuItem>
    </Menu>
  </details>

  <label class="check">
    <Checkbox>
      <input type="checkbox" checked={!!draft.autoApply} onchange={(e: Event) => draft.autoApply = (e.currentTarget as HTMLInputElement).checked} />
    </Checkbox>
    <span>Auto-apply to new</span>
  </label>

  <div class="buttons">
    <Button variant="text" onclick={resetDraft}>Reset</Button>
    <Button variant="outlined" onclick={applyDraft}>Apply</Button>
    <div style="display:flex; gap:0.25rem; align-items:center;">
      <TextFieldOutlined label="Save as" value={saveName} oninput={(e: Event) => saveName = (e.currentTarget as HTMLInputElement).value} style="min-width:10rem;" />
      <Button variant="filled" onclick={saveDraft}>Save</Button>
    </div>
  </div>
</div>

<style>
  .bar { display:flex; flex-wrap:wrap; gap:0.5rem; align-items:flex-end; margin: 0.25rem 0 0.5rem; }
  .labels { display:flex; flex-direction:column; gap:0.25rem; }
  .check { display:flex; align-items:center; gap:0.25rem; }
  .summary-btn { cursor: pointer; }
  .action { position: relative; }
  .action > summary { list-style: none; }
  .action[open] > :global(.m3-container) { position:absolute; z-index:10; margin-top:0.25rem; }
  .saved { position: relative; }
  .saved > summary { list-style: none; }
  .saved[open] > :global(.m3-container) { position:absolute; z-index:10; margin-top:0.25rem; }
  .buttons { display:flex; gap:0.5rem; align-items:center; margin-left:auto; }
</style>