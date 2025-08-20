import { writable } from 'svelte/store';
import type { AccountAuthMeta } from '$lib/types';

export const account = writable<AccountAuthMeta | null>(null);

