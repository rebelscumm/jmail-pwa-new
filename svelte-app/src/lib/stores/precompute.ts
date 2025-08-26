import { writable } from 'svelte/store';

export interface PrecomputeStatus {
  isRunning: boolean;
  processed: number;
  total: number;
  startTime: number | null;
  currentOperation: string | null;
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
        currentOperation: 'Starting precompute...'
      });
    },
    updateProgress: (processed: number, operation?: string) => {
      update(status => ({
        ...status,
        processed,
        currentOperation: operation || status.currentOperation
      }));
    },
    complete: () => {
      set({
        isRunning: false,
        processed: 0,
        total: 0,
        startTime: null,
        currentOperation: null
      });
    },
    reset: () => {
      set({
        isRunning: false,
        processed: 0,
        total: 0,
        startTime: null,
        currentOperation: null
      });
    }
  };
}

export const precomputeStatus = createPrecomputeStore();
