<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  let { items, rowHeight = 64, overscan = 6, children, getKey }: { items: any[]; rowHeight?: number; overscan?: number; children: Snippet<[any, number]>; getKey?: (item: any, index: number) => string | number } = $props();
  let container: HTMLDivElement | null = null;
  let height = 400;
  let scrollTop = 0;
  const onScroll = () => { scrollTop = container?.scrollTop || 0; height = container?.clientHeight || height; };
  $effect(() => { const h = container?.clientHeight || height; height = h; });

  // Track measured heights per item; default to rowHeight
  let heights: number[] = $state([]);
  $effect(() => {
    const len = items.length;
    if (heights.length !== len) {
      const next: number[] = new Array(len);
      for (let i = 0; i < len; i++) next[i] = heights[i] ?? rowHeight;
      heights = next;
    }
  });

  // Prefix offsets for absolute positioning
  const offsets = $derived.by(() => {
    const arr: number[] = new Array(items.length);
    let sum = 0;
    for (let i = 0; i < items.length; i++) { arr[i] = sum; sum += heights[i] ?? rowHeight; }
    return arr;
  });
  const total = $derived.by(() => offsets.length ? offsets[offsets.length - 1] + (heights[offsets.length - 1] ?? 0) : 0);

  // Find first visible index via binary search on offsets
  const startIndex = $derived.by(() => {
    const st = scrollTop;
    const arr = offsets;
    let lo = 0, hi = arr.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= st) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return Math.max(0, ans - overscan);
  });

  // Find end index just past viewport bottom
  const endIndex = $derived.by(() => {
    const arr = offsets;
    const bottom = scrollTop + height;
    let lo = 0, hi = arr.length - 1, ans = arr.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < bottom) { lo = mid + 1; } else { ans = mid; hi = mid - 1; }
    }
    return Math.min(items.length, ans + overscan);
  });
  const slice = $derived(items.slice(startIndex, endIndex));

  // Observe row size changes to update heights
  let observer: ResizeObserver | null = null;
  const indexToEl: Map<number, HTMLElement> = new Map();
  const elToIndex: WeakMap<HTMLElement, number> = new WeakMap();
  function measureRow(node: HTMLElement, index: number) {
    indexToEl.set(index, node);
    elToIndex.set(node, index);
    if (observer) observer.observe(node);
    return {
      update(newIndex: number) {
        const prevIndex = elToIndex.get(node) ?? index;
        if (prevIndex !== newIndex) {
          indexToEl.delete(prevIndex);
          indexToEl.set(newIndex, node);
          elToIndex.set(node, newIndex);
          index = newIndex;
        }
      },
      destroy() {
        observer?.unobserve(node);
        const idx = elToIndex.get(node);
        if (idx !== undefined) indexToEl.delete(idx);
        elToIndex.delete(node);
      }
    };
  }
  onMount(() => {
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const idx = elToIndex.get(el);
        if (idx === undefined) continue;
        const newH = Math.ceil(entry.contentRect.height);
        if (newH > 0 && heights[idx] !== newH) { heights[idx] = newH; heights = heights; }
      }
    });
    for (const el of indexToEl.values()) observer.observe(el);
    return () => { observer?.disconnect(); observer = null; indexToEl.clear(); };
  });
</script>

<div bind:this={container} onscroll={onScroll} style="overflow: auto; will-change: transform; contain: strict; height: 100%; min-height: 0;">
  <div style={`height:${total}px; position: relative;`}>
    {#each slice as item, i (getKey ? getKey(item, startIndex + i) : (startIndex + i))}
      {@const idx = startIndex + i}
      <div class="row" style={`position:absolute; top:${offsets[idx]}px; left:0; right:0; min-height:${rowHeight}px;`} use:measureRow={idx}>
        {@render children(item, idx)}
      </div>
    {/each}
  </div>
</div>


<style>
  .row:has(:global(details[open])) {
    z-index: 5;
  }
  .row:hover {
    z-index: 4;
  }
</style>
