import { writable } from 'svelte/store';

export interface Counts {
  inbox: number;
  unread: number;
  lastUpdated: number;
}

export const counts = writable<Counts>({
  inbox: 0,
  unread: 0,
  lastUpdated: 0
});

