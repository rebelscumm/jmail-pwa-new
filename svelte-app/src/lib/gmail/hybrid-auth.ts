// Hybrid Authentication System
// Combines server-side refresh tokens (long-lasting) with client-side GIS (immediate access)
// This provides the best of both worlds: persistence and user experience

import { writable } from 'svelte/store';
import { pushGmailDiag } from '$lib/gmail/diag';
import type { AccountAuthMeta } from '$lib/types';

export type HybridAuthState = {
  ready: boolean;
  serverSession?: {
    authenticated: boolean;
    email?: string;
    sub?: string;
    scope?: string;
    expiresAt?: number;
  };
  clientToken?: {
    access_token: string;
    expires_in: number;
    expiryMs: number;
    scope?: string;
  };
  preferredMode: 'server' | 'client' | 'auto';
  lastRefresh?: number;
};

export const hybridAuthState = writable<HybridAuthState>({
  ready: false,
  preferredMode: 'auto'
});

// Configuration
const SERVER_BASE_URL = typeof window !== 'undefined' ? 
  (window as any).__ENV__?.APP_BASE_URL || 
  import.meta.env.VITE_APP_BASE_URL || 
  window.location.origin : '';

const GOOGLE_CLIENT_ID = typeof window !== 'undefined' ?
  (window as any).__ENV__?.GOOGLE_CLIENT_ID ||
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  '49551890193-e6n262ccj95229ftp2dh6k9s2boo1kip.apps.googleusercontent.com' : '';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.readonly'
].join(' ');

// Initialize the hybrid authentication system
export async function initHybridAuth(): Promise<void> {
  pushGmailDiag({ type: 'hybrid_auth_init_start' });

  try {
    // Step 1: Check server session
    const serverSession = await checkServerSession();
    
    // Step 2: Initialize client-side GIS (non-blocking)
    const clientReady = await initializeGIS().catch(() => false);

    // Update state
    hybridAuthState.update(state => ({
      ...state,
      ready: true,
      serverSession,
      preferredMode: serverSession.authenticated ? 'server' : 'client'
    }));

    pushGmailDiag({ 
      type: 'hybrid_auth_init_complete', 
      serverAuthenticated: serverSession.authenticated,
      clientReady,
      preferredMode: serverSession.authenticated ? 'server' : 'client'
    });

  } catch (error) {
    pushGmailDiag({ 
      type: 'hybrid_auth_init_error', 
      error: error instanceof Error ? error.message : String(error) 
    });
    
    // Set ready to true even on error so UI can handle the error state
    hybridAuthState.update(state => ({ ...state, ready: true }));
    throw error;
  }
}

// Check if we have a valid server session
async function checkServerSession(): Promise<HybridAuthState['serverSession']> {
  try {
    const response = await fetch(`${SERVER_BASE_URL}/api/google-me`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      const data = await response.json();
      pushGmailDiag({ type: 'server_session_valid', email: data.email });
      
      return {
        authenticated: true,
        email: data.email,
        sub: data.sub,
        scope: data.scope,
        expiresAt: data.exp ? data.exp * 1000 : undefined
      };
    } else {
      pushGmailDiag({ type: 'server_session_invalid', status: response.status });
      return { authenticated: false };
    }
  } catch (error) {
    pushGmailDiag({ 
      type: 'server_session_check_error', 
      error: error instanceof Error ? error.message : String(error) 
    });
    return { authenticated: false };
  }
}

