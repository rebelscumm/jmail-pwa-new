import { writable } from 'svelte/store';
import type { QueuedOp } from '$lib/types';

export const queue = writable<QueuedOp[]>([]);

