<script lang="ts">
  // @ts-nocheck
  /// <reference types="svelte" />
  let { icon, width = '1em', height = '1em', class: clazz = '' } = $props();
  // Keep a DOM container for injecting raw SVG body safely at runtime
  let svgContainer: HTMLElement | null = null;
  $effect(() => {
    try {
      if (svgContainer) svgContainer.innerHTML = icon && (icon as any).body ? (icon as any).body : '';
    } catch {}
  });
</script>

<svg bind:this={svgContainer} {width} {height} class={clazz} viewBox="0 0 {icon?.width || 24} {icon?.height || 24}"></svg>
