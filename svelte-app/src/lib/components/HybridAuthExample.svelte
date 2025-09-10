<script lang="ts">
  import { onMount } from 'svelte';
  import { 
    initHybridAuth, 
    hybridAuthState, 
    getValidAccessToken, 
    initiateInteractiveAuth, 
    makeGmailApiCall,
    signOut,
    refreshAuthState,
    type HybridAuthState 
  } from '$lib/gmail/hybrid-auth';
  import Button from '$lib/buttons/Button.svelte';
  import Card from '$lib/containers/Card.svelte';
  import CircularProgressIndeterminate from '$lib/forms/CircularProgressIndeterminate.svelte';
  import { show as showSnackbar } from '$lib/containers/snackbar';

  let isLoading = false;
  let error: string | null = null;
  let profile: any = null;
  let labels: any[] = [];

  $: authState = $hybridAuthState as HybridAuthState;

  onMount(async () => {
    try {
      await initHybridAuth();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  });

  async function handleServerLogin() {
    try {
      await initiateInteractiveAuth('server');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      showSnackbar({ message: `Server login failed: ${error}`, timeout: 5000 });
    }
  }

  async function handleClientLogin() {
    try {
      isLoading = true;
      error = null;
      await initiateInteractiveAuth('client');
      showSnackbar({ message: 'Client authentication successful!', timeout: 3000 });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      showSnackbar({ message: `Client login failed: ${error}`, timeout: 5000 });
    } finally {
      isLoading = false;
    }
  }

  async function testGetProfile() {
    try {
      isLoading = true;
      error = null;
      profile = await makeGmailApiCall('/profile');
      showSnackbar({ message: 'Profile loaded successfully!', timeout: 3000 });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      showSnackbar({ message: `Failed to get profile: ${error}`, timeout: 5000 });
    } finally {
      isLoading = false;
    }
  }

  async function testGetLabels() {
    try {
      isLoading = true;
      error = null;
      const response = await makeGmailApiCall('/labels') as any;
      labels = response.labels || [];
      showSnackbar({ message: `Loaded ${labels.length} labels!`, timeout: 3000 });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      showSnackbar({ message: `Failed to get labels: ${error}`, timeout: 5000 });
    } finally {
      isLoading = false;
    }
  }

  async function testGetToken() {
    try {
      isLoading = true;
      error = null;
      const token = await getValidAccessToken();
      const tokenPreview = token === 'server-managed-token' ? 'Server-managed token' : `${token.substring(0, 20)}...`;
      showSnackbar({ message: `Got token: ${tokenPreview}`, timeout: 3000 });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      showSnackbar({ message: `Failed to get token: ${error}`, timeout: 5000 });
    } finally {
      isLoading = false;
    }
  }

  async function handleSignOut() {
    try {
      isLoading = true;
      await signOut();
      profile = null;
      labels = [];
      showSnackbar({ message: 'Signed out successfully!', timeout: 3000 });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      showSnackbar({ message: `Sign out failed: ${error}`, timeout: 5000 });
    } finally {
      isLoading = false;
    }
  }

  async function handleRefreshState() {
    try {
      isLoading = true;
      await refreshAuthState();
      showSnackbar({ message: 'Auth state refreshed!', timeout: 3000 });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      showSnackbar({ message: `Refresh failed: ${error}`, timeout: 5000 });
    } finally {
      isLoading = false;
    }
  }
</script>

<div class="hybrid-auth-example">
  <Card variant="elevated">
    <h2>🔄 Hybrid Authentication Demo</h2>
    <p>This demonstrates the hybrid auth system that combines server-side refresh tokens (long-lasting) with client-side GIS tokens.</p>
    
    <!-- Authentication Status -->
    <div class="auth-status">
      <h3>Authentication Status</h3>
      {#if !authState.ready}
        <div class="status-item loading">
          <CircularProgressIndeterminate />
          Initializing authentication...
        </div>
      {:else}
        <div class="status-grid">
          <div class="status-item" class:success={authState.serverSession?.authenticated} class:error={!authState.serverSession?.authenticated}>
            <strong>Server Session:</strong>
            {#if authState.serverSession?.authenticated}
              ✅ Authenticated ({authState.serverSession.email})
            {:else}
              ❌ Not authenticated
            {/if}
          </div>
          
          <div class="status-item" class:success={authState.clientToken} class:error={!authState.clientToken}>
            <strong>Client Token:</strong>
            {#if authState.clientToken}
              ✅ Valid (expires: {new Date(authState.clientToken.expiryMs).toLocaleTimeString()})
            {:else}
              ❌ No token
            {/if}
          </div>
          
          <div class="status-item">
            <strong>Preferred Mode:</strong> {authState.preferredMode}
          </div>
          
          {#if authState.lastRefresh}
            <div class="status-item">
              <strong>Last Refresh:</strong> {new Date(authState.lastRefresh).toLocaleTimeString()}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Error Display -->
    {#if error}
      <div class="error-message">
        ❌ <strong>Error:</strong> {error}
      </div>
    {/if}

    <!-- Action Buttons -->
    <div class="actions">
      <h3>Authentication Actions</h3>
      <div class="button-grid">
        <Button onclick={handleServerLogin} disabled={isLoading}>
          🖥️ Server Login (Long-lasting)
        </Button>
        
        <Button onclick={handleClientLogin} disabled={isLoading} variant="outlined">
          💻 Client Login (Session-based)
        </Button>
        
        <Button onclick={handleRefreshState} disabled={isLoading} variant="outlined">
          🔄 Refresh State
        </Button>
        
        <Button onclick={handleSignOut} disabled={isLoading} variant="outlined">
          🚪 Sign Out
        </Button>
      </div>
    </div>

    <!-- API Test Actions -->
    <div class="api-tests">
      <h3>API Tests</h3>
      <div class="button-grid">
        <Button onclick={testGetToken} disabled={isLoading || !authState.ready}>
          🎫 Get Access Token
        </Button>
        
        <Button onclick={testGetProfile} disabled={isLoading || !authState.ready}>
          👤 Get Gmail Profile
        </Button>
        
        <Button onclick={testGetLabels} disabled={isLoading || !authState.ready}>
          🏷️ Get Gmail Labels
        </Button>
      </div>
    </div>

    <!-- Results Display -->
    {#if profile}
      <div class="results">
        <h3>Gmail Profile</h3>
        <div class="result-card">
          <p><strong>Email:</strong> {profile.emailAddress}</p>
          <p><strong>Messages Total:</strong> {profile.messagesTotal?.toLocaleString() || 'N/A'}</p>
          <p><strong>Threads Total:</strong> {profile.threadsTotal?.toLocaleString() || 'N/A'}</p>
          <p><strong>History ID:</strong> {profile.historyId || 'N/A'}</p>
        </div>
      </div>
    {/if}

    {#if labels.length > 0}
      <div class="results">
        <h3>Gmail Labels ({labels.length})</h3>
        <div class="labels-grid">
          {#each labels.slice(0, 10) as label}
            <div class="label-item">
              <strong>{label.name}</strong>
              {#if label.type === 'system'}
                <span class="label-type system">System</span>
              {:else}
                <span class="label-type user">User</span>
              {/if}
            </div>
          {/each}
          {#if labels.length > 10}
            <div class="label-item more">
              ... and {labels.length - 10} more labels
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Loading Indicator -->
    {#if isLoading}
      <div class="loading-overlay">
        <CircularProgressIndeterminate />
        <span>Processing...</span>
      </div>
    {/if}
  </Card>

  <!-- Implementation Guide -->
  <Card variant="elevated">
    <h2>📚 How It Works</h2>
    <div class="implementation-guide">
      <h3>Long-Lasting Authentication Strategy:</h3>
      <ol>
        <li><strong>Server-First Approach:</strong> The system checks for a server session first, which uses refresh tokens that can last weeks or months.</li>
        <li><strong>Automatic Token Refresh:</strong> Server-side refresh tokens are automatically renewed without user interaction.</li>
        <li><strong>Client Fallback:</strong> If server session is unavailable, falls back to client-side GIS tokens for immediate access.</li>
        <li><strong>Seamless API Calls:</strong> The <code>makeGmailApiCall()</code> function automatically chooses the best available authentication method.</li>
        <li><strong>Hybrid Benefits:</strong> Combines the persistence of server auth with the UX of client auth.</li>
      </ol>

      <h3>Usage in Your App:</h3>
      <pre><code>{`// Initialize once in your app
await initHybridAuth();

// Make API calls - authentication is handled automatically
const profile = await makeGmailApiCall('/profile');
const labels = await makeGmailApiCall('/labels');

// For long-lasting auth, direct users to server login
await initiateInteractiveAuth('server');`}</code></pre>

      <h3>Key Advantages:</h3>
      <ul>
        <li>✅ <strong>Long-lasting:</strong> Server refresh tokens persist across browser sessions</li>
        <li>✅ <strong>Automatic:</strong> Token refresh happens transparently</li>
        <li>✅ <strong>Resilient:</strong> Falls back gracefully if one method fails</li>
        <li>✅ <strong>Secure:</strong> Refresh tokens are httpOnly cookies, not accessible to JavaScript</li>
        <li>✅ <strong>User-friendly:</strong> Minimal re-authentication required</li>
      </ul>
    </div>
  </Card>
</div>

<style>
  .hybrid-auth-example {
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
    font-family: 'Roboto', sans-serif;
  }

  .auth-status {
    margin-bottom: 20px;
  }

  .status-grid {
    display: grid;
    gap: 10px;
    margin-top: 10px;
  }

  .status-item {
    padding: 10px;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    background-color: #f9f9f9;
  }

  .status-item.loading {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .status-item.success {
    border-color: #4caf50;
    background-color: #e8f5e8;
    color: #2e7d32;
  }

  .status-item.error {
    border-color: #f44336;
    background-color: #ffebee;
    color: #c62828;
  }

  .error-message {
    background-color: #ffebee;
    color: #c62828;
    padding: 15px;
    border-radius: 4px;
    border: 1px solid #f44336;
    margin-bottom: 20px;
  }

  .actions, .api-tests {
    margin-bottom: 20px;
  }

  .button-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px;
    margin-top: 10px;
  }

  .results {
    margin-bottom: 20px;
  }

  .result-card {
    background-color: #f8f9fa;
    padding: 15px;
    border-radius: 4px;
    border: 1px solid #e0e0e0;
  }

  .result-card p {
    margin: 5px 0;
  }

  .labels-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px;
    margin-top: 10px;
  }

  .label-item {
    padding: 10px;
    background-color: #f8f9fa;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .label-item.more {
    font-style: italic;
    color: #666;
  }

  .label-type {
    font-size: 12px;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: normal;
  }

  .label-type.system {
    background-color: #e3f2fd;
    color: #1976d2;
  }

  .label-type.user {
    background-color: #f3e5f5;
    color: #7b1fa2;
  }

  .loading-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: white;
    font-weight: 500;
    z-index: 1000;
  }

  .implementation-guide {
    line-height: 1.6;
  }

  .implementation-guide h3 {
    color: #1976d2;
    margin-top: 20px;
    margin-bottom: 10px;
  }

  .implementation-guide ol, .implementation-guide ul {
    margin-bottom: 15px;
  }

  .implementation-guide li {
    margin-bottom: 8px;
  }

  .implementation-guide code {
    background-color: #f8f9fa;
    padding: 2px 4px;
    border-radius: 3px;
    font-family: 'Courier New', monospace;
    font-size: 14px;
  }

  .implementation-guide pre {
    background-color: #f8f9fa;
    padding: 15px;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 14px;
    margin: 10px 0;
  }

  /* Responsive design */
  @media (max-width: 768px) {
    .hybrid-auth-example {
      padding: 10px;
    }
    
    .button-grid {
      grid-template-columns: 1fr;
    }
    
    .labels-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
