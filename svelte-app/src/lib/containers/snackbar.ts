import type { SnackbarIn } from './Snackbar.svelte';

let showImpl: ((opts: SnackbarIn) => void) | null = null;
let history: SnackbarIn[] = [];

export function register(showFn: (opts: SnackbarIn) => void): void {
  showImpl = showFn;
}

export function show(opts: SnackbarIn): void {
  // Record to history (most-recent-first), cap at 100
  try {
    history.unshift({ ...opts });
    if (history.length > 100) history.length = 100;
  } catch {}
  if (showImpl) showImpl({ ...opts, closable: opts.closable ?? true });
  // Also write to console for easier debugging during batch/precompute operations
  try {
    const level = (opts.level || 'info');
    if (level === 'error') console.error('[Snackbar]', opts.message, opts.detail || '');
    else if (level === 'warn') console.warn('[Snackbar]', opts.message, opts.detail || '');
    else console.log('[Snackbar]', opts.message, opts.detail || '');
  } catch {}
}

export function getHistory(): SnackbarIn[] {
  return history.slice();
}

export function clearHistory(): void {
  history = [];
}


