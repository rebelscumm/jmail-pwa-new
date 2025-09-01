<script lang="ts">
  import { get } from 'svelte/store';
import { syncState } from '$lib/stores/queue';
import { settings } from '$lib/stores/settings';
import { precomputeStatus } from '$lib/stores/precompute';
  import { undoLast, redoLast, getUndoHistory, getRedoHistory } from '$lib/queue/intents';
  import Button from '$lib/buttons/Button.svelte';
  import SplitButton from '$lib/buttons/SplitButton.svelte';
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
  import { onMount } from 'svelte';
  import { trailingHolds } from '$lib/stores/holds';
  import { labels as labelsStore } from '$lib/stores/labels';
  let { onSyncNow, backHref, backLabel }: { onSyncNow?: () => void; backHref?: string; backLabel?: string } = $props();
  let overflowDetails: HTMLDetailsElement;
  let aboutOpen = $state(false);
  let notificationsOpen = $state(false);
  let notifications = $state([] as any[]);
  let __menuPushed = $state(false);
  let __menuPopHandler: ((e: PopStateEvent) => void) | null = $state(null);
  function toggleOverflow(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const d = overflowDetails || (e.currentTarget as HTMLElement).closest('details') as HTMLDetailsElement | null;
    if (d) d.open = !d.open;
  }
  async function doSync() {
    try {
      showSnackbar({ message: 'Syncing…' });
    } catch {}
    try {
      const { syncNow } = await import('$lib/stores/queue');
      await syncNow();
      // After flushing, immediately clear any trailing holds and reload inbox cache
      try {
        const { clearAllHolds } = await import('$lib/stores/holds');
        clearAllHolds();
      } catch {}
      // Ensure we don't show stale threads after server sync
      try {
        const mod = await import('../../routes/inbox/+page.svelte');
        if (typeof (mod as any).resetInboxCache === 'function') await (mod as any).resetInboxCache();
      } catch {}
      try {
        const mod = await import('../../routes/inbox/+page.svelte');
        if (typeof (mod as any).reloadFromCache === 'function') await (mod as any).reloadFromCache();
      } catch {}
    } catch {}
    try {
      // Ask pages (e.g., inbox) to re-hydrate from server
      window.dispatchEvent(new CustomEvent('jmail:refresh'));
      showSnackbar({ message: 'Sync complete', timeout: 2500 });
    } catch {}
    onSyncNow && onSyncNow();
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
    try {
      // Check if precompute is enabled
      const { settings } = await import('$lib/stores/settings');
      const s = get(settings);
      if (!s?.precomputeSummaries) {
        showSnackbar({ 
          message: 'Precompute is disabled. Enable it in Settings > App > Precompute summaries', 
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
              'Sync Now': () => { doSync(); }
            }
          });
          return;
        }
      } catch (e) {
        console.error('Error checking thread count:', e);
      }
      
      showSnackbar({ message: 'Starting precompute...' });
      const { precomputeNow } = await import('$lib/ai/precompute');
      const result: any = await precomputeNow(25);
      // If the precompute module returned a skip reason, surface it to the user and offer a force-run
      if (result && result.__reason) {
        showSnackbar({
          message: `Precompute skipped: ${result.__reason}`,
          timeout: 8000,
          actions: {
            'Force run': async () => {
              showSnackbar({ message: 'Forcing precompute now…', timeout: 2000 });
              const forced: any = await precomputeNow(25);
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
    } catch (e) {
      showSnackbar({ message: `Could not load logs: ${e instanceof Error ? e.message : e}`, timeout: 4000 });
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

      if (isSpaHtml404) {
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

  let cacheVersion = $state('unknown');

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
      const keys = await caches.keys();
      const cache = keys.find((k: string) => k.startsWith('Jmail-v'));
      if (cache) cacheVersion = cache.replace('Jmail-v', '');
    } catch (e) {
      console.error(e);
    }
    // Refresh label stats on mount
    try { await refreshLabelStats(); } catch (_) {}
    // Update label stats when a global refresh occurs
    try { window.addEventListener('jmail:refresh', refreshLabelStats as EventListener); } catch (_) {}
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

  // Optional inbox label totals fetched from Gmail (preferred authoritative counts)
  // Note: use thread-level counts (threadsTotal/threadsUnread) to match local thread-based counters
  let inboxMessagesTotal = $state<number | undefined>(undefined);
  let inboxMessagesUnread = $state<number | undefined>(undefined);

  async function refreshLabelStats() {
    try {
      const { getLabel } = await import('$lib/gmail/api');
      const inboxLabel = await getLabel('INBOX');
      const tt = typeof inboxLabel?.threadsTotal === 'number' ? inboxLabel.threadsTotal : undefined;
      const tu = typeof inboxLabel?.threadsUnread === 'number' ? inboxLabel.threadsUnread : undefined;
      inboxMessagesTotal = tt;
      inboxMessagesUnread = tu;
      // Immediately update the rendered counters with authoritative values when available
      if (typeof tt === 'number') renderedInboxCount = tt;
      if (typeof tu === 'number') renderedUnreadCount = tu;
    } catch (e) {
      inboxMessagesTotal = undefined;
      inboxMessagesUnread = undefined;
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
  const inboxCount = $derived(inboxThreads.length);
  const unreadCount = $derived(inboxThreads.filter((t) => (t.labelIds || []).includes('UNREAD')).length);
  // Schedule authoritative label stat refresh when local counts change
  let _labelRefreshTimer: number | undefined;
  function scheduleLabelRefresh() {
    try {
      if (typeof _labelRefreshTimer !== 'undefined') window.clearTimeout(_labelRefreshTimer);
    } catch {}
    _labelRefreshTimer = window.setTimeout(() => { try { refreshLabelStats(); } catch {} }, 800);
  }
  // React to derived value changes (these are reactive primitives, not Svelte stores)
  $effect(() => {
    try { renderedInboxCount = Number(inboxCount || 0); } catch { renderedInboxCount = 0; }
    scheduleLabelRefresh();
  });
  $effect(() => {
    try { renderedUnreadCount = Number(unreadCount || 0); } catch { renderedUnreadCount = 0; }
    scheduleLabelRefresh();
  });
  // Cleanup timer when component unmounts
  $effect(() => {
    return () => { try { if (typeof _labelRefreshTimer !== 'undefined') clearTimeout(_labelRefreshTimer); } catch {} };
  });
  
  // Render-safe primitive values to avoid accidentally printing function sources
  let renderedInboxCount = $state(0);
  let renderedUnreadCount = $state(0);
  $effect(() => {
    try {
      if (typeof inboxMessagesTotal === 'number') {
        renderedInboxCount = inboxMessagesTotal;
      } else {
        try { renderedInboxCount = Number(inboxCount || 0); } catch { renderedInboxCount = 0; }
      }
    } catch {
      renderedInboxCount = 0;
    }
    try {
      if (typeof inboxMessagesUnread === 'number') {
        renderedUnreadCount = inboxMessagesUnread;
      } else {
        try { renderedUnreadCount = Number(unreadCount || 0); } catch { renderedUnreadCount = 0; }
      }
    } catch {
      renderedUnreadCount = 0;
    }
  });
</script>

<div class="topbar">
  <div class="left">
    {#if backHref}
      <Button variant="text" iconType="full" aria-label={backLabel || 'Back'} onclick={handleBack}>
        <Icon icon={iconBack} />
      </Button>
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

    <Button variant="outlined" iconType="left" onclick={doSync}>
      {#snippet children()}
        <Icon icon={iconSync} />
        {#if $syncState.pendingOps > 0}
          <span class="label">{$syncState.pendingOps} pending</span>
        {:else}
          <span class="last-sync m3-font-label-small">{formatLastSync($syncState.lastUpdatedAt)}</span>
        {/if}
      {/snippet}
    </Button>

    <SplitButton variant="filled" x="inner" y="down" onclick={() => doUndo(1)} on:toggle={(e) => { if (e.detail) refreshUndo(); }}>
      {#snippet children()}
        <Icon icon={iconUndo} />
        <span class="label">Undo</span>
      {/snippet}
      {#snippet menu()}
        <div class="history-menu">
          <Menu>
            {#if undoItems.length}
              {#each undoItems as it, idx}
                <MenuItem onclick={() => doUndo(idx + 1)}>{it.description}</MenuItem>
              {/each}
            {:else}
              <MenuItem disabled={true} onclick={() => {}}>No actions to undo</MenuItem>
            {/if}
          </Menu>
        </div>
      {/snippet}
    </SplitButton>

    <SplitButton variant="tonal" x="inner" y="down" onclick={() => doRedo(1)} on:toggle={(e) => { if (e.detail) refreshRedo(); }}>
      {#snippet children()}
        <Icon icon={iconRedo} />
        <span class="label">Redo</span>
      {/snippet}
      {#snippet menu()}
        <div class="history-menu">
          <Menu>
            {#if redoItems.length}
              {#each redoItems as it, idx}
                <MenuItem onclick={() => doRedo(idx + 1)}>{it.description}</MenuItem>
              {/each}
            {:else}
              <MenuItem disabled={true} onclick={() => {}}>No actions to redo</MenuItem>
            {/if}
          </Menu>
        </div>
      {/snippet}
    </SplitButton>

    <div style="display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap;">
      <div style="display:flex; align-items:center; gap:0.5rem;">
        <Icon icon={iconInbox} width="1.25rem" height="1.25rem" />
        <div style="color: rgb(var(--m3-scheme-on-surface)); padding: 0.15rem 0.5rem; border-radius: 0.5rem; font-weight: 700;">{renderedInboxCount}</div>
      </div>
      <div style="display:flex; align-items:center; gap:0.5rem;">
        <Icon icon={iconMarkEmailUnread} width="1.25rem" height="1.25rem" />
        <div style="color: rgb(var(--m3-scheme-on-surface)); padding: 0.15rem 0.5rem; border-radius: 0.5rem; font-weight: 700;">{renderedUnreadCount}</div>
      </div>
    </div>

    <details class="overflow" bind:this={overflowDetails}>
      <summary aria-label="More actions" class="summary-btn" onclick={toggleOverflow}>
        <Button variant="text" iconType="full" aria-label="More actions">
          <Icon icon={iconMore} />
        </Button>
      </summary>
      <Menu>
        <!-- Primary: Inbox / Sync -->
        <MenuItem icon="space" disabled={true} onclick={() => {}}>
          <strong style="font-weight:600;">Inbox & Sync</strong>
        </MenuItem>
        <MenuItem icon={iconSync} onclick={doSync}>
          Sync Now
          <div class="menu-desc">Flush pending ops and refresh inbox from server</div>
        </MenuItem>
        <MenuItem icon={iconRefresh} onclick={() => { const u = new URL(window.location.href); u.searchParams.set('refresh', '1'); location.href = u.toString(); }}>
          Check for App Update
      
        </MenuItem>

        <!-- Precompute section -->
        <MenuItem icon="space" disabled={true} onclick={() => {}}>
          <strong style="font-weight:600;">Precompute</strong>
        </MenuItem>
        <MenuItem icon={iconSparkles} onclick={doPrecompute}>
          Run Precompute
          <div class="menu-desc">Generate AI summaries for cached threads (requires AI key)</div>
        </MenuItem>
        <MenuItem icon={iconLogs} onclick={doShowPrecomputeLogs}>
          Review Precompute Logs
          <div class="menu-desc">Inspect recent precompute activity and errors</div>
        </MenuItem>
        <MenuItem icon={iconSmartToy} onclick={doShowPrecomputeSummary}>
          Precompute Summary
          <div class="menu-desc">View aggregate stats and recent run details</div>
        </MenuItem>
        <MenuItem icon={iconSparkles} onclick={doBackfillSummaryVersions}>Backfill AI summary versions</MenuItem>

        <!-- Dev / Diagnostics section (recommended sequence included) -->
        <MenuItem icon="space" disabled={true} onclick={() => {}}>
          <strong style="font-weight:600;">Developer tools</strong>
        </MenuItem>
        <MenuItem icon={iconTerminal} onclick={() => (devToolsOpen = true)} aria-label="Developer tools">
          Dev tools
          <div class="menu-desc">Common developer utilities</div>
        </MenuItem>
        <MenuItem icon={iconNotifications} onclick={async () => {
          try {
            const { getHistory } = await import('$lib/containers/snackbar');
            notifications = getHistory();
            notificationsOpen = true;
          } catch (e) { showSnackbar({ message: 'Failed to load notifications', closable: true }); }
        }}>Notifications</MenuItem>

        <!-- Account & About -->
        <MenuItem icon={iconLogout} onclick={doRelogin}>Re-login</MenuItem>
        <MenuItem icon={iconSettings} onclick={() => (location.href = '/settings')}>Settings</MenuItem>
        <MenuItem icon={iconInfo} onclick={() => { aboutOpen = true; }}>About</MenuItem>
      </Menu>
    </details>
    <Dialog icon={iconInfo} headline="About" bind:open={aboutOpen} closeOnClick={false}>
      {#snippet children()}
        <div class="about">
          <div class="row"><span class="k">Version</span><span class="v">{appVersion}</span></div>
          <div class="row"><span class="k">Build</span><span class="v">{buildId}</span></div>
          <div class="row"><span class="k">Cache</span><span class="v">{cacheVersion}</span></div>
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
  .label { margin-inline-start: 0.25rem; }
  .search-field { flex: 1 1 12rem; min-width: 0; }
  .search-field :global(.m3-container) {
    min-width: 12rem;
    width: 100%;
  }
  .overflow { position:relative; }
  .overflow > summary { list-style: none; }
  .summary-btn { cursor: pointer; }
  .overflow[open] > :global(.m3-container) { position:absolute; right:0; margin-top:0.25rem; }
  .last-sync { color: rgb(var(--m3-scheme-on-surface-variant)); margin-inline-start: 0; }
  .about { display:flex; flex-direction:column; gap:0.5rem; }
  .about .row { display:flex; justify-content:space-between; gap:1rem; }
  .about .k { color: rgb(var(--m3-scheme-on-surface-variant)); }
  .about .v { color: rgb(var(--m3-scheme-on-surface)); font-variant-numeric: tabular-nums; }
  /* Make Undo/Redo dropdowns wider to accommodate longer text */
  .history-menu :global(.m3-container) { max-width: 28rem; }
  /* Center Undo/Redo dropdown menus in the viewport */
  .history-menu {
    position: fixed !important;
    top: 50% !important;
    left: 50% !important;
    transform: translate(-50%, -50%);
    right: auto !important;
    bottom: auto !important;
  }
  :global(.chip-icon) { width:1.1rem; height:1.1rem; flex:0 0 auto; }
</style>