<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import ListItem from '$lib/containers/ListItem.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import { initAuth, authState, getAuthDiagnostics, resolveGoogleClientId } from '$lib/gmail/auth';
  import { checkServerSession } from '$lib/gmail/server-session-check';
  import { pushGmailDiag } from '$lib/gmail/diag';
  import { getDB } from '$lib/db/indexeddb';
  import { copyGmailDiagnosticsToClipboard } from '$lib/gmail/api';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  

  let CLIENT_ID = $state(import.meta.env.VITE_GOOGLE_CLIENT_ID as string);
  let loading = $state(true);
  let ready = $state(false);
  let hasAccount = $state(false);
  let copiedDiagOk = $state(false);
  let loadingTimedOut = $state(false);
  let copyingDiagnostics = $state(false);
  let copyingRuntimeChecks = $state(false);
  let copiedRuntimeOk = $state(false);

  onMount(() => {
    let unsub: (() => void) | undefined;
    let overallTimeout: ReturnType<typeof setTimeout> | undefined;
    
    try {
      unsub = authState.subscribe((s)=> ready = s.ready);
      
      // Shorter timeout for faster feedback
      overallTimeout = setTimeout(() => {
        console.warn('[Page] Overall initialization timeout reached');
        loadingTimedOut = true;
        loading = false;
      }, 8000);
    } catch (err) {
      console.warn('[Page] Mount initialization failed:', err);
      loading = false;
    }
    
    (async () => {
      try {
        // Quick database check first (layout may have already handled server session)
        try {
          const dbPromise = getDB();
          const timeoutPromise = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Quick DB timeout')), 2000)
          );
          const db = await Promise.race([dbPromise, timeoutPromise]);
          const account = await db.get('auth', 'me');
          if (account) {
            hasAccount = true;
            console.log('[Page] Found existing account, redirecting to inbox');
            window.location.href = `${base}/inbox`;
            return;
          }
        } catch (e) {
          console.log('[Page] Quick DB check failed, proceeding with auth flow:', e instanceof Error ? e.message : String(e));
        }

        // Check for server session (layout may have missed this)
        try {
          const { checkServerSession, storeServerSessionInDB } = await import('$lib/gmail/server-session-check');
          const serverSession = await checkServerSession();
          if (serverSession.authenticated) {
            await storeServerSessionInDB(serverSession);
            pushGmailDiag({ type: 'home_page_server_session_redirect', email: serverSession.email });
            console.log('[Page] Server session found, redirecting to inbox');
            window.location.href = `${base}/inbox`;
            return;
          }
        } catch (e) {
          console.warn('[Page] Server session check failed:', e);
        }

        // Check if localhost - check for existing auth only, don't auto-init
        const isLocalhost = typeof window !== 'undefined' && (
          window.location.hostname === 'localhost' || 
          window.location.hostname === '127.0.0.1' || 
          window.location.hostname.startsWith('192.168.')
        );
        
        if (isLocalhost) {
          try {
            // Only check for existing tokens, don't trigger new auth
            const { getLocalhostToken } = await import('$lib/gmail/localhost-auth');
            const existingToken = getLocalhostToken();
            if (existingToken) {
              // Quick recheck of database
              const db = await getDB();
              const account = await db.get('auth', 'me');
              if (account) {
                console.log('[Page] Found existing localhost auth, redirecting to inbox');
                window.location.href = `${base}/inbox`;
                return;
              }
            }
          } catch (e) {
            console.warn('[Page] Localhost token check failed:', e);
          }
        }

        // Initialize client-side auth for the connect flow
        try {
          CLIENT_ID = CLIENT_ID || resolveGoogleClientId() as string;
          const authPromise = initAuth(CLIENT_ID);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Auth initialization timeout')), 5000)
          );
          await Promise.race([authPromise, timeoutPromise]);
        } catch (e) {
          console.warn('[Page] Client auth initialization failed:', e);
        }
        
      } catch (e) {
        console.error('[Page] Unexpected error during initialization:', e);
      } finally {
        try {
          if (overallTimeout) clearTimeout(overallTimeout);
        } catch {}
        loading = false;
      }
    })();
    
    return () => {
      try {
        if (unsub) unsub();
        if (overallTimeout) clearTimeout(overallTimeout);
      } catch (err) {
        console.warn('[Page] Cleanup failed:', err);
      }
    };
  });

  async function connect() {
    try {
      const returnTo = `${base}/inbox`;
      
      // Try server login via relative URL (Vite dev server proxies /api to Functions runtime)
      const loginUrl = '/api/google-login';
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(loginUrl, { 
          method: 'HEAD', 
          credentials: 'include', 
          signal: controller.signal 
        });
        clearTimeout(timeoutId);
        if (response.ok || response.status === 405) {
          // Server endpoint exists, use it
          console.log('[Auth] Using server-side authentication', loginUrl);
          if (typeof window !== 'undefined') {
            window.location.assign(`${loginUrl}?return_to=${encodeURIComponent(returnTo)}`);
          }
          return;
        }
      } catch (e) {
        // Server not available, continue to client-side
        console.log('[Auth] Server login unavailable, using client-side auth', e instanceof Error ? e.message : String(e));
      }
      
      // Fall back to client-side authentication
      // This requires the client ID to be configured with localhost as an authorized JavaScript origin
      console.log('[Auth] Starting client-side authentication');
      
      CLIENT_ID = CLIENT_ID || resolveGoogleClientId() as string;
      if (!CLIENT_ID) {
        showSnackbar({ 
          message: 'No Google Client ID configured. Please enter a client ID using the "Enter client ID" button.', 
          timeout: 8000, 
          closable: true 
        });
        return;
      }
      
      // Initialize auth
      await initAuth(CLIENT_ID);
      
      // Use acquireTokenInteractive which will show a popup
      try {
        const { acquireTokenInteractive } = await import('$lib/gmail/auth');
        await acquireTokenInteractive('consent', 'connect_button');
        
        // Store the token in localhost auth format for compatibility
        try {
          const { getDB } = await import('$lib/db/indexeddb');
          const db = await getDB();
          const { getAuthState } = await import('$lib/gmail/auth');
          const state = getAuthState();
          
          if (state.accessToken) {
            // Store in localhost format
            localStorage.setItem('LOCALHOST_ACCESS_TOKEN', state.accessToken);
            localStorage.setItem('LOCALHOST_TOKEN_EXPIRY', String(state.expiryMs || Date.now() + 3600000));
            
            // Also store in DB
            const account = {
              sub: 'me',
              accessToken: state.accessToken,
              tokenExpiry: state.expiryMs || Date.now() + 3600000,
              lastConnectedAt: Date.now(),
              lastConnectedOrigin: window.location.origin,
              lastConnectedUrl: window.location.href,
              firstConnectedAt: Date.now(),
              firstConnectedOrigin: window.location.origin,
              firstConnectedUrl: window.location.href,
              email: 'client-auth-user@gmail.com',
              serverManaged: false,
              localhostMode: 'client'
            };
            await db.put('auth', account, 'me');
          }
        } catch (dbErr) {
          console.warn('[Auth] Failed to store auth in DB:', dbErr);
        }
        
        // After successful auth, redirect to inbox
        if (typeof window !== 'undefined') {
          window.location.href = `${base}/inbox`;
        }
      } catch (authErr) {
        // Re-throw to be caught by outer catch
        throw authErr;
      }
      
    } catch (e) {
      console.error('[Auth] Client-side auth failed', e);
      const errorMessage = e instanceof Error ? e.message : String(e);
      let userMessage = 'Authentication failed. ';
      
      // Provide specific guidance for redirect_uri_mismatch
      if (errorMessage.includes('redirect_uri_mismatch') || 
          errorMessage.includes('redirect_uri') || 
          errorMessage.includes('Client ID Configuration Error') || 
          errorMessage.includes('Client ID configuration') ||
          errorMessage.includes('not be secure') ||
          errorMessage.includes('invalid_request')) {
        userMessage = '⚠️ Client ID Configuration Issue\n\n';
        userMessage += 'Your client ID is configured for server-side OAuth, not client-side authentication.\n\n';
        userMessage += 'To fix this, you have TWO options:\n\n';
        userMessage += 'OPTION 1: Start the backend server (Recommended)\n';
        userMessage += '  Run this command in your terminal:\n';
        userMessage += '  swa start ./svelte-app --api-location ./api --run "npm run dev --prefix svelte-app"\n';
        userMessage += '  Then click "Sign in with Google" again - it will use server-side auth.\n\n';
        userMessage += 'OPTION 2: Configure a client-side client ID\n';
        userMessage += '  1. Go to https://console.cloud.google.com/apis/credentials\n';
        userMessage += '  2. Create a NEW OAuth 2.0 Client ID (or edit existing)\n';
        userMessage += '  3. Add "' + window.location.origin + '" to "Authorized JavaScript origins"\n';
        userMessage += '  4. Save the Client ID\n';
        userMessage += '  5. Use "Enter client ID" button to set it\n\n';
        userMessage += 'Note: "Authorized JavaScript origins" is different from "Authorized redirect URIs"';
      } else if (errorMessage.includes('No client ID available')) {
        userMessage = 'No Google Client ID configured. Please enter a client ID using the "Enter client ID" button.';
      }
      
      showSnackbar({ 
        message: userMessage, 
        timeout: 20000, 
        closable: true,
        actions: {
          'Copy Error Details': async () => {
            try {
              await copyGmailDiagnosticsToClipboard({ 
                error: errorMessage,
                origin: window.location.origin,
                clientId: CLIENT_ID ? CLIENT_ID.slice(0, 20) + '...' : 'not set',
                note: 'For client-side auth, add this origin to "Authorized JavaScript origins" in Google Cloud Console'
              });
              showSnackbar({ message: 'Error details copied to clipboard', timeout: 3000 });
            } catch (copyErr) {
              console.error('Failed to copy error details:', copyErr);
            }
          }
        }
      });
    }
  }

  // Root page no longer hydrates; inbox route handles data loading

  async function copyDiagnostics() {
    if (copyingDiagnostics) return; // Prevent multiple clicks
    
    copyingDiagnostics = true;
    try {
      const payload = {
        note: 'Auth landing diagnostics snapshot',
        at: new Date().toISOString(),
        ready,
        hasAccount,
        clientIdPresent: !!CLIENT_ID && String(CLIENT_ID).trim().length > 0,
        clientIdPreview: CLIENT_ID ? String(CLIENT_ID).slice(0, 8) + '…' : undefined,
        ...getAuthDiagnostics(),
        location: typeof window !== 'undefined' ? window.location?.href : undefined,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        localStorageKeys: typeof localStorage !== 'undefined' ? Object.keys(localStorage || {}) : undefined
      };
      
      // Try to copy to clipboard
      copiedDiagOk = await copyGmailDiagnosticsToClipboard(payload);
      
      // Provide user feedback
      if (copiedDiagOk) {
        showSnackbar({ message: 'Diagnostics copied to clipboard', timeout: 3000 });
      } else {
        showSnackbar({ message: 'Clipboard access denied. Check console for diagnostics.', timeout: 5000, closable: true });
        // Also log to console as fallback
        console.log('Diagnostics (console fallback):', payload);
      }
    } catch (error) {
      console.error('copyDiagnostics failed:', error);
      copiedDiagOk = false;
      
      // Show error message
      showSnackbar({ message: 'Failed to copy diagnostics. Check console for error.', timeout: 5000, closable: true });
    } finally {
      copyingDiagnostics = false;
    }
  }

  if (typeof window !== 'undefined') {
    (window as any).__copyPageDiagnostics = async () => { await copyDiagnostics(); };
    (window as any).__copyRuntimeChecks = async () => { await copyRuntimeChecks(); };
  }

  async function copyRuntimeChecks() {
    if (copyingRuntimeChecks) return;
    copyingRuntimeChecks = true;
    try {
      const gisScriptSrc = typeof document !== 'undefined' ? document.getElementById('gis-script')?.getAttribute('src') ?? null : null;
      const hasWindowGoogle = typeof window !== 'undefined' ? Boolean((window as any).google) : undefined;
      const hasOauth2 = typeof window !== 'undefined' ? Boolean((window as any).google?.accounts?.oauth2) : undefined;
      const clientIdFromLocalStorage = typeof localStorage !== 'undefined' ? (localStorage.getItem('GOOGLE_CLIENT_ID') || localStorage.getItem('VITE_GOOGLE_CLIENT_ID')) : null;
      const online = typeof navigator !== 'undefined' ? navigator.onLine : undefined;
      // Perf/resource entries related to GIS
      let gsiResources: any[] | undefined = undefined;
      try {
        if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
          const resources = (performance.getEntriesByType('resource') as any[]).filter((r) => String(r.name || '').includes('gsi') || String(r.name || '').includes('accounts.google.com'));
          gsiResources = resources.map((r) => ({ name: r.name, duration: r.duration, transferSize: r.transferSize, initiatorType: r.initiatorType, encodedBodySize: (r as any).encodedBodySize }));
        }
      } catch (_) { gsiResources = undefined; }

      const payload = {
        at: new Date().toISOString(),
        gisScriptSrc,
        hasWindowGoogle,
        hasOauth2,
        clientIdFromLocalStorage,
        online,
        gsiResources,
        location: typeof window !== 'undefined' ? window.location?.href : undefined,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined
      } as const;

      const text = JSON.stringify(payload, null, 2);
      let ok = false;
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try { await navigator.clipboard.writeText(text); ok = true; } catch (_) { ok = false; }
      }
      if (!ok && typeof document !== 'undefined' && document.queryCommandSupported && document.queryCommandSupported('copy')) {
        try {
          const textArea = document.createElement('textarea');
          textArea.value = text;
          textArea.style.position = 'fixed';
          textArea.style.left = '-999999px';
          textArea.style.top = '-999999px';
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          const successful = document.execCommand('copy');
          document.body.removeChild(textArea);
          ok = !!successful;
        } catch (_) { ok = false; }
      }
      if (!ok) {
        showSnackbar({ message: 'Clipboard unavailable. Runtime checks printed to console.', timeout: 6000, closable: true });
      }
      copiedRuntimeOk = ok;
      // Also log to console for easy inspection
      try { console.log('[RuntimeChecks] payload', payload); } catch (_) {}
    } catch (error) {
      console.error('copyRuntimeChecks failed:', error);
      copiedRuntimeOk = false;
    } finally {
      copyingRuntimeChecks = false;
    }
  }

  async function enterClientId() {
    try {
      const id = prompt('Enter Google OAuth Client ID (will be saved locally)', CLIENT_ID || '');
      if (!id) return;
      CLIENT_ID = id.trim();
      try { 
        localStorage.setItem('GOOGLE_CLIENT_ID', CLIENT_ID); 
        console.log('[ClientID] Saved to localStorage');
      } catch (e) { 
        console.warn('[ClientID] Failed to save to localStorage:', e);
      }
      try { 
        await initAuth(CLIENT_ID); 
        console.log('[ClientID] Auth initialized successfully');
        // Try to proceed with the flow
        try {
          const db = await getDB();
          const account = await db.get('auth', 'me');
          hasAccount = !!account;
          if (hasAccount) {
            window.location.href = `${base}/inbox`;
          }
        } catch (e) {
          console.warn('[ClientID] DB check failed after auth init:', e);
        }
      } catch (e) { 
        console.error('[ClientID] Auth initialization failed:', e);
      }
    } catch (e) {
      console.error('[ClientID] Manual client ID entry failed:', e);
    }
  }

  async function retryInitialization() {
    loading = true;
    loadingTimedOut = false;
    
    try {
      // Ensure auth is initialized before attempting API calls
      try {
        CLIENT_ID = CLIENT_ID || resolveGoogleClientId() as string;
        // Add timeout to prevent hanging
        const authPromise = initAuth(CLIENT_ID);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Auth initialization timeout')), 10000)
        );
        await Promise.race([authPromise, timeoutPromise]);
      } catch (e) {
        console.warn('[Retry] Auth initialization failed:', e);
      }
      
      try {
        // Add timeout to prevent hanging
        const dbPromise = getDB();
        const timeoutPromise = new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Database initialization timeout')), 5000)
        );
        const db = await Promise.race([dbPromise, timeoutPromise]);
        const account = await db.get('auth', 'me');
        hasAccount = !!account;
        if (hasAccount) {
          // User is already connected; go straight to inbox
          window.location.href = `${base}/inbox`;
        }
      } catch (e) {
        console.warn('[Retry] Database operation failed:', e);
      }
    } catch (e) {
      console.error('[Retry] Unexpected error during initialization:', e);
    } finally {
      // Always ensure loading is set to false, even if operations fail
      loading = false;
    }
  }
