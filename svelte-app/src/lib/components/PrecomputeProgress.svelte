<script lang="ts">
  import { precomputeStatus } from '$lib/stores/precompute';
  import LinearProgress from '$lib/forms/LinearProgress.svelte';
  import Icon from '$lib/misc/_icon.svelte';
  import iconSparkles from '@ktibow/iconset-material-symbols/auto-awesome';
  import iconClose from '@ktibow/iconset-material-symbols/close';
  
  let { onClose }: { onClose?: () => void } = $props();
  
  const progressPercent = $derived($precomputeStatus.total > 0 
    ? Math.round(($precomputeStatus.processed / $precomputeStatus.total) * 100)
    : 0);
  
  const elapsedTime = $derived($precomputeStatus.startTime 
    ? Math.round((Date.now() - $precomputeStatus.startTime) / 1000)
    : 0);
  
  const timeString = $derived(elapsedTime < 60 
    ? `${elapsedTime}s` 
    : `${Math.floor(elapsedTime / 60)}m ${elapsedTime % 60}s`);
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
        </div>
        {#if onClose}
          <button 
            class="close-button" 
            onclick={onClose}
            aria-label="Close progress indicator"
            title="Close progress indicator"
          >
            <Icon icon={iconClose} />
          </button>
        {/if}
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
  
  .sparkle-icon {
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
