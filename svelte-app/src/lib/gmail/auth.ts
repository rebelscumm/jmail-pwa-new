// Google Identity Services (GIS) Token Client auth implementation
// Browser-only; no secrets at rest.

import { writable } from 'svelte/store';
import { pushGmailDiag } from '$lib/gmail/diag';
import { confirmGooglePopup } from '$lib/gmail/preauth';
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
  'https://www.googleapis.com/auth/gmail.labels',
  // Include readonly explicitly to satisfy some providers/error heuristics
  'https://www.googleapis.com/auth/gmail.readonly'
].join(' ');

let tokenClient: google.accounts.oauth2.TokenClient | null = null;

// Lightweight diagnostics for auth initialization
let lastInitAt: string | undefined;
let lastInitOk: boolean | undefined;
let lastInitError: string | undefined;

// Serialize all token client requests to avoid callback clobbering and timeouts
let authLockActive = false;
const authLockWaiters: Array<() => void> = [];
async function withTokenClientLock<T>(fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
  const queuedAt = Date.now();
  if (authLockActive) {
    try { pushGmailDiag({ type: 'auth_lock_wait', queuedAt, queueLen: authLockWaiters.length + 1, ...(meta || {}) }); } catch (_) {}
    await new Promise<void>((resolve) => authLockWaiters.push(resolve));
  }
  authLockActive = true;
  try {
    try { pushGmailDiag({ type: 'auth_lock_acquired', waitedMs: Date.now() - queuedAt, ...(meta || {}) }); } catch (_) {}
    return await fn();
  } finally {
    authLockActive = false;
    try { pushGmailDiag({ type: 'auth_lock_released', durationMs: Date.now() - queuedAt, ...(meta || {}) }); } catch (_) {}
    // Wake all waiters so they contend again (cheap and simple fairness)
    while (authLockWaiters.length) {
      const next = authLockWaiters.shift();
      try { next && next(); } catch (_) {}
    }
  }
}

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
    // Attempt to initialize a client-side TokenClient when GIS exposes initTokenClient.
    // This enables interactive client-side sign-in flows in environments where
    // client-managed auth is desired. If initTokenClient is not available or
    // initialization fails, fall back to server-managed mode (tokenClient left null).
    try {
      if (typeof (window as any).google?.accounts?.oauth2?.initTokenClient === 'function') {
        try {
          tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: SCOPES,
            callback: () => {}
          }) as unknown as typeof tokenClient;
        } catch (_) {
          tokenClient = null as any;
        }
      } else {
        tokenClient = null as any;
      }
    } catch (_) {
      tokenClient = null as any;
    }
    authState.update((s) => ({ ...s, ready: true }));
    // No local token persistence in server-managed mode.
    lastInitOk = true;
    lastInitError = undefined;
    pushGmailDiag({ type: 'auth_init_success', clientIdPresent: !!clientId, scopes: SCOPES });
  } catch (e) {
    lastInitOk = false;
    lastInitError = e instanceof Error ? e.message : String(e);
    authState.update((s) => ({ ...s, ready: false }));
    pushGmailDiag({ type: 'auth_init_error', error: e instanceof Error ? e.message : String(e) });
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

export async function acquireTokenInteractive(prompt: 'none' | 'consent' | 'select_account' = 'consent', reason?: string): Promise<void> {
  if (!tokenClient) throw new Error('Auth not initialized');
  await withTokenClientLock(async () => {
    // Coalesce concurrent interactive requests: if a valid token exists now, skip
    const preState = getAuthState();
    if (preState.accessToken && preState.expiryMs && preState.expiryMs > Date.now()) {
      // Only skip if current token already has all required scopes when using consent flows.
      // If scopes are missing, proceed to prompt so we can grant them.
      try {
        const info = await fetchTokenInfo();
        const granted = typeof info?.scope === 'string' ? String(info.scope).split(/\s+/).filter(Boolean) : [];
        const requested = String(SCOPES).split(/\s+/).filter(Boolean);
        const missingScopes = requested.filter((s) => !granted.includes(s));
        if (missingScopes.length === 0 && prompt !== 'select_account') {
          pushGmailDiag({ type: 'auth_interactive_skip_valid' });
          return;
        }
      } catch (_) {
        // If token info check fails, fall through to allow prompt to fix potential auth issues
      }
    }
    let beforeInfo: any = undefined;
    try { beforeInfo = await fetchTokenInfo(); } catch (_) {}
    // Pre-auth explanation dialog with diagnostics and scope analysis
    try {
      const state = getAuthState();
      const granted = typeof beforeInfo?.scope === 'string' ? String(beforeInfo.scope).split(/\s+/).filter(Boolean) : [];
      const requested = String(SCOPES).split(/\s+/).filter(Boolean);
      const missingScopes = requested.filter((s) => !granted.includes(s));
      await confirmGooglePopup({
        flow: 'interactive',
        prompt,
        reason,
        requestedScopes: SCOPES,
        missingScopes,
        tokenPresent: !!state.accessToken,
        tokenExpired: typeof state.expiryMs === 'number' ? state.expiryMs <= Date.now() : undefined,
        diagnostics: { ...getAuthDiagnostics(), tokenInfo: beforeInfo }
      });
    } catch (_) {}
    pushGmailDiag({ type: 'auth_popup_before', flow: 'interactive', prompt, reason, requestedScopes: SCOPES, tokenInfo: beforeInfo });
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
    let afterInfo: any = undefined;
    try { afterInfo = await fetchTokenInfo(); } catch (_) {}
    pushGmailDiag({ type: 'auth_popup_after', flow: 'interactive', prompt, reason, tokenInfo: afterInfo, expiresIn: token.expires_in });
    try {
      // Persist token, expiry, and connection metadata for continuity and troubleshooting
      const { getDB } = await import('$lib/db/indexeddb');
      const db = await getDB();
      const prev = (await db.get('auth', 'me')) as AccountAuthMeta | undefined;
      const href = typeof window !== 'undefined' ? window.location.href : undefined;
      const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
      const nowMs = Date.now();
      const next: AccountAuthMeta = {
        ...(prev || { sub: 'me' }),
        sub: 'me',
        accessToken: token.access_token,
        tokenExpiry: expiryMs,
        lastConnectedAt: nowMs,
        lastConnectedOrigin: origin,
        lastConnectedUrl: href,
        firstConnectedAt: prev?.firstConnectedAt || nowMs,
        firstConnectedOrigin: prev?.firstConnectedOrigin || origin,
        firstConnectedUrl: prev?.firstConnectedUrl || href
      };
      await db.put('auth', next, 'me');
    } catch (_) {
      // non-fatal
    }
  }, { flow: 'interactive', reason });
}

// Request additional scopes (e.g., to upgrade from metadata-only to readonly/modify)
export async function acquireTokenForScopes(scopes: string, prompt: 'none' | 'consent' | 'select_account' = 'consent', reason?: string): Promise<boolean> {
  if (!tokenClient) throw new Error('Auth not initialized');
  return await withTokenClientLock(async () => {
    // Coalesce concurrent scope-upgrade requests: if already granted, skip
    const preState = getAuthState();
    if (preState.accessToken && preState.expiryMs && preState.expiryMs > Date.now()) {
      try {
        const info = await fetchTokenInfo();
        const granted = typeof info?.scope === 'string' ? String(info.scope).split(/\s+/).filter(Boolean) : [];
        const requested = String(scopes).split(/\s+/).filter(Boolean);
        const missingScopes = requested.filter((s) => !granted.includes(s));
        if (missingScopes.length === 0) {
          pushGmailDiag({ type: 'auth_scope_upgrade_skip_already_granted' });
          return true;
        }
      } catch (_) {}
    }
    let beforeInfo: any = undefined;
    try { beforeInfo = await fetchTokenInfo(); } catch (_) {}
    // Pre-auth explanation dialog with diagnostics and scope analysis
    try {
      const state = getAuthState();
      const granted = typeof beforeInfo?.scope === 'string' ? String(beforeInfo.scope).split(/\s+/).filter(Boolean) : [];
      const requested = String(scopes).split(/\s+/).filter(Boolean);
      const missingScopes = requested.filter((s) => !granted.includes(s));
      await confirmGooglePopup({
        flow: 'scope_upgrade',
        prompt,
        reason,
        requestedScopes: scopes,
        missingScopes,
        tokenPresent: !!state.accessToken,
        tokenExpired: typeof state.expiryMs === 'number' ? state.expiryMs <= Date.now() : undefined,
        diagnostics: { ...getAuthDiagnostics(), tokenInfo: beforeInfo }
      });
    } catch (_) {}
    pushGmailDiag({ type: 'auth_popup_before', flow: 'scope_upgrade', prompt, reason, requestedScopes: scopes, tokenInfo: beforeInfo });
    const token = await withTimeout(
      new Promise<TokenResponse>((resolve, reject) => {
        tokenClient!.callback = (res) => {
          if ('error' in res) reject(new Error(res.error as string));
          else resolve(res as unknown as TokenResponse);
        };
        tokenClient!.requestAccessToken({ scope: scopes, prompt });
      }),
      20000,
      'scope_upgrade'
    ).catch(() => null);
    if (!token) return false;
    const now = Date.now();
    const expiryMs = now + (token.expires_in - 60) * 1000;
    authState.update((s) => ({ ...s, accessToken: token.access_token, expiryMs }));
    let afterInfo: any = undefined;
    try { afterInfo = await fetchTokenInfo(); } catch (_) {}
    pushGmailDiag({ type: 'auth_popup_after', flow: 'scope_upgrade', prompt, reason, tokenInfo: afterInfo, expiresIn: token.expires_in });
    try {
      const { getDB } = await import('$lib/db/indexeddb');
      const db = await getDB();
      const prev = (await db.get('auth', 'me')) as AccountAuthMeta | undefined;
      const href = typeof window !== 'undefined' ? window.location.href : undefined;
      const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
      const nowMs = Date.now();
      const next: AccountAuthMeta = {
        ...(prev || { sub: 'me' }),
        sub: 'me',
        accessToken: token.access_token,
        tokenExpiry: expiryMs,
        lastConnectedAt: nowMs,
        lastConnectedOrigin: origin,
        lastConnectedUrl: href,
        firstConnectedAt: prev?.firstConnectedAt || nowMs,
        firstConnectedOrigin: prev?.firstConnectedOrigin || origin,
        firstConnectedUrl: prev?.firstConnectedUrl || href
      };
      await db.put('auth', next, 'me');
    } catch (_) {}
    return true;
  }, { flow: 'scope_upgrade', reason, requestedScopes: scopes });
}

export async function ensureValidToken(): Promise<string> {
  const state = getAuthState();
  if (state.accessToken && state.expiryMs && state.expiryMs > Date.now()) return state.accessToken;
  if (!tokenClient) {
    // Attempt late init using resolved client ID to avoid "Auth not initialized" in lazy routes
    try {
      const cid = resolveGoogleClientId();
      if (cid) await initAuth(cid);
    } catch (_) {}
    if (!tokenClient) throw new Error('Auth not initialized');
  }
  pushGmailDiag({ type: 'auth_silent_token_attempt' });
  const accessToken = await withTokenClientLock(async () => {
    let token: TokenResponse;
    try {
      token = await withTimeout(
        new Promise<TokenResponse>((resolve, reject) => {
          tokenClient!.callback = (res) => {
            if ('error' in res) reject(new Error(res.error as string));
            else resolve(res as unknown as TokenResponse);
          };
          // Try silent token acquisition; avoids popups on refresh. If it fails,
          // callers should handle by prompting interactively.
          tokenClient!.requestAccessToken({ prompt: 'none' });
        }),
        20000,
        'silent_token'
      );
    } catch (e) {
      pushGmailDiag({ type: 'auth_silent_token_error', error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    const now = Date.now();
    const expiryMs = now + (token.expires_in - 60) * 1000;
    authState.update((s) => ({ ...s, accessToken: token.access_token, expiryMs }));
    pushGmailDiag({ type: 'auth_silent_token_success', expiresIn: token.expires_in });
    try {
      const { getDB } = await import('$lib/db/indexeddb');
      const db = await getDB();
      const prev = (await db.get('auth', 'me')) as AccountAuthMeta | undefined;
      const href = typeof window !== 'undefined' ? window.location.href : undefined;
      const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
      const nowMs = Date.now();
      const next: AccountAuthMeta = {
        ...(prev || { sub: 'me' }),
        sub: 'me',
        accessToken: token.access_token,
        tokenExpiry: expiryMs,
        lastConnectedAt: nowMs,
        lastConnectedOrigin: origin,
        lastConnectedUrl: href,
        firstConnectedAt: prev?.firstConnectedAt || nowMs,
        firstConnectedOrigin: prev?.firstConnectedOrigin || origin,
        firstConnectedUrl: prev?.firstConnectedUrl || href
      };
      await db.put('auth', next, 'me');
    } catch (_) {}
    return token.access_token;
  }, { flow: 'silent' });
  return accessToken;
}

// Force a silent token refresh regardless of current token validity
export async function refreshTokenSilent(reason?: string): Promise<string> {
  if (!tokenClient) {
    // Attempt late init using resolved client ID
    try {
      const cid = resolveGoogleClientId();
      if (cid) await initAuth(cid);
    } catch (_) {}
    if (!tokenClient) throw new Error('Auth not initialized');
  }
  pushGmailDiag({ type: 'auth_forced_silent_refresh_attempt', reason });
  const token = await withTokenClientLock(async () => {
    const t = await withTimeout(
      new Promise<TokenResponse>((resolve, reject) => {
        tokenClient!.callback = (res) => {
          if ('error' in res) reject(new Error(res.error as string));
          else resolve(res as unknown as TokenResponse);
        };
        tokenClient!.requestAccessToken({ prompt: 'none' });
      }),
      20000,
      'forced_silent_token'
    );
    const now = Date.now();
    const expiryMs = now + (t.expires_in - 60) * 1000;
    authState.update((s) => ({ ...s, accessToken: t.access_token, expiryMs }));
    try {
      const { getDB } = await import('$lib/db/indexeddb');
      const db = await getDB();
      const account = { sub: 'me', tokenExpiry: expiryMs, accessToken: t.access_token } satisfies AccountAuthMeta;
      await db.put('auth', account, account.sub);
    } catch (_) {}
    pushGmailDiag({ type: 'auth_forced_silent_refresh_success', expiresIn: token?.expires_in });
    return t;
  }, { flow: 'silent', reason: reason || 'api_401_retry' });
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
    const now = Date.now();
    const diagnostics: Record<string, unknown> = {
      at: new Date().toISOString(),
      ready: getAuthState().ready,
      tokenClientReady: !!tokenClient,
      gisScriptPresent: typeof document !== 'undefined' ? !!document.getElementById('gis-script') : undefined,
      hasWindowGoogle: typeof window !== 'undefined' ? !!(window as any).google : undefined,
      hasOauth2: typeof window !== 'undefined' ? !!(window as any).google?.accounts?.oauth2 : undefined,
      lastInitAt,
      lastInitOk,
      lastInitError,
      // Enhanced network and environment diagnostics
      network: {
        online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
        connection: typeof navigator !== 'undefined' ? (navigator as any).connection?.effectiveType : undefined,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
        language: typeof navigator !== 'undefined' ? navigator.language : undefined
      },
      // Script loading diagnostics
      scriptLoading: {
        gisScriptElement: typeof document !== 'undefined' ? {
          id: document.getElementById('gis-script')?.id,
          src: document.getElementById('gis-script')?.getAttribute('src'),
          async: (document.getElementById('gis-script') as HTMLScriptElement)?.async,
          defer: (document.getElementById('gis-script') as HTMLScriptElement)?.defer,
          parentNode: !!document.getElementById('gis-script')?.parentNode
        } : undefined,
        headElement: typeof document !== 'undefined' ? !!document.head : undefined,
        bodyElement: typeof document !== 'undefined' ? !!document.body : undefined
      },
      // Window object diagnostics
      window: {
        location: typeof window !== 'undefined' ? {
          href: window.location?.href,
          origin: window.location?.origin,
          protocol: window.location?.protocol,
          host: window.location?.host,
          hostname: window.location?.hostname,
          port: window.location?.port,
          pathname: window.location?.pathname,
          search: window.location?.search
        } : undefined,
        innerWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
        innerHeight: typeof window !== 'undefined' ? window.innerHeight : undefined,
        screen: typeof window !== 'undefined' ? {
          width: window.screen?.width,
          height: window.screen?.height,
          availWidth: window.screen?.availWidth,
          availHeight: window.screen?.availHeight
        } : undefined
      },
      // Timing information
      timing: {
        currentTime: now,
        lastInitTime: lastInitAt ? new Date(lastInitAt).getTime() : undefined,
        timeSinceLastInit: lastInitAt ? now - new Date(lastInitAt).getTime() : undefined
      },
      // Local storage diagnostics
      storage: {
        localStorageAvailable: typeof localStorage !== 'undefined',
        localStorageKeys: typeof localStorage !== 'undefined' ? Object.keys(localStorage) : undefined,
        sessionStorageAvailable: typeof sessionStorage !== 'undefined',
        sessionStorageKeys: typeof sessionStorage !== 'undefined' ? Object.keys(sessionStorage) : undefined
      },
      // Cookie diagnostics
      cookies: {
        cookieEnabled: typeof navigator !== 'undefined' ? navigator.cookieEnabled : undefined,
        cookieCount: typeof document !== 'undefined' ? document.cookie.split(';').length : undefined
      },
      // Browser diagnostics
      browser: captureBrowserDiagnostics()
    };
    
    return diagnostics;
  } catch (_) {
    return {};
  }
}

// Try to resolve Google Client ID from multiple sources to ease configuration in static hosts
export function resolveGoogleClientId(): string | undefined {
  try {
    const envId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
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
    // Diagnostics-only: avoid triggering token flows; use current state token if available
    const state = getAuthState();
    const token = state.accessToken;
    if (!token) return undefined;
    const u = new URL('https://oauth2.googleapis.com/tokeninfo');
    u.searchParams.set('access_token', token);
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(u.toString(), { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return undefined;
    const info = await res.json();
    return { scope: info.scope as string | undefined, expires_in: info.expires_in as string | undefined, aud: info.aud as string | undefined };
  } catch (_) {
    return undefined;
  }
}

// Sign out flow: revoke current token (best-effort), clear local state and auth cache
export async function signOut(): Promise<void> {
  try {
    const state = getAuthState();
    const token = state.accessToken;
    if (typeof window !== 'undefined' && (window as any)?.google?.accounts?.oauth2?.revoke && token) {
      try {
        await new Promise<void>((resolve) => {
          (window as any).google.accounts.oauth2.revoke(token, () => resolve());
        });
        pushGmailDiag({ type: 'auth_revoked' });
      } catch (_) {}
    }
    authState.update((s) => ({ ...s, accessToken: undefined, expiryMs: undefined, account: undefined }));
    try {
      const { getDB } = await import('$lib/db/indexeddb');
      const db = await getDB();
      // Remove persisted token, but keep any other metadata if present
      await db.put('auth', { sub: 'me' } as AccountAuthMeta, 'me');
    } catch (_) {}
  } catch (_) {}
}

// Capture browser console errors and network information
function captureBrowserDiagnostics(): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = {};
  
  try {
    // Capture performance information
    if (typeof performance !== 'undefined') {
      try {
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        if (navigation) {
          diagnostics.performance = {
            domContentLoaded: navigation.domContentLoadedEventEnd - navigation.domContentLoadedEventStart,
            loadComplete: navigation.loadEventEnd - navigation.loadEventStart,
            domInteractive: navigation.domInteractive,
            firstPaint: performance.getEntriesByName('first-paint')[0]?.startTime,
            firstContentfulPaint: performance.getEntriesByName('first-contentful-paint')[0]?.startTime
          };
        }
      } catch (_) {}
    }
    
    // Capture resource loading information
    if (typeof performance !== 'undefined') {
      try {
        const resources = performance.getEntriesByType('resource');
        const googleResources = resources.filter((r: any) => 
          r.name.includes('google') || r.name.includes('accounts.google.com') || r.name.includes('gsi')
        );
        
        diagnostics.resourceLoading = {
          totalResources: resources.length,
          googleResources: googleResources.length,
          googleResourceDetails: googleResources.map((r: any) => ({
            name: r.name,
            duration: r.duration,
            transferSize: r.transferSize,
            initiatorType: r.initiatorType,
            failed: r.duration === 0
          }))
        };
      } catch (_) {}
    }
    
  } catch (e) {
    diagnostics.browserDiagnosticsError = e instanceof Error ? e.message : String(e);
  }
  
  return diagnostics;
}

// Test network connectivity to Google's servers

