<script lang="ts">
  import Button from "$lib/buttons/Button.svelte";

  export let onSave: () => void | Promise<void>;
  export let onSaveAndExit: () => void | Promise<void>;
  export let onClose: () => void | Promise<void>;
</script>

<div style="margin-top:0.5rem; display:flex; gap:0.5rem; justify-content:flex-end;">
  <Button variant="filled" onclick={onSave}>Save</Button>
  <Button variant="filled" onclick={onSaveAndExit}>Save & Exit</Button>
  <Button variant="text" onclick={onClose}>Close</Button>
  <!-- Maintain identical layout/labels to the top action buttons -->
</div>


