<script lang="ts">
  import type { Snippet } from "svelte";

  let { 
    children, 
    class: className = "",
    ...restProps
  }: { 
    children: Snippet;
    class?: string;
  } & Record<string, any> = $props();
</script>

<div
  class="m3-container {className}"
  {...restProps}
  role="menu"
  aria-orientation="vertical"
  aria-label="Menu"
  tabindex="0"
  onclick={(e) => { 
    // Only prevent default if the click is directly on the menu container, not on menu items
    if (e.target === e.currentTarget) {
      e.preventDefault(); 
      e.stopPropagation(); 
    }
  }}
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
    /* Allow menus (esp. snooze date picker) to use nearly full viewport height */
    max-height: min(100dvh, 44rem);
    overflow-y: auto;
    overscroll-behavior: contain;
    background-color: rgb(var(--m3-scheme-surface-container));
    z-index: 10001; /* above list row so native pickers are visible */
    box-shadow: var(--m3-util-elevation-3);
  }
  
  /* Allow history menu to override size constraints */
  .m3-container.history-menu {
    max-width: none !important;
    min-width: none !important;
    width: auto !important;
  }
  @media (max-width: 480px) {
    .m3-container {
      max-width: calc(100vw - 1rem);
    }
    /* Ensure history menu uses full width on mobile too */
    .m3-container.history-menu {
      max-width: calc(100vw - 2rem) !important;
      width: calc(100vw - 2rem) !important;
    }
  }
  /* Make sure the menu's inner content is left-aligned while the container is centered */
  .m3-container.history-menu {
    text-align: left !important;
  }
</style>
