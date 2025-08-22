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

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels'
].join(' ');

let tokenClient: google.accounts.oauth2.TokenClient | null = null;

// Lightweight diagnostics for auth initialization
let lastInitAt: string | undefined;
let lastInitOk: boolean | undefined;
let lastInitError: string | undefined;

declare global {
  interface Window {
    google: typeof google;
  }
}

export async function initAuth(clientId: string) {
  lastInitAt = new Date().toISOString();
  try {
    // Auto-resolve client ID from multiple sources if missing
    if (!clientId || typeof clientId !== 'string' || clientId.trim().length === 0) {
      const resolved = resolveGoogleClientId();
      if (resolved && resolved.trim().length > 0) clientId = resolved;
      if (!clientId || String(clientId).trim().length === 0) {
        throw new Error('Missing Google client ID (VITE_GOOGLE_CLIENT_ID)');
      }
    }
    await loadGis();
    if (!window?.google?.accounts?.oauth2) {
      throw new Error('GIS loaded but window.google.accounts.oauth2 is unavailable');
    }
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      prompt: '',
      callback: () => {}
    });
    authState.update((s) => ({ ...s, ready: true }));
    lastInitOk = true;
    lastInitError = undefined;
  } catch (e) {
    lastInitOk = false;
    lastInitError = e instanceof Error ? e.message : String(e);
    authState.update((s) => ({ ...s, ready: false }));
    throw e;
  }
}

// Utility to add timeouts to async flows that can stall in some browsers/ad-blockers
function withTimeout<T>(promise: Promise<T>, ms: number, label = 'timeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const id = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Operation ${label} exceeded ${ms}ms`));
    }, ms);
    promise
      .then((v) => {
        if (settled) return;
        settled = true;
        clearTimeout(id);
        resolve(v);
      })
      .catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(id);
        reject(e);
      });
  });
}

export async function acquireTokenInteractive(prompt: 'none' | 'consent' | 'select_account' = 'consent'): Promise<void> {
  if (!tokenClient) throw new Error('Auth not initialized');
  const token = await withTimeout(
    new Promise<TokenResponse>((resolve, reject) => {
      tokenClient!.callback = (res) => {
        if ('error' in res) reject(new Error(res.error as string));
        else resolve(res as unknown as TokenResponse);
      };
      // Default to 'consent' to ensure full scopes are granted on first login
      tokenClient!.requestAccessToken({ prompt });
    }),
    30000,
    'interactive_token'
  );
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

// Request additional scopes (e.g., to upgrade from metadata-only to readonly/modify)
export async function acquireTokenForScopes(scopes: string, prompt: 'none' | 'consent' | 'select_account' = 'consent'): Promise<boolean> {
  if (!tokenClient) throw new Error('Auth not initialized');
  const token = await withTimeout(
    new Promise<TokenResponse>((resolve, reject) => {
      tokenClient!.callback = (res) => {
        if ('error' in res) reject(new Error(res.error as string));
        else resolve(res as unknown as TokenResponse);
      };
      // @ts-expect-error: scope is allowed on OverridableTokenClientConfig
      tokenClient!.requestAccessToken({ scope: scopes, prompt });
    }),
    15000,
    'scope_upgrade'
  ).catch(() => null);
  if (!token) return false;
  const now = Date.now();
  const expiryMs = now + (token.expires_in - 60) * 1000;
  authState.update((s) => ({ ...s, accessToken: token.access_token, expiryMs }));
  try {
    const { getDB } = await import('$lib/db/indexeddb');
    const db = await getDB();
    const account = { sub: 'me', tokenExpiry: expiryMs } satisfies AccountAuthMeta;
    await db.put('auth', account, account.sub);
  } catch (_) {}
  return true;
}

export async function ensureValidToken(): Promise<string> {
  const state = getAuthState();
  if (state.accessToken && state.expiryMs && state.expiryMs > Date.now()) return state.accessToken;
  if (!tokenClient) throw new Error('Auth not initialized');
  const token = await withTimeout(
    new Promise<TokenResponse>((resolve, reject) => {
      tokenClient!.callback = (res) => {
        if ('error' in res) reject(new Error(res.error as string));
        else resolve(res as unknown as TokenResponse);
      };
      // Try silent token acquisition; avoids popups on refresh. If it fails,
      // callers should handle by prompting interactively.
      tokenClient!.requestAccessToken({ prompt: 'none' });
    }),
    8000,
    'silent_token'
  );
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

// Export a snapshot of current auth diagnostics for copy-to-clipboard flows
export function getAuthDiagnostics(): Record<string, unknown> {
  try {
    return {
      at: new Date().toISOString(),
      ready: getAuthState().ready,
      tokenClientReady: !!tokenClient,
      gisScriptPresent: typeof document !== 'undefined' ? !!document.getElementById('gis-script') : undefined,
      hasWindowGoogle: typeof window !== 'undefined' ? !!(window as any).google : undefined,
      hasOauth2: typeof window !== 'undefined' ? !!(window as any).google?.accounts?.oauth2 : undefined,
      lastInitAt,
      lastInitOk,
      lastInitError
    };
  } catch (_) {
    return {};
  }
}

// Try to resolve Google Client ID from multiple sources to ease configuration in static hosts
export function resolveGoogleClientId(): string | undefined {
  try {
    const envId = (import.meta as any)?.env?.VITE_GOOGLE_CLIENT_ID as string | undefined;
    if (envId && envId.trim()) return envId.trim();
  } catch (_) {}
  try {
    const lsId = typeof localStorage !== 'undefined' ? (localStorage.getItem('GOOGLE_CLIENT_ID') || localStorage.getItem('VITE_GOOGLE_CLIENT_ID')) : null;
    if (lsId && lsId.trim()) return lsId.trim();
  } catch (_) {}
  try {
    const url = typeof window !== 'undefined' ? new URL(window.location.href) : undefined;
    const qp = url?.searchParams.get('client_id');
    if (qp && qp.trim()) return qp.trim();
  } catch (_) {}
  try {
    const winId = typeof window !== 'undefined' ? ((window as any).__ENV__?.GOOGLE_CLIENT_ID || (window as any).__env?.GOOGLE_CLIENT_ID) : undefined;
    if (winId && String(winId).trim()) return String(winId).trim();
  } catch (_) {}
  // Hardcoded fallback for this app (safe to embed; client IDs are not secrets)
  return '49551890193-e6n262ccj95229ftp2dh6k9s2boo1kip.apps.googleusercontent.com';
}

// Fetch current token's granted scopes (diagnostics only)
export async function fetchTokenInfo(): Promise<{ scope?: string; expires_in?: string; aud?: string } | undefined> {
  try {
    const token = await ensureValidToken();
    const u = new URL('https://oauth2.googleapis.com/tokeninfo');
    u.searchParams.set('access_token', token);
    const res = await fetch(u.toString());
    if (!res.ok) return undefined;
    const info = await res.json();
    return { scope: info.scope as string | undefined, expires_in: info.expires_in as string | undefined, aud: info.aud as string | undefined };
  } catch (_) {
    return undefined;
  }
}

