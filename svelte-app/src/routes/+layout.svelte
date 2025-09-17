<script lang="ts">
  import type { Snippet } from "svelte";
  // Sidebar icons removed because sidebar tabs are hidden
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import { get } from 'svelte/store';
  import NavCMLX from "$lib/nav/NavCMLX.svelte";
  import NavCMLXItem from "$lib/nav/NavCMLXItem.svelte";
  import { styling } from "./themeStore";
  import "../app.css";
  import { startFlushLoop } from "$lib/queue/flush";
  import TopAppBar from "$lib/misc/TopAppBar.svelte";
  import { refreshSyncState } from "$lib/stores/queue";
  import FAB from "$lib/buttons/FAB.svelte";
  import Snackbar from "$lib/containers/Snackbar.svelte";
  import { register as registerSnackbar, show as showSnackbar } from "$lib/containers/snackbar";
  
  import iconCompose from "@ktibow/iconset-material-symbols/edit";
  import BottomSheet from "$lib/containers/BottomSheet.svelte";
  import TextField from "$lib/forms/TextField.svelte";
  import TextFieldMultiline from "$lib/forms/TextFieldMultiline.svelte";
  import Button from "$lib/buttons/Button.svelte";
  import { queueSendRaw } from "$lib/queue/intents";
  import { copyGmailDiagnosticsToClipboard } from "$lib/gmail/api";
  import { startUpdateChecker } from "$lib/update/checker";
  import KeyboardShortcutsDialog from "$lib/misc/KeyboardShortcutsDialog.svelte";
  import { settings as appSettings } from "$lib/stores/settings";
  import { getFriendlyAIErrorMessage } from "$lib/ai/providers";
  import PrecomputeProgress from "$lib/components/PrecomputeProgress.svelte";
  import RecipientBadges from "$lib/utils/RecipientBadges.svelte";
  import { loadUserProfile } from "$lib/stores/user";
  import { installGlobalAuthInterceptor, sessionManager } from "$lib/auth/session-manager";
  
  let onKeyDownRef: ((e: KeyboardEvent) => void) | null = null;
  
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      navigator.serviceWorker.addEventListener('message', (e) => {
        try {
          const msg = e.data || {};
          if (msg.type === 'NOTIFICATION_ACTION') {
            const data = msg.data || {};
            if (msg.action === 'archive' && data.threadId) {
              import('$lib/queue/intents').then((m) => m.archiveThread(data.threadId)).catch(() => {});
            }
            if (msg.action === 'snooze1h' && data.threadId) {
              import('$lib/snooze/actions').then((m) => m.snoozeThreadByRule(data.threadId, '1h')).catch(() => {});
            }
          }
          if (msg.type === 'SYNC_TICK') {
            import('$lib/db/backups').then((m) => m.maybeCreateWeeklySnapshot()).catch(() => {});
            // Trigger background precompute tick for AI summaries (lightweight)
            import('$lib/ai/precompute').then((m) => m.tickPrecompute(8)).catch(() => {});
          }
        } catch (err) {
          console.warn('[SW Message] Handler error:', err);
        }
      });
    } catch (err) {
      console.warn('[SW] Event listener setup failed:', err);
    }
  }

  if (typeof window !== 'undefined') {
    // Support ?refresh to force a clean reload without caches/service worker
    try {
      const currentUrl = new URL(window.location.href);
      if (currentUrl.searchParams.has('refresh')) {
        (async () => {
          const log = (...args: any[]) => { try { console.log('[ForceRefresh]', ...args); } catch {} };
          const collect = async (stage: string) => {
            const registrations = await (async () => {
              try {
                if (!('serviceWorker' in navigator)) return [] as any[];
                const regs = await navigator.serviceWorker.getRegistrations();
                return regs.map((r) => ({ scope: r.scope, active: !!r.active, waiting: !!r.waiting, installing: !!r.installing }));
              } catch { return [] as any[]; }
            })();
            const cacheKeys = await (async () => { try { return await caches.keys(); } catch { return [] as string[]; } })();
            const controller = (() => { try { return navigator.serviceWorker?.controller?.scriptURL || null; } catch { return null; } })();
            const diag = {
              stage,
              time: Date.now(),
              href: window.location.href,
              userAgent: navigator.userAgent,
              controller,
              registrations,
              cacheKeys,
              doc: { readyState: document.readyState, visibilityState: (document as any).visibilityState }
            };
            log('diag', diag);
            try { await navigator.clipboard.writeText(JSON.stringify(diag, null, 2)); } catch {}
            return diag;
          };

          try {
            await collect('before');
            if ('caches' in window) {
              try {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
              } catch {}
            }
            if ('serviceWorker' in navigator) {
              try {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map((r) => r.unregister()));
              } catch {}
            }
            await collect('after');
          } catch (_) {}

          currentUrl.searchParams.delete('refresh');
          const cleanPath = currentUrl.pathname + (currentUrl.search || '') + currentUrl.hash;
          const sep = cleanPath.includes('?') ? '&' : '?';
          const target = (cleanPath || '/') + sep + '__hardreload=' + Date.now();
          log('navigating to', target);
          window.location.assign(target);
        })();
      }
    } catch (_) {}

    try {
      startFlushLoop();
    } catch (err) {
      console.warn('[Init] startFlushLoop failed:', err);
    }
    
    // Install global auth interceptor for automatic session refresh
    try {
      // Temporarily disabled to prevent infinite recursion - will be re-enabled after testing
      // installGlobalAuthInterceptor();
      console.log('[Init] Global auth interceptor temporarily disabled');
    } catch (err) {
      console.warn('[Init] Global auth interceptor failed:', err);
    }
    
    // Start session monitoring
    try {
      sessionManager.startMonitoring();
      console.log('[Init] Session monitoring started');
    } catch (err) {
      console.warn('[Init] Session monitoring failed:', err);
    }
    
    // Load settings at app start
    try {
      import('$lib/stores/settings').then((m)=>m.loadSettings()).catch(() => {});
    } catch (err) {
      console.warn('[Init] settings loading failed:', err);
    }
    
    try {
      refreshSyncState();
    } catch (err) {
      console.warn('[Init] refreshSyncState failed:', err);
    }
    
    // Load user profile for recipient filtering
    try {
      loadUserProfile().catch(() => {
        // Silently handle errors during profile loading
      });
    } catch (err) {
      console.warn('[Init] loadUserProfile failed:', err);
    }
    
    try {
      import('$lib/db/backups').then((m) => m.maybeCreateWeeklySnapshot()).catch(() => {});
    } catch (err) {
      console.warn('[Init] backups failed:', err);
    }
    
    // Kick a small precompute tick shortly after startup
    try { 
      setTimeout(() => { 
        try {
          import('$lib/ai/precompute').then((m) => m.tickPrecompute(6)).catch(() => {}); 
        } catch {}
      }, 4000); 
    } catch {}
    
    // Schedule nightly/initial backfill at user-configured anchorHour if enabled
    (async () => {
      try {
        const s: any = get(appSettings);
        if (s?.precomputeSummaries && s?.precomputeAutoRun) {
          const anchorHour = Number(s.anchorHour || 5);
          const now = new Date();
          const next = new Date(now);
          next.setHours(anchorHour, 0, 0, 0);
          if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
          const delay = Math.max(0, next.getTime() - now.getTime());
          // One-off timeout to fire at the next anchor hour, then repeat every 24h
          setTimeout(() => {
            try { import('$lib/ai/precompute').then((m) => m.precomputeNow(200)).catch(() => {}); } catch (_) {}
            try { setInterval(() => { import('$lib/ai/precompute').then((m) => m.precomputeNow(200)).catch(() => {}); }, 1000 * 60 * 60 * 24); } catch (_) {}
          }, delay);
        }
      } catch (_) {}
    })();
    
    // Keep optional: legacy local snooze viewer; safe if empty
    try {
      import('$lib/stores/snooze').then((m)=>m.loadSnoozes()).catch(() => {});
    } catch (err) {
      console.warn('[Init] snooze loading failed:', err);
    }

    // Check for newer app version and offer a reload (disabled in dev)
    try {
      if (!(import.meta as any).env?.DEV) {
        startUpdateChecker(() => {
          showSnackbar({
            message: 'A new version is available',
            actions: {
              Reload: () => {
                const url = new URL(window.location.href);
                url.searchParams.set('__hardreload', String(Date.now()));
                window.location.assign(url.toString());
              }
            },
            closable: true,
            timeout: null
          });
        }, { intervalMs: 5 * 60 * 1000, immediate: true });
      }
    } catch (_) {}

    // Offline banner
    const updateOfflineState = () => {
      isOffline = !navigator.onLine;
    };
    window.addEventListener('online', updateOfflineState);
    window.addEventListener('offline', updateOfflineState);
    setTimeout(updateOfflineState, 0);

    // Global keyboard shortcuts (Gmail-like)
    const isFromInput = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return false;
      const tag = (t.tagName || '').toLowerCase();
      const editable = (t as any).isContentEditable;
      return tag === 'input' || tag === 'textarea' || editable;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // '?' help dialog
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        if (isFromInput(e)) return;
        e.preventDefault();
        try { kbdDialog?.show(); } catch {}
        return;
      }
      // '/' focus search in top app bar
      if (e.key === '/' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isFromInput(e)) return;
        e.preventDefault();
        try { (window as any).jmailFocusSearch?.(); } catch {}
        return;
      }
      // 'c' compose
      if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isFromInput(e)) return;
        e.preventDefault();
        showCompose = true;
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    onKeyDownRef = onKeyDown;

    // Comprehensive authentication check with server session support
    // Skip redirect for debug and test pages
    (async () => {
      try {
        // Allow access to debug and test pages without authentication
        const debugPaths = ['/auth-debug', '/auth-test'];
        const currentPath = location.pathname;
        const isDebugPath = debugPaths.some(path => currentPath.startsWith(path));
        
        console.log('[Layout] Auth check - Current path:', currentPath, 'Is debug path:', isDebugPath);
        
        if (isDebugPath) {
          return; // Skip authentication check for debug pages
        }

        // First check for server session (most reliable for authenticated users)
        let hasValidAuth = false;
        try {
          const { checkServerSession } = await import('$lib/gmail/server-session-check');
          const serverSession = await checkServerSession();
          if (serverSession.authenticated) {
            console.log('[Layout] Found valid server session, user is authenticated');
            hasValidAuth = true;
            
            // Store server session for consistency
            try {
              const { storeServerSessionInDB } = await import('$lib/gmail/server-session-check');
              await storeServerSessionInDB(serverSession);
            } catch (e) {
              console.warn('[Layout] Failed to store server session:', e);
            }
          }
        } catch (e) {
          console.warn('[Layout] Server session check failed:', e);
        }

        // If no server session, check local database
        if (!hasValidAuth) {
          try {
            const { getDB } = await import('$lib/db/indexeddb');
            const db = await getDB();
            const account = await db.get('auth', 'me');
            if (account) {
              hasValidAuth = true;
              // Apply server session to session manager if applicable
              try {
                if ((account as any).serverManaged) {
                  sessionManager.applyServerSession((account as any).email, (account as any).tokenExpiry);
                  console.log('[Layout] Applied server-managed session to sessionManager for', (account as any).email);
                }
              } catch (e) {
                console.warn('[Layout] Failed to apply server session to sessionManager:', e);
              }
            }
          } catch (dbErr) {
            console.warn('[Layout] Database check failed:', dbErr);
          }
        }

        // Only redirect to connect screen if we're not already there and no auth found
        if (!hasValidAuth) {
          const target = (base || '') + '/';
          if (location.pathname !== target) {
            console.log('[Layout] No authentication found, redirecting to connect screen');
            location.href = target;
          }
        }
        
      } catch (err) {
        console.warn('[Layout] Auth check failed:', err);
      }
    })();

    // Global error reporting to snackbar with Copy action
    try {
      window.addEventListener('error', (e: ErrorEvent) => {
        const message = e?.message || 'An unexpected error occurred';
        showSnackbar({
          message,
          actions: {
            Copy: async () => {
              const ok = await copyGmailDiagnosticsToClipboard({ reason: 'window_error', message, stack: (e?.error as Error | undefined)?.stack });
              showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
            }
          },
          closable: true,
          timeout: 6000
        });
      });
      window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
        const reason: unknown = (e && 'reason' in e) ? (e as any).reason : undefined;
        const friendly = getFriendlyAIErrorMessage(reason);
        const message = friendly.message || (reason instanceof Error ? reason.message : String(reason || 'Unhandled promise rejection'));
        showSnackbar({
          message,
          actions: {
            Copy: async () => {
              const base = { reason: 'unhandled_rejection', message, stack: reason instanceof Error ? reason.stack : undefined } as Record<string, unknown>;
              try {
                if (reason && typeof reason === 'object') {
                  const r: any = reason;
                  if (r.name === 'AIProviderError') {
                    base.ai = {
                      status: r.status,
                      requestId: r.requestId,
                      retryAfterSeconds: r.retryAfterSeconds,
                      headers: r.headers,
                      body: r.body
                    };
                  }
                }
              } catch (_) {}
              const ok = await copyGmailDiagnosticsToClipboard(base);
              showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
            }
          },
          closable: true,
          timeout: 6000
        });
      });
    } catch (_) {}
  }

  // Cleanup global listeners when layout unmounts
  $effect(() => {
    return () => {
      try { 
        if (onKeyDownRef && typeof window !== 'undefined') {
          window.removeEventListener('keydown', onKeyDownRef as any); 
        }
      } catch (err) {
        console.warn('[Layout] Cleanup failed:', err);
      }
    };
  });

  let { children }: { children: Snippet } = $props();

  // Hide sidebar navigation items by default
  const paths: any[] = [];
  const normalizePath = (path: string) => {
    try {
      const u = new URL(path, page.url.href);
      path = u.pathname;
      if (path.endsWith("/")) path = path.slice(0, -1);
      return path || "/";
    } catch (err) {
      console.warn('[Layout] Path normalization failed:', err);
      return path || "/";
    }
  };


  // Compose sheet state
  let showCompose = $state(false);
  let to = $state("");
  let subject = $state("");
  let body = $state("");
  let snackbar: ReturnType<typeof Snackbar>;
    let isOffline = $state(false);
  let kbdDialog: ReturnType<typeof KeyboardShortcutsDialog>;
  
  $effect(() => {
    try {
      const percent = (typeof ($appSettings as any)?.fontScalePercent === 'number' ? ($appSettings as any).fontScalePercent : 100);
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.style.setProperty('--m3-font-scale', `${percent}%`);
      }
    } catch (err) {
      console.warn('[Layout] Font scale update failed:', err);
    }
  });
  
  $effect(() => { 
    try {
      if (snackbar && typeof snackbar.show === 'function' && typeof snackbar.dismiss === 'function') {
        registerSnackbar(snackbar.show, snackbar.dismiss);
      } else if (snackbar && typeof snackbar.show === 'function') {
        registerSnackbar(snackbar.show);
      }
    } catch (err) {
      console.warn('[Layout] Snackbar registration failed:', err);
    }
  });

  function makeRfc2822(): string {
    const boundary = `----Jmail-${Math.random().toString(36).slice(2)}`;
    const headers = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
    ].join("\r\n");
    const raw = `${headers}\r\n\r\n${body}`;
    // base64url encode
    const b64 = btoa(unescape(encodeURIComponent(raw)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    return b64;
  }

  async function sendCompose() {
    try {
      const raw = makeRfc2822();
      await queueSendRaw(raw);
      showCompose = false;
      to = subject = body = "";
      snackbar.show({ message: "Message queued to send", closable: true });
    } catch (e) {
      snackbar.show({ message: `Failed to queue: ${e instanceof Error ? e.message : e}`, closable: true });
    }
  }

  const isViewer = $derived(/\/viewer\//.test(page.url.pathname));
  const backHref = $derived(isViewer ? (base || '') + '/inbox' : undefined);
  const isSettings = $derived(normalizePath(page.url.pathname).startsWith(normalizePath((base || '') + '/settings')));
</script>

<svelte:head>
  <title>Jmail</title>
  <meta name="application-name" content="Jmail" />
  <meta property="og:title" content="Jmail" />
</svelte:head>

{@html `<style>${$styling}</style>`}
<div class="container">
  {#if normalizePath(base || "/") !== normalizePath(page.url.pathname)}
    <div class="sidebar">
      <NavCMLX variant="auto">
        {#each paths as { path, icon, iconS, label }}
          {@const selected = normalizePath(path) === normalizePath(page.url.pathname)}
          <NavCMLXItem
            variant="auto"
            href={normalizePath(path)}
            {selected}
            icon={selected ? iconS : icon}
            text={label}
          />
        {/each}
        
      </NavCMLX>
    </div>
  {/if}
  <div class="content">
    {#if normalizePath(base || "/") !== normalizePath(page.url.pathname)}
      <TopAppBar onSyncNow={() => refreshSyncState()} {backHref} backLabel="Back to inbox" />
      <div id="offline-banner" class="offline" class:visible={isOffline}>You are offline. Actions will be queued.</div>
    {/if}
    {@render children()}
    {#if normalizePath(base || "/") !== normalizePath(page.url.pathname) && !isSettings}
      <div class="fab-holder">
        <FAB color="primary" icon={iconCompose} onclick={() => (showCompose = true)} />
      </div>
    {/if}
    <Snackbar bind:this={snackbar} />
    <KeyboardShortcutsDialog bind:this={kbdDialog} />
  </div>
  
  <!-- Global precompute progress indicator -->
  <PrecomputeProgress onClose={() => {
    import('$lib/stores/precompute').then(m => m.precomputeStatus.reset());
  }} />
</div>

<style>
  .container {
    display: grid;
    min-height: 100dvh;
  }
  .sidebar {
    display: flex;
    position: sticky;
  }
  .content {
    display: flex;
    flex-direction: column;
    padding: 0.75rem 1rem;
    gap: 0.75rem;
    min-width: 0;
  }
  @media (width < 52.5rem) {
    .container {
      grid-template-rows: 1fr;
      /* Remove extra bottom spacing since bottom tabs are removed */
      --m3-util-bottom-offset: unset;
    }
    .sidebar {
      display: none;
    }
  }
  @media (width >= 52.5rem) {
    .container {
      grid-template-columns: auto 1fr;
    }
    .sidebar {
      grid-column: 1;
      top: 0;
      left: 0;
      flex-direction: column;
      height: 100dvh;
      @media (width < 100rem) {
        width: 6rem;
        > :global(nav) {
          position: absolute;
          top: 50%;
          translate: 0 -50%;
        }
      }
    }
    .content {
      padding: 1.25rem 1.5rem;
      gap: 1rem;
      grid-column: 2;
      min-width: 0;
    }
  }
  .fab-holder {
    position: fixed;
    right: 1.25rem;
    bottom: var(--m3-util-bottom-offset, 1.25rem);
    z-index: 3;
  }
  .offline {
    display: none;
    background: rgb(var(--m3-scheme-surface-container-highest));
    color: rgb(var(--m3-scheme-on-surface));
    border: 1px solid var(--m3-outline-variant);
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.5rem;
  }
  .offline.visible { display: block; }
</style>

{#if normalizePath(base || "/") !== normalizePath(page.url.pathname) && showCompose}
  <BottomSheet close={() => (showCompose = false)}>
    <div style="display:grid; gap:0.5rem; padding-bottom:1rem;">
      <h3 class="m3-font-title-medium" style="margin:0.25rem 0 0 0">New message</h3>
      <TextField label="To" bind:value={to} type="email" />
      {#if to.trim()}
        <RecipientBadges 
          to={to} 
          maxDisplayCount={6} 
          compact={false} 
        />
      {/if}
      <TextField label="Subject" bind:value={subject} />
      <TextFieldMultiline label="Message" bind:value={body} rows={8} />
      <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
        <Button variant="text" onclick={() => (showCompose = false)}>Discard</Button>
        <Button variant="filled" onclick={sendCompose}>Send</Button>
      </div>
    </div>
  </BottomSheet>
{/if}