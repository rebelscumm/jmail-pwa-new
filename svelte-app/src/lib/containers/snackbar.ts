import type { SnackbarIn } from './Snackbar.svelte';

let showImpl: ((opts: SnackbarIn) => void) | null = null;

export function register(showFn: (opts: SnackbarIn) => void): void {
  showImpl = showFn;
}

export function show(opts: SnackbarIn): void {
  if (showImpl) showImpl(opts);
}


