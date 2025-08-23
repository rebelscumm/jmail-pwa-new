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

  let draft: ThreadFilter = $state({ subjectIncludes: '', senderIncludes: '', labelIds: [], unreadOnly: false, action: 'none', autoApply: false });
  let savedOpen = $state(false);
  let saveName = $state('');

  function resetDraft() {
    draft = { subjectIncludes: '', senderIncludes: '', labelIds: [], unreadOnly: false, action: 'none', autoApply: false };
  }
  function applyDraft() { saveActiveFilter({ ...draft }); }
  async function saveDraft() {
    const name = (saveName || '').trim();
    if (!name) return;
    await upsertSavedFilter({ ...draft, name });
    saveName = '';
  }
  function loadSaved(f: ThreadFilter) {
    draft = { subjectIncludes: f.subjectIncludes, senderIncludes: f.senderIncludes, labelIds: f.labelIds, unreadOnly: f.unreadOnly, action: f.action, autoApply: f.autoApply };
    applyDraft();
  }
  async function removeSaved(id?: string) {
    if (!id) return;
    await deleteSavedFilter(id);
  }

  const labelOptions = $derived(($labelsStore || []).map((l) => ({ label: l.name || l.id, value: l.id })));
</script>

<div class="bar">
  <details class="saved" bind:open={savedOpen}>
    <summary class="summary-btn">
      <Button variant="text">{#snippet children()}Saved filters{/snippet}</Button>
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

  <div class="labels">
    <label class="m3-font-body-small">Labels</label>
    <ChipChooser options={labelOptions} bind:chosenOptions={draft.labelIds} />
  </div>

  <label class="check">
    <Checkbox>
      <input type="checkbox" checked={!!draft.unreadOnly} onchange={(e: Event) => draft.unreadOnly = (e.currentTarget as HTMLInputElement).checked} />
    </Checkbox>
    <span>Unread only</span>
  </label>

  <details class="action">
    <summary class="summary-btn">
      <Button variant="text">{#snippet children()}Action: {draft.action || 'none'}{/snippet}</Button>
    </summary>
    <Menu>
      <MenuItem onclick={() => draft.action = 'none'}>None</MenuItem>
      <MenuItem onclick={() => draft.action = 'archive'}>Archive</MenuItem>
      <MenuItem onclick={() => draft.action = 'delete'}>Delete</MenuItem>
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
  .action[open] > :global(.m3-container) { position:absolute; z-index:10; }
  .saved { position: relative; }
  .saved[open] > :global(.m3-container) { position:absolute; z-index:10; }
  .buttons { display:flex; gap:0.5rem; align-items:center; margin-left:auto; }
</style>
