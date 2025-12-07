<script lang="ts">
/**
 * SyncButton - MD3-compliant sync/refresh button with server status feedback
 * 
 * Provides world-class UX with:
 * - Visual status indicators (spinning, error badge, offline icon)
 * - Human-friendly error messages via snackbar
 * - Automatic retry with exponential backoff
 * - Responsive feedback during sync operations
 */
import { onMount } from 'svelte';
import Button from '$lib/buttons/Button.svelte';
import Icon from '$lib/misc/_icon.svelte';
import { show as showSnackbar } from '$lib/containers/snackbar';
import { 
  serverStatus, 
  statusMessage, 
  performHealthCheck, 
  markOnline, 
  markError,
  resetErrorState,
  type ServerState 
} from '$lib/stores/server-status';
import iconSync from '@ktibow/iconset-material-symbols/sync';
import iconCloudOff from '@ktibow/iconset-material-symbols/cloud-off';
import iconError from '@ktibow/iconset-material-symbols/error';
import iconWifiOff from '@ktibow/iconset-material-symbols/wifi-off';
import iconRefresh from '@ktibow/iconset-material-symbols/refresh';

interface Props {
  /** Callback when sync is requested */
  onSync?: () => Promise<void>;
  /** Whether a sync is in progress (controlled externally) */
  syncing?: boolean;
  /** Compact mode (icon only) */
  compact?: boolean;
  /** Button variant */
  variant?: 'filled' | 'outlined' | 'text' | 'tonal';
}

let { 
  onSync, 
  syncing = false, 
  compact = false,
  variant = 'outlined' 
}: Props = $props();

let internalSyncing = $state(false);
let lastSyncAttempt = $state<number | null>(null);
let showRetryHint = $state(false);

// Combine external and internal syncing states
const isSpinning = $derived(syncing || internalSyncing || $serverStatus.state === 'checking');

// Determine button icon based on state
const buttonIcon = $derived(() => {
  if ($serverStatus.state === 'offline') return iconWifiOff;
  if ($serverStatus.state === 'unreachable' || $serverStatus.state === 'error') return iconCloudOff;
  return iconSync;
});

// Determine if we should show an error indicator
const hasError = $derived(
  $serverStatus.state === 'offline' || 
  $serverStatus.state === 'unreachable' || 
  $serverStatus.state === 'error'
);

// Determine button color variant based on state
const effectiveVariant = $derived(() => {
  if (hasError) return 'outlined';
  return variant;
});

