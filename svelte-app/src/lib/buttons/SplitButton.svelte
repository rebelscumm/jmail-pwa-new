<script lang="ts">
  import iconExpand from "@ktibow/iconset-material-symbols/keyboard-arrow-down";
  import type { Snippet } from "svelte";
  import Layer from "$lib/misc/Layer.svelte";
  import Icon from "$lib/misc/_icon.svelte";
  import { createEventDispatcher } from 'svelte';

  let {
    variant,
    x = "inner",
    y = "down",
    children,
    menu,
    onclick,
  }: {
    variant: "elevated" | "filled" | "tonal" | "outlined" | "text";
    x?: "inner" | "right";
    y?: "down" | "up";
    children: Snippet;
    menu: Snippet;
    onclick: () => void;
  } = $props();

  const dispatch = createEventDispatcher<{ toggle: boolean }>();
  let open = $state(false);

  const autoclose = (node: HTMLDetailsElement) => {
    const close = (e: Event) => {
      const target = e.target as Element | null;
      if (!target) { node.open = false; return; }
      // If click is on the summary toggle, ignore (native toggle will handle)
      if (target.closest('summary')) return;
      const inside = node.contains(target);
      if (inside) {
        // Keep menu OPEN for general interactions inside the menu, except
        // when an actual action control is activated (buttons/links/menuitems).
        if (target.closest('.picker')) return;
        if (target.closest('button, [role="menuitem"], a[href]')) {
          node.open = false; // selecting a chip/menuitem closes the menu
          return;
        }
        return; // clicks on other inner areas do not close
      }
      // Click outside → close
      node.open = false;
    };
    // Use capture so it still fires even if inner handlers stop propagation
    window.addEventListener("click", close, true);
    return {
      destroy() {
        window.removeEventListener("click", close, true);
      },
    };
  };
</script>

<div class="m3-container {variant}">
  <button type="button" class="split m3-font-label-large" {onclick}>
    <Layer />
    {@render children()}
  </button>
  <details class="align-{x} align-{y}" use:autoclose ontoggle={(e) => { const isOpen = (e.currentTarget as HTMLDetailsElement).open; open = isOpen; dispatch('toggle', isOpen); }}>
    <summary class="split" aria-haspopup="menu" aria-expanded={open} onpointerdown={(e) => e.stopPropagation()} onclick={(e) => e.stopPropagation()}>
      <Layer />
      <Icon icon={iconExpand} width="1.375rem" height="1.375rem" />
    </summary>
    {@render menu()}
  </details>
</div>