</script>

{#if loading}
  <div style="display:grid; gap:1rem; max-width:28rem; margin: 10vh auto; text-align: center;">
    <p>Checking authentication…</p>
    {#if loadingTimedOut}
      <p style="font-size: 0.875rem; color: rgb(var(--m3-scheme-error));">
        Loading timed out. This usually means there's an issue with the Google OAuth configuration.
      </p>
    {:else}
      <p style="font-size: 0.875rem; color: rgb(var(--m3-scheme-on-surface-variant));">
        Connecting to your Gmail account
      </p>
    {/if}
    <Button variant="outlined" onclick={enterClientId}>Enter Client ID Manually</Button>
    <div style="display:flex; gap:0.5rem; justify-content:center;">
      <Button variant="text" onclick={copyDiagnostics} disabled={copyingDiagnostics}>
        {copyingDiagnostics ? 'Copying...' : 'Copy Diagnostics'}
      </Button>
      <Button variant="text" onclick={copyRuntimeChecks} disabled={copyingRuntimeChecks}>
        {copyingRuntimeChecks ? 'Copying...' : 'Copy Runtime Checks'}
      </Button>
    </div>
    {#if copiedDiagOk !== null}
      <span style="font-size: 0.75rem; color: {copiedDiagOk ? 'rgb(var(--m3-scheme-primary))' : 'rgb(var(--m3-scheme-error))'};">
        {copiedDiagOk ? '✓ Copied successfully' : '✗ Copy failed - check console'}
      </span>
    {/if}
    {#if copiedRuntimeOk !== null}
      <span style="display:block; font-size: 0.75rem; color: {copiedRuntimeOk ? 'rgb(var(--m3-scheme-primary))' : 'rgb(var(--m3-scheme-error))'};">
        {copiedRuntimeOk ? '✓ Runtime checks copied' : '✗ Runtime copy failed - check console'}
      </span>
    {/if}
    {#if loadingTimedOut}
      <Button variant="filled" onclick={retryInitialization}>Retry</Button>
    {/if}
    
    <!-- Help info -->
    <details style="text-align: left; font-size: 0.75rem; color: rgb(var(--m3-scheme-on-surface-variant));">
      <summary>How to get a Google OAuth Client ID</summary>
      <div style="margin-top: 0.5rem;">
        <ol style="margin: 0; padding-left: 1rem;">
          <li>Go to <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a></li>
          <li>Create a new project or select an existing one</li>
          <li>Enable the Gmail API</li>
          <li>Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client IDs"</li>
          <li>Choose "Web application" as the application type</li>
          <li>Add your domain to authorized origins</li>
                  <li>Copy the Client ID and paste it above</li>
      </ol>
      <p style="margin-top: 0.5rem;">
        <strong>Note:</strong> The app includes a fallback client ID, but you may need to provide your own for production use.
      </p>
    </div>
  </details>
    
    <!-- Debug info -->
    <details style="text-align: left; font-size: 0.75rem; color: rgb(var(--m3-scheme-on-surface-variant));">
      <summary>Debug Info</summary>
      <div style="margin-top: 0.5rem;">
        <p><strong>Client ID:</strong> {CLIENT_ID ? CLIENT_ID.slice(0, 20) + '...' : 'Not set'}</p>
        <p><strong>Ready:</strong> {ready}</p>
        <p><strong>Has Account:</strong> {hasAccount}</p>
        <p><strong>Loading:</strong> {loading}</p>
        <p><strong>Base Path:</strong> {base}</p>
        <p><strong>Copied Diag:</strong> {copiedDiagOk ? 'Yes' : 'No'}</p>
        <p><strong>Timed Out:</strong> {loadingTimedOut ? 'Yes' : 'No'}</p>
      </div>
    </details>
  </div>
{:else if hasAccount}
  <p>Redirecting to Inbox…</p>
{:else}
  <div style="display:grid; gap:1rem; max-width:28rem; margin: 10vh auto;">
    <h2 class="m3-font-headline-large" style="margin:0">Connect Gmail</h2>
    <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">Sign in to your Google account to view and manage your inbox.</p>
    <ListItem headline="Permissions" supporting="We request Gmail read/modify and labels scopes to snooze and label threads." />
    <Button variant="filled" onclick={connect}>Sign in with Google</Button>
    {#if !ready}
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        <Button variant="outlined" onclick={enterClientId}>Enter client ID</Button>
      </div>
    {/if}
    <Button variant="text" href="https://myaccount.google.com/permissions">Review Google permissions</Button>
  </div>
{/if}
