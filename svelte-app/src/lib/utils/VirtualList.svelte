<script lang="ts">
  import type { Snippet } from 'svelte';
  let { items, rowHeight = 64, overscan = 6, children }: { items: any[]; rowHeight?: number; overscan?: number; children: Snippet<[any, number]> } = $props();
  let container: HTMLDivElement | null = null;
  let height = 400;
  let scrollTop = 0;
  const onScroll = () => { scrollTop = container?.scrollTop || 0; height = container?.clientHeight || height; };
  $effect(() => { const h = container?.clientHeight || height; height = h; });
  const total = $derived(items.length * rowHeight);
  const startIndex = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const visibleCount = $derived(Math.ceil(height / rowHeight) + overscan * 2);
  const slice = $derived(items.slice(startIndex, startIndex + visibleCount));
  const offsetTop = $derived(startIndex * rowHeight);
</script>

<div bind:this={container} onscroll={onScroll} style="overflow: auto; will-change: transform; contain: strict; height: 100%; min-height: 0;">
  <div style={`height:${total}px; position: relative;`}>
    <div style={`position:absolute; top:${offsetTop}px; left:0; right:0`}>
      {#each slice as item, i}
        <div style={`height:${rowHeight}px; overflow:hidden`}>
          {@render children(item, startIndex + i)}
        </div>
      {/each}
    </div>
  </div>
</div>


