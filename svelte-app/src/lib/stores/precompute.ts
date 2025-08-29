import { writable } from 'svelte/store';

export interface PrecomputeStatus {
  isRunning: boolean;
  processed: number;
  total: number;
  startTime: number | null;
  currentOperation: string | null;
  // internal counters surfaced to UI
  _errors?: number;
  _warns?: number;
  // last processed count from final result (optional)
  _lastProcessed?: number;
}

function createPrecomputeStore() {
  const { subscribe, set, update } = writable<PrecomputeStatus>({
    isRunning: false,
    processed: 0,
    total: 0,
    startTime: null,
    currentOperation: null
  });

  return {
    subscribe,
    start: (total: number) => {
      set({
        isRunning: true,
        processed: 0,
        total,
        startTime: Date.now(),
        currentOperation: 'Starting precompute...',
        _errors: 0,
        _warns: 0
      });
    },
    updateProgress: (processed: number, operation?: string) => {
      update(status => ({
        ...status,
        processed,
        currentOperation: operation || status.currentOperation
      }));
    },
    // New: increment counters for warnings and errors
    incrementError: (n = 1) => update(s => ({ ...s, _errors: (s as any)._errors ? (s as any)._errors + n : n })),
    incrementWarn: (n = 1) => update(s => ({ ...s, _warns: (s as any)._warns ? (s as any)._warns + n : n })),
    getCounts: () => {
      let counts: { errors: number; warns: number } = { errors: 0, warns: 0 };
      try {
        // read current value synchronously
        let v: PrecomputeStatus;
        const unsub = subscribe(val => { v = val; });
        unsub();
        counts.errors = (v as any)._errors || 0;
        counts.warns = (v as any)._warns || 0;
      } catch (_) {}
      return counts;
    },
    complete: (counts?: { errors?: number; warns?: number; processed?: number; total?: number }) => {
      // Preserve provided counters or capture current counters before resetting running state
      let errors = 0;
      let warns = 0;
      let lastProcessed: number | undefined = undefined;
      let lastTotal: number | undefined = undefined;
      try {
        if (counts) {
          errors = counts.errors || 0;
          warns = counts.warns || 0;
          lastProcessed = typeof counts.processed === 'number' ? counts.processed : undefined;
          lastTotal = typeof counts.total === 'number' ? counts.total : undefined;
        } else {
          let v: PrecomputeStatus;
          const unsub = subscribe(val => { v = val; });
          unsub();
          errors = (v as any)._errors || 0;
          warns = (v as any)._warns || 0;
        }
      } catch (_) {}
      set({
        isRunning: false,
        processed: 0,
        total: 0,
        startTime: null,
        currentOperation: null,
        _errors: errors,
        _warns: warns,
        _lastProcessed: lastProcessed !== undefined ? lastProcessed : (undefined as any)
      });
    },
    reset: () => {
      set({
        isRunning: false,
        processed: 0,
        total: 0,
        startTime: null,
        currentOperation: null,
        _errors: 0,
        _warns: 0
      });
    }
  };
}

export const precomputeStatus = createPrecomputeStore();
