<script lang="ts">
  import { precomputeStatus } from '$lib/stores/precompute';
  import { writable } from 'svelte/store';
  import LinearProgress from '$lib/forms/LinearProgress.svelte';
  import Icon from '$lib/misc/_icon.svelte';
  import iconSparkles from '@ktibow/iconset-material-symbols/auto-awesome';
  import iconClose from '@ktibow/iconset-material-symbols/close';
  import { show as showSnackbar } from '$lib/containers/snackbar';
  import { onDestroy } from 'svelte';
  
  // Accept an optional onClose prop or dispatch a close event when X clicked
  let { onClose }: { onClose?: () => void } = $props();
  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher();
  
  const progressPercent = $derived($precomputeStatus.total > 0 
    ? Math.round(($precomputeStatus.processed / $precomputeStatus.total) * 100)
    : 0);
  
  const elapsedTime = $derived($precomputeStatus.startTime 
    ? Math.round((Date.now() - $precomputeStatus.startTime) / 1000)
    : 0);
  
  const timeString = $derived(elapsedTime < 60 
    ? `${elapsedTime}s` 
    : `${Math.floor(elapsedTime / 60)}m ${elapsedTime % 60}s`);

  // Watch for completion to show final summary snackbar
  let prevRunning = false;
  const runningErrorSummary = writable('');
  let unsub = precomputeStatus.subscribe(async (s) => {
    try {
      // While running, attempt to surface up to three recent unique error messages
      if (s.isRunning && (s as any)._errors > 0) {
        try {
          const mod = await import('$lib/ai/precompute');
          const getLogs = typeof (mod as any).getPrecomputeLogs === 'function' ? (mod as any).getPrecomputeLogs : null;
          const logs = getLogs ? (getLogs() as any[]) : [];
          const errorLogs = logs.filter((l:any) => l.level && l.level.toLowerCase() === 'error');
          const uniq: string[] = [];
          for (const e of errorLogs) {
            const msg = typeof e.message === 'string' ? (e.message.split('\n')[0] || e.message).trim() : String(e.message || '');
            if (msg && !uniq.includes(msg)) uniq.push(msg);
            if (uniq.length >= 3) break;
          }
          runningErrorSummary.set(uniq.length ? uniq.map((m, i) => `${i+1}. ${m}`).join(' — ') : '');
        } catch (e) {
          runningErrorSummary.set('');
        }
      } else {
        runningErrorSummary.set('');
      }
    } catch {}
    try {
      // detect transition from running -> not running
      if (prevRunning && !s.isRunning) {
        const counts = (precomputeStatus as any).getCounts ? (precomputeStatus as any).getCounts() : { errors: 0, warns: 0 };
        // Attempt to fetch up to three error descriptions to include inline in the snackbar
        let errorSummary = '';
        // Prefer exact processed count from precomputeStatus._lastProcessed when available
        let successCount: number | null = null;
        try {
          const v: any = s as any;
          if (typeof v._lastProcessed === 'number') {
            successCount = Math.max(0, v._lastProcessed - (counts.errors || 0));
          }
        } catch {}

        if (successCount === null && counts.errors > 0) {
          try {
            const mod = await import('$lib/ai/precompute');
            const getLogs = typeof (mod as any).getPrecomputeLogs === 'function' ? (mod as any).getPrecomputeLogs : null;
            const logs = getLogs ? (getLogs() as any[]) : [];
            const errorLogs = logs.filter((l:any) => l.level && l.level.toLowerCase() === 'error');
            if (errorLogs.length > 0) {
              // Take up to three error messages, de-duplicate by message text
              const uniq: string[] = [];
              for (const e of errorLogs) {
                const msg = typeof e.message === 'string' ? e.message.trim() : String(e.message || '');
                if (msg && !uniq.includes(msg)) uniq.push(msg);
                if (uniq.length >= 3) break;
              }
              if (uniq.length > 0) {
                errorSummary = '\nErrors: ' + uniq.map((m, i) => `${i+1}. ${m}`).join('\n');
              }
            }
            // Try to find the Completed log entry to determine processed count
            try {
              const completed = logs.find((l:any) => typeof l.message === 'string' && l.message.indexOf('[Precompute] Completed:') >= 0);
              if (completed && completed.message) {
                const idx = completed.message.indexOf('{');
                if (idx >= 0) {
                  const jsonPart = completed.message.slice(idx);
                  try {
                    const parsed = JSON.parse(jsonPart);
                    if (typeof parsed.processed === 'number') {
                      // successful items approximated as processed - errors
                      successCount = parsed.processed - (counts.errors || 0);
                      if (successCount < 0) successCount = 0;
                    }
                  } catch {}
                }
              }
            } catch {}
          } catch (e) {
            // ignore and fall back to generic message
          }
        }

        // Gather provider error diagnostics from logs (rate limits, quota, etc.)
        let providerDiagnostics = '';
        try {
          const mod = await import('$lib/ai/precompute');
          const getLogs = typeof (mod as any).getPrecomputeLogs === 'function' ? (mod as any).getPrecomputeLogs : null;
          const logs = getLogs ? (getLogs() as any[]) : [];
          const diag = logs.filter((l:any) => l.message && /rate limit|rate limited|quota|insufficient_quota|rate limit exceeded|rate limit/i.test(l.message));
          if (diag.length) {
            const uniq = Array.from(new Set(diag.map(d => d.message))).slice(0,3);
            providerDiagnostics = '\nProvider issues: ' + uniq.map((u,i) => `${i+1}. ${u}`).join('\n');
          }
        } catch {}

        const message = counts.errors > 0
          ? `Precompute finished: ${counts.errors} errors, ${counts.warns} warnings.${successCount !== null ? ` ${successCount} succeeded.` : ''}${errorSummary || ''}` + providerDiagnostics
          : (counts.warns > 0 ? `Precompute finished with ${counts.warns} warnings.` + providerDiagnostics : 'Precompute completed successfully.' + providerDiagnostics);
        // Offer Copy + View actions via snackbar. View will dispatch a global event
        // so a top-level component (TopAppBar) can open the Precompute logs dialog.
        const actions: Record<string, () => void> = {
          'Copy logs': async () => {
            try {
              const mod = await import('$lib/ai/precompute');
              const getLogs = typeof (mod as any).getPrecomputeLogs === 'function' ? (mod as any).getPrecomputeLogs : null;
              const logs = getLogs ? getLogs() : [];
              const txt = logs.map((l:any) => `[${new Date(l.ts).toLocaleString()}] ${l.level.toUpperCase()}: ${l.message}`).join('\n');
              await navigator.clipboard.writeText(txt);
              showSnackbar({ message: 'Logs copied', closable: true });
            } catch (e) {
              showSnackbar({ message: 'Failed to copy logs', closable: true });
            }
          },
          'View logs': async () => {
            try {
              // Let the app open the logs dialog; dispatch a global event so the
              // topbar (or any interested listener) can handle showing the dialog.
              window.dispatchEvent(new CustomEvent('jmail:show-precompute-logs'));
            } catch (e) {
              // Fallback to snackbar if dispatch fails
              showSnackbar({ message: 'Could not open logs', closable: true });
            }
          }
        };

        showSnackbar({ message, actions, timeout: counts.errors > 0 ? null : 6000 });
      }
    } catch {}
    prevRunning = !!s.isRunning;
  });
  onDestroy(() => { try { unsub(); } catch {} });
