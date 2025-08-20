import { writable } from 'svelte/store';
import type { GmailLabel } from '$lib/types';

export const labels = writable<GmailLabel[]>([]);