<style>
  :root {
    --m3-split-button-outer-shape: 1.25rem;
    --m3-split-button-half-shape: var(--m3-util-rounding-medium);
    --m3-split-button-inner-shape: var(--m3-util-rounding-extra-small);
  }

  .m3-container {
    display: inline-grid;
    grid-template-columns: 1fr auto;
    gap: 0; /* unify halves */
    position: relative;
    border-radius: var(--m3-split-button-outer-shape);
    overflow: hidden; /* make outline wrap both halves and clip layers */

    &.elevated .split {
      background-color: rgb(var(--m3-scheme-surface-container-low));
      color: rgb(var(--m3-scheme-primary));
      box-shadow: var(--m3-util-elevation-1);
      &:hover {
        box-shadow: var(--m3-util-elevation-2);
      }
    }

    &.filled .split {
      background-color: rgb(var(--m3-scheme-primary));
      color: rgb(var(--m3-scheme-on-primary));
    }

    /* Text variant: plain text surface like other text buttons */
    &.text .split {
      background-color: transparent;
      color: rgb(var(--m3-scheme-primary));
    }

    &.tonal .split {
      background-color: rgb(var(--m3-scheme-secondary-container));
      color: rgb(var(--m3-scheme-on-secondary-container));
    }

    /* Outlined variant: single outline around both halves */
    &.outlined {
      outline: 1px solid rgb(var(--m3-scheme-outline-variant));
      outline-offset: -1px;
    }
    &.outlined .split {
      color: rgb(var(--m3-scheme-on-surface-variant));
    }
    /* Divider between halves for outlined variant */
    &.outlined summary {
      border-left: 1px solid rgb(var(--m3-scheme-outline-variant));
    }
  }

  /* Allow dropdowns to overflow the split button when open */
  .m3-container:has(details[open]) {
    overflow: visible;
  }

  .split {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 2.5rem;
    gap: 0.5rem;

    cursor: pointer;
    background-color: transparent;
    border: none;

    position: relative;
    transition:
      box-shadow var(--m3-util-easing-fast),
      border-radius var(--m3-util-easing-fast),
      padding var(--m3-util-easing-fast);
  }

  button {
    padding-inline-start: 1rem;
    padding-inline-end: 0.75rem;
    border-start-start-radius: var(--m3-split-button-outer-shape);
    border-end-start-radius: var(--m3-split-button-outer-shape);
    border-start-end-radius: var(--m3-split-button-inner-shape);
    border-end-end-radius: var(--m3-split-button-inner-shape);
    &:hover,
    &:active {
      border-start-end-radius: var(--m3-split-button-half-shape);
      border-end-end-radius: var(--m3-split-button-half-shape);
    }

    > :global(svg) {
      width: 1.25rem;
      height: 1.25rem;
    }
  }

  details {
    display: flex;
    position: relative;
    overflow: visible; /* allow open menus and popovers to escape */
  }
  summary {
    padding-inline-start: 0.75rem;
    padding-inline-end: 0.875rem;
    border-start-start-radius: var(--m3-split-button-inner-shape);
    border-end-start-radius: var(--m3-split-button-inner-shape);
    &:hover,
    &:active {
      border-start-start-radius: var(--m3-split-button-half-shape);
      border-end-start-radius: var(--m3-split-button-half-shape);
    }
    border-start-end-radius: var(--m3-split-button-outer-shape);
    border-end-end-radius: var(--m3-split-button-outer-shape);
    /* Reset default summary marker */
    list-style: none;
    /* Reset native summary button appearance so it matches MD3 button styles */
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
    border: none;
    color: inherit;
    padding: 0.375rem;
    margin: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    outline: none;
  }
  summary::-webkit-details-marker { display: none; }

    summary:is(details[open] summary) {
      padding-inline-start: 0.8125rem;
      padding-inline-end: 0.8125rem;
      border-radius: var(--m3-split-button-outer-shape);
    }
    summary:is(details[open] summary) > :global(.tint) {
      opacity: 0.08;
    }
    summary:is(details[open] summary) > :global(svg) {
      rotate: 180deg;
    }
    summary > :global(svg) {
      transition: rotate var(--m3-util-easing-fast);
    }
    /* Focus ring for keyboard accessibility using MD3 token */
    summary:focus-visible {
      box-shadow: 0 0 0 3px rgb(var(--m3-scheme-primary) / 0.16);
      border-radius: var(--m3-split-button-outer-shape);
    }

  	details > :global(:not(summary)) {
		position: absolute !important;
		z-index: 10;
	}
	details.align-inner > :global(:not(summary)) { left: 0; }
	details.align-right > :global(:not(summary)) { right: 0; }
	details.align-down > :global(:not(summary)) { top: 100%; }
	details.align-up > :global(:not(summary)) { bottom: 100%; }
	
	/* Special positioning for history menu to allow it to be wider and centered */
	details > :global(.history-menu.m3-container) {
		/* Use fixed positioning so the menu isn't clipped by parent stacking contexts */
		position: fixed !important;
		left: 50% !important;
		top: 8vh !important; /* place near top but leave some breathing room */
		transform: translateX(-50%) !important;
		margin: 0 !important;
		padding-top: 0.5rem !important;
		width: calc(100vw - 3rem) !important;
		max-width: calc(100vw - 3rem) !important;
		max-height: calc(100vh - 6rem) !important;
		overflow-x: hidden !important;
		overflow-y: auto !important;
		z-index: 10003 !important;
		box-shadow: var(--m3-util-elevation-4) !important;
		border-radius: var(--m3-util-rounding-medium) !important;
	}

  .m3-container {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
</style>
