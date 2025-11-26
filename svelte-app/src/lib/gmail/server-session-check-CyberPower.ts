// Server Session Check Utility
// Checks for existing server-side authentication before initializing client-side auth

import { pushGmailDiag } from '$lib/gmail/diag';

export type ServerSessionInfo = {
  authenticated: boolean;
  email?: string;
  sub?: string;
  scope?: string;
  exp?: number;
};

// Check if we have a valid server session
export async function checkServerSession(): Promise<ServerSessionInfo> {
  try {
    // Always use relative URL - Vite dev server proxies /api to the Functions runtime
    // This avoids CORS issues when running frontend on 5173 and API on different ports
    const apiUrl = '/api/google-me';
    pushGmailDiag({ type: 'checking_server_session', url: apiUrl });

    const response = await fetch(apiUrl, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      const data = await response.json();
      pushGmailDiag({ 
        type: 'server_session_found', 
        email: data.email || data.user?.email,
        scope: data.scope 
      });
      
      return {
        authenticated: true,
        email: data.email || data.user?.email,
        sub: data.sub || data.user?.sub,
        scope: data.scope,
        exp: data.exp
      };
    } else {
      pushGmailDiag({ 
        type: 'server_session_not_found', 
        status: response.status 
      });
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

// Store server session info in IndexedDB for the main app to use
export async function storeServerSessionInDB(sessionInfo: ServerSessionInfo): Promise<void> {
  if (!sessionInfo.authenticated) return;
  
  try {
    const { getDB } = await import('$lib/db/indexeddb');
    const db = await getDB();
    
    const account = {
      sub: sessionInfo.sub || 'me',
      accessToken: 'server-managed', // Placeholder since server manages the actual token
      tokenExpiry: sessionInfo.exp ? sessionInfo.exp * 1000 : Date.now() + 3600000, // 1 hour default
      lastConnectedAt: Date.now(),
      lastConnectedOrigin: typeof window !== 'undefined' ? window.location.origin : undefined,
      lastConnectedUrl: typeof window !== 'undefined' ? window.location.href : undefined,
      firstConnectedAt: Date.now(),
      firstConnectedOrigin: typeof window !== 'undefined' ? window.location.origin : undefined,
      firstConnectedUrl: typeof window !== 'undefined' ? window.location.href : undefined,
      email: sessionInfo.email,
      serverManaged: true // Flag to indicate this is a server-managed session
    };
    
    await db.put('auth', account, 'me');
    pushGmailDiag({ type: 'server_session_stored_in_db', email: sessionInfo.email });
    // Notify session manager so UI updates to authenticated state
    try {
      const { sessionManager } = await import('$lib/auth/session-manager');
      sessionManager.applyServerSession(sessionInfo.email, sessionInfo.exp ? sessionInfo.exp * 1000 : undefined);
    } catch (e) {
      pushGmailDiag({ type: 'apply_server_session_failed', error: e instanceof Error ? e.message : String(e) });
    }
  } catch (error) {
    pushGmailDiag({ 
      type: 'server_session_store_error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
}

// Initialize auth with server-first approach
export async function initAuthWithServerFirst(): Promise<{ type: 'server' | 'client'; sessionInfo?: ServerSessionInfo }> {
  pushGmailDiag({ type: 'init_auth_server_first_start' });

  // Step 1: Check for existing server session
  const serverSession = await checkServerSession();
  
  if (serverSession.authenticated) {
    // Store server session in DB so main app recognizes the user
    await storeServerSessionInDB(serverSession);
    pushGmailDiag({ type: 'init_auth_server_first_success', mode: 'server' });
    return { type: 'server', sessionInfo: serverSession };
  }

  // Step 2: Fall back to client-side auth initialization
  try {
    const { initAuth, resolveGoogleClientId } = await import('$lib/gmail/auth');
    const clientId = resolveGoogleClientId();
    if (clientId) {
      await initAuth(clientId);
      pushGmailDiag({ type: 'init_auth_server_first_success', mode: 'client' });
      return { type: 'client' };
    }
  } catch (error) {
    pushGmailDiag({ 
      type: 'init_auth_server_first_client_fallback_error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }

  pushGmailDiag({ type: 'init_auth_server_first_no_auth' });
  return { type: 'client' }; // Return client type even if failed, let caller handle
}
