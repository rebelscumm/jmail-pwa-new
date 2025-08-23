<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  let { items, rowHeight = 64, overscan = 6, children, getKey, persistKey }: { items: any[]; rowHeight?: number; overscan?: number; children: Snippet<[any, number]>; getKey?: (item: any, index: number) => string | number; persistKey?: string } = $props();
  let container: HTMLDivElement | null = null;
  let height = 400;

  type PersistEntry = {
    scrollTop?: number;
    heightsByKey?: Record<string, number>;
    anchorKey?: string;
    anchorOffset?: number;
  };
  const __vlCache: Map<string, PersistEntry> = (globalThis as any).__vlCache || new Map<string, PersistEntry>();
  try { (globalThis as any).__vlCache = __vlCache; } catch {}
  function getPersist(): PersistEntry | null {
    if (!persistKey) return null;
    let e = __vlCache.get(persistKey);
    if (!e) { e = {}; __vlCache.set(persistKey, e); }
    return e;
  }

  let scrollTop = (typeof window !== 'undefined' ? (getPersist()?.scrollTop || 0) : 0);
  const onScroll = () => {
    const st = container?.scrollTop || 0;
    scrollTop = st;
    height = container?.clientHeight || height;
    const p = getPersist(); if (p) p.scrollTop = st;
  };
  $effect(() => { const h = container?.clientHeight || height; height = h; });

  // Track measured heights per item; default to rowHeight
  let heights: number[] = $state([]);
  $effect(() => {
    const len = items.length;
    if (heights.length !== len) {
      const next: number[] = new Array(len);
      for (let i = 0; i < len; i++) {
        if (heights[i] != null) { next[i] = heights[i]; continue; }
        let h = rowHeight;
        try {
          const p = getPersist();
          if (p && getKey) {
            const k = getKey(items[i], i);
            const saved = p.heightsByKey?.[String(k)];
            if (typeof saved === 'number' && saved > 0) h = saved;
          }
        } catch {}
        next[i] = h;
      }
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

  // Persist anchor (first visible item's key + offset) whenever viewport changes
  $effect(() => {
    try {
      const p = getPersist();
      if (!p || !getKey) return;
      const idx = startIndex;
      const item = items[idx];
      if (!item) return;
      const key = getKey(item, idx);
      const offsetRemainder = (container?.scrollTop || 0) - (offsets[idx] || 0);
      p.anchorKey = String(key);
      p.anchorOffset = Math.max(0, offsetRemainder);
    } catch {}
  });

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
    let pending = false;
    let pendingUpdates: Array<{ idx: number; height: number }> = [];
    const flush = () => {
      pending = false;
      if (!pendingUpdates.length) return;
      const updates = pendingUpdates;
      pendingUpdates = [];
      // Temporarily disconnect to avoid triggering ResizeObserver loop when mutating layout
      observer?.disconnect();
      let changed = false;
      // Preserve scroll position by compensating for height changes above current scrollTop
      const currentScrollTop = container?.scrollTop || 0;
      let deltaScroll = 0;
      // Use current offsets (pre-update) to decide which rows are above the viewport
      const oldOffsets = offsets;
      for (const { idx, height: h } of updates) {
        if (h > 0 && heights[idx] !== h) {
          // If this row starts above current scrollTop, accumulate delta
          try {
            if (oldOffsets[idx] < currentScrollTop) {
              const prev = heights[idx] ?? rowHeight;
              deltaScroll += (h - prev);
            }
          } catch {}
          heights[idx] = h;
          // Persist measured height keyed by item key if available
          try {
            const p = getPersist();
            if (p && getKey) {
              const key = getKey(items[idx], idx);
              const map = p.heightsByKey || {};
              map[String(key)] = h;
              p.heightsByKey = map;
            }
          } catch {}
          changed = true;
        }
      }
      if (changed) {
        // Nudge Svelte state
        heights = heights;
        // Adjust scrollTop to keep viewport anchored
        if (deltaScroll !== 0 && container) {
          container.scrollTop = currentScrollTop + deltaScroll;
        }
      }
      // Re-observe all known elements after state update
      for (const el of indexToEl.values()) observer?.observe(el);
    };
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const idx = elToIndex.get(el);
        if (idx === undefined) continue;
        const newH = Math.ceil(entry.contentRect.height);
        pendingUpdates.push({ idx, height: newH });
      }
      if (!pending) {
        pending = true;
        requestAnimationFrame(flush);
      }
    });
    for (const el of indexToEl.values()) observer.observe(el);
    return () => {
      observer?.disconnect(); observer = null; indexToEl.clear();
      try { const p = getPersist(); if (p && container) p.scrollTop = container.scrollTop || 0; } catch {}
    };
  });
  
  // Apply initial scroll as early as possible via an action to avoid flicker
  function applyInitialScroll(node: HTMLDivElement) {
    try {
      const p = getPersist();
      if (p) {
        // Prefer anchor restoration by item key
        if (getKey && p.anchorKey != null) {
          let targetIdx = -1;
          for (let i = 0; i < items.length; i++) {
            try { if (String(getKey(items[i], i)) === String(p.anchorKey)) { targetIdx = i; break; } } catch {}
          }
          if (targetIdx >= 0) {
            const base = offsets[targetIdx] || 0;
            const y = Math.max(0, base + (p.anchorOffset || 0));
            node.scrollTop = y;
            scrollTop = y;
            return {};
          }
        }
        // Fallback to raw scrollTop
        if (typeof p.scrollTop === 'number' && p.scrollTop > 0) {
          node.scrollTop = p.scrollTop;
          scrollTop = p.scrollTop;
        }
      }
    } catch {}
    return {};
  }

  // If items arrive later (e.g., after cache/remote hydrate), attempt anchor-based restoration again
  let __appliedAnchorKey: string | null = null;
  $effect(() => {
    try {
      if (!container) return;
      const p = getPersist();
      if (!p || !getKey || !p.anchorKey) return;
      if (__appliedAnchorKey === String(p.anchorKey)) return;
      let targetIdx = -1;
      for (let i = 0; i < items.length; i++) {
        try { if (String(getKey(items[i], i)) === String(p.anchorKey)) { targetIdx = i; break; } } catch {}
      }
      if (targetIdx >= 0) {
        const base = offsets[targetIdx] || 0;
        const y = Math.max(0, base + (p.anchorOffset || 0));
        container.scrollTop = y;
        scrollTop = y;
        __appliedAnchorKey = String(p.anchorKey);
      }
    } catch {}
  });
</script>

<div bind:this={container} onscroll={onScroll} use:applyInitialScroll style="overflow: auto; will-change: transform; contain: strict; height: 100%; min-height: 0;">
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
</style>
