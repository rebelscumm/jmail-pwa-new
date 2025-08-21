// Google Identity Services (GIS) Token Client auth implementation
// Browser-only; no secrets at rest.

import { writable } from 'svelte/store';
import type { AccountAuthMeta } from '$lib/types';

type TokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

export type AuthState = {
  accessToken?: string;
  expiryMs?: number;
  account?: AccountAuthMeta;
  ready: boolean;
};

export const authState = writable<AuthState>({ ready: false });

// Load GIS script dynamically
function loadGis(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById('gis-script')) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.id = 'gis-script';
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load GIS'));
    document.head.appendChild(script);
  });
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.metadata'
].join(' ');

let tokenClient: google.accounts.oauth2.TokenClient | null = null;

declare global {
  interface Window {
    google: typeof google;
  }
}

export async function initAuth(clientId: string) {
  await loadGis();
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    prompt: '',
    callback: () => {}
  });
  authState.update((s) => ({ ...s, ready: true }));
}

export async function acquireTokenInteractive(): Promise<void> {
  if (!tokenClient) throw new Error('Auth not initialized');
  const token = await new Promise<TokenResponse>((resolve, reject) => {
    tokenClient!.callback = (res) => {
      if ('error' in res) reject(new Error(res.error as string));
      else resolve(res as unknown as TokenResponse);
    };
    tokenClient!.requestAccessToken({ prompt: 'consent' });
  });
  const now = Date.now();
  const expiryMs = now + (token.expires_in - 60) * 1000; // safety margin
  authState.update((s) => ({ ...s, accessToken: token.access_token, expiryMs }));
  try {
    // Persist minimal token metadata for session continuity without storing secrets
    const { getDB } = await import('$lib/db/indexeddb');
    const db = await getDB();
    const account = { sub: 'me', tokenExpiry: expiryMs } satisfies AccountAuthMeta;
    await db.put('auth', account, account.sub);
  } catch (_) {
    // non-fatal
  }
}

export async function ensureValidToken(): Promise<string> {
  const state = getAuthState();
  if (state.accessToken && state.expiryMs && state.expiryMs > Date.now()) return state.accessToken;
  if (!tokenClient) throw new Error('Auth not initialized');
  const token = await new Promise<TokenResponse>((resolve, reject) => {
    tokenClient!.callback = (res) => {
      if ('error' in res) reject(new Error(res.error as string));
      else resolve(res as unknown as TokenResponse);
    };
    tokenClient!.requestAccessToken({ prompt: '' });
  });
  const now = Date.now();
  const expiryMs = now + (token.expires_in - 60) * 1000;
  authState.update((s) => ({ ...s, accessToken: token.access_token, expiryMs }));
  try {
    const { getDB } = await import('$lib/db/indexeddb');
    const db = await getDB();
    const account = { sub: 'me', tokenExpiry: expiryMs } satisfies AccountAuthMeta;
    await db.put('auth', account, account.sub);
  } catch (_) {}
  return token.access_token;
}

export function setAccount(meta: AccountAuthMeta) {
  authState.update((s) => ({ ...s, account: meta }));
}

export function getAuthState(): AuthState {
  let value: AuthState = { ready: false };
  authState.subscribe((v) => (value = v))();
  return value;
}

