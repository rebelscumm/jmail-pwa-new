<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import ListItem from '$lib/containers/ListItem.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import { initAuth, authState, getAuthDiagnostics, resolveGoogleClientId } from '$lib/gmail/auth';
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
    const unsub = authState.subscribe((s)=> ready = s.ready);
    
    // Overall timeout to prevent infinite loading
    const overallTimeout = setTimeout(() => {
      console.warn('[Page] Overall initialization timeout reached');
      loadingTimedOut = true;
      loading = false;
    }, 15000);
    
    (async () => {
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
          console.warn('[Auth] Initialization failed:', e);
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
          console.warn('[DB] Database operation failed:', e);
        }
      } catch (e) {
        console.error('[Page] Unexpected error during initialization:', e);
      } finally {
        // Always ensure loading is set to false, even if operations fail
        clearTimeout(overallTimeout);
        loading = false;
      }
    })();
    return () => {
      unsub();
      clearTimeout(overallTimeout);
    };
  });

  async function connect() {
    try {
      const returnTo = `${base}/inbox`;
      window.location.assign(`/api/google/login?return_to=${encodeURIComponent(returnTo)}`);
    } catch (e) {
      console.error('[Auth] Redirect failed', e);
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
    <p>Loading…</p>
    {#if loadingTimedOut}
      <p style="font-size: 0.875rem; color: rgb(var(--m3-scheme-error));">
        Loading timed out. This usually means there's an issue with the Google OAuth configuration.
      </p>
    {:else}
      <p style="font-size: 0.875rem; color: rgb(var(--m3-scheme-on-surface-variant));">
        If this takes too long, you may need to provide a Google OAuth Client ID
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
