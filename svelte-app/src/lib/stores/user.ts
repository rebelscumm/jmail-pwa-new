import { writable } from 'svelte/store';
import { getProfile } from '$lib/gmail/api';

export type UserProfile = {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
};

export const userProfile = writable<UserProfile | null>(null);
export const userEmail = writable<string>('');

// Fetch and cache the user profile
export async function loadUserProfile(): Promise<UserProfile | null> {
  try {
    const profile = await getProfile();
    userProfile.set(profile);
    userEmail.set(profile.emailAddress?.toLowerCase() || '');
    return profile;
  } catch (e) {
    console.warn('Could not fetch user profile:', e);
    userProfile.set(null);
    userEmail.set('');
    return null;
  }
}

// Initialize user profile when the module loads
if (typeof window !== 'undefined') {
  // Only load in browser environment
  loadUserProfile().catch(() => {
    // Silently handle errors during initialization
  });
}