// Initialize Google Identity Services for client-side auth
async function initializeGIS(): Promise<boolean> {
  try {
    // Load GIS script if not already loaded
    if (!document.getElementById('gis-script')) {
      await new Promise<void>((resolve, reject) => {
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

    // Wait for Google APIs to be available
    let retries = 0;
    while (!(window as any).google?.accounts?.oauth2 && retries < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      retries++;
    }

    if (!(window as any).google?.accounts?.oauth2) {
      throw new Error('Google APIs not available after loading');
    }

    pushGmailDiag({ type: 'gis_initialized' });
    return true;
  } catch (error) {
    pushGmailDiag({ 
      type: 'gis_init_error', 
      error: error instanceof Error ? error.message : String(error) 
    });
    return false;
  }
}

// Get a valid access token using the hybrid approach
export async function getValidAccessToken(): Promise<string> {
  const state = await new Promise<HybridAuthState>(resolve => {
    hybridAuthState.subscribe(s => resolve(s))();
  });

  if (!state.ready) {
    throw new Error('Hybrid auth not initialized');
  }

  // Strategy 1: Try server-side first if we have a session
  if (state.serverSession?.authenticated) {
    try {
      const token = await getServerAccessToken();
      if (token) {
        pushGmailDiag({ type: 'token_acquired_server' });
        return token;
      }
    } catch (error) {
      pushGmailDiag({ 
        type: 'server_token_failed', 
        error: error instanceof Error ? error.message : String(error) 
      });
      // Continue to client-side fallback
    }
  }

  // Strategy 2: Fall back to client-side GIS
  try {
    const token = await getClientAccessToken();
    pushGmailDiag({ type: 'token_acquired_client' });
    return token;
  } catch (error) {
    pushGmailDiag({ 
      type: 'client_token_failed', 
      error: error instanceof Error ? error.message : String(error) 
    });
    throw new Error('Failed to acquire access token from both server and client');
  }
}

// Get access token from server (uses refresh token automatically)
async function getServerAccessToken(): Promise<string | null> {
  try {
    // First try to refresh the token
    const refreshResponse = await fetch(`${SERVER_BASE_URL}/api/google-refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!refreshResponse.ok) {
      throw new Error(`Token refresh failed: ${refreshResponse.status}`);
    }

    // Now make a test API call to get the actual token (indirectly)
    // Since we can't directly access the server's access token for security,
    // we'll use the server's Gmail proxy which handles the token internally
    const testResponse = await fetch(`${SERVER_BASE_URL}/api/gmail/profile`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });

    if (testResponse.ok) {
      // Server has a valid token - return a placeholder since we use server APIs
      hybridAuthState.update(state => ({
        ...state,
        lastRefresh: Date.now()
      }));
      return 'server-managed-token';
    }

    return null;
  } catch (error) {
    pushGmailDiag({ 
      type: 'server_token_error', 
      error: error instanceof Error ? error.message : String(error) 
    });
    return null;
  }
}

// Get access token from client-side GIS
async function getClientAccessToken(): Promise<string> {
  if (!(window as any).google?.accounts?.oauth2) {
    throw new Error('Google Identity Services not available');
  }

  // Check if we have a valid cached client token
  const state = await new Promise<HybridAuthState>(resolve => {
    hybridAuthState.subscribe(s => resolve(s))();
  });

  if (state.clientToken && state.clientToken.expiryMs > Date.now()) {
    return state.clientToken.access_token;
  }

  // Initialize token client
  const tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GMAIL_SCOPES,
    callback: () => {}
  });

  // Try silent token acquisition first
  try {
    const token = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Silent token timeout')), 15000);
      tokenClient.callback = (response: any) => {
        clearTimeout(timeout);
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      };
      tokenClient.requestAccessToken({ prompt: 'none' });
    });

    const clientToken = {
      access_token: token.access_token,
      expires_in: token.expires_in,
      expiryMs: Date.now() + (token.expires_in - 60) * 1000, // 60s safety margin
      scope: token.scope
    };

    hybridAuthState.update(state => ({ ...state, clientToken }));
    return token.access_token;

  } catch (error) {
    // Silent acquisition failed, need interactive auth
    pushGmailDiag({ 
      type: 'client_silent_failed', 
      error: error instanceof Error ? error.message : String(error) 
    });
    throw new Error('Interactive authentication required');
  }
}

// Initiate interactive authentication
export async function initiateInteractiveAuth(mode: 'server' | 'client' = 'server'): Promise<void> {
  pushGmailDiag({ type: 'interactive_auth_start', mode });

  if (mode === 'server') {
    // Redirect to server OAuth flow
    const returnUrl = encodeURIComponent(window.location.href);
    const loginUrl = `${SERVER_BASE_URL}/api/google-login?return_to=${returnUrl}`;
    
    pushGmailDiag({ type: 'redirecting_to_server_auth', loginUrl });
    window.location.href = loginUrl;
    return;
  }

  // Client-side interactive auth
  if (!(window as any).google?.accounts?.oauth2) {
    throw new Error('Google Identity Services not available');
  }

  const tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GMAIL_SCOPES,
    callback: () => {}
  });

  try {
    const token = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Interactive auth timeout')), 60000);
      tokenClient.callback = (response: any) => {
        clearTimeout(timeout);
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      };
      tokenClient.requestAccessToken({ prompt: 'consent' });
    });

    const clientToken = {
      access_token: token.access_token,
      expires_in: token.expires_in,
      expiryMs: Date.now() + (token.expires_in - 60) * 1000,
      scope: token.scope
    };

    hybridAuthState.update(state => ({ 
      ...state, 
      clientToken,
      preferredMode: 'client'
    }));

    pushGmailDiag({ type: 'client_interactive_success', scope: token.scope });

  } catch (error) {
    pushGmailDiag({ 
      type: 'client_interactive_error', 
      error: error instanceof Error ? error.message : String(error) 
    });
    throw error;
  }
}

// Make Gmail API call using the hybrid approach
export async function makeGmailApiCall<T>(
  endpoint: string, 
  options: RequestInit = {}
): Promise<T> {
  const state = await new Promise<HybridAuthState>(resolve => {
    hybridAuthState.subscribe(s => resolve(s))();
  });

  // Strategy 1: Try server proxy first if we have server session
  if (state.serverSession?.authenticated || state.preferredMode === 'server') {
    try {
      const response = await fetch(`${SERVER_BASE_URL}/api/gmail${endpoint}`, {
        ...options,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });

      if (response.ok) {
        const data = await response.json();
        pushGmailDiag({ type: 'api_call_server_success', endpoint });
        return data;
      }

      if (response.status === 401) {
        // Server session expired, try to refresh
        await getServerAccessToken();
        // Retry once
        const retryResponse = await fetch(`${SERVER_BASE_URL}/api/gmail${endpoint}`, {
          ...options,
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
          }
        });

        if (retryResponse.ok) {
          const data = await retryResponse.json();
          pushGmailDiag({ type: 'api_call_server_retry_success', endpoint });
          return data;
        }
      }

      throw new Error(`Server API failed: ${response.status}`);
    } catch (error) {
      pushGmailDiag({ 
        type: 'api_call_server_failed', 
        endpoint,
        error: error instanceof Error ? error.message : String(error) 
      });
      // Continue to client fallback
    }
  }

  // Strategy 2: Fall back to direct Gmail API with client token
  try {
    const accessToken = await getClientAccessToken();
    
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      throw new Error(`Gmail API failed: ${response.status}`);
    }

    const data = await response.json();
    pushGmailDiag({ type: 'api_call_client_success', endpoint });
    return data;

  } catch (error) {
    pushGmailDiag({ 
      type: 'api_call_client_failed', 
      endpoint,
      error: error instanceof Error ? error.message : String(error) 
    });
    throw error;
  }
}

// Sign out from both server and client
export async function signOut(): Promise<void> {
  pushGmailDiag({ type: 'hybrid_signout_start' });

  // Sign out from server
  try {
    await fetch(`${SERVER_BASE_URL}/api/google-logout`, {
      method: 'POST',
      credentials: 'include'
    });
    pushGmailDiag({ type: 'server_signout_success' });
  } catch (error) {
    pushGmailDiag({ 
      type: 'server_signout_error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }

  // Revoke client token if available
  const state = await new Promise<HybridAuthState>(resolve => {
    hybridAuthState.subscribe(s => resolve(s))();
  });

  if (state.clientToken && (window as any).google?.accounts?.oauth2?.revoke) {
    try {
      await new Promise<void>((resolve) => {
        (window as any).google.accounts.oauth2.revoke(state.clientToken!.access_token, () => resolve());
      });
      pushGmailDiag({ type: 'client_token_revoked' });
    } catch (error) {
      pushGmailDiag({ 
        type: 'client_token_revoke_error', 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }

  // Clear state
  hybridAuthState.update(() => ({
    ready: true,
    preferredMode: 'auto'
  }));

  pushGmailDiag({ type: 'hybrid_signout_complete' });
}

// Get current authentication status
export function getAuthStatus(): HybridAuthState {
  let currentState: HybridAuthState = { ready: false, preferredMode: 'auto' };
  hybridAuthState.subscribe(state => currentState = state)();
  return currentState;
}

// Force refresh of authentication state
export async function refreshAuthState(): Promise<void> {
  pushGmailDiag({ type: 'auth_state_refresh_start' });
  
  const serverSession = await checkServerSession();
  
  hybridAuthState.update(state => ({
    ...state,
    serverSession,
    preferredMode: serverSession.authenticated ? 'server' : state.preferredMode
  }));

  pushGmailDiag({ 
    type: 'auth_state_refresh_complete', 
    serverAuthenticated: serverSession.authenticated 
  });
}
