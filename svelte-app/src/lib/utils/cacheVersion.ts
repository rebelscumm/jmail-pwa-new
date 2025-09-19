import { readable } from 'svelte/store';

let current = 'unknown';

async function probeCacheVersion() {
  try {
    try {
      const keys = await caches.keys();
      const cache = keys.find((k: string) => k.startsWith('Jmail-v'));
      if (cache) return cache.replace('Jmail-v', '');
    } catch (e) {
      // ignore and continue
    }

    try {
      const r = await fetch('/sw.js', { method: 'GET', cache: 'no-store' });
      if (r && r.ok) {
        const swText = await r.text();
        const m = /CACHE_NAME\s*=\s*['"]Jmail-v([0-9.]+)['"]/i.exec(swText);
        if (m && m[1]) return m[1];
      }
    } catch (e) {
      // ignore
    }
    return 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

export const cacheVersion = readable(current, (set) => {
  // Probe once on subscription
  let mounted = true;
  (async () => {
    const v = await probeCacheVersion();
    if (mounted) { current = v; set(v); }
  })();

  // No teardown needed beyond marking mounted
  return () => { mounted = false; };
});

export async function refreshCacheVersion() {
  const v = await probeCacheVersion();
  current = v;
  return v;
}
