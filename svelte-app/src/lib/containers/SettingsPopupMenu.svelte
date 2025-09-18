<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import Card from '$lib/containers/Card.svelte';
  import Switch from '$lib/forms/Switch.svelte';
  import Button from '$lib/buttons/Button.svelte';
  import Icon from '$lib/misc/_icon.svelte';
  import iconClose from "@ktibow/iconset-material-symbols/close";
  import type { AppSettings } from '$lib/stores/settings';

  export let visible = false;
  export let settings: Partial<AppSettings> = {};
  export let title = "Settings";
  export let settingKeys: (keyof AppSettings)[] = [];

  const dispatch = createEventDispatcher<{
    close: void;
    update: { key: keyof AppSettings; value: any };
    openFullSettings: void;
  }>();

  function handleSettingChange(key: keyof AppSettings, value: any) {
    dispatch('update', { key, value });
  }

  function getSettingLabel(key: keyof AppSettings): string {
    const labels: Record<keyof AppSettings, string> = {
      precomputeSummaries: 'Enable AI Precompute',
      precomputeAutoRun: 'Auto-run Precompute',
      precomputeUseBatch: 'Use Batch Mode',
      precomputeUseContextCache: 'Use Context Cache',
      confirmDelete: 'Confirm Delete Actions',
      notifEnabled: 'Enable Notifications',
      aiPageFetchOptIn: 'AI Page Fetch',
      unreadOnUnsnooze: 'Mark Unread on Unsnooze',
      suppressAuthPopups: 'Suppress Auth Popups',
      // Add more labels as needed
      anchorHour: 'Anchor Hour',
      roundMinutes: 'Round Minutes',
      labelMapping: 'Label Mapping',
      aiProvider: 'AI Provider',
      aiApiKey: 'AI API Key',
      aiModel: 'AI Model',
      aiSummaryModel: 'AI Summary Model',
      aiDraftModel: 'AI Draft Model',
      taskFilePath: 'Task File Path',
      trailingRefreshDelayMs: 'Refresh Delay (ms)',
      trailingSlideOutDurationMs: 'Slide Out Duration (ms)',
      swipeRightPrimary: 'Swipe Right Action',
      swipeLeftPrimary: 'Swipe Left Action',
      swipeCommitVelocityPxPerSec: 'Swipe Commit Velocity',
      swipeDisappearMs: 'Swipe Disappear Duration',
      inboxSort: 'Inbox Sort',
      fontScalePercent: 'Font Scale Percent',
      inboxPageSize: 'Inbox Page Size',
      authPopupCooldownSeconds: 'Auth Popup Cooldown',
      pullForwardCount: 'Pull Forward Count'
    };
    return labels[key] || key.toString();
  }

  function getSettingDescription(key: keyof AppSettings): string {
    const descriptions: Record<keyof AppSettings, string> = {
      precomputeSummaries: 'Enable background AI processing to generate summaries',
      precomputeAutoRun: 'Automatically run precompute when missing summaries are detected',
      precomputeUseBatch: 'Use Gemini Batch Mode for more efficient processing',
      precomputeUseContextCache: 'Cache AI context for better performance',
      confirmDelete: 'Show confirmation dialog before deleting emails',
      notifEnabled: 'Enable browser notifications',
      // Add more descriptions as needed
      aiPageFetchOptIn: 'Allow AI to fetch page content for better context',
      unreadOnUnsnooze: 'Mark emails as unread when unsnoozed',
      suppressAuthPopups: 'Reduce frequency of authentication popups'
    };
    return descriptions[key] || '';
  }
</script>

{#if visible}
  <!-- Backdrop -->
  <div 
    class="backdrop" 
    role="button"
    tabindex="0"
    transition:fade={{ duration: 200 }}
    onclick={() => dispatch('close')}
    onkeydown={(e) => e.key === 'Escape' && dispatch('close')}
    aria-label="Close settings popup"
  ></div>
  
  <!-- Popup Menu -->
  <div 
    class="popup-container"
    transition:fly={{ y: 20, duration: 300 }}
  >
    <Card>
      <div class="popup-content">
        <!-- Header -->
        <div class="header">
          <h3 class="m3-font-headline-small title">{title}</h3>
          <button 
            type="button"
            class="close-button"
            onclick={() => dispatch('close')}
            aria-label="Close settings"
          >
            <Icon icon={iconClose} />
          </button>
        </div>

        <!-- Settings List -->
        <div class="settings-list">
          {#each settingKeys as key (key)}
            <div class="setting-item">
              <div class="setting-info">
                <div class="setting-label m3-font-body-large">{getSettingLabel(key)}</div>
                {#if getSettingDescription(key)}
                  <div class="setting-description m3-font-body-small">{getSettingDescription(key)}</div>
                {/if}
              </div>
              
              <div class="setting-control">
                {#if typeof settings[key] === 'boolean'}
                  <Switch
                    checked={settings[key] || false}
                    onchange={(checked) => handleSettingChange(key, checked)}
                  />
                {/if}
              </div>
            </div>
          {/each}
        </div>

        <!-- Actions -->
        <div class="actions">
          <Button 
            variant="text" 
            onclick={() => dispatch('openFullSettings')}
          >
            Open Full Settings
          </Button>
        </div>
      </div>
    </Card>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.32);
    z-index: 1000;
  }

  .popup-container {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1001;
    max-width: 90vw;
    max-height: 80vh;
    min-width: 320px;
    width: 480px;
  }

  .popup-content {
    padding: 1.5rem;
    max-height: 70vh;
    overflow-y: auto;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
  }

  .title {
    margin: 0;
    color: rgb(var(--m3-scheme-on-surface));
  }

  .close-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border: none;
    background: transparent;
    border-radius: 0.75rem;
    color: rgb(var(--m3-scheme-on-surface-variant));
    cursor: pointer;
    transition: background-color 0.2s ease;
  }

  .close-button:hover {
    background-color: rgb(var(--m3-scheme-surface-variant) / 0.08);
  }

  .close-button:focus-visible {
    outline: 2px solid rgb(var(--m3-scheme-primary));
    outline-offset: 2px;
  }

  .close-button :global(svg) {
    width: 1.5rem;
    height: 1.5rem;
  }

  .settings-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .setting-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid rgb(var(--m3-scheme-outline-variant) / 0.2);
  }

  .setting-item:last-child {
    border-bottom: none;
  }

  .setting-info {
    flex: 1;
    min-width: 0;
  }

  .setting-label {
    color: rgb(var(--m3-scheme-on-surface));
    font-weight: 500;
    margin-bottom: 0.25rem;
  }

  .setting-description {
    color: rgb(var(--m3-scheme-on-surface-variant));
    line-height: 1.4;
  }

  .setting-control {
    flex-shrink: 0;
  }

  .actions {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid rgb(var(--m3-scheme-outline-variant) / 0.2);
    display: flex;
    justify-content: flex-end;
  }

  /* Responsive design */
  @media (max-width: 600px) {
    .popup-container {
      width: 90vw;
      max-width: none;
    }
    
    .popup-content {
      padding: 1rem;
    }
    
    .setting-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.75rem;
    }
    
    .setting-control {
      align-self: flex-end;
    }
  }
</style>