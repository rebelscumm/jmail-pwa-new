// Localhost Development Authentication
// Provides GIS fallback for local development when server auth isn't available

import { writable } from 'svelte/store';
import { pushGmailDiag } from '$lib/gmail/diag';
import type { AccountAuthMeta } from '$lib/types';

export type LocalAuthState = {
  ready: boolean;
  hasToken: boolean;
  tokenExpiry?: number;
  email?: string;
  mode: 'server' | 'client' | 'none';
};

export const localAuthState = writable<LocalAuthState>({
  ready: false,
  hasToken: false,
  mode: 'none'
});

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.readonly'
].join(' ');

// Check if running on localhost
function isLocalhost(): boolean {
  if (typeof window === 'undefined') return false;
  const hostname = window.location.hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.');
}

// Track if auth initialization is in progress to prevent multiple simultaneous attempts
let authInitInProgress = false;
let authInitPromise: Promise<void> | null = null;

// Initialize localhost authentication with server-first approach
export async function initLocalhostAuth(): Promise<void> {
  if (!isLocalhost()) {
    throw new Error('This function is only for localhost development');
  }

  // Prevent multiple simultaneous initialization attempts
  if (authInitInProgress && authInitPromise) {
    pushGmailDiag({ type: 'localhost_auth_init_already_in_progress' });
    return authInitPromise;
  }

  authInitInProgress = true;
  authInitPromise = (async () => {
    try {
      pushGmailDiag({ type: 'localhost_auth_init_start' });

      // Step 1: Try server session (SWA CLI or production)
      const serverResult = await tryServerAuth();
      if (serverResult.success) {
        localAuthState.set({
          ready: true,
          hasToken: true,
          email: serverResult.email,
          mode: 'server',
          tokenExpiry: serverResult.tokenExpiry
        });
        pushGmailDiag({ type: 'localhost_auth_success', mode: 'server' });
        return;
      }

      // Step 2: Check for existing client token first (don't trigger new popup)
      const existingToken = getLocalhostToken();
      if (existingToken) {
        localAuthState.set({
          ready: true,
          hasToken: true,
          email: 'localhost-client-user',
          mode: 'client',
          tokenExpiry: parseInt(localStorage.getItem('LOCALHOST_TOKEN_EXPIRY') || '0')
        });
        pushGmailDiag({ type: 'localhost_auth_success', mode: 'client', source: 'existing_token' });
        return;
      }

      // Step 3: Only try interactive client auth if explicitly requested (not auto-triggered)
      // This prevents popup spam when multiple API calls fail
      localAuthState.set({
        ready: true,
        hasToken: false,
        mode: 'none'
      });
      pushGmailDiag({ type: 'localhost_auth_no_auth', note: 'No existing token, user must click sign in' });

    } catch (error) {
      pushGmailDiag({ 
        type: 'localhost_auth_error', 
        error: error instanceof Error ? error.message : String(error) 
      });
      localAuthState.set({
        ready: true,
        hasToken: false,
        mode: 'none'
      });
      throw error;
    } finally {
      authInitInProgress = false;
      authInitPromise = null;
    }
  })();

  return authInitPromise;
}

// Try server authentication (SWA CLI or production)
async function tryServerAuth(): Promise<{ success: boolean; email?: string; tokenExpiry?: number }> {
  const ports = ['4280', '7071']; // SWA CLI and Azure Functions Core Tools
  
  // First try SWA CLI
  for (const port of ports) {
    try {
      const response = await fetch(`http://localhost:${port}/api/google-me`, {
        method: 'GET',
        credentials: 'include'
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.authenticated) {
          pushGmailDiag({ type: 'localhost_server_auth_found', port, email: data.user?.email });
          
          // Store in DB for main app compatibility
          await storeLocalhostServerSession(data, port);
          
          return { 
            success: true, 
            email: data.user?.email,
            tokenExpiry: data.exp ? data.exp * 1000 : Date.now() + 3600000
          };
        }
      }
    } catch (e) {
      pushGmailDiag({ type: 'localhost_server_auth_port_failed', port, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Try production API as fallback
  try {
    const response = await fetch('/api/google-me', {
      method: 'GET',
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.authenticated) {
        pushGmailDiag({ type: 'localhost_server_auth_production', email: data.user?.email });
        await storeLocalhostServerSession(data, 'production');
        return { 
          success: true, 
          email: data.user?.email,
          tokenExpiry: data.exp ? data.exp * 1000 : Date.now() + 3600000
        };
      }
    }
  } catch (e) {
    pushGmailDiag({ type: 'localhost_server_auth_production_failed', error: e instanceof Error ? e.message : String(e) });
  }

  return { success: false };
}

// Try client-side GIS authentication
async function tryClientAuth(): Promise<{ success: boolean; email?: string; tokenExpiry?: number }> {
  try {
    // Load GIS script
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

    // Wait for Google APIs
    let retries = 0;
    while (!(window as any).google?.accounts?.oauth2 && retries < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      retries++;
    }

    if (!(window as any).google?.accounts?.oauth2) {
      throw new Error('Google APIs not available');
    }

    // Get localhost client ID
    const clientId = getLocalhostClientId();
    if (!clientId) {
      throw new Error('No localhost client ID configured');
    }

    // Initialize token client
    const tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GMAIL_SCOPES,
      callback: () => {}
    });

    // Try silent token first
    try {
      const token = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Silent token timeout')), 10000);
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

      // Store token in local storage and DB
      await storeLocalhostClientToken(token);
      
      return { 
        success: true, 
        email: 'client-auth-user',
        tokenExpiry: Date.now() + (token.expires_in - 60) * 1000
      };
    } catch (silentError) {
      pushGmailDiag({ type: 'localhost_client_silent_failed', error: silentError instanceof Error ? silentError.message : String(silentError) });
      
      // Prepare snackbar (if available) before starting interactive auth
      let showSnackbar: ((opts: any) => void) | null = null;
      try {
        const { show } = await import('$lib/containers/snackbar');
        showSnackbar = show;
      } catch (_) {
        // Snackbar not available, continue silently
      }

      // Silent failed, need interactive auth
      const token = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Interactive auth timeout')), 60000);
        tokenClient.callback = (response: any) => {
          clearTimeout(timeout);
          if (response.error) {
            const error = response.error as string;
            // Handle redirect_uri_mismatch specifically
            if (error.includes('redirect_uri_mismatch') || error.includes('redirect_uri')) {
              const origin = window.location.origin;
              const helpfulError = new Error(
                `Client ID Configuration Error: This client ID is configured for server-side OAuth, not client-side authentication.\n\n` +
                `To fix this, you have two options:\n\n` +
                `Option 1: Start the backend server (Recommended)\n` +
                `  Run: swa start ./svelte-app --api-location ./api --run "npm run dev --prefix svelte-app"\n` +
                `  Then use the "Sign in with Google" button - it will use server-side auth.\n\n` +
                `Option 2: Configure client-side client ID\n` +
                `  1. Go to https://console.cloud.google.com/apis/credentials\n` +
                `  2. Create a NEW OAuth 2.0 Client ID (or edit existing)\n` +
                `  3. Add "${origin}" to "Authorized JavaScript origins"\n` +
                `  4. Save the Client ID\n` +
                `  5. Use "Enter client ID" button to set it\n\n` +
                `Original error: ${error}`
              );
              pushGmailDiag({ 
                type: 'localhost_client_auth_redirect_uri_mismatch', 
                error, 
                origin,
                clientId: clientId ? clientId.slice(0, 20) + '...' : 'unknown'
              });
              reject(helpfulError);
            } else {
              reject(new Error(error));
            }
          } else {
            resolve(response);
          }
        };
        // Show diagnostic snackbar for localhost auth popup tracking
        if (showSnackbar) {
          showSnackbar({ 
            message: `Localhost auth popup triggered`, 
            timeout: 8000, 
            closable: true,
            actions: { 
              'Copy Diagnostics': async () => {
                try {
                  const diagnostics = {
                    timestamp: new Date().toISOString(),
                    flow: 'localhost_client_interactive',
                    prompt: 'consent',
                    localStorage: {
                      jmail_last_interactive_auth: localStorage.getItem('jmail_last_interactive_auth'),
                      jmail_last_scope_auth: localStorage.getItem('jmail_last_scope_auth'),
                      jmail_last_server_redirect: localStorage.getItem('jmail_last_server_redirect'),
                      LOCALHOST_ACCESS_TOKEN: localStorage.getItem('LOCALHOST_ACCESS_TOKEN'),
                      LOCALHOST_TOKEN_EXPIRY: localStorage.getItem('LOCALHOST_TOKEN_EXPIRY')
                    }
                  };
                  await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
                  showSnackbar({ message: 'Localhost auth diagnostics copied to clipboard', timeout: 3000 });
                } catch (e) {
                  showSnackbar({ message: 'Failed to copy diagnostics: ' + String(e), timeout: 5000, closable: true });
                }
              }
            }
          });
        }
        
        tokenClient.requestAccessToken({ prompt: 'consent' });
      });

      await storeLocalhostClientToken(token);
      
      return { 
        success: true, 
        email: 'client-auth-user',
        tokenExpiry: Date.now() + (token.expires_in - 60) * 1000
      };
    }
  } catch (error) {
    pushGmailDiag({ 
      type: 'localhost_client_auth_failed', 
      error: error instanceof Error ? error.message : String(error) 
    });
    return { success: false };
  }
}

