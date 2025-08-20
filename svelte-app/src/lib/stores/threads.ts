import { writable } from 'svelte/store';
import type { GmailThread, GmailMessage } from '$lib/types';

export const threads = writable<GmailThread[]>([]);
export const messages = writable<Record<string, GmailMessage>>({});

