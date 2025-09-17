<script>
  // @ts-nocheck
  /// <reference types="svelte" />
  import Icon from "$lib/misc/_icon.svelte";
  import Layer from "$lib/misc/Layer.svelte";

  let {
    variant,
    icon = null,
    trailingIcon = null,
    elevated = false,
    disabled = false,
    selected = false,
    children,
    ...extra
  } = $props();
// Render children safely: call nested snippet functions until we get a primitive/string
// If `children` is a Svelte snippet function, render it with {@render children()}.
// Otherwise render the primitive value directly. This avoids losing DOM
// fragments when the slot returns nodes rather than plain strings.

</script>

<button
  type="button"
  class="m3-container {variant}"
  class:elevated
  class:selected
  {disabled}
  onclick={(e) => {
    // Prevent chip clicks from bubbling to parent rows
    e.preventDefault();
    e.stopPropagation();
    // Call the original onclick if provided
    if (extra.onclick) {
      extra.onclick(e);
    }
  }}
  {...extra}
  role="menuitem"
>
  <Layer />
  {#if icon}
    <Icon {icon} class="leading" />
  {/if}
  <span class="m3-font-label-large" style="color: rgb(var(--m3-scheme-on-surface))">
    {#if typeof children === 'function'}
      {@render children()}
    {:else}
      {children}
    {/if}
  </span>
  {#if trailingIcon}
    <Icon icon={trailingIcon} class="trailing" />
  {/if}
</button>

<style>
  :root {
    --m3-chip-shape: var(--m3-util-rounding-small);
  }
  .m3-container {
    display: flex;
    height: 2rem;
    border-radius: var(--m3-chip-shape);
    padding: 0 0.75rem; /* MD3 assist chip horizontal padding = 12dp */
    gap: 0.5rem;
    align-items: center;

    background-color: rgb(var(--m3-scheme-surface));
    color: rgb(var(--m3-scheme-on-surface-variant));
    border: solid 1px rgb(var(--m3-scheme-outline));
    position: relative;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: var(--m3-util-easing-fast);
    outline: none;
  }

  .m3-container:focus-visible {
    box-shadow: 0 0 0 3px rgb(var(--m3-scheme-primary) / 0.3);
  }

  .m3-container > :global(:is(.ripple-container, .tint)) {
    inset: -1px;
  }
  .m3-container > :global(svg) {
    width: 1.125rem;
    height: 1.125rem;
  }
  .m3-container:enabled:not(.input):not(.selected) > :global(.leading) {
    color: rgb(var(--m3-scheme-primary));
  }
  .m3-container > :global(.leading) {
    margin-left: -0.5rem;
  }
  .m3-container > :global(.trailing) {
    margin-right: -0.5rem;
  }
  .input > :global(.leading) {
    margin-left: -0.25rem;
  }
  .input > :global(.trailing) {
    margin-right: -0.25rem;
  }

  .assist {
    color: rgb(var(--m3-scheme-on-surface));
  }
  .input {
    padding: 0 0.75rem;
  }
  .elevated {
    border-color: transparent;
    background-color: rgb(var(--m3-scheme-surface-container-low));
    box-shadow: var(--m3-util-elevation-1);
  }
  .selected {
    border-color: transparent;
    background-color: rgb(var(--m3-scheme-secondary-container));
    color: rgb(var(--m3-scheme-on-secondary-container));
  }

  .layer {
    background-color: currentColor;
    opacity: 0;
  }
  @media (hover: hover) {
    .selected:hover:enabled {
      box-shadow: var(--m3-util-elevation-1);
    }
    .elevated:hover:enabled {
      box-shadow: var(--m3-util-elevation-2);
    }
  }

  .m3-container:disabled {
    cursor: auto;
    box-shadow: none;
    border-color: rgb(var(--m3-scheme-on-surface) / 0.12);
    background-color: rgb(var(--m3-scheme-surface));
    color: rgb(var(--m3-scheme-on-surface) / 0.38);
  }
  .selected:disabled,
  .elevated:disabled {
    border-color: transparent;
  }
  .selected:disabled,
  .elevated:disabled {
    background-color: rgb(var(--m3-scheme-on-surface) / 0.12);
  }

  .m3-container {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
  @media screen and (forced-colors: active) {
    .selected {
      background-color: selecteditem !important;
    }
    .m3-container.disabled {
      opacity: 0.38;
    }
  }
</style>
