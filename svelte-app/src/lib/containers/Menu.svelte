<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div class="m3-container" role="menu" aria-orientation="vertical" aria-label="Menu">
  {@render children()}
</div>

<style>
  :root {
    --m3-menu-shape: var(--m3-util-rounding-extra-small);
  }
  .m3-container {
    display: flex;
    position: relative;
    overflow: visible; /* allow native pickers/popovers to escape */
    flex-direction: column;
    padding: 0.5rem 0.5rem; /* MD3 menu container padding */
    border-radius: var(--m3-menu-shape);
    min-width: 7rem;
    max-width: 17.5rem;
    background-color: rgb(var(--m3-scheme-surface-container));
    z-index: 2;
    box-shadow: var(--m3-util-elevation-2);
  }
</style>
