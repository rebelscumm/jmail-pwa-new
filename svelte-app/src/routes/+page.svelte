<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import ListItem from '$lib/containers/ListItem.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import { initAuth, acquireTokenInteractive, authState, getAuthDiagnostics, resolveGoogleClientId } from '$lib/gmail/auth';
  import { getDB } from '$lib/db/indexeddb';
  import { copyGmailDiagnosticsToClipboard } from '$lib/gmail/api';
  

  let CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
  let loading = $state(true);
  let ready = $state(false);
  let hasAccount = $state(false);
  let copiedDiagOk = $state(false);

  onMount(() => {
    const unsub = authState.subscribe((s)=> ready = s.ready);
    (async () => {
      // Ensure auth is initialized before attempting API calls
      try {
        CLIENT_ID = CLIENT_ID || resolveGoogleClientId() as string;
        await initAuth(CLIENT_ID);
      } catch (_) {}
      const db = await getDB();
      const account = await db.get('auth', 'me');
      hasAccount = !!account;
      if (hasAccount) {
        // User is already connected; go straight to inbox
        window.location.href = `${base}/inbox`;
      }
      loading = false;
    })();
    return () => unsub();
  });

  async function connect() {
    try {
      if (!ready) {
        CLIENT_ID = CLIENT_ID || resolveGoogleClientId() as string;
        try { await initAuth(CLIENT_ID); } catch (_) {}
      }
      await acquireTokenInteractive('consent');
      hasAccount = true;
      // Navigate immediately; inbox page will hydrate
      window.location.href = `${base}/inbox`;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[Auth] Sign-in failed on landing', e);
      try {
        const diag = getAuthDiagnostics();
        const payload = {
          note: 'Auth landing diagnostics snapshot (sign-in error)',
          at: new Date().toISOString(),
          ready,
          hasAccount,
          clientIdPresent: !!CLIENT_ID && String(CLIENT_ID).trim().length > 0,
          clientIdPreview: CLIENT_ID ? String(CLIENT_ID).slice(0, 8) + '…' : undefined,
          error: e instanceof Error ? e.message : String(e),
          ...diag,
          location: typeof window !== 'undefined' ? window.location?.href : undefined,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
          localStorageKeys: typeof localStorage !== 'undefined' ? Object.keys(localStorage || {}) : undefined
        };
        copiedDiagOk = await copyGmailDiagnosticsToClipboard(payload);
      } catch (_) {
        copiedDiagOk = false;
      }
    }
  }

  // Root page no longer hydrates; inbox route handles data loading

  async function copyDiagnostics() {
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
      copiedDiagOk = await copyGmailDiagnosticsToClipboard(payload);
    } catch (_) {
      copiedDiagOk = false;
    }
  }

  async function enterClientId() {
    try {
      const id = prompt('Enter Google OAuth Client ID (will be saved locally)', CLIENT_ID || '');
      if (!id) return;
      CLIENT_ID = id.trim();
      try { localStorage.setItem('GOOGLE_CLIENT_ID', CLIENT_ID); } catch (_) {}
      try { await initAuth(CLIENT_ID); } catch (_) {}
    } catch (_) {}
  }
</script>

{#if loading}
  <p>Loading…</p>
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
        <Button variant="text" onclick={copyDiagnostics}>{copiedDiagOk ? 'Copied!' : 'Copy diagnostics'}</Button>
        <Button variant="outlined" onclick={enterClientId}>Enter client ID</Button>
      </div>
    {/if}
    <Button variant="text" href="https://myaccount.google.com/permissions">Review Google permissions</Button>
  </div>
{/if}