</script>

{#if $precomputeStatus.isRunning}
  <div class="progress-container" role="status" aria-live="polite">
    <div class="progress-content">
      <div class="progress-header">
        <div class="progress-info">
          <Icon icon={iconSparkles} class="sparkle-icon" />
          <div class="progress-text">
            <div class="progress-title">AI Precompute Running</div>
            <div class="progress-subtitle">
              {$precomputeStatus.currentOperation || 'Processing...'}
            </div>
          </div>
        </div>
        <div class="progress-stats">
          <span class="progress-count">{$precomputeStatus.processed} / {$precomputeStatus.total}</span>
          <span class="progress-time">{timeString}</span>
          <span class="progress-badges">
            {#if ($precomputeStatus._errors || 0) > 0}
              <span class="badge error" title={$runningErrorSummary || 'Click to view logs.'}>
                {($precomputeStatus._errors || 0)} errors{#if $runningErrorSummary}: {$runningErrorSummary}{/if}
              </span>
            {/if}
            {#if ($precomputeStatus._warns || 0) > 0}
              <span class="badge warn">{($precomputeStatus._warns || 0)} warnings</span>
            {/if}
          </span>
        </div>
        <!-- Always show a close X in the top-right; prefer prop handler if provided, else dispatch `close` -->
        <button 
          class="close-button" 
          onclick={() => { try { if (typeof onClose === 'function') onClose(); else dispatch('close'); } catch {} }}
          aria-label="Close progress indicator"
          title="Close progress indicator"
        >
          <Icon icon={iconClose} />
        </button>
      </div>
      
      <div class="progress-bar">
        <LinearProgress percent={progressPercent} height={6} />
      </div>
      
      <div class="progress-details">
        <span class="progress-percent">{progressPercent}% complete</span>
        {#if $precomputeStatus.total > 0}
          <span class="progress-eta">
            {progressPercent > 0 && elapsedTime > 0 
              ? `~${Math.round((elapsedTime / progressPercent) * (100 - progressPercent))}s remaining`
              : 'Calculating...'
            }
          </span>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .progress-container {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    background: rgb(var(--m3-scheme-surface-container));
    border-top: 1px solid rgb(var(--m3-scheme-outline-variant));
    box-shadow: 0 -4px 8px -2px rgba(0, 0, 0, 0.1);
    animation: slideUp 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
  }
  
  .progress-content {
    padding: 1rem 1.5rem;
    max-width: 100%;
  }
  
  .progress-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.75rem;
  }
  
  .progress-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
  }
  
  .progress-info :global(.sparkle-icon) {
    color: rgb(var(--m3-scheme-primary));
    flex-shrink: 0;
  }
  
  .progress-text {
    min-width: 0;
    flex: 1;
  }
  
  .progress-title {
    font-weight: 500;
    color: rgb(var(--m3-scheme-on-surface));
    margin-bottom: 0.125rem;
    font-size: 0.875rem;
  }
  
  .progress-subtitle {
    color: rgb(var(--m3-scheme-on-surface-variant));
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .progress-stats {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.25rem;
    flex-shrink: 0;
  }
  
  .progress-count {
    font-size: 0.75rem;
    color: rgb(var(--m3-scheme-on-surface));
    font-weight: 500;
  }
  
  .progress-time {
    font-size: 0.75rem;
    color: rgb(var(--m3-scheme-on-surface-variant));
  }
  
  .close-button {
    background: none;
    border: none;
    padding: 0.5rem;
    border-radius: 50%;
    cursor: pointer;
    color: rgb(var(--m3-scheme-on-surface-variant));
    transition: background-color 0.2s ease;
    flex-shrink: 0;
  }
  
  .close-button:hover {
    background-color: rgb(var(--m3-scheme-surface-container-highest));
  }
  
  .close-button:active {
    background-color: rgb(var(--m3-scheme-surface-container-highest));
  }
  
  .progress-bar {
    margin-bottom: 0.75rem;
  }
  
  .progress-details {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.75rem;
  }
  
  .progress-percent {
    color: rgb(var(--m3-scheme-on-surface));
    font-weight: 500;
  }
  
  .progress-eta {
    color: rgb(var(--m3-scheme-on-surface-variant));
  }
  
  @keyframes slideUp {
    from {
      transform: translateY(100%);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
  
  /* Mobile responsive adjustments */
  @media (max-width: 768px) {
    .progress-content {
      padding: 0.75rem 1rem;
    }
    
    .progress-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
    }
    
    .progress-stats {
      align-items: flex-start;
      flex-direction: row;
      gap: 1rem;
    }
    
    .close-button {
      position: absolute;
      top: 0.75rem;
      right: 1rem;
    }
  }
</style>