async function handleClick() {
  if (isSpinning) return;
  
  lastSyncAttempt = Date.now();
  internalSyncing = true;
  resetErrorState();
  
  try {
    // First, check if server is reachable
    const state = await performHealthCheck();
    
    if (state === 'offline') {
      showSnackbar({
        message: '📵 You\'re offline',
        timeout: 5000,
        closable: true,
        actions: {
          'Retry': () => handleClick()
        }
      });
      return;
    }
    
    if (state === 'unreachable') {
      showSnackbar({
        message: '🔌 Server is unavailable',
        timeout: 6000,
        closable: true,
        actions: {
          'Retry': () => handleClick(),
          'Details': () => showErrorDetails()
        }
      });
      return;
    }
    
    if (state === 'error') {
      showSnackbar({
        message: '⚠️ Server error occurred',
        timeout: 6000,
        closable: true,
        actions: {
          'Retry': () => handleClick(),
          'Details': () => showErrorDetails()
        }
      });
      return;
    }
    
    if (state === 'auth-error') {
      showSnackbar({
        message: '🔐 Session expired - please sign in again',
        timeout: null,
        closable: true,
        actions: {
          'Sign In': async () => {
            try {
              const { sessionManager } = await import('$lib/auth/session-manager');
              await sessionManager.forceReauth();
            } catch (e) {
              console.error('[SyncButton] Reauth failed:', e);
            }
          }
        }
      });
      return;
    }
    
    // Server is online, proceed with sync
    if (onSync) {
      try {
        await onSync();
        markOnline();
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        handleSyncError(err);
      }
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    handleSyncError(err);
  } finally {
    internalSyncing = false;
  }
}

function handleSyncError(err: Error) {
  console.error('[SyncButton] Sync error:', err);
  
  // Categorize the error
  const message = err.message.toLowerCase();
  
  if (message.includes('network') || message.includes('fetch') || message.includes('net::')) {
    markError('Network error', undefined);
    showSnackbar({
      message: '🔌 Network error - check your connection',
      timeout: 6000,
      closable: true,
      actions: {
        'Retry': () => handleClick()
      }
    });
  } else if (message.includes('timeout') || message.includes('timed out')) {
    markError('Request timeout', undefined);
    showSnackbar({
      message: '⏱️ Request timed out - server may be busy',
      timeout: 6000,
      closable: true,
      actions: {
        'Retry': () => handleClick()
      }
    });
  } else if (message.includes('401') || message.includes('unauthorized')) {
    markError('Session expired', 401);
    showSnackbar({
      message: '🔐 Session expired - please sign in again',
      timeout: null,
      closable: true,
      actions: {
        'Sign In': async () => {
          try {
            const { sessionManager } = await import('$lib/auth/session-manager');
            await sessionManager.forceReauth();
          } catch (e) {
            console.error('[SyncButton] Reauth failed:', e);
          }
        }
      }
    });
  } else if (message.includes('500') || message.includes('502') || message.includes('503')) {
    const code = message.match(/\d{3}/)?.[0];
    markError('Server error', code ? parseInt(code) : 500);
    showSnackbar({
      message: '⚠️ Server error - please try again later',
      timeout: 6000,
      closable: true,
      actions: {
        'Retry': () => handleClick(),
        'Details': () => showErrorDetails()
      }
    });
  } else {
    markError(err.message, undefined);
    showSnackbar({
      message: `❌ Sync failed: ${err.message.slice(0, 50)}${err.message.length > 50 ? '...' : ''}`,
      timeout: 6000,
      closable: true,
      actions: {
        'Retry': () => handleClick(),
        'Copy Error': async () => {
          try {
            await navigator.clipboard.writeText(err.message + '\n' + err.stack);
            showSnackbar({ message: 'Error copied to clipboard', timeout: 2000 });
          } catch {
            console.log('Error details:', err);
            showSnackbar({ message: 'Error logged to console', timeout: 2000 });
          }
        }
      }
    });
  }
}

function showErrorDetails() {
  const status = $serverStatus;
  const msg = $statusMessage;
  
  showSnackbar({
    message: `${msg.title}\n\n${msg.description}\n\nLast error: ${status.lastError || 'Unknown'}\nRetry count: ${status.retryCount}`,
    timeout: 10000,
    closable: true,
    actions: {
      'Copy Diagnostics': async () => {
        try {
          const diagnostics = {
            serverStatus: status,
            timestamp: new Date().toISOString(),
            userAgent: navigator.userAgent,
            online: navigator.onLine
          };
          await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
          showSnackbar({ message: 'Diagnostics copied', timeout: 2000 });
        } catch {
          showSnackbar({ message: 'Failed to copy', timeout: 2000 });
        }
      },
      'Retry': () => handleClick()
    }
  });
}

// Generate accessible label based on state
const ariaLabel = $derived(() => {
  if (isSpinning) return 'Syncing...';
  if ($serverStatus.state === 'offline') return 'Offline - tap to retry when connected';
  if ($serverStatus.state === 'unreachable') return 'Server unavailable - tap to retry';
  if ($serverStatus.state === 'error') return 'Server error - tap to retry';
  return 'Sync with server';
});

// Show retry hint after a delay when there's an error
$effect(() => {
  if (hasError && !isSpinning) {
    const id = setTimeout(() => { showRetryHint = true; }, 3000);
    return () => clearTimeout(id);
  } else {
    showRetryHint = false;
  }
});

// Auto-check server status on mount
onMount(() => {
  // Only check if we haven't checked recently
  const status = $serverStatus;
  if (!status.lastCheck || Date.now() - status.lastCheck > 60000) {
    performHealthCheck();
  }
});
</script>

<div class="sync-button-wrapper" class:has-error={hasError} class:spinning={isSpinning}>
  <Button 
    variant={effectiveVariant()}
    iconType="full"
    onclick={handleClick}
    disabled={isSpinning}
    aria-label={ariaLabel()}
    title={$statusMessage.description}
  >
    <div class="icon-container" class:spin={isSpinning}>
      <Icon icon={buttonIcon()} />
    </div>
    {#if !compact}
      <span class="label">
        {#if isSpinning}
          Syncing...
        {:else if $serverStatus.state === 'offline'}
          Offline
        {:else if hasError}
          Retry
        {:else}
          Sync
        {/if}
      </span>
    {/if}
  </Button>
  
  {#if hasError && !isSpinning}
    <div class="error-badge" aria-hidden="true">
      <Icon icon={iconError} />
    </div>
  {/if}
  
  {#if showRetryHint && hasError && !isSpinning}
    <div class="retry-hint" role="status">
      Tap to retry
    </div>
  {/if}
</div>

<style>
  .sync-button-wrapper {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  
  .icon-container {
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.2s ease;
  }
  
  .icon-container.spin {
    animation: spin 1s linear infinite;
  }
  
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  
  .label {
    margin-inline-start: 0.25rem;
  }
  
  .error-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: rgb(var(--m3-scheme-error));
    color: rgb(var(--m3-scheme-on-error));
    border-radius: 50%;
    font-size: 12px;
    pointer-events: none;
    animation: pulse 2s ease-in-out infinite;
  }
  
  .error-badge :global(svg) {
    width: 12px;
    height: 12px;
  }
  
  @keyframes pulse {
    0%, 100% { 
      transform: scale(1);
      opacity: 1;
    }
    50% { 
      transform: scale(1.1);
      opacity: 0.8;
    }
  }
  
  .retry-hint {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 4px;
    padding: 4px 8px;
    background-color: rgb(var(--m3-scheme-surface-container-highest));
    color: rgb(var(--m3-scheme-on-surface));
    border-radius: var(--m3-util-rounding-small, 4px);
    font-size: 0.75rem;
    white-space: nowrap;
    opacity: 0;
    animation: fadeIn 0.3s ease forwards;
    pointer-events: none;
    z-index: 10;
  }
  
  @keyframes fadeIn {
    to { opacity: 1; }
  }
  
  /* Error state styling */
  .has-error :global(.m3-container) {
    border-color: rgb(var(--m3-scheme-error)) !important;
  }
  
  .has-error :global(.m3-container:not(:disabled)) {
    color: rgb(var(--m3-scheme-error)) !important;
  }
  
  /* Spinning state - subtle background pulse */
  .spinning :global(.m3-container) {
    background-color: rgb(var(--m3-scheme-primary-container)) !important;
  }
</style>