// Get localhost client ID (for development)
function getLocalhostClientId(): string | null {
  // Check localStorage first
  const stored = localStorage.getItem('LOCALHOST_GOOGLE_CLIENT_ID') || localStorage.getItem('DEV_GOOGLE_CLIENT_ID');
  if (stored) return stored;

  // Check environment variables
  const envId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (envId) return envId;

  // Fallback to production client ID (may not work for localhost due to redirect URI)
  return '49551890193-e6n262ccj95229ftp2dh6k9s2boo1kip.apps.googleusercontent.com';
}

// Store server session info for localhost
async function storeLocalhostServerSession(sessionData: any, source: string): Promise<void> {
  try {
    const { getDB } = await import('$lib/db/indexeddb');
    const db = await getDB();
    
    const account: AccountAuthMeta = {
      sub: sessionData.user?.sub || 'localhost-server',
      accessToken: 'server-managed',
      tokenExpiry: sessionData.exp ? sessionData.exp * 1000 : Date.now() + 3600000,
      lastConnectedAt: Date.now(),
      lastConnectedOrigin: window.location.origin,
      lastConnectedUrl: window.location.href,
      firstConnectedAt: Date.now(),
      firstConnectedOrigin: window.location.origin,
      firstConnectedUrl: window.location.href,
      email: sessionData.user?.email,
      serverManaged: true,
      localhostSource: source
    };
    
    await db.put('auth', account, 'me');
    pushGmailDiag({ type: 'localhost_server_session_stored', source, email: account.email });
  } catch (error) {
    pushGmailDiag({ 
      type: 'localhost_server_session_store_error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
}

// Store client token for localhost
async function storeLocalhostClientToken(token: any): Promise<void> {
  try {
    // Store in localStorage for direct API calls
    localStorage.setItem('LOCALHOST_ACCESS_TOKEN', token.access_token);
    localStorage.setItem('LOCALHOST_TOKEN_EXPIRY', String(Date.now() + (token.expires_in - 60) * 1000));
    
    // Store in DB for main app compatibility
    const { getDB } = await import('$lib/db/indexeddb');
    const db = await getDB();
    
    const account: AccountAuthMeta = {
      sub: 'localhost-client',
      accessToken: token.access_token,
      tokenExpiry: Date.now() + (token.expires_in - 60) * 1000,
      lastConnectedAt: Date.now(),
      lastConnectedOrigin: window.location.origin,
      lastConnectedUrl: window.location.href,
      firstConnectedAt: Date.now(),
      firstConnectedOrigin: window.location.origin,
      firstConnectedUrl: window.location.href,
      email: 'localhost-client-user@gmail.com',
      serverManaged: false,
      localhostMode: 'client'
    };
    
    await db.put('auth', account, 'me');
    pushGmailDiag({ type: 'localhost_client_token_stored' });
  } catch (error) {
    pushGmailDiag({ 
      type: 'localhost_client_token_store_error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
}

// Get stored localhost token for API calls
export function getLocalhostToken(): string | null {
  const token = localStorage.getItem('LOCALHOST_ACCESS_TOKEN');
  const expiry = localStorage.getItem('LOCALHOST_TOKEN_EXPIRY');
  
  if (!token || !expiry) return null;
  
  const expiryTime = parseInt(expiry);
  if (Date.now() >= expiryTime) {
    // Token expired
    localStorage.removeItem('LOCALHOST_ACCESS_TOKEN');
    localStorage.removeItem('LOCALHOST_TOKEN_EXPIRY');
    return null;
  }
  
  return token;
}
