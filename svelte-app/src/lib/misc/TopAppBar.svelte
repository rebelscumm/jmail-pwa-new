<script lang="ts">
  import { get } from 'svelte/store';
  import { syncState } from '$lib/stores/queue';
import { settings } from '$lib/stores/settings';
import { precomputeStatus } from '$lib/stores/precompute';
  import { undoLast, redoLast, getUndoHistory, getRedoHistory } from '$lib/queue/intents';
  import Button from '$lib/buttons/Button.svelte';
  import SplitButton from '$lib/buttons/SplitButton.svelte';
  import SyncButton from '$lib/components/SyncButton.svelte';
  import TextField from '$lib/forms/TextField.svelte';
  import Menu from '$lib/containers/Menu.svelte';
  import MenuItem from '$lib/containers/MenuItem.svelte';
  import Chip from '$lib/forms/Chip.svelte';
  import Icon from '$lib/misc/_icon.svelte';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { copyGmailDiagnosticsToClipboard, getAndClearGmailDiagnostics } from '$lib/gmail/api';
  import Dialog from '$lib/containers/Dialog.svelte';
  import { appVersion, buildId } from '$lib/utils/version';
  import { checkForUpdateOnce, hardReloadNow } from '$lib/update/checker';
  import { signOut, acquireTokenInteractive, resolveGoogleClientId, initAuth, getAuthDiagnostics } from '$lib/gmail/auth';
  import { threads as threadsStore } from '$lib/stores/threads';
  import { serverStatus, markOnline, markError, performHealthCheck } from '$lib/stores/server-status';
  import iconSearch from '@ktibow/iconset-material-symbols/search';
  import iconMore from '@ktibow/iconset-material-symbols/more-vert';
  import iconInfo from '@ktibow/iconset-material-symbols/info';
  import iconUndo from '@ktibow/iconset-material-symbols/undo';
  import iconRedo from '@ktibow/iconset-material-symbols/redo';
  import iconSync from '@ktibow/iconset-material-symbols/sync';
  import iconSettings from '@ktibow/iconset-material-symbols/settings';
  import iconRefresh from '@ktibow/iconset-material-symbols/refresh';
  import iconLogout from '@ktibow/iconset-material-symbols/logout';
  import iconBack from '@ktibow/iconset-material-symbols/chevron-left';
  import iconCopy from '@ktibow/iconset-material-symbols/content-copy-outline';
  import iconInbox from '@ktibow/iconset-material-symbols/inbox';
  import iconMarkEmailUnread from '@ktibow/iconset-material-symbols/mark-email-unread';
  import iconSmartToy from '@ktibow/iconset-material-symbols/smart-toy';
  import iconClose from '@ktibow/iconset-material-symbols/close';
  import iconSparkles from '@ktibow/iconset-material-symbols/auto-awesome';
  import iconLogs from '@ktibow/iconset-material-symbols/article';
  import iconNotifications from '@ktibow/iconset-material-symbols/notifications';
  import iconTerminal from '@ktibow/iconset-material-symbols/terminal';
  import iconDiagnostics from '@ktibow/iconset-material-symbols/bug-report';
  import iconSchool from '@ktibow/iconset-material-symbols/school';
  import { onMount, tick } from 'svelte';
  import { cacheVersion as cacheVersionStore } from '$lib/utils/cacheVersion';
  import { trailingHolds } from '$lib/stores/holds';
  import { labels as labelsStore } from '$lib/stores/labels';
  import { counts } from '$lib/stores/counts';
  import { optimisticCounters } from '$lib/stores/optimistic-counters';
  let { onSyncNow, backHref, backLabel }: { onSyncNow?: () => void; backHref?: string; backLabel?: string } = $props();
  let overflowDetails: HTMLDetailsElement;
  let aboutOpen = $state(false);
  let comprehensiveRefreshInProgress = $state(false);
  let notificationsOpen = $state(false);
  let notifications = $state([] as any[]);
  let __menuPushed = $state(false);
  let __menuPopHandler: ((e: PopStateEvent) => void) | null = $state(null);
  function toggleOverflow(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    
    const d = overflowDetails || (e.currentTarget as HTMLElement).closest('details') as HTMLDetailsElement | null;
    if (!d) return;
    
    // Android-specific handling for details/summary toggle
    const isAndroid = /Android/i.test(navigator.userAgent);
    
    if (isAndroid) {
      try {
        // For Android, use setTimeout to ensure the toggle happens after event handling
        const currentState = d.open;
        setTimeout(() => {
          try {
            d.open = !currentState;
            // Force a reflow to ensure the change takes effect
            d.offsetHeight;
            console.log('[TopAppBar] Android overflow toggle:', d.open ? 'opened' : 'closed');
          } catch (e1) {
            console.error('[TopAppBar] Android toggle failed:', e1);
            // Emergency fallback - try direct attribute manipulation
            try {
              if (currentState) {
                d.removeAttribute('open');
              } else {
                d.setAttribute('open', '');
              }
            } catch (e2) {
              console.error('[TopAppBar] Attribute fallback failed:', e2);
            }
          }
        }, 16);
      } catch (e) {
        console.error('[TopAppBar] Android overflow setup failed:', e);
        // Fallback to original behavior
        d.open = !d.open;
      }
    } else {
      // Non-Android behavior (original)
      d.open = !d.open;
    }
  }
  async function doComprehensiveRefresh() {
    if (comprehensiveRefreshInProgress) {
      showSnackbar({ message: 'Sync already in progress...', timeout: 2000 });
      return;
    }
    
    comprehensiveRefreshInProgress = true;
    console.log('[TopAppBar] ===== COMPREHENSIVE REFRESH STARTED =====');
    
    try {
      // Step 0: Check if we're online first
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        showSnackbar({
          message: '📵 You\'re offline - connect to the internet to sync',
          timeout: 5000,
          closable: true,
          actions: {
            'Retry': () => doComprehensiveRefresh()
          }
        });
        return;
      }
      
      // Step 1: Show initial message with progress indicator
      showSnackbar({ message: '🔄 Starting inbox refresh…', timeout: null });
      
      // Step 2: Check server health before proceeding
      console.log('[TopAppBar] Step 0: Checking server health...');
      try {
        const serverState = await performHealthCheck();
        if (serverState === 'offline') {
          showSnackbar({
            message: '📵 You\'re offline - check your connection',
            timeout: 6000,
            closable: true,
            actions: { 'Retry': () => doComprehensiveRefresh() }
          });
          return;
        }
        if (serverState === 'unreachable') {
          showSnackbar({
            message: '🔌 Server is unavailable - it might be down for maintenance',
            timeout: 8000,
            closable: true,
            actions: {
              'Retry': () => doComprehensiveRefresh(),
              'Diagnostics': () => { location.href = '/diagnostics'; }
            }
          });
          return;
        }
        if (serverState === 'error') {
          showSnackbar({
            message: '⚠️ Server error - please try again in a few minutes',
            timeout: 8000,
            closable: true,
            actions: {
              'Retry': () => doComprehensiveRefresh(),
              'Diagnostics': () => { location.href = '/diagnostics'; }
            }
          });
          return;
        }
      } catch (healthErr) {
        console.warn('[TopAppBar] Health check failed:', healthErr);
        // Continue anyway - maybe it's just the health endpoint that's missing
      }
      
      // Step 3: Refresh authentication session
      console.log('[TopAppBar] Step 1: Refreshing session...');
      try {
        const { sessionManager } = await import('$lib/auth/session-manager');
        await sessionManager.refreshSession();
        console.log('[TopAppBar] Step 1: Session refresh completed');
        markOnline(); // Mark server as online since API call succeeded
        showSnackbar({ message: '✓ Session refreshed', timeout: 1500 });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.warn('[TopAppBar] Step 1: Session refresh failed:', e);
        
        // Check if this is a network/server error
        if (isServerError(err)) {
          handleServerError(err, 'Session refresh');
          return;
        }
        
        showSnackbar({ message: 'Session refresh skipped (may not be needed)', timeout: 1500 });
      }
      
      // Step 4: Sync pending queue operations first
      console.log('[TopAppBar] Step 2: Syncing pending operations...');
      try {
        const { syncNow } = await import('$lib/stores/queue');
        await syncNow();
        console.log('[TopAppBar] Step 2: Queue sync completed');
        markOnline();
        showSnackbar({ message: '✓ Pending operations synced', timeout: 1500 });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error('[TopAppBar] Step 2: Queue sync failed:', e);
        
        if (isServerError(err)) {
          handleServerError(err, 'Queue sync');
          return;
        }
        
        showSnackbar({ message: '⚠️ Some pending operations may not have synced', timeout: 2000 });
      }
      
      // Step 4: Reset slid rows and clear visual holds to prepare for fresh data
      try {
        console.log('[TopAppBar] Step 3: Resetting slid rows and clearing holds...');
        // Cancel any pending disappear timer
        try {
          const w = window as any;
          if (w.__jmailDisappearTimer) {
            clearTimeout(w.__jmailDisappearTimer);
            w.__jmailDisappearTimer = null;
          }
        } catch {}
        // Reset slid rows back to their normal position
        window.dispatchEvent(new CustomEvent('jmail:resetSlidRows'));
        const { clearAllHolds } = await import('$lib/stores/holds');
        clearAllHolds();
        console.log('[TopAppBar] Step 3: Slid rows reset and holds cleared');
      } catch (e) {
        console.error('[TopAppBar] Step 3: Failed to reset slid rows/clear holds:', e);
      }
      
      // Step 5: Get pre-sync counts for comparison
      let preCount = 0;
      let preUnreadCount = 0;
      try {
        const { getDB } = await import('$lib/db/indexeddb');
        const db = await getDB();
        const threads = await db.getAll('threads');
        const inboxThreads = threads.filter((t: any) => 
          Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
        );
        preCount = inboxThreads.length;
        preUnreadCount = inboxThreads.filter((t: any) => 
          Array.isArray(t.labelIds) && t.labelIds.includes('UNREAD')
        ).length;
        console.log('[TopAppBar] Pre-sync: ', preCount, 'inbox threads,', preUnreadCount, 'unread');
      } catch (e) {
        console.warn('[TopAppBar] Could not get pre-sync counts:', e);
      }
      
      // Step 6: Perform authoritative inbox sync
      console.log('[TopAppBar] Step 4: Performing authoritative inbox sync...');
      // Only show syncing snackbar briefly or let it be replaced by success/failure
      // We don't use timeout: null anymore to avoid it getting stuck
      const syncingSnack = showSnackbar({ message: '📨 Syncing with Gmail server…', timeout: 2000 });
      
      const isInboxPage = typeof window !== 'undefined' && window.location.pathname.includes('/inbox');
      if (isInboxPage) {
        try {
          // Call the sync function directly from inbox page if available
          const w = window as any;
          if (typeof w.__performAuthoritativeSync === 'function') {
            console.log('[TopAppBar] Calling __performAuthoritativeSync directly');
            await w.__performAuthoritativeSync();
          } else {
            console.log('[TopAppBar] __performAuthoritativeSync not available, dispatching event');
            // Fallback: dispatch event and wait a bit
            window.dispatchEvent(new CustomEvent('jmail:performAuthoritativeSync'));
            // Wait for sync to complete (listen for completion event or timeout)
            await new Promise((resolve, reject) => {
              let resolved = false;
              const successHandler = () => {
                if (!resolved) {
                  resolved = true;
                  resolve(undefined);
                }
              };
              const errorHandler = (e: Event) => {
                if (!resolved) {
                  resolved = true;
                  const detail = (e as CustomEvent).detail;
                  reject(new Error(detail?.error || 'Sync failed'));
                }
              };
              window.addEventListener('jmail:authSyncComplete', successHandler, { once: true });
              window.addEventListener('jmail:authSyncError', errorHandler, { once: true });
              // Timeout after 60 seconds
              setTimeout(() => {
                if (!resolved) {
                  resolved = true;
                  window.removeEventListener('jmail:authSyncComplete', successHandler);
                  window.removeEventListener('jmail:authSyncError', errorHandler);
                  reject(new Error('Sync timed out after 60 seconds'));
                }
              }, 60000);
            });
          }
          console.log('[TopAppBar] Step 4: Authoritative sync completed');
          markOnline();
          // Manually close the syncing snackbar if it hasn't disappeared
          // Wait for any completion event handlers to fire first
          // Note: We can't close it directly without the ID or a close method on the snackbar API
          // but the timeout we set earlier (2000ms) should handle it.
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error('[TopAppBar] Step 4: Authoritative sync failed:', e);
          
          if (isServerError(err)) {
            handleServerError(err, 'Gmail sync');
            return;
          }
          
          showSnackbar({ 
            message: `❌ Sync failed: ${err.message.slice(0, 50)}${err.message.length > 50 ? '...' : ''}`, 
            closable: true,
            timeout: 6000,
            actions: {
              'Retry': () => doComprehensiveRefresh(),
              'Diagnostics': () => { location.href = '/diagnostics'; }
            }
          });
          return;
        }
      } else {
        console.log('[TopAppBar] Not on inbox page, skipping authoritative sync');
        showSnackbar({ message: 'ℹ️ Navigate to Inbox to sync emails', timeout: 2000 });
      }
      
      // Step 7: Refresh label stats to update counters with authoritative Gmail counts
      console.log('[TopAppBar] Step 5: Refreshing label stats from Gmail...');
      try {
        await refreshLabelStats(true); // Force update after authoritative sync
        console.log('[TopAppBar] Step 5: Label stats refreshed successfully');
      } catch (e) {
        console.warn('[TopAppBar] Step 5: Could not refresh label stats:', e);
      }
      
      // Step 8: Get post-sync counts and compare with Gmail
      try {
        const { getDB } = await import('$lib/db/indexeddb');
        const { getLabel } = await import('$lib/gmail/api');
        const db = await getDB();
        const threads = await db.getAll('threads');
        const inboxThreads = threads.filter((t: any) => 
          Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
        );
        const postCount = inboxThreads.length;
        const postUnreadCount = inboxThreads.filter((t: any) => 
          Array.isArray(t.labelIds) && t.labelIds.includes('UNREAD')
        ).length;
        
        // Get Gmail's reported counts for comparison
        let gmailTotal = 0;
        let gmailUnread = 0;
        try {
          const inboxLabel = await getLabel('INBOX');
          gmailTotal = inboxLabel.threadsTotal || 0;
          gmailUnread = inboxLabel.threadsUnread || 0;
        } catch (_) {}
        
        console.log('[TopAppBar] Post-sync:', postCount, 'inbox threads,', postUnreadCount, 'unread');
        console.log('[TopAppBar] Gmail reports:', gmailTotal, 'total,', gmailUnread, 'unread');
        
        const added = Math.max(0, postCount - preCount);
        const removed = Math.max(0, preCount - postCount);
        
        // Build human-friendly message
        let message = '';
        const discrepancy = gmailTotal - postCount;
        
        if (Math.abs(discrepancy) <= 2) {
          // Counts match - show success message
          // No snackbar for success to reduce noise
        } else if (discrepancy > 0) {
          // Gmail has more - might need to fetch more
          // Redundant message removed - we already show a actionable snackbar in inbox/+page.svelte
          console.log(`[TopAppBar] Sync discrepancy: ${discrepancy} missing locally`);
        } else {
          // Local has more than Gmail - stale threads not removed
          // Redundant message removed - we already show a actionable snackbar in inbox/+page.svelte
          console.log(`[TopAppBar] Sync discrepancy: Local has ${Math.abs(discrepancy)} more threads`);
        }
      } catch (e) {
        console.warn('[TopAppBar] Could not get post-sync counts:', e);
      }
      
      // Step 9: Dispatch global refresh event for other components
      console.log('[TopAppBar] Step 6: Dispatching global refresh event...');
      window.dispatchEvent(new CustomEvent('jmail:refresh'));
      console.log('[TopAppBar] Step 6: Global refresh event dispatched');
      
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error('[TopAppBar] Comprehensive refresh failed:', e);
      
      if (isServerError(err)) {
        handleServerError(err, 'Inbox refresh');
      } else {
        showSnackbar({ 
          message: `❌ Refresh failed: ${err.message.slice(0, 50)}${err.message.length > 50 ? '...' : ''}`, 
          closable: true,
          timeout: 6000,
          actions: {
            'Retry': () => doComprehensiveRefresh(),
            'Copy Error': async () => {
              try {
                await navigator.clipboard.writeText(err.message + '\n' + err.stack);
                showSnackbar({ message: 'Error copied', timeout: 2000 });
              } catch {
                showSnackbar({ message: 'Check console for details', timeout: 2000 });
              }
            }
          }
        });
      }
    } finally {
      comprehensiveRefreshInProgress = false;
    }
    
    onSyncNow && onSyncNow();
    console.log('[TopAppBar] ===== COMPREHENSIVE REFRESH COMPLETE =====');
  }

  /**
   * Helper: Check if an error indicates a server/network issue
   */
  function isServerError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('failed to fetch') ||
      msg.includes('networkerror') ||
      msg.includes('net::') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound')
    );
  }
  
  /**
   * Helper: Handle server errors with human-friendly messages
   */
  function handleServerError(err: Error, context: string) {
    const msg = err.message.toLowerCase();
    
    let userMessage: string;
    let emoji: string;
    
    if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('net::')) {
      emoji = '🔌';
      userMessage = 'Server is not responding';
      markError('Network error - server unreachable', undefined);
    } else if (msg.includes('timeout') || msg.includes('timed out')) {
      emoji = '⏱️';
      userMessage = 'Request timed out - server may be busy';
      markError('Request timeout', undefined);
    } else if (msg.includes('503')) {
      emoji = '🔧';
      userMessage = 'Server is temporarily unavailable (maintenance?)';
      markError('Service unavailable', 503);
    } else if (msg.includes('502') || msg.includes('504')) {
      emoji = '🌐';
      userMessage = 'Gateway error - server infrastructure issue';
      markError('Gateway error', msg.includes('502') ? 502 : 504);
    } else if (msg.includes('500')) {
      emoji = '⚠️';
      userMessage = 'Server error - something went wrong';
      markError('Internal server error', 500);
    } else {
      emoji = '❌';
      userMessage = `${context} failed`;
      markError(err.message, undefined);
    }
    
    console.error(`[TopAppBar] ${context} server error:`, err);
    
    showSnackbar({
      message: `${emoji} ${userMessage}`,
      timeout: 8000,
      closable: true,
      actions: {
        'Retry': () => doComprehensiveRefresh(),
        'Copy Error': async () => {
          try {
            const diagnostics = {
              context,
              error: err.message,
              stack: err.stack,
              timestamp: new Date().toISOString(),
              online: navigator.onLine,
              serverStatus: $serverStatus
            };
            await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
            showSnackbar({ message: 'Error details copied', timeout: 2000 });
          } catch {
            console.log('Error details:', err);
            showSnackbar({ message: 'Logged to console', timeout: 2000 });
          }
        }
      }
    });
  }

  function handleBack() {
    try {
      const hasReferrer = typeof document !== 'undefined' && !!document.referrer;
      const canGoBack = hasReferrer && history.length > 1;
      if (canGoBack) { history.back(); return; }
    } catch {}
    if (backHref) { location.href = backHref; }
  }

  async function doPrecompute() {
    console.log('[TopAppBar] Precompute function called');
    try {
      const { settings } = await import('$lib/stores/settings');
      const s = get(settings);
      
      if (!s?.aiApiKey) {
        showSnackbar({ 
          message: 'AI API key is missing. Set it in Settings > API', 
          timeout: 6000,
          actions: {
            'Go to Settings': () => { location.href = '/settings'; }
          }
        });
        return;
      }
      
      // Check if there are any threads to process
      try {
        const { getDB } = await import('$lib/db/indexeddb');
        const db = await getDB();
        const threadCount = await db.count('threads');
        if (threadCount === 0) {
          showSnackbar({ 
            message: 'No email threads found. Sync your inbox first.', 
            timeout: 4000,
            actions: {
              'Sync Now': () => { if (onSyncNow) onSyncNow(); }
            }
          });
          return;
        }
      } catch (e) {
        console.error('Error checking thread count:', e);
      }
      
      showSnackbar({ message: 'Starting precompute...' });
      const { precomputeNow } = await import('$lib/ai/precompute');
      const result: any = await precomputeNow(100);
      // If the precompute module returned a skip reason, surface it to the user and offer a force-run
      if (result && result.__reason) {
        showSnackbar({
          message: `Precompute skipped: ${result.__reason}`,
          timeout: 8000,
          actions: {
            'Force run': async () => {
              showSnackbar({ message: 'Forcing precompute now…', timeout: 2000 });
              const forced: any = await precomputeNow(100);
              if (forced && forced.processed > 0) showSnackbar({ message: `Precompute complete: ${forced.processed} items processed`, timeout: 4000 });
              else showSnackbar({ message: 'Precompute did not process any items', timeout: 4000 });
            }
          }
        });
      } else if (result && result.processed > 0) {
        showSnackbar({ message: `Precompute complete: ${result.processed} items processed`, timeout: 4000 });
      } else {
        showSnackbar({ message: 'Precompute did not process any items', timeout: 4000 });
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      showSnackbar({ message: `Precompute failed: ${errorMsg}`, timeout: 5000 });
    }
  }

  // Open a simple dialog showing precompute logs (reads from precompute module)
  let precomputeLogsOpen = $state(false);
  let precomputeLogsContent: { ts: number; level: string; message: string }[] = $state([]);
  // MD3-compliant summary dialog state
  let precomputeSummaryOpen = $state(false);
  let precomputeSummary: any = $state(null);
  // Developer tools dialog
  let devToolsOpen = $state(false);

  async function doShowPrecomputeLogs() {
    try {
      const mod = await import('$lib/ai/precompute');
      if (typeof (mod as any).getPrecomputeLogs === 'function') {
        precomputeLogsContent = (mod as any).getPrecomputeLogs();
      } else {
        precomputeLogsContent = [];
      }
      precomputeLogsOpen = true;
      overflowDetails.open = false;
    } catch (e) {
      showSnackbar({ message: `Could not load logs: ${e instanceof Error ? e.message : e}`, timeout: 4000 });
    }
  }


  function doShowAbout() {
    console.log('[TopAppBar] About menu item clicked');
    try {
      if (overflowDetails) overflowDetails.open = false;
      aboutOpen = true;
      console.log('[TopAppBar] About dialog should now be open:', aboutOpen);
    } catch (e) {
      console.error('[TopAppBar] Error opening About dialog:', e);
    }
  }

  async function doRunRecruitingModeration() {
    try {
      overflowDetails.open = false;
      const s = get(settings);
      
      if (!s?.precomputeSummaries) {
        showSnackbar({ 
          message: 'Precompute is disabled. Enable it in Settings to use recruiting moderation.', 
          timeout: 6000,
          actions: {
            'Go to Settings': () => { location.href = '/settings'; }
          }
        });
        return;
      }
      
      if (!s?.aiApiKey) {
        showSnackbar({ 
          message: 'AI API key is missing. Set it in Settings > API', 
          timeout: 6000,
          actions: {
            'Go to Settings': () => { location.href = '/settings'; }
          }
        });
        return;
      }
      
      // Check for inbox threads
      try {
        const { getDB } = await import('$lib/db/indexeddb');
        const db = await getDB();
        const allThreads = await db.getAll('threads');
        const inboxThreads = allThreads.filter(t => t.labelIds?.includes('INBOX'));
        
        if (inboxThreads.length === 0) {
          showSnackbar({ 
            message: 'No inbox threads found. Sync your inbox first.', 
            timeout: 4000,
            actions: {
              'Sync Now': () => { if (onSyncNow) onSyncNow(); }
            }
          });
          return;
        }
        
        showSnackbar({ message: `Starting college recruiting moderation for ${inboxThreads.length} inbox threads...`, timeout: 3000 });
      } catch (e) {
        console.error('Error checking inbox threads:', e);
      }
      
      // Run precompute which includes moderation
      console.log('[TopAppBar] Starting college recruiting filter - calling precomputeNow(200, { moderationPriority: true })');
      const { precomputeNow } = await import('$lib/ai/precompute');
      const result: any = await precomputeNow(200, { moderationPriority: true }); // Process more threads and prioritize moderation
      console.log('[TopAppBar] Precompute completed:', result);
      
      if (result && result.processed > 0) {
        showSnackbar({ 
          message: `College recruiting moderation complete! Processed ${result.processed} threads. Check Diagnostics for results.`, 
          timeout: 6000,
          actions: {
            'View Results': () => { location.href = '/diagnostics'; }
          }
        });
      } else {
        showSnackbar({ message: 'No threads needed processing', timeout: 4000 });
      }
           } catch (e) {
             const errorMsg = e instanceof Error ? e.message : String(e);
             
             // Provide more helpful error messages for common Gemini issues
             let displayMsg = errorMsg;
             if (errorMsg.includes('Gemini error 404')) {
               displayMsg = 'Gemini API key not found or invalid. Check your API key in Settings > API.';
             } else if (errorMsg.includes('Gemini API key not set')) {
               displayMsg = 'Gemini API key is required. Set it in Settings > API.';
             } else if (errorMsg.includes('Gemini invalid API key')) {
               displayMsg = 'Gemini API key is invalid. Check your API key in Settings > API.';
             }
             
             showSnackbar({ 
               message: `College recruiting moderation failed: ${displayMsg}`, 
               timeout: 6000,
               actions: {
                 'Go to Settings': () => { location.href = '/settings'; }
               }
             });
           }
  }

  async function doShowPrecomputeSummary() {
    try {
      const mod = await import('$lib/ai/precompute');
      const summary = typeof (mod as any).getPrecomputeSummary === 'function' ? (mod as any).getPrecomputeSummary() : null;
      if (!summary) {
        showSnackbar({ message: 'No precompute summary available', timeout: 3000 });
        return;
      }
      summary.reasons = Array.isArray(summary.reasons) ? summary.reasons : [];
      if (!summary.reasons.length) {
        if (summary.total === 0) summary.reasons.push('Precompute has not produced any logs; it may not have run yet.');
        if (summary.errors && summary.errors > 0) summary.reasons.push('AI errors occurred during precompute. Inspect logs for details.');
        summary.reasons.push('Gmail scopes or labels may prevent reading full message bodies required for summaries.');
        summary.reasons.push('Local cache may be out of sync with Gmail server; try Sync to refresh threads.');
      }
      precomputeSummary = summary;
      precomputeSummaryOpen = true;
      overflowDetails.open = false;
    } catch (e) {
      showSnackbar({ message: `Could not load summary: ${e instanceof Error ? e.message : e}`, timeout: 4000 });
    }
  }

  async function doBackfillSummaryVersions() {
    try {
      const ok = confirm('Backfill cached AI summaries for unchanged inbox threads? This will update your local database. Continue?');
      if (!ok) return;
      showSnackbar({ message: 'Backfilling AI summaries...', timeout: null });
      const { backfillSummaryVersions } = await import('$lib/db/indexeddb');
      const res = await backfillSummaryVersions();
      showSnackbar({ message: `Backfilled ${res.updated} of ${res.scanned} threads`, timeout: 5000 });
    } catch (e) {
      showSnackbar({ message: `Backfill failed: ${e instanceof Error ? e.message : String(e)}`, timeout: 6000 });
    }
  }

  let search = $state('');
  let searchOpen = $state(false);
  $effect(() => {
    import('$lib/stores/search').then(m => m.searchQuery.set(search));
  });

  // Show snackbar when a new queue error surfaces; allow copying diagnostics
  let lastShownError: string | undefined = $state();
  $effect(() => {
    const err = $syncState.lastError;
    if (err && err !== lastShownError) {
      lastShownError = err;
      showSnackbar({
        message: err,
        actions: {
          Copy: async () => {
            const ok = await copyGmailDiagnosticsToClipboard({
              reason: 'sync_error',
              lastError: err,
              pendingOps: $syncState.pendingOps,
              lastUpdatedAt: $syncState.lastUpdatedAt
            });
            showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
          }
        },
        closable: true,
        timeout: 6000
      });
    }
  });

  async function onPendingChipClick() {
    if ($syncState.lastError) {
      const ok = await copyGmailDiagnosticsToClipboard({
        reason: 'user_clicked_pending_chip',
        lastError: $syncState.lastError,
        pendingOps: $syncState.pendingOps,
        lastUpdatedAt: $syncState.lastUpdatedAt
      });
      showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
    }
  }

  // Close overflow menu when clicking outside of it
  $effect(() => {
    function handleWindowClick(e: MouseEvent) {
      const d = overflowDetails;
      if (!d || !d.open) return;
      const target = e.target as Node | null;
      if (target && (d === target || d.contains(target))) return;
      d.open = false;
    }
    window.addEventListener('click', handleWindowClick);
    // Manage synthetic history when menu opens/closes
    const manageMenuHistory = () => {
      try {
        const d = overflowDetails;
        const isOpen = !!(d && d.open);
        if (isOpen && !__menuPushed) {
          // Replace manual history handling with centralized helper
          try {
            import('$lib/utils/overlayHistory').then(m => {
              try {
                const handle = m.pushOverlay('menu', () => { const dd = overflowDetails; if (dd && dd.open) dd.open = false; });
                __menuPushed = true;
                __menuPopHandler = (_e: PopStateEvent) => { try { handle.close(); } catch {} };
                window.addEventListener('popstate', __menuPopHandler, { once: true });
              } catch {}
            }).catch(() => {});
          } catch {}
        } else if (!isOpen && __menuPushed) {
          __menuPushed = false;
          if (__menuPopHandler) { window.removeEventListener('popstate', __menuPopHandler); __menuPopHandler = null; }
        }
      } catch {}
    };
    const mo = new MutationObserver(manageMenuHistory);
    if (overflowDetails) mo.observe(overflowDetails, { attributes: true, attributeFilter: ['open'] });
    // Initial sync in case it's opened programmatically
    manageMenuHistory();
    return () => {
      window.removeEventListener('click', handleWindowClick);
      try { mo.disconnect(); } catch {}
      try {
        if (__menuPushed) {
          __menuPushed = false;
          if (__menuPopHandler) { window.removeEventListener('popstate', __menuPopHandler); __menuPopHandler = null; }
          history.back();
        }
      } catch {}
    };
  });

  function formatLastSync(ts?: number): string {
    if (!ts) return '';
    try {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'Just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    } catch {
      return '';
    }
  }

  // Undo/Redo history state
  type HistItem = { id: string; createdAt: number; threadId: string; type: string; description: string };
  let undoItems: HistItem[] = $state([]);
  let redoItems: HistItem[] = $state([]);
  async function refreshUndo() { try { undoItems = await getUndoHistory(10); } catch {} }
  async function refreshRedo() { try { redoItems = await getRedoHistory(10); } catch {} }
  async function doUndo(n: number) {
    await undoLast(n);
    await Promise.all([refreshUndo(), refreshRedo()]);
  }
  async function doRedo(n: number) {
    await redoLast(n);
    await Promise.all([refreshUndo(), refreshRedo()]);
  }
  async function doRelogin() {
    try {
      await signOut();
      const cid = resolveGoogleClientId() || '';
      if (cid) { try { await initAuth(cid); } catch (_) {} }
      try {
        await acquireTokenInteractive('consent', 'topbar_relogin');
        location.href = '/inbox';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (typeof msg === 'string' && msg.includes('Auth not initialized')) {
          try {
            const loginUrl = typeof window !== 'undefined' ? new URL('/api/google-login', window.location.href).toString() : '/api/google-login';
            window.location.href = loginUrl;
            return;
          } catch (_) {}
        }
        throw e;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      showSnackbar({
        message: `Re-login failed: ${errMsg}`,
        closable: true,
        timeout: null,
        actions: {
          Copy: async () => {
            try {
              const authDiag = getAuthDiagnostics();
              let buffered = [] as any[];
              try { buffered = getAndClearGmailDiagnostics() || []; } catch (_) { buffered = []; }

              // Attempt quick server probe for /api/gmail/profile to capture server-side status
              let serverProbe: Record<string, unknown> | undefined = undefined;
              try {
                const ctrl = new AbortController();
                const id = setTimeout(() => ctrl.abort(), 5000);
                const r = await fetch('/api/gmail/profile', { method: 'GET', credentials: 'include', signal: ctrl.signal });
                clearTimeout(id);
                let bodyText: string | undefined = undefined;
                try { bodyText = await r.text(); } catch (_) { bodyText = undefined; }
                serverProbe = { status: r.status, statusText: r.statusText, body: typeof bodyText === 'string' ? (bodyText.length > 2000 ? bodyText.slice(0, 2000) + '…' : bodyText) : undefined };
              } catch (probeErr) {
                serverProbe = { error: probeErr instanceof Error ? probeErr.message : String(probeErr) };
              }

              // Service worker and environment info
              const swController = (typeof navigator !== 'undefined' && navigator.serviceWorker && (navigator.serviceWorker as any).controller) ? (navigator.serviceWorker as any).controller.scriptURL : undefined;
              const permissions: Record<string, unknown> = {};
              try {
                if (typeof navigator !== 'undefined' && (navigator as any).permissions && typeof (navigator as any).permissions.query === 'function') {
                  // Non-blocking: query a few common permissions (may reject in some browsers)
                  try { const p = await (navigator as any).permissions.query({ name: 'notifications' as any }); permissions.notifications = p.state; } catch (_) {}
                }
              } catch (_) {}

              // Parse cookies into map for easier inspection
              const cookiesMap: Record<string, string> = {};
              try {
                if (typeof document !== 'undefined' && document.cookie) {
                  String(document.cookie).split(';').forEach((c) => {
                    const i = c.indexOf('=');
                    if (i === -1) return;
                    const k = c.slice(0, i).trim();
                    const v = c.slice(i + 1).trim();
                    cookiesMap[k] = v;
                  });
                }
              } catch (_) {}

              const extra: Record<string, unknown> = {
                reason: 'relogin_failed',
                error: errMsg,
                stack: e instanceof Error ? e.stack : undefined,
                authDiagnostics: authDiag,
                bufferedEntries: buffered,
                serverProbe,
                swController,
                permissions,
                clientIdResolved: (() => { try { return resolveGoogleClientId(); } catch { return undefined; } })(),
                clientIdPreview: (() => { try { const c = resolveGoogleClientId(); return c ? String(c).slice(0, 8) + '…' : undefined; } catch { return undefined; } })(),
                location: typeof window !== 'undefined' ? window.location.href : undefined,
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
                platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
                cookies: cookiesMap,
                localStorageKeys: typeof localStorage !== 'undefined' ? Object.keys(localStorage) : undefined,
                importantLocalStorageValues: (() => { try { return { GOOGLE_CLIENT_ID: localStorage.getItem('GOOGLE_CLIENT_ID'), VITE_GOOGLE_CLIENT_ID: localStorage.getItem('VITE_GOOGLE_CLIENT_ID') }; } catch { return undefined; } })(),
                date: new Date().toISOString()
              };

              const text = JSON.stringify(extra, null, 2);
              let ok = false;
              try {
                if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                  await navigator.clipboard.writeText(text);
                  ok = true;
                }
              } catch (_) { ok = false; }
              if (!ok) {
                try { ok = !!(await copyGmailDiagnosticsToClipboard(extra)); } catch (_) { ok = false; }
              }
              if (!ok) {
                try { console.log('Re-login diagnostics:', extra); } catch (_) {}
              }
              showSnackbar({ message: ok ? 'Diagnostics copied' : 'Diagnostics logged to console', closable: true });
            } catch (_) {
              showSnackbar({ message: 'Failed to copy diagnostics', closable: true });
            }
          }
        }
      });
    }
  }
  async function doCopyDiagnostics() {
    try {
      const w = typeof window !== 'undefined' ? (window as any) : undefined;
      if (w) {
        if (typeof w.__copyPageDiagnostics === 'function') {
          await w.__copyPageDiagnostics();
          showSnackbar({ message: 'Diagnostics copied', closable: true });
          return;
        }
        if (typeof w.__copyViewerDiagnostics === 'function') {
          await w.__copyViewerDiagnostics();
          showSnackbar({ message: 'Diagnostics copied', closable: true });
          return;
        }
      }
    } catch (_) {}
    const ok = await copyGmailDiagnosticsToClipboard({ reason: 'topbar_manual_copy' });
    showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
  }

  // Helper: copy the Static Web Apps start command for local dev
  async function doCopySwaCommand() {
    try {
      const cmd = 'swa start ./svelte-app --api-location ./api --run "npm run dev --prefix svelte-app"';
      await navigator.clipboard.writeText(cmd);
      showSnackbar({ message: 'swa start command copied', closable: true });
    } catch (e) {
      showSnackbar({ message: 'Failed to copy swa command', closable: true });
    }
  }

  // Helper: copy a local.settings.json example for Functions local dev
  async function doCopyLocalSettings() {
    try {
      const example = `{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "OPENAI_API_KEY": "sk-xxxx",
    "APP_BASE_URL": "http://localhost:4280",
    "GOOGLE_CLIENT_ID": "your-google-client-id.apps.googleusercontent.com",
    "GOOGLE_CLIENT_SECRET": "your-google-client-secret",
    "GOOGLE_SCOPES": "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.labels https://www.googleapis.com/auth/gmail.readonly",
    "COOKIE_SECRET": "change-this-long-random-secret",
    "COOKIE_SIGNING_SECRET": "change-this-other-secret",
    "COOKIE_SECURE": "false"
  }
}`;
      await navigator.clipboard.writeText(example);
      showSnackbar({ message: 'local.settings.json example copied', closable: true });
    } catch (e) {
      showSnackbar({ message: 'Failed to copy local.settings.json example', closable: true });
    }
  }

  // Resolve server base for debugging purposes (mirror of client redirect logic)
  function resolveServerBaseForDebug(): string {
    try {
      const w = (window as any) || {};
      if (w.__ENV__ && w.__ENV__.APP_BASE_URL) return String(w.__ENV__.APP_BASE_URL);
    } catch (_) {}
    try {
      const env = (import.meta as any).env;
      if (env && env.VITE_APP_BASE_URL) return String(env.VITE_APP_BASE_URL);
    } catch (_) {}
    try {
      const ls = localStorage.getItem('APP_BASE_URL') || localStorage.getItem('VITE_APP_BASE_URL');
      if (ls) return ls;
    } catch (_) {}
    try { return window.location.origin; } catch (_) { return '/'; }
  }

  // Small state for API probe dialog when proxy returns unexpected SPA HTML
  let apiProbeOpen = $state(false);
  let apiProbeResult: any = $state(undefined as any);

  // Helper: test that the /api/gmail proxy is reachable and copy a short probe result
  async function doTestApiProxy() {
    try {
      showSnackbar({ message: 'Testing API proxy…' });
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch('/api/gmail/profile', { method: 'GET', credentials: 'include', signal: ctrl.signal });
      clearTimeout(id);
      let bodyText: string | undefined = undefined;
      try { bodyText = await r.text(); } catch (_) { bodyText = undefined; }
      const probe = { status: r.status, statusText: r.statusText, body: typeof bodyText === 'string' ? (bodyText.length > 2000 ? bodyText.slice(0, 2000) + '…' : bodyText) : undefined };

      // Detect the common local-dev failure where the frontend SPA is returned
      // for /api/* requests (SWA proxy or Functions host not running).
      const isSpaHtml404 = r.status === 404 && typeof bodyText === 'string' && /<!doctype html|<html/i.test(bodyText || '');
      apiProbeResult = { ...probe, isSpaHtml404 };

      if (r.status === 401) {
        showSnackbar({
          message: 'API proxy is working (401 = authentication required). This is expected when not logged in.',
          timeout: 5000,
          closable: true
        });
        try { await navigator.clipboard.writeText(JSON.stringify(probe, null, 2)); showSnackbar({ message: 'API probe result copied', closable: true }); } catch (_) { showSnackbar({ message: 'API probe complete (could not copy)', closable: true }); }
        return;
      } else if (isSpaHtml404) {
        showSnackbar({
          message: 'API proxy appears to be routing to the frontend (404 HTML). API host may not be running.',
          timeout: 8000,
          closable: true,
          actions: {
            Help: () => { apiProbeOpen = true; },
            'Copy swa start command': async () => { await doCopySwaCommand(); showSnackbar({ message: 'swa command copied', closable: true }); }
          }
        });

        // Also attempt to copy probe payload for easier debugging
        try { await navigator.clipboard.writeText(JSON.stringify(probe, null, 2)); showSnackbar({ message: 'API probe result copied', closable: true }); } catch (_) {}
        return;
      }

      try { await navigator.clipboard.writeText(JSON.stringify(probe, null, 2)); showSnackbar({ message: 'API probe result copied', closable: true }); } catch (_) { showSnackbar({ message: 'API probe complete (could not copy)', closable: true }); }
    } catch (e) {
      const em = e instanceof Error ? e.message : String(e);
      showSnackbar({ message: `API probe failed: ${em}`, closable: true });
    }
  }

  // Cache version is read from centralized helper (service worker CACHE_NAME or Cache Storage)
  // Exposed as a Svelte store `cacheVersionStore`; use `$cacheVersionStore` in markup.

  let checkingUpdate = $state(false);
  async function doCheckForUpdates() {
    if (checkingUpdate) return;
    checkingUpdate = true;
    try {
      showSnackbar({ message: 'Checking for updates…' });
    } catch {}
    try {
      const res = await checkForUpdateOnce();
      if (res.status === 'new') {
        showSnackbar({
          message: 'A new version is available',
          actions: {
            Reload: () => hardReloadNow()
          },
          closable: true,
          timeout: null
        });
      } else if (res.status === 'same') {
        showSnackbar({ message: 'You are up to date', timeout: 2500 });
      } else if (res.status === 'offline') {
        showSnackbar({ message: 'You are offline. Connect to the internet to check.', closable: true });
      } else {
        showSnackbar({ message: 'Could not check for updates. Try again later.', closable: true });
      }
    } catch (_) {
      showSnackbar({ message: 'Could not check for updates. Try again later.', closable: true });
    } finally {
      checkingUpdate = false;
    }
  }

  onMount(async () => {
    try {
      // Ensure label stats are refreshed on mount
      try { await refreshLabelStats(); } catch (_) {}
    } catch (e) {
      console.error(e);
    }
  });
  
  onMount(() => {
    const handleRefresh = () => { void refreshLabelStats(); };
    const handleRefreshLabelStats = () => { void refreshLabelStats(); };
    const handleRequestSync = () => { void doComprehensiveRefresh(); };
    
    try {
      window.addEventListener('jmail:refresh', handleRefresh);
      window.addEventListener('jmail:refreshLabelStats', handleRefreshLabelStats);
      window.addEventListener('jmail:requestSync', handleRequestSync);
    } catch (_) {}
    return () => {
      try { window.removeEventListener('jmail:refresh', handleRefresh); } catch (_) {}
      try { window.removeEventListener('jmail:refreshLabelStats', handleRefreshLabelStats); } catch (_) {}
      try { window.removeEventListener('jmail:requestSync', handleRequestSync); } catch (_) {}
    };
  });

  // Listen for global request to show precompute logs (dispatched by snackbar action)
  onMount(() => {
    function handleShowPrecomputeLogs() {
      try {
        // Prefer centralized function to load and show the dialog
        doShowPrecomputeLogs();
      } catch (e) {}
    }
    try { window.addEventListener('jmail:show-precompute-logs', handleShowPrecomputeLogs); } catch (e) {}
    return () => { try { window.removeEventListener('jmail:show-precompute-logs', handleShowPrecomputeLogs); } catch (e) {} };
  });

  // Ticking clock to evaluate hold expirations for real-time counters
  let now = $state(Date.now());
  onMount(() => { const id = setInterval(() => { now = Date.now(); }, 250); return () => clearInterval(id); });

  async function refreshLabelStats(force = false) {
    try {
      const { getLabel } = await import('$lib/gmail/api');
      const inboxLabel = await getLabel('INBOX');
      const tt = typeof inboxLabel?.threadsTotal === 'number' ? inboxLabel.threadsTotal : undefined;
      const tu = typeof inboxLabel?.threadsUnread === 'number' ? inboxLabel.threadsUnread : undefined;
      
      // Check if there are recent user actions or pending operations
      // If so, prefer local counts over potentially stale server counts
      // UNLESS force=true (e.g., after manual refresh button)
      let hasRecentActivity = false;
      let activityReason = '';
      
      if (!force) {
        try {
          const { getDB } = await import('$lib/db/indexeddb');
          const db = await getDB();
          
          // Check for pending operations
          const pendingOps = await db.getAll('ops');
          if (pendingOps && pendingOps.length > 0) {
            hasRecentActivity = true;
            activityReason = `${pendingOps.length} pending ops`;
          }
          
          // Check for recent journal entries (last 30 seconds)
          // Use same window as Phase 1 for consistency
          if (!hasRecentActivity) {
            const recentCutoff = Date.now() - (30 * 1000); // 30 seconds
            const journalEntries = await db.getAll('journal');
            const recentEntries = journalEntries.filter((e: any) => 
              e && e.createdAt && e.createdAt > recentCutoff
            );
            if (recentEntries.length > 0) {
              hasRecentActivity = true;
              activityReason = `${recentEntries.length} journal entries from last 30s`;
            }
            console.log(`[TopAppBar] Journal check: ${journalEntries.length} total, ${recentEntries.length} recent (cutoff: ${new Date(recentCutoff).toISOString()})`);
          }
        } catch (e) {
          // If we can't check, be conservative and assume there might be recent activity
          hasRecentActivity = true;
          activityReason = `check failed: ${e}`;
        }
      } else {
        console.log(`[TopAppBar] Force refresh - using server counts regardless of recent activity`);
      }
      
      // Only update global counts with server values if there's no recent activity OR force=true
      // This prevents overwriting optimistic updates with stale server counts
      if (!hasRecentActivity || force) {
        console.log(`[TopAppBar] Using server counts${force ? ' (forced)' : ' - no recent activity'} (server: ${tt} inbox, ${tu} unread)`);
        counts.update(c => ({
          ...c,
          inbox: typeof tt === 'number' ? tt : c.inbox,
          unread: typeof tu === 'number' ? tu : c.unread,
          lastUpdated: Date.now()
        }));
      } else {
        console.log(`[TopAppBar] Skipping server count update - ${activityReason} (server: ${tt})`);
      }
    } catch (e) {
      console.warn('[TopAppBar] Failed to refresh label stats:', e);
    }
  }

  // Do not mirror labelsStore here to avoid stale/duplicated counts; rely on fresh API fetch via refreshLabelStats()

  // Inbox counters (local view based on cached threads + trailing holds)
  const inboxThreads = $derived(($threadsStore || []).filter((t) => {
    // Guard against undefined/partial entries
    if (!t || typeof (t as any).threadId !== 'string') return false;
    const labels = Array.isArray((t as any).labelIds) ? ((t as any).labelIds as string[]) : [];
    const inInbox = labels.includes('INBOX');
    const held = (($trailingHolds || {})[(t as any).threadId] || 0) > now;
    return inInbox || held;
  }));
  
  // Count threads that are held (being animated) separately to avoid double counting with optimistic adjustments
  const heldThreads = $derived(() => {
    try {
      const threads = $threadsStore || [];
      const holds = $trailingHolds || {};
      return threads.filter((t) => {
        if (!t || typeof (t as any).threadId !== 'string') return false;
        const held = (holds[(t as any).threadId] || 0) > now;
        const labels = Array.isArray((t as any).labelIds) ? ((t as any).labelIds as string[]) : [];
        const inInbox = labels.includes('INBOX');
        // Only count held threads that are NOT in inbox (i.e., were removed but still showing due to animation)
        return held && !inInbox;
      });
    } catch {
      return [];
    }
  });
  
  // Schedule authoritative label stat refresh when local counts change
  let _labelRefreshTimer: number | undefined;
  function scheduleLabelRefresh() {
    try {
      if (typeof _labelRefreshTimer !== 'undefined') window.clearTimeout(_labelRefreshTimer);
    } catch {}
    _labelRefreshTimer = window.setTimeout(() => { try { refreshLabelStats(); } catch {} }, 800);
  }
  
  // Cleanup timer when component unmounts
  $effect(() => {
    return () => { try { if (typeof _labelRefreshTimer !== 'undefined') clearTimeout(_labelRefreshTimer); } catch {} };
  });

</script>

<div class="topbar">
  <div class="left">
    {#if backHref}
      <Button variant="text" iconType="full" aria-label={backLabel || 'Back'} onclick={handleBack}>
        <Icon icon={iconBack} />
      </Button>
    {/if}
    {#if !backHref && ($counts.inbox > 0 || $counts.unread > 0)}
      <div class="counters">
        <span class="counter-badge" title="Total inbox threads">
          <Icon icon={iconInbox} width="1.125rem" height="1.125rem" />
          {$counts.inbox}
        </span>
        {#if $counts.unread > 0}
          <span class="counter-badge unread" title="Unread threads">
            <Icon icon={iconMarkEmailUnread} width="1.125rem" height="1.125rem" />
            {$counts.unread}
          </span>
        {/if}
      </div>
    {/if}
  </div>
  <div class="right">
    {#if searchOpen || search.length > 0}
      <div class="search-field">
        <TextField label="Search" leadingIcon={iconSearch} bind:value={search} enter={() => { import('$lib/stores/search').then(m => m.searchQuery.set(search)); }} trailing={{ icon: iconSearch, onclick: () => { import('$lib/stores/search').then(m => m.searchQuery.set(search)); } }} onBlur={() => { if (!search) searchOpen = false; }} />
      </div>
    {:else}
      <Button variant="text" iconType="full" aria-label="Search" onclick={() => { searchOpen = true; }}>
        <Icon icon={iconSearch} />
      </Button>
    {/if}

    <SyncButton 
      onSync={doComprehensiveRefresh}
      syncing={comprehensiveRefreshInProgress}
      compact={true}
      variant="outlined"
    />

    <SplitButton variant="filled" x="right" y="down" onclick={() => doUndo(1)} on:toggle={(e) => { if (e.detail) refreshUndo(); }}>
      {#snippet children()}
        <Icon icon={iconUndo} />
        <span class="label">Undo</span>
      {/snippet}
      {#snippet menu()}
        <Menu class="history-menu">
          {#if undoItems.length}
            {#each undoItems as it, idx}
              <MenuItem onclick={() => doUndo(idx + 1)}>
                <span class="history-text">{it.description}</span>
              </MenuItem>
            {/each}
          {:else}
            <MenuItem disabled={true} onclick={() => {}}>
              <span class="history-text">No actions to undo</span>
            </MenuItem>
          {/if}
        </Menu>
      {/snippet}
    </SplitButton>

    <SplitButton variant="tonal" x="right" y="down" onclick={() => doRedo(1)} on:toggle={(e) => { if (e.detail) refreshRedo(); }}>
      {#snippet children()}
        <Icon icon={iconRedo} />
        <span class="label">Redo</span>
      {/snippet}
      {#snippet menu()}
        <Menu class="history-menu">
          {#if redoItems.length}
            {#each redoItems as it, idx}
              <MenuItem onclick={() => doRedo(idx + 1)}>
                <span class="history-text">{it.description}</span>
              </MenuItem>
            {/each}
          {:else}
            <MenuItem disabled={true} onclick={() => {}}>
              <span class="history-text">No actions to redo</span>
            </MenuItem>
          {/if}
        </Menu>
      {/snippet}
    </SplitButton>


    <details class="overflow" bind:this={overflowDetails}>
      <summary aria-label="More actions" class="summary-btn" onclick={toggleOverflow}>
        <Button variant="text" iconType="full" aria-label="More actions">
          <Icon icon={iconMore} />
        </Button>
      </summary>
      <Menu>
        <div class="menu-section-header">Quick Actions</div>
        <MenuItem icon={iconSettings} onclick={async () => {
          try {
            // Check if we're on Android and try alternative navigation methods
            const isAndroid = /Android/i.test(navigator.userAgent);
            const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
            
            if (isAndroid || isPWA) {
              // Try window.open first for Android PWAs
              try {
                window.open('/settings', '_self');
                return;
              } catch (e) {
                console.log('[TopAppBar] window.open failed, trying pushState:', e);
              }
              
              // Fallback to pushState navigation
              try {
                history.pushState(null, '', '/settings');
                window.location.reload();
                return;
              } catch (e) {
                console.log('[TopAppBar] pushState failed, using location.href:', e);
              }
            }
            
            // Default fallback
            location.href = '/settings';
          } catch (e) {
            console.error('[TopAppBar] All navigation methods failed:', e);
            // Show user feedback
            showSnackbar({ message: 'Navigation failed. Please try again or refresh the app.', closable: true });
          }
        }}>Settings</MenuItem>
        
        <div class="menu-section-header">AI Features</div>
        <MenuItem icon={iconSparkles} onclick={doPrecompute}>Run Precompute</MenuItem>
        <MenuItem icon={iconSchool} onclick={doRunRecruitingModeration}>Run College Recruiting Filter</MenuItem>
        <MenuItem icon={iconSmartToy} onclick={doShowPrecomputeSummary}>Precompute Summary</MenuItem>
        <MenuItem icon={iconLogs} onclick={doShowPrecomputeLogs}>Review Precompute Logs</MenuItem>
        <MenuItem icon={iconSparkles} onclick={doBackfillSummaryVersions}>Backfill AI Summary Versions</MenuItem>
        
        <div class="menu-section-header">System</div>
        <MenuItem icon={iconRefresh} onclick={async () => {
          try {
            // Redirect to home with ?refresh to trigger hard reload logic
            location.href = '/?refresh';
          } catch (e) {
            console.error('[TopAppBar] App update redirect failed:', e);
            try { showSnackbar({ message: 'Navigation failed. Please try again.', closable: true }); } catch {}
          }
        }}>Check for App Update</MenuItem>
        <MenuItem icon={iconDiagnostics} onclick={async () => {
          try {
            const isAndroid = /Android/i.test(navigator.userAgent);
            const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
            
            if (isAndroid || isPWA) {
              try {
                window.open('/diagnostics', '_self');
                return;
              } catch (e) {
                console.log('[TopAppBar] window.open failed for diagnostics, trying pushState:', e);
                try {
                  history.pushState(null, '', '/diagnostics');
                  window.location.reload();
                  return;
                } catch (e2) {
                  console.log('[TopAppBar] pushState failed for diagnostics:', e2);
                }
              }
            }
            
            location.href = '/diagnostics';
          } catch (e) {
            console.error('[TopAppBar] Diagnostics navigation failed:', e);
            showSnackbar({ message: 'Navigation failed. Please try again.', closable: true });
          }
        }}>Diagnostics</MenuItem>
        <MenuItem icon={iconNotifications} onclick={async () => {
          try {
            const { getHistory } = await import('$lib/containers/snackbar');
            notifications = getHistory();
            notificationsOpen = true;
            overflowDetails.open = false;
          } catch (e) { showSnackbar({ message: 'Failed to load notifications', closable: true }); }
        }}>Notifications</MenuItem>
        
        <div class="menu-section-header">Developer</div>
        <MenuItem icon={iconTerminal} onclick={() => { devToolsOpen = true; overflowDetails.open = false; }}>Dev Tools</MenuItem>
        <MenuItem icon={iconTerminal} onclick={async () => {
          try {
            // Collect recent diagnostics and surface a copy dialog for both client and server probes
            const buf = getAndClearGmailDiagnostics() || [];
            // Also attempt to fetch recent server-collected diagnostics from /api/collect-diagnostics (best-effort)
            let serverDiag: any = null;
            try {
              const base = resolveServerBaseForDebug();
              const r = await fetch(new URL('/api/collect-diagnostics', base).toString(), { method: 'GET' });
              if (r.ok) {
                try { serverDiag = await r.json(); } catch (_) { serverDiag = await r.text(); }
              } else {
                serverDiag = { status: r.status, statusText: r.statusText };
              }
            } catch (_) { serverDiag = { error: 'unavailable' }; }

            const payload = { time: new Date().toISOString(), client: buf, server: serverDiag };
            const txt = JSON.stringify(payload, null, 2);
            const ok = await navigator.clipboard.writeText(txt).then(() => true).catch(() => false);
            showSnackbar({ message: ok ? 'Diagnostics copied' : 'Could not copy; check console', timeout: 4000 });
            if (!ok) console.log('Diagnostics payload:', payload);
          } catch (e) { showSnackbar({ message: `Inspection failed: ${e instanceof Error ? e.message : String(e)}`, closable: true }); }
        }}>Inspect Gmail Requests</MenuItem>
        
        <div class="menu-section-header">Account</div>
        <MenuItem icon={iconLogout} onclick={doRelogin}>Re-login</MenuItem>
        <MenuItem icon={iconInfo} onclick={doShowAbout}>About</MenuItem>
      </Menu>
    </details>
    <Dialog icon={iconInfo} headline="About" bind:open={aboutOpen} closeOnClick={false}>
      {#snippet children()}
        <div class="about">
          <div class="row"><span class="k">Version</span><span class="v">{appVersion}</span></div>
          <div class="row"><span class="k">Build</span><span class="v">{buildId}</span></div>
          <div class="row"><span class="k">Cache</span><span class="v">{$cacheVersionStore}</span></div>
        </div>
      {/snippet}
      {#snippet buttons()}
        <Button variant="text" disabled={checkingUpdate} onclick={doCheckForUpdates}>{checkingUpdate ? 'Checking…' : 'Check for updates'}</Button>
        <Button variant="text" onclick={() => (aboutOpen = false)}>Close</Button>
      {/snippet}
    </Dialog>
    <Dialog icon={iconLogs} headline="Precompute logs" bind:open={precomputeLogsOpen} closeOnClick={false}>
      {#snippet children()}
        <div class="log-list" role="log" aria-live="polite" style="position:relative;">
          {#if precomputeLogsContent.length}
            <div style="position:absolute; top:0.5rem; right:0.5rem;">
              <Button variant="text" onclick={() => (precomputeLogsOpen = false)} aria-label="Close">
                <Icon icon={iconClose} />
              </Button>
            </div>
            <div style="display:flex; flex-direction:column; gap:0.5rem; max-height:60vh; overflow:auto;">
              <div style="display:flex; gap:0.5rem; align-items:center;">
                <div style="flex:1; color: rgb(var(--m3-scheme-on-surface-variant)); font-size:0.85rem;">Showing latest precompute logs</div>
                <Button variant="outlined" iconType="left" onclick={async () => {
                  try {
                    const txt = precomputeLogsContent.map((l:any) => `[${new Date(l.ts).toLocaleString()}] ${l.level.toUpperCase()}: ${l.message}`).join('\n');
                    await navigator.clipboard.writeText(txt);
                    showSnackbar({ message: 'Logs copied', closable: true });
                  } catch (e) { showSnackbar({ message: 'Failed to copy logs', closable: true }); }
                }} title="Copy logs to clipboard" aria-label="Copy logs to clipboard">
                  <Icon icon={iconCopy} />
                  <span style="font-size:0.85rem;">Copy</span>
                </Button>
              </div>
              <div style="max-height:48vh; overflow:auto; font-family:monospace; font-size:0.9rem; white-space:pre-wrap;">{#each precomputeLogsContent as l}
                <div>[{new Date(l.ts).toLocaleString()}] {l.level.toUpperCase()}: {l.message}</div>
              {/each}</div>
            </div>
          {:else}
            <div>No precompute logs available.</div>
          {/if}
        </div>
      {/snippet}
      {#snippet buttons()}
        <Button variant="text" onclick={() => (precomputeLogsOpen = false)}>Close</Button>
      {/snippet}
    </Dialog>

    <!-- Developer tools dialog grouping the previous verbose menu items -->
    <Dialog icon={iconTerminal} headline="Developer tools" bind:open={devToolsOpen} closeOnClick={false} pushHistory={false}>
      {#snippet children()}
        <div style="display:flex; flex-direction:column; gap:0.5rem; min-width:16rem;">
          <Button variant="text" onclick={async () => { try { await doCopySwaCommand(); showSnackbar({ message: 'swa command copied', closable: true }); devToolsOpen = false; } catch { showSnackbar({ message: 'Failed', closable: true }); } }}>
            <Icon icon={iconCopy} />
            <span>Copy swa</span>
          </Button>

          <Button variant="text" onclick={async () => { try { await doCopyLocalSettings(); showSnackbar({ message: 'local.settings example copied', closable: true }); devToolsOpen = false; } catch { showSnackbar({ message: 'Failed', closable: true }); } }}>
            <Icon icon={iconCopy} />
            <span>Copy local settings</span>
          </Button>

          <Button variant="text" onclick={async () => {
            try {
              const base = resolveServerBaseForDebug();
              let ok = false;
              try { await navigator.clipboard.writeText(base); ok = true; } catch (_) { ok = false; }
              showSnackbar({ message: ok ? `APP_BASE_URL: ${base} (copied)` : `APP_BASE_URL: ${base}`, timeout: 6000, closable: true });
              devToolsOpen = false;
            } catch (e) { showSnackbar({ message: `Failed to resolve APP_BASE_URL: ${e instanceof Error ? e.message : String(e)}`, closable: true }); }
          }}>
            <Icon icon={iconInfo} />
            <span>Show APP_BASE_URL</span>
          </Button>

          <Button variant="text" onclick={async () => { try { await doTestApiProxy(); showSnackbar({ message: 'API probe complete', closable: true }); devToolsOpen = false; } catch { showSnackbar({ message: 'Failed', closable: true }); } }}>
            <Icon icon={iconRefresh} />
            <span>Test API</span>
          </Button>

          <Button variant="text" onclick={async () => { try { await doCopyDiagnostics(); devToolsOpen = false; } catch { showSnackbar({ message: 'Failed', closable: true }); } }}>
            <Icon icon={iconCopy} />
            <span>Copy diagnostics</span>
          </Button>
        </div>
      {/snippet}
      {#snippet buttons()}
        <Button variant="text" onclick={() => (devToolsOpen = false)}>Close</Button>
      {/snippet}
    </Dialog>

    <Dialog icon={iconNotifications} headline="Notifications" bind:open={notificationsOpen} closeOnClick={false}>
      {#snippet children()}
        {#if notifications && notifications.length}
          <div style="display:flex; flex-direction:column; gap:0.5rem; max-width:40rem;">
            {#each notifications as n, i}
              <div style="padding:0.5rem; border:1px solid rgb(var(--m3-scheme-outline)); border-radius:6px;">
                <div style="display:flex; justify-content:space-between; gap:0.5rem; align-items:start;">
                  <div style="flex:1; white-space:pre-wrap;">{n.message}</div>
                  <div style="display:flex; flex-direction:column; gap:0.25rem; align-items:flex-end;">
                    <Button variant="text" onclick={async () => { try { await navigator.clipboard.writeText(n.message || ''); showSnackbar({ message: 'Copied', closable: true }); } catch { showSnackbar({ message: 'Failed to copy', closable: true }); } }} title="Copy">Copy</Button>
                  </div>
                </div>
                {#if n.actions && Object.keys(n.actions).length}
                  <div style="display:flex; gap:0.5rem; margin-top:0.5rem; flex-wrap:wrap;">
                    {#each Object.entries(n.actions) as [k, action]}
                      <Button variant="text" onclick={() => { try { (action as any)(); } catch {} }}>{k}</Button>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <div>No notifications</div>
        {/if}
      {/snippet}
      {#snippet buttons()}
        <Button variant="outlined" onclick={async () => { try { const m = await import('$lib/containers/snackbar'); m.clearHistory(); notifications = []; showSnackbar({ message: 'Notifications cleared', closable: true }); } catch { showSnackbar({ message: 'Failed to clear', closable: true }); } }}>Clear</Button>
        <Button variant="text" onclick={() => (notificationsOpen = false)}>Close</Button>
      {/snippet}
    </Dialog>

    <!-- API probe dialog shown when SPA HTML 404 is detected during probe -->
    <Dialog icon={iconRefresh} headline="API probe result" bind:open={apiProbeOpen} closeOnClick={false} pushHistory={false}>
      {#snippet children()}
        {#if apiProbeResult}
          <div style="display:flex; flex-direction:column; gap:0.5rem; min-width:20rem; max-width:40rem;">
            <div><strong>Status</strong>: {apiProbeResult.status} {apiProbeResult.statusText}</div>
            {#if apiProbeResult.isSpaHtml404}
              <div style="color:var(--m3-scheme-error);">The request returned the frontend HTML (404). This usually means the API host or SWA proxy is not running.</div>
              <div>Suggested fixes:</div>
              <ul>
                <li>Start the SWA CLI: <code>swa start ./svelte-app --api-location ./api --run "npm run dev --prefix svelte-app"</code></li>
                <li>Or run Functions host and frontend separately: <code>cd api && func start</code> and <code>npm run dev --prefix svelte-app</code></li>
                <li>Ensure `api/gmail-proxy/index.js` exists and exports an HTTP function.</li>
              </ul>
            {:else}
              <div>Probe body:</div>
              <pre style="max-height:40vh; overflow:auto; font-family:monospace; white-space:pre-wrap;">{apiProbeResult.body}</pre>
            {/if}
            <div style="display:flex; gap:0.5rem;">
              <Button variant="outlined" iconType="left" onclick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(apiProbeResult, null, 2)); showSnackbar({ message: 'Probe copied', closable: true }); } catch { showSnackbar({ message: 'Failed to copy probe', closable: true }); } }}>
                <Icon icon={iconCopy} />
                <span>Copy JSON</span>
              </Button>
              <Button variant="text" onclick={() => { apiProbeOpen = false; }}>Close</Button>
            </div>
          </div>
        {:else}
          <div>No probe result available.</div>
        {/if}
      {/snippet}
      {#snippet buttons()}
        <!-- buttons handled inline -->
      {/snippet}
    </Dialog>

    <!-- Precompute Summary Dialog (MD3-compliant) -->
    <Dialog icon={iconSmartToy} headline="Precompute Summary" bind:open={precomputeSummaryOpen} closeOnClick={false} pushHistory={false}>
      {#snippet children()}
        {#if precomputeSummary}
          <div style="position:relative; display:flex; flex-direction:column; gap:0.5rem; min-width:20rem; max-width:40rem; max-height:60vh; overflow:auto;">
            <div style="position:absolute; top:0.5rem; right:0.5rem;">
              <Button variant="text" onclick={() => (precomputeSummaryOpen = false)} aria-label="Close">
                <Icon icon={iconClose} />
              </Button>
            </div>
            <div style="font-weight:600">Precompute Summary</div>
            <div style="display:flex; gap:1rem; flex-wrap:wrap;">
              <div>Total logs: <strong>{precomputeSummary.total}</strong></div>
              <div>Last hour: <strong>{precomputeSummary.lastHour}</strong></div>
              <div>Last day: <strong>{precomputeSummary.lastDay}</strong></div>
              <div>Errors: <strong>{precomputeSummary.errors}</strong> | Warnings: <strong>{precomputeSummary.warns}</strong></div>
            </div>

            <hr/>

            {#if precomputeSummary.lastRun && Object.keys(precomputeSummary.lastRun.errorTypes || {}).length}
              <div style="font-size:0.9rem; font-weight:600;">Most recent precompute: {precomputeSummary.lastRun.processed ?? '?'} processed of {precomputeSummary.lastRun.total ?? '?'} candidates</div>
              <div style="margin:0.25rem 0 0 0; color: rgb(var(--m3-scheme-on-surface-variant));">
                {#each Object.entries(precomputeSummary.lastRun.errorTypes) as [msg, count]}
                  <div style="font-family:monospace; white-space:pre-wrap; margin-top:0.25rem;">{count} × {msg}</div>
                {/each}
              </div>
            {:else}
              <div style="color: rgb(var(--m3-scheme-on-surface-variant));">No recent run error breakdown available.</div>
            {/if}

            {#if precomputeSummary.lastRun && precomputeSummary.lastRun.runLogs && precomputeSummary.lastRun.runLogs.length}
              {#if precomputeSummary.lastRun.runLogs.filter((r: any) => r.level === 'error' || /failed|error/i.test(String(r.message))).length}
                <div style="font-size:0.9rem; font-weight:600; margin-top:0.25rem;">Identified issues in most recent run</div>
                <div style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-top:0.25rem;">
                  {#each precomputeSummary.lastRun.runLogs.filter((r: any) => r.level === 'error' || /failed|error/i.test(String(r.message))) as f}
                    <div style="font-family:monospace; white-space:normal; margin-top:0.25rem;">[{new Date(f.ts).toLocaleString()}] {f.level.toUpperCase()}: {f.message}</div>
                  {/each}
                </div>
              {:else}
                <div style="color: rgb(var(--m3-scheme-on-surface-variant));">No specific errors detected in the most recent run.</div>
              {/if}
            {:else}
              <div style="color: rgb(var(--m3-scheme-on-surface-variant));">No recent run logs available.</div>
            {/if}
          </div>
        {:else}
          <div>No precompute summary available.</div>
        {/if}
      {/snippet}
      {#snippet buttons()}
        <Button variant="outlined" iconType="left" onclick={async () => {
          try {
            const s = precomputeSummary;
            // Keep the JSON copy button for advanced users; copy lastRun JSON if available
            const payload = s.lastRun ? { lastRun: s.lastRun } : { summary: s };
            await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
            showSnackbar({ message: 'Summary JSON copied', closable: true });
          } catch (e) { showSnackbar({ message: 'Failed to copy summary', closable: true }); }
        }}>
          <Icon icon={iconCopy} />
          <span>Copy JSON</span>
        </Button>
        <Button variant="text" onclick={() => (precomputeSummaryOpen = false)}>Close</Button>
      {/snippet}
    </Dialog>
  </div>
</div>

<style>
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.25rem 0;
    flex-wrap: nowrap;
  }
  .left, .right { display: flex; align-items: center; gap: 0.5rem; }
  .right { flex: 1; flex-wrap: wrap; min-width: 0; justify-content: flex-end; }
  .counters { 
    display: flex; 
    align-items: center; 
    gap: 0.75rem; 
    margin-left: 0.5rem;
  }
  .counter-badge {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.625rem;
    border-radius: var(--m3-util-rounding-medium, 0.75rem);
    background-color: rgb(var(--m3-scheme-surface-container-high));
    color: rgb(var(--m3-scheme-on-surface));
    font-size: 0.875rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .counter-badge.unread {
    background-color: rgb(var(--m3-scheme-primary-container));
    color: rgb(var(--m3-scheme-on-primary-container));
  }
  /* Ensure all buttons in the topbar have consistent height and alignment */
  .right :global(.m3-container) { 
    height: 2.5rem; 
    display: inline-flex;
    align-items: center;
  }
  .right :global(.split) { 
    height: 2.5rem; 
    display: flex;
    align-items: center;
  }
  /* Ensure button groups maintain proper vertical alignment */
  .right > * {
    display: flex;
    align-items: center;
  }
  .label { margin-inline-start: 0.25rem; }
  .search-field { flex: 1 1 12rem; min-width: 0; }
  .search-field :global(.m3-container) {
    min-width: 12rem;
    width: 100%;
  }
  .overflow { 
    position: relative; 
    overflow: visible;
  }
  .overflow > summary { list-style: none; }
  .summary-btn { cursor: pointer; }
  .overflow[open] > :global(.m3-container) { 
    position: absolute; 
    right: 0; 
    top: 100%;
    margin-top: 0.25rem; 
    background-color: rgb(var(--m3-scheme-surface-container)) !important;
    border: 1px solid rgb(var(--m3-scheme-outline-variant));
    box-shadow: var(--m3-util-elevation-3);
    min-width: 12rem;
    max-width: 20rem;
    max-height: none !important;
    overflow: visible !important;
    overflow-y: visible !important;
    z-index: 10002;
    padding: 0.5rem 0 !important;
    gap: 0 !important;
  }
  .last-sync { color: rgb(var(--m3-scheme-on-surface-variant)); margin-inline-start: 0; }
  .about { 
    display:flex; 
    flex-direction:column; 
    gap:0.75rem; 
    min-height: auto;
    width: 100%;
  }
  
  /* Ensure About dialog is large enough to be readable */
  :global(dialog:has(.about)) {
    min-width: 22rem !important;
    max-width: 32rem !important;
    width: auto !important;
  }
  
  :global(dialog:has(.about) .content) {
    min-height: auto !important;
    max-height: none !important;
    overflow: visible !important;
    padding: 0.25rem 0 !important;
  }
  
  :global(dialog:has(.about) .d) {
    min-height: auto !important;
    padding: 1.5rem !important;
  }
  
    /* Menu section headers with solid background - no transparency issues */
    .overflow :global(.menu-section-header) {
      color: rgb(var(--m3-scheme-on-surface-variant));
      font-size: 0.6875rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 0.75rem 1rem 0.375rem 1rem;
      margin: 0;
      background-color: rgb(var(--m3-scheme-surface-container)) !important;
      line-height: 1.2;
      display: block;
      width: 100%;
      box-sizing: border-box;
    }
    
    /* First section header styling */
    .overflow :global(.menu-section-header:first-child) {
      padding-top: 0.5rem;
    }
   
   /* Ensure menu items are visible and properly sized */
   .overflow :global(.m3-container .item) {
     color: rgb(var(--m3-scheme-on-surface)) !important;
     background-color: rgb(var(--m3-scheme-surface-container)) !important;
     white-space: nowrap !important;
     height: 2.5rem !important;
     min-height: 2.5rem !important;
     display: flex !important;
     align-items: center !important;
     width: 100%;
     padding: 0 1rem !important;
     margin: 0 !important;
     border-radius: 0 !important;
   }
   
   .overflow :global(.m3-container .item .icon svg) {
     color: rgb(var(--m3-scheme-on-surface-variant)) !important;
     width: 1.5rem;
     height: 1.5rem;
   }
   
   /* Hover states for better UX */
   .overflow :global(.m3-container .item:hover) {
     background-color: rgb(var(--m3-scheme-surface-container-high)) !important;
   }
   
   /* Ensure dialogs appear above overflow menu */
   :global(dialog[open]) {
     z-index: 10010 !important;
   }
  .about .row { 
    display:flex; 
    justify-content:space-between; 
    gap:1rem; 
    align-items:center;
    min-height: 2rem;
    padding: 0.25rem 0;
    line-height: 1.5;
  }
  .about .k { 
    color: rgb(var(--m3-scheme-on-surface-variant)); 
    font-size: 0.9375rem;
    flex-shrink: 0;
  }
  .about .v { 
    color: rgb(var(--m3-scheme-on-surface)); 
    font-variant-numeric: tabular-nums; 
    font-size: 0.9375rem;
    text-align: right;
    word-break: break-all;
  }
  /* Fix the history menu sizing issues */
  :global(.history-menu.m3-container) {
    min-width: 24rem !important;
    max-width: calc(100vw - 3rem) !important;
    width: calc(100vw - 3rem) !important;
    min-height: auto !important;
    height: auto !important; /* grow to fit content up to max-height */
    max-height: calc(100vh - 4rem) !important; /* almost full viewport height */
    overflow-x: hidden !important;
    overflow-y: auto !important;
  }
  
  /* Allow text wrapping in history menu items */
  :global(.history-menu) :global(.item) {
    white-space: normal !important;
    word-wrap: break-word !important;
    line-height: 1.3 !important;
    min-height: 3rem !important;
    height: auto !important;
    padding: 0.75rem 1rem !important;
  }
  
  /*
    Force left alignment for history menu items.
    The MenuItem component renders a button with class "item" that has justify-content: center.
    We need to override this to align the text to the left.
  */
  :global(.history-menu button.item) {
    justify-content: flex-start !important;
    text-align: left !important;
  }
  :global(.history-menu .history-text) {
    display: block !important;
    text-align: left !important;
  }
  :global(.chip-icon) { width:1.1rem; height:1.1rem; flex:0 0 auto; }
</style>