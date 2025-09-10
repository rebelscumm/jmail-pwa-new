<script lang="ts">
  import { onMount } from 'svelte';
  import { writable } from 'svelte/store';
  import Button from '$lib/buttons/Button.svelte';
  import Card from '$lib/containers/Card.svelte';
  import TextField from '$lib/forms/TextField.svelte';
  import CircularProgressIndeterminate from '$lib/forms/CircularProgressIndeterminate.svelte';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { copyGmailDiagnosticsToClipboard } from '$lib/gmail/api';
  import { getFriendlyAIErrorMessage } from '$lib/ai/providers';

  // Diagnostic state
  const diagnostics = writable<any>({});
  const currentStep = writable(0);
  const isLoading = writable(false);
  const logs = writable<string[]>([]);

  // Configuration
  let clientId = '';
  let serverBaseUrl = '';
  let testScopes = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.labels';

  // Type definitions for analysis
  type AnalysisResult = {
    summary: {
      environmentOk: boolean;
      serverReachable: boolean;
      googleReachable: boolean;
      serverAuthWorking: boolean;
      refreshTokenWorking: boolean;
      overallHealth: string;
    };
    recommendations: string[];
    issues: string[];
    strengths: string[];
  };

  type RefreshResult = {
    attempt: number;
    status: number;
    success: boolean;
    timestamp: string;
    expires_in?: number;
    error?: any;
  };

  // Results storage
  let serverAuthResult: any = null;
  let refreshTestResult: any = null;
  let tokenComparisonResult: any = null;
  
  // Check if running in local development
  let isLocalDev = false;

  const steps = [
    'Environment Check',
    'Server Auth Flow',
    'Token Refresh Test',
    'Token Comparison',
    'Final Analysis'
  ];

  function addLog(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warning' ? '⚠️' : 'ℹ️';
    logs.update(l => [...l, `${timestamp} ${prefix} ${message}`]);
  }

  function clearLogs() {
    logs.set([]);
  }

  async function copyLogsToClipboard() {
    try {
      const logText = $logs.join('\n');
      await navigator.clipboard.writeText(logText);
      showSnackbar({ message: 'Logs copied to clipboard!', timeout: 3000 });
    } catch (err) {
      showSnackbar({ message: 'Failed to copy logs', timeout: 3000 });
    }
  }

  async function copyDiagnosticsToClipboard() {
    try {
      const diagText = JSON.stringify({
        diagnostics: $diagnostics,
        serverAuthResult,
        refreshTestResult,
        tokenComparisonResult,
        logs: $logs
      }, null, 2);
      await navigator.clipboard.writeText(diagText);
      showSnackbar({ message: 'Full diagnostics copied to clipboard!', timeout: 3000 });
    } catch (err) {
      showSnackbar({ message: 'Failed to copy diagnostics', timeout: 3000 });
    }
  }

  // Step 1: Environment Check
  async function checkEnvironment() {
    isLoading.set(true);
    addLog('Starting environment check...');
    
    const env = {
      userAgent: navigator.userAgent,
      cookiesEnabled: navigator.cookieEnabled,
      localStorage: typeof localStorage !== 'undefined',
      sessionStorage: typeof sessionStorage !== 'undefined',
      fetch: typeof fetch !== 'undefined',
      location: {
        href: window.location.href,
        origin: window.location.origin,
        protocol: window.location.protocol,
        host: window.location.host
      },
      cookies: document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean),
      googleScript: !!document.getElementById('gis-script'),
      windowGoogle: !!(window as any).google,
      googleOAuth2: !!(window as any).google?.accounts?.oauth2
    };

    // Auto-detect configuration
    const hostname = window.location.hostname;
    const isLocalDev = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.endsWith('.local');
    
    clientId = clientId || 
      import.meta.env.VITE_GOOGLE_CLIENT_ID || 
      '49551890193-e6n262ccj95229ftp2dh6k9s2boo1kip.apps.googleusercontent.com';
      
    serverBaseUrl = serverBaseUrl || import.meta.env.VITE_APP_BASE_URL || window.location.origin;

    // Test server connectivity
    let serverConnectivity = null;
    try {
      addLog('Testing server connectivity...');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${serverBaseUrl}/api/diagnostics`, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      let responseText = '';
      try {
        responseText = await response.text();
      } catch (textErr) {
        responseText = `Failed to read response: ${textErr instanceof Error ? textErr.message : String(textErr)}`;
      }
      
      serverConnectivity = {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        responseText: responseText.slice(0, 500),
        responseLength: responseText.length,
        contentType: response.headers.get('content-type'),
        url: response.url,
        redirected: response.redirected,
        type: response.type,
        requestUrl: `${serverBaseUrl}/api/diagnostics`
      };
      
      if (response.ok) {
        addLog('Server connectivity: OK', 'success');
      } else {
        addLog(`Server connectivity: ${response.status} ${response.statusText}`, 'warning');
      }
    } catch (err) {
      serverConnectivity = { 
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
        stack: err instanceof Error ? err.stack : undefined,
        requestUrl: `${serverBaseUrl}/api/diagnostics`,
        isTimeout: err instanceof Error && err.name === 'AbortError'
      };
      addLog(`Server connectivity failed: ${serverConnectivity.error}`, 'error');
    }

    // Test Google APIs connectivity
    let googleConnectivity = null;
    try {
      addLog('Testing Google APIs connectivity...');
      const response = await fetch('https://www.googleapis.com/oauth2/v2/tokeninfo?access_token=invalid', {
        method: 'GET'
      });
      googleConnectivity = {
        status: response.status,
        reachable: true
      };
      addLog('Google APIs connectivity: OK', 'success');
    } catch (err) {
      googleConnectivity = { error: err instanceof Error ? err.message : String(err), reachable: false };
      addLog(`Google APIs connectivity failed: ${googleConnectivity.error}`, 'error');
    }

    const result = {
        environment: env,
        configuration: {
          clientId: clientId ? 'present' : 'missing',
          clientIdLength: clientId ? clientId.length : 0,
          serverBaseUrl,
          testScopes,
          isDev: isLocalDev,
          hostname: window.location.hostname,
          port: window.location.port,
          protocol: window.location.protocol
        },
        serverConnectivity,
        googleConnectivity,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };

    diagnostics.update(d => ({ ...d, environment: result }));
    addLog('Environment check completed', 'success');
    isLoading.set(false);
  }

  // Step 2: Server Auth Flow
  async function testServerAuth() {
    isLoading.set(true);
    addLog('Starting server auth flow test...');

    try {
      // Step 2a: Initiate server login
      addLog('Testing server login endpoint...');
      const loginUrl = `${serverBaseUrl}/api/google-login?return_to=${encodeURIComponent(window.location.href)}`;
      
      // Test if login endpoint is reachable
      let loginEndpointTest = null;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
        
        const response = await fetch(loginUrl, {
          method: 'GET',
          credentials: 'include',
          redirect: 'manual',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        const responseHeaders = Object.fromEntries(response.headers.entries());
        let responseText = '';
        try {
          responseText = await response.text();
        } catch (textErr) {
          responseText = `Failed to read response: ${textErr instanceof Error ? textErr.message : String(textErr)}`;
        }
        
        loginEndpointTest = {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers: responseHeaders,
          redirected: response.type === 'opaqueredirect',
          type: response.type,
          url: response.url,
          responseText: responseText.slice(0, 500),
          responseLength: responseText.length,
          contentType: response.headers.get('content-type'),
          location: response.headers.get('location'),
          requestUrl: loginUrl
        };
        
        if (response.status === 302 || response.status === 301) {
          addLog(`Login endpoint: redirect to ${responseHeaders.location || 'unknown'}`, 'success');
        } else {
          addLog(`Login endpoint status: ${response.status} ${response.statusText}`, response.status < 400 ? 'success' : 'warning');
        }
      } catch (err) {
        loginEndpointTest = { 
          error: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
          stack: err instanceof Error ? err.stack : undefined,
          requestUrl: loginUrl,
          isTimeout: err instanceof Error && err.name === 'AbortError'
        };
        addLog(`Login endpoint test failed: ${loginEndpointTest.error}`, 'error');
      }

      // Step 2b: Check current session
      addLog('Checking current server session...');
      let sessionCheck = null;
      try {
        const response = await fetch(`${serverBaseUrl}/api/google-me`, {
          method: 'GET',
          credentials: 'include'
        });
        
        // Enhanced diagnostics for response
        const responseHeaders = Object.fromEntries(response.headers.entries());
        const contentType = response.headers.get('content-type');
        
        let responseText = '';
        try {
          responseText = await response.text();
        } catch (textErr) {
          responseText = `Failed to read response text: ${textErr instanceof Error ? textErr.message : String(textErr)}`;
        }
        
        let data = null;
        let parseError = null;
        if (responseText) {
          try {
            data = JSON.parse(responseText);
          } catch (jsonErr) {
            parseError = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
          }
        }
        
        sessionCheck = {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          authenticated: response.ok && data,
          headers: responseHeaders,
          contentType,
          responseText: responseText.slice(0, 500), // Limit size
          responseLength: responseText.length,
          data: response.ok ? data : null,
          parseError,
          url: response.url,
          redirected: response.redirected,
          type: response.type
        };
        
        if (response.ok && data) {
          addLog(`Current session: authenticated as ${data.email || 'unknown'}`, 'success');
        } else {
          addLog(`Current session: not authenticated (${response.status}) - ${parseError || 'No JSON data'}`, 'info');
        }
      } catch (err) {
        sessionCheck = { 
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          name: err instanceof Error ? err.name : undefined
        };
        addLog(`Session check failed: ${sessionCheck.error}`, 'error');
      }

      // Step 2c: Test token refresh if we have a session
      let refreshCheck = null;
      if (sessionCheck?.authenticated) {
        addLog('Testing server token refresh...');
        try {
          const response = await fetch(`${serverBaseUrl}/api/google-refresh`, {
            method: 'POST',
            credentials: 'include'
          });
          const data = await response.json();
          refreshCheck = {
            status: response.status,
            success: response.ok,
            data: response.ok ? data : { error: data }
          };
          if (response.ok) {
            addLog('Token refresh: successful', 'success');
          } else {
            addLog(`Token refresh failed: ${response.status}`, 'warning');
          }
        } catch (err) {
          refreshCheck = { error: err instanceof Error ? err.message : String(err) };
          addLog(`Token refresh test failed: ${refreshCheck.error}`, 'error');
        }
      }

      // Step 2d: Test Gmail proxy
      let gmailProxyCheck = null;
      if (sessionCheck?.authenticated) {
        addLog('Testing Gmail proxy...');
        try {
          const response = await fetch(`${serverBaseUrl}/api/gmail/profile`, {
            method: 'GET',
            credentials: 'include'
          });
          const data = await response.json();
          gmailProxyCheck = {
            status: response.status,
            success: response.ok,
            data: response.ok ? data : { error: data }
          };
          if (response.ok) {
            addLog(`Gmail proxy: working (${data.emailAddress})`, 'success');
          } else {
            addLog(`Gmail proxy failed: ${response.status}`, 'warning');
          }
        } catch (err) {
          gmailProxyCheck = { error: err instanceof Error ? err.message : String(err) };
          addLog(`Gmail proxy test failed: ${gmailProxyCheck.error}`, 'error');
        }
      }

      serverAuthResult = {
        loginEndpointTest,
        sessionCheck,
        refreshCheck,
        gmailProxyCheck,
        timestamp: new Date().toISOString()
      };

      addLog('Server auth flow test completed', 'success');
    } catch (err) {
      serverAuthResult = { error: err instanceof Error ? err.message : String(err) };
      addLog(`Server auth flow test failed: ${serverAuthResult.error}`, 'error');
    }

    isLoading.set(false);
  }

  // Step 3: Token Refresh Test (formerly step 4)
  // Moved up since we removed client auth flow

  async function testTokenRefresh() {
    isLoading.set(true);
    addLog('Starting token refresh test...');

    try {
      // Test server-side refresh token persistence
      addLog('Testing refresh token persistence...');
      
      let refreshTokenTest = null;
      try {
        const response = await fetch(`${serverBaseUrl}/api/google-refresh`, {
          method: 'POST',
          credentials: 'include'
        });
        
        if (response.ok) {
          const data = await response.json();
          refreshTokenTest = {
            success: true,
            expires_in: data.expires_in,
            timestamp: new Date().toISOString()
          };
          addLog(`Refresh token test: successful (expires in ${data.expires_in}s)`, 'success');
        } else {
          const errorData = await response.json();
          refreshTokenTest = {
            success: false,
            status: response.status,
            error: errorData
          };
          addLog(`Refresh token test failed: ${response.status}`, 'warning');
        }
      } catch (err) {
        refreshTokenTest = {
          success: false,
          error: err instanceof Error ? err.message : String(err)
        };
        addLog(`Refresh token test error: ${refreshTokenTest.error}`, 'error');
      }

      // Test multiple refreshes to simulate long-term usage
      addLog('Testing multiple token refreshes...');
      const multipleRefreshResults: RefreshResult[] = [];
      
      for (let i = 0; i < 3; i++) {
        try {
          addLog(`Refresh attempt ${i + 1}/3...`);
          const response = await fetch(`${serverBaseUrl}/api/google-refresh`, {
            method: 'POST',
            credentials: 'include'
          });
          
          const result: RefreshResult = {
            attempt: i + 1,
            status: response.status,
            success: response.ok,
            timestamp: new Date().toISOString()
          };
          
          if (response.ok) {
            const data = await response.json();
            result.expires_in = data.expires_in;
            addLog(`Refresh ${i + 1}: success (${data.expires_in}s)`, 'success');
          } else {
            const errorData = await response.json();
            result.error = errorData;
            addLog(`Refresh ${i + 1}: failed (${response.status})`, 'warning');
          }
          
          multipleRefreshResults.push(result);
          
          // Small delay between requests
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
          const result: RefreshResult = {
            attempt: i + 1,
            status: 0,
            success: false,
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString()
          };
          multipleRefreshResults.push(result);
          addLog(`Refresh ${i + 1}: error (${result.error})`, 'error');
        }
      }

      refreshTestResult = {
        refreshTokenTest,
        multipleRefreshResults,
        summary: {
          totalAttempts: 3,
          successfulAttempts: multipleRefreshResults.filter(r => r.success).length,
          failedAttempts: multipleRefreshResults.filter(r => !r.success).length
        },
        timestamp: new Date().toISOString()
      };

      addLog('Token refresh test completed', 'success');
    } catch (err) {
      refreshTestResult = {
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString()
      };
      addLog(`Token refresh test failed: ${refreshTestResult.error}`, 'error');
    }

    isLoading.set(false);
  }

  // Step 4: Token Comparison (formerly step 5)
  async function compareTokens() {
    isLoading.set(true);
    addLog('Starting token comparison...');

    try {
      // Get server token info
      addLog('Getting server token information...');
      let serverTokenInfo = null;
      try {
        const response = await fetch(`${serverBaseUrl}/api/google-tokeninfo`, {
          method: 'GET',
          credentials: 'include'
        });
        if (response.ok) {
          serverTokenInfo = await response.json();
          addLog('Server token info retrieved', 'success');
        } else {
          const errorData = await response.json();
          serverTokenInfo = { error: errorData, status: response.status };
          addLog(`Server token info failed: ${response.status}`, 'warning');
        }
      } catch (err) {
        serverTokenInfo = { error: err instanceof Error ? err.message : String(err) };
        addLog(`Server token info error: ${serverTokenInfo.error}`, 'error');
      }

      // Note: Client auth removed - focusing on server-side only
      let clientTokenInfo = { hasToken: false, note: 'Client auth flow removed - server-side only' };
      addLog('Client auth flow skipped - focusing on server-side auth', 'info');

      // Compare scopes - skip since client auth is removed
      let scopeComparison = {
        note: 'Client auth removed - server-side only',
        serverScopes: serverTokenInfo?.scope ? serverTokenInfo.scope.split(' ').sort() : [],
        clientScopes: [],
        identical: false,
        serverOnly: serverTokenInfo?.scope ? serverTokenInfo.scope.split(' ') : [],
        clientOnly: []
      };
        
      addLog('Token scopes: server-side only (client auth removed)', 'info');

      // Test server vs client API calls
      addLog('Comparing API call results...');
      let apiComparison = null;
      try {
        // Test server API call
        const serverApiResponse = await fetch(`${serverBaseUrl}/api/gmail/profile`, {
          method: 'GET',
          credentials: 'include'
        });
        
        const serverApiResult = {
          status: serverApiResponse.status,
          success: serverApiResponse.ok,
          data: serverApiResponse.ok ? await serverApiResponse.json() : await serverApiResponse.json()
        };

        apiComparison = {
          server: serverApiResult,
          client: { note: 'Client-side API calls not implemented in this test' }
        };

        if (serverApiResult.success) {
          addLog(`Server API call: success (${serverApiResult.data.emailAddress})`, 'success');
        } else {
          addLog(`Server API call: failed (${serverApiResult.status})`, 'warning');
        }
      } catch (err) {
        apiComparison = {
          error: err instanceof Error ? err.message : String(err)
        };
        addLog(`API comparison error: ${apiComparison.error}`, 'error');
      }

      tokenComparisonResult = {
        serverTokenInfo,
        clientTokenInfo,
        scopeComparison,
        apiComparison,
        timestamp: new Date().toISOString()
      };

      addLog('Token comparison completed', 'success');
    } catch (err) {
      tokenComparisonResult = {
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString()
      };
      addLog(`Token comparison failed: ${tokenComparisonResult.error}`, 'error');
    }

    isLoading.set(false);
  }

  // Step 5: Final Analysis (formerly step 6)
  function generateAnalysis() {
    addLog('Generating final analysis...');

    const analysis: AnalysisResult = {
      summary: {
        environmentOk: !!$diagnostics.environment?.environment,
        serverReachable: $diagnostics.environment?.serverConnectivity?.ok,
        googleReachable: $diagnostics.environment?.googleConnectivity?.reachable,
        serverAuthWorking: serverAuthResult?.sessionCheck?.authenticated,
        refreshTokenWorking: refreshTestResult?.refreshTokenTest?.success,
        overallHealth: 'unknown'
      },
      recommendations: [],
      issues: [],
      strengths: []
    };

    // Analyze results and generate recommendations
    if (!analysis.summary.serverReachable) {
      analysis.issues.push('Server is not reachable - check API deployment');
      analysis.recommendations.push('Verify that the API server is running and accessible');
    }

    if (!analysis.summary.googleReachable) {
      analysis.issues.push('Google APIs are not reachable - network/firewall issue');
      analysis.recommendations.push('Check network connectivity and firewall settings');
    }

    if (analysis.summary.serverAuthWorking) {
      analysis.strengths.push('Server-side authentication is working correctly');
      if (analysis.summary.refreshTokenWorking) {
        analysis.strengths.push('Refresh token mechanism is functional - this enables long-lasting auth');
        analysis.recommendations.push('Focus on using server-side auth for long-lasting sessions');
      }
    } else {
      analysis.issues.push('Server-side authentication not working');
      analysis.recommendations.push('Complete the server-side OAuth flow first');
    }

    // Client auth removed - focusing on server-side for long-lasting tokens
    analysis.strengths.push('Focusing on server-side auth for long-lasting token persistence');

    // Determine overall health
    const healthScore = [
      analysis.summary.environmentOk,
      analysis.summary.serverReachable,
      analysis.summary.googleReachable,
      analysis.summary.serverAuthWorking
    ].filter(Boolean).length;

    if (healthScore >= 3) {
      analysis.summary.overallHealth = 'good';
    } else if (healthScore >= 2) {
      analysis.summary.overallHealth = 'fair';
    } else {
      analysis.summary.overallHealth = 'poor';
    }

    // Long-lasting auth specific recommendations
    if (analysis.summary.serverAuthWorking && analysis.summary.refreshTokenWorking) {
      analysis.recommendations.push('✅ Your server-side auth supports long-lasting tokens (weeks/months)');
      analysis.recommendations.push('Modify client code to use server-side auth instead of GIS for persistence');
      analysis.recommendations.push('Consider implementing hybrid approach: server auth for persistence, client auth for immediate access');
    } else {
      analysis.recommendations.push('❌ Long-lasting auth not fully functional - server-side auth needs to be working');
    }

    diagnostics.update(d => ({ ...d, analysis }));

    addLog('Final analysis completed', 'success');
    addLog(`Overall health: ${analysis.summary.overallHealth}`, 
           analysis.summary.overallHealth === 'good' ? 'success' : 
           analysis.summary.overallHealth === 'fair' ? 'warning' : 'error');
  }

  async function runStep(step: number) {
    currentStep.set(step);
    
    switch (step) {
      case 0:
        await checkEnvironment();
        break;
      case 1:
        await testServerAuth();
        break;
      case 2:
        await testTokenRefresh();
        break;
      case 3:
        await compareTokens();
        break;
      case 4:
        generateAnalysis();
        break;
    }
  }

  async function runAllSteps() {
    clearLogs();
    addLog('Starting comprehensive authentication diagnostic...', 'info');
    
    for (let i = 0; i < steps.length; i++) {
      addLog(`\n=== Step ${i + 1}: ${steps[i]} ===`, 'info');
      await runStep(i);
      await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between steps
    }
    
    addLog('\n🎉 Comprehensive diagnostic completed!', 'success');
    showSnackbar({ message: 'Diagnostic completed! Check results below.', timeout: 5000 });
  }

  function initiateServerLogin() {
    const loginUrl = `${serverBaseUrl}/api/google-login?return_to=${encodeURIComponent(window.location.href)}`;
    addLog(`Redirecting to server login: ${loginUrl}`, 'info');
    window.location.href = loginUrl;
  }

  onMount(() => {
    // Auto-detect configuration
    const hostname = window.location.hostname;
    isLocalDev = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.endsWith('.local');
    
    clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '49551890193-e6n262ccj95229ftp2dh6k9s2boo1kip.apps.googleusercontent.com';
    serverBaseUrl = import.meta.env.VITE_APP_BASE_URL || window.location.origin;
    
    addLog('Auth Debug Wizard loaded', 'info');
    addLog(`Client ID: ${clientId ? 'configured' : 'missing'}`, clientId ? 'success' : 'warning');
    addLog(`Server Base URL: ${serverBaseUrl}`, 'info');
    
    if (isLocalDev) {
      addLog('Local development environment detected', 'info');
      addLog('Using server-side auth flow (recommended for long-lasting tokens)', 'info');
    }

    // Global error reporting to snackbar with Copy action
    try {
      window.addEventListener('error', (e: ErrorEvent) => {
        const message = e?.message || 'An unexpected error occurred';
        showSnackbar({
          message,
          actions: {
            Copy: async () => {
              await copyDiagnosticsToClipboard();
              showSnackbar({ message: 'Full diagnostics copied to clipboard', closable: true });
            }
          },
          closable: true,
          timeout: 6000
        });
      });
      
      window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
        const reason: unknown = (e && 'reason' in e) ? (e as any).reason : undefined;
        const message = reason instanceof Error ? reason.message : String(reason || 'Unhandled promise rejection');
        showSnackbar({
          message,
          actions: {
            Copy: async () => {
              await copyDiagnosticsToClipboard();
              showSnackbar({ message: 'Full diagnostics copied to clipboard', closable: true });
            }
          },
          closable: true,
          timeout: 6000
        });
      });
    } catch (_) {}
  });
</script>

<div class="auth-debug-container">
  <div class="header">
    <h1>🔍 Google Auth Debug Wizard</h1>
    <p>Comprehensive diagnostic tool for debugging and implementing long-lasting Google authorization</p>
  </div>

  <!-- Configuration Panel -->
  <Card variant="elevated">
    <h2>⚙️ Configuration</h2>
    
    {#if isLocalDev}
      <div class="local-dev-notice">
        <h3>ℹ️ Local Development Detected</h3>
        <p>You're running on <code>{window.location.hostname}</code>. This wizard focuses on server-side authentication which works properly in both development and production environments.</p>
        <p><strong>Note:</strong> Client-side auth flow has been removed from this wizard since server-side auth provides the long-lasting tokens you need.</p>
      </div>
    {/if}
    
    <div class="config-grid">
      <TextField 
        bind:value={clientId} 
        label="Google Client ID" 
        placeholder="Your Google OAuth Client ID"
      />
      <TextField 
        bind:value={serverBaseUrl} 
        label="Server Base URL" 
        placeholder="https://your-api-server.com"
      />
      <TextField 
        bind:value={testScopes} 
        label="Test Scopes" 
        placeholder="Space-separated OAuth scopes"
      />
    </div>
  </Card>

  <!-- Control Panel -->
  <Card variant="elevated">
    <h2>🎛️ Controls</h2>
    <div class="controls">
      <Button onclick={runAllSteps} disabled={$isLoading}>
        {#if $isLoading}
          <CircularProgressIndeterminate />
          Running Diagnostics...
        {:else}
          🚀 Run Full Diagnostic
        {/if}
      </Button>
      
      <Button variant="outlined" onclick={clearLogs} disabled={$isLoading}>
        🗑️ Clear Logs
      </Button>
      
      <Button variant="outlined" onclick={copyLogsToClipboard} disabled={$logs.length === 0}>
        📋 Copy Logs
      </Button>
      
      <Button variant="outlined" onclick={copyDiagnosticsToClipboard}>
        📊 Copy Full Diagnostics
      </Button>

      <Button variant="outlined" onclick={initiateServerLogin}>
        🔐 Server Login
      </Button>
    </div>
  </Card>

  <!-- Step Progress -->
  <Card variant="elevated">
    <h2>📋 Diagnostic Steps</h2>
    <div class="steps">
      {#each steps as step, index}
        <div class="step" class:active={$currentStep === index} class:completed={$currentStep > index}>
          <div class="step-number">{index + 1}</div>
          <div class="step-content">
            <div class="step-title">{step}</div>
            <Button 
              variant="outlined" 
              onclick={() => runStep(index)}
              disabled={$isLoading}
            >
              Run Step
            </Button>
          </div>
        </div>
      {/each}
    </div>
  </Card>

  <!-- Live Logs -->
  <Card variant="elevated">
    <h2>📝 Live Logs</h2>
    <div class="logs-container">
      {#if $logs.length === 0}
        <p class="no-logs">No logs yet. Run a diagnostic to see live updates.</p>
      {:else}
        {#each $logs as log}
          <div class="log-entry">{log}</div>
        {/each}
      {/if}
    </div>
  </Card>

  <!-- Results Panels -->
  {#if $diagnostics.environment}
    <Card variant="elevated">
      <h2>🌍 Environment Check Results</h2>
      <pre>{JSON.stringify($diagnostics.environment, null, 2)}</pre>
    </Card>
  {/if}

  {#if serverAuthResult}
    <Card variant="elevated">
      <h2>🖥️ Server Auth Results</h2>
      <pre>{JSON.stringify(serverAuthResult, null, 2)}</pre>
    </Card>
  {/if}

  <!-- Client Auth Results removed - focusing on server-side auth -->

  {#if refreshTestResult}
    <Card variant="elevated">
      <h2>🔄 Token Refresh Results</h2>
      <pre>{JSON.stringify(refreshTestResult, null, 2)}</pre>
    </Card>
  {/if}

  {#if tokenComparisonResult}
    <Card variant="elevated">
      <h2>⚖️ Token Comparison Results</h2>
      <pre>{JSON.stringify(tokenComparisonResult, null, 2)}</pre>
    </Card>
  {/if}

  {#if $diagnostics.analysis}
    <Card variant="elevated">
      <h2>📊 Final Analysis & Recommendations</h2>
      <div class="analysis">
        <div class="summary">
          <h3>Summary</h3>
          <div class="health-indicator health-{$diagnostics.analysis.summary.overallHealth}">
            Overall Health: {$diagnostics.analysis.summary.overallHealth.toUpperCase()}
          </div>
          <ul>
            <li class:success={$diagnostics.analysis.summary.environmentOk} class:error={!$diagnostics.analysis.summary.environmentOk}>
              Environment: {$diagnostics.analysis.summary.environmentOk ? '✅ OK' : '❌ Issues'}
            </li>
            <li class:success={$diagnostics.analysis.summary.serverReachable} class:error={!$diagnostics.analysis.summary.serverReachable}>
              Server: {$diagnostics.analysis.summary.serverReachable ? '✅ Reachable' : '❌ Unreachable'}
            </li>
            <li class:success={$diagnostics.analysis.summary.serverAuthWorking} class:error={!$diagnostics.analysis.summary.serverAuthWorking}>
              Server Auth: {$diagnostics.analysis.summary.serverAuthWorking ? '✅ Working' : '❌ Not Working'}
            </li>
            <li class:success={$diagnostics.analysis.summary.refreshTokenWorking} class:error={!$diagnostics.analysis.summary.refreshTokenWorking}>
              Refresh Token: {$diagnostics.analysis.summary.refreshTokenWorking ? '✅ Working' : '❌ Not Working'}
            </li>
            <li class="info">
              Client Auth: ⏭️ Skipped (focusing on server-side for long-lasting tokens)
            </li>
          </ul>
        </div>

        {#if $diagnostics.analysis.strengths.length > 0}
          <div class="strengths">
            <h3>✅ Strengths</h3>
            <ul>
              {#each $diagnostics.analysis.strengths as strength}
                <li class="success">{strength}</li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if $diagnostics.analysis.issues.length > 0}
          <div class="issues">
            <h3>❌ Issues Found</h3>
            <ul>
              {#each $diagnostics.analysis.issues as issue}
                <li class="error">{issue}</li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if $diagnostics.analysis.recommendations.length > 0}
          <div class="recommendations">
            <h3>💡 Recommendations</h3>
            <ul>
              {#each $diagnostics.analysis.recommendations as rec}
                <li>{rec}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    </Card>
  {/if}

  <!-- Live Demo -->
  <Card variant="elevated">
    <h2>🧪 Live Demo</h2>
    <p>Want to test the hybrid authentication system? <a href="/auth-test" target="_blank" rel="noopener noreferrer">Open the Auth Test Page</a></p>
  </Card>

  <!-- Implementation Guide -->
  <Card variant="elevated">
    <h2>🛠️ Implementation Guide</h2>
    <div class="implementation-guide">
      <h3>For Long-Lasting Authentication (Weeks/Months):</h3>
      <ol>
        <li><strong>Use Server-Side Auth:</strong> The server-side flow with refresh tokens is designed for long-term persistence</li>
        <li><strong>Complete OAuth Flow:</strong> User must go through the server OAuth flow at least once to get refresh tokens</li>
        <li><strong>Modify Client Code:</strong> Update your client-side auth to check server session first before falling back to GIS</li>
        <li><strong>Implement Hybrid Approach:</strong>
          <ul>
            <li>Check server session on app load</li>
            <li>Use server APIs for Gmail operations when session exists</li>
            <li>Fall back to client-side auth only when server session is invalid</li>
          </ul>
        </li>
        <li><strong>Handle Token Refresh:</strong> Server automatically refreshes tokens as needed</li>
      </ol>

      <h3>Recommended Client-Side Changes:</h3>
      <pre><code>{`// In your auth initialization
async function initAuth() {
  // 1. Check server session first
  try {
    const response = await fetch('/api/google-me', { credentials: 'include' });
    if (response.ok) {
      const userData = await response.json();
      // Server session is valid - use server-side auth
      return { type: 'server', user: userData };
    }
  } catch (e) {
    console.log('Server session check failed:', e);
  }

  // 2. Fall back to client-side GIS auth
  // ... existing GIS initialization code
  return { type: 'client', user: null };
}

// For API calls, prefer server endpoints
async function makeGmailApiCall(endpoint) {
  // Try server proxy first (uses refresh tokens automatically)
  try {
    const response = await fetch(\`/api/gmail\${endpoint}\`, {
      credentials: 'include'
    });
    if (response.ok) {
      return await response.json();
    }
  } catch (e) {
    console.log('Server API failed, falling back to client');
  }

  // Fall back to client-side API with GIS token
  // ... existing client-side API code
}`}</code></pre>
    </div>
  </Card>
</div>

<style>
  .auth-debug-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
    font-family: 'Roboto', sans-serif;
  }

  .header {
    text-align: center;
    margin-bottom: 30px;
  }

  .header h1 {
    color: #1976d2;
    margin-bottom: 10px;
  }

  .config-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 20px;
    margin-bottom: 20px;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .step {
    display: flex;
    align-items: center;
    padding: 15px;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    transition: all 0.2s;
  }

  .step.active {
    border-color: #1976d2;
    background-color: #e3f2fd;
  }

  .step.completed {
    border-color: #4caf50;
    background-color: #e8f5e8;
  }

  .step-number {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background-color: #f5f5f5;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    margin-right: 15px;
  }

  .step.active .step-number {
    background-color: #1976d2;
    color: white;
  }

  .step.completed .step-number {
    background-color: #4caf50;
    color: white;
  }

  .step-content {
    flex: 1;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .step-title {
    font-weight: 500;
  }

  .logs-container {
    max-height: 400px;
    overflow-y: auto;
    background-color: #f8f9fa;
    padding: 15px;
    border-radius: 4px;
    font-family: 'Courier New', monospace;
    font-size: 14px;
  }

  .no-logs {
    color: #666;
    font-style: italic;
    text-align: center;
  }

  .log-entry {
    margin-bottom: 5px;
    line-height: 1.4;
  }

  pre {
    background-color: #f8f9fa;
    padding: 15px;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 12px;
    max-height: 400px;
    overflow-y: auto;
  }

  .analysis {
    display: grid;
    gap: 20px;
  }

  .health-indicator {
    padding: 10px;
    border-radius: 4px;
    font-weight: bold;
    text-align: center;
    margin-bottom: 15px;
  }

  .health-good {
    background-color: #e8f5e8;
    color: #2e7d32;
    border: 1px solid #4caf50;
  }

  .health-fair {
    background-color: #fff3e0;
    color: #f57c00;
    border: 1px solid #ff9800;
  }

  .health-poor {
    background-color: #ffebee;
    color: #c62828;
    border: 1px solid #f44336;
  }

  .analysis ul {
    list-style: none;
    padding: 0;
  }

  .analysis li {
    padding: 5px 0;
    border-left: 3px solid #e0e0e0;
    padding-left: 10px;
    margin-bottom: 5px;
  }

  .analysis li.success {
    border-left-color: #4caf50;
    color: #2e7d32;
  }

  .analysis li.error {
    border-left-color: #f44336;
    color: #c62828;
  }

  .analysis li.info {
    border-left-color: #2196f3;
    color: #1976d2;
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

  .implementation-guide code {
    background-color: #f8f9fa;
    padding: 2px 4px;
    border-radius: 3px;
    font-family: 'Courier New', monospace;
  }

  .implementation-guide pre {
    margin-top: 10px;
  }

  .local-dev-notice {
    background-color: #fff3cd;
    border: 1px solid #ffeaa7;
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 20px;
    color: #856404;
  }

  .local-dev-notice h3 {
    color: #856404;
    margin-top: 0;
  }

  .local-dev-notice code {
    background-color: #f8f9fa;
    padding: 2px 6px;
    border-radius: 3px;
    font-family: 'Courier New', monospace;
  }


  /* Responsive design */
  @media (max-width: 768px) {
    .auth-debug-container {
      padding: 10px;
    }
    
    .config-grid {
      grid-template-columns: 1fr;
    }
    
    .controls {
      flex-direction: column;
    }
    
    .step-content {
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
    }
  }
</style>
