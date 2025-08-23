<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div
  class="m3-container"
  role="menu"
  aria-orientation="vertical"
  aria-label="Menu"
  tabindex="0"
  onclick={(e) => { e.preventDefault(); e.stopPropagation(); }}
  onpointerdown={(e) => e.stopPropagation()}
  onmousedown={(e) => e.stopPropagation()}
  onmouseup={(e) => e.stopPropagation()}
  ontouchstart={(e) => e.stopPropagation()}
  ontouchend={(e) => e.stopPropagation()}
  onkeydown={(e) => { if (e.key === 'Escape') { (e.currentTarget as HTMLElement).blur(); } }}
>
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
    padding: 0.75rem 0.75rem; /* slightly roomier MD3 menu container padding */
    gap: 0.375rem; /* add space between menu items */
    border-radius: var(--m3-menu-shape);
    min-width: 7rem;
    max-width: 17.5rem;
    max-height: min(72vh, 32rem);
    overflow-y: auto;
    overscroll-behavior: contain;
    background-color: rgb(var(--m3-scheme-surface-container));
    z-index: 10001; /* above list row so native pickers are visible */
    box-shadow: var(--m3-util-elevation-3);
  }
  @media (max-width: 480px) {
    .m3-container {
      max-width: calc(100vw - 1rem);
    }
  }
</style>
