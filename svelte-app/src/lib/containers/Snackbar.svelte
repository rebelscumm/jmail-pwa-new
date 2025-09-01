<script module lang="ts">
  export type SnackbarIn = {
    message: string;
    actions?: Record<string, () => void>;
    closable?: boolean;
    /*
    timeout: undefined/unset -> 4s timeout
    timeout: null -> no timeout
    timeout: 2000 -> 2s timeout
    */
    timeout?: number | null;
  };
</script>

<script lang="ts">
  import { onDestroy, type ComponentProps } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { fade } from "svelte/transition";
  import iconX from "@ktibow/iconset-material-symbols/close";
  import iconCopy from "@ktibow/iconset-material-symbols/content-copy-outline";
  import Icon from "$lib/misc/_icon.svelte";
  import SnackbarItem from "./SnackbarItem.svelte";
  import Layer from "$lib/misc/Layer.svelte";

  type SnackbarConfig = Omit<ComponentProps<typeof SnackbarItem>, "children">;

  let {
    config = {},
    closeButtonTitle = "Close",
    ...extra
  }: {
    config?: SnackbarConfig;
    closeButtonTitle?: string;
  } & HTMLAttributes<HTMLDivElement> = $props();
  export const show = ({ message, actions = {}, closable = true, timeout = 4000 }: SnackbarIn) => {
    snackbar = { message, actions, closable, timeout };
    clearTimeout(timeoutId);
    if (timeout)
      timeoutId = setTimeout(() => {
        snackbar = undefined;
      }, timeout);
  };

  async function copyMessageToClipboard() {
    if (!snackbar) return;
    try {
      await navigator.clipboard.writeText(snackbar.message);
      // Briefly replace current snackbar with a confirmation
      show({ message: "Copied", closable: true, timeout: 1000 });
    } catch (e) {
      show({ message: "Failed to copy", closable: true });
    }
  }

  let snackbar: Required<SnackbarIn> | undefined = $state();
  let timeoutId: number;
  onDestroy(() => {
    clearTimeout(timeoutId);
  });
</script>

{#if snackbar}
  <div class="holder" out:fade={{ duration: 200 }} {...extra}>
    {#key snackbar}
      <SnackbarItem {...config}>
        <div class="message-container">
          <p class="m3-font-body-medium message">{snackbar.message}</p>
        </div>
        {#each Object.entries(snackbar.actions) as [key, action]}
          <button
            type="button"
            class="action m3-font-label-large"
            onclick={() => {
              snackbar = undefined;
              action();
            }}
          >
            {key}
          </button>
        {/each}
        <div class="actions">
          <button
            type="button"
            class="action m3-font-label-large copy"
            title="Copy"
            aria-label="Copy snackbar message"
            onclick={async () => {
              await copyMessageToClipboard();
            }}
          >
            <Icon icon={iconCopy} />
          </button>
          <button
            type="button"
            class="close"
            title={closeButtonTitle}
            onclick={() => {
              snackbar = undefined;
            }}
          >
            <Layer />
            <Icon icon={iconX} class="close-icon" />
          </button>
        </div>
      </SnackbarItem>
    {/key}
  </div>
{/if}

<style>
  .holder {
    position: fixed;
    padding-bottom: 1rem;
    bottom: max(calc(var(--m3-util-bottom-offset) - 1rem), 0.5rem);
    left: 50%;
    transform: translate(-50%, 0);
    z-index: 3;
  }
  .message-container { max-width: 60rem; }
  /* Allow snackbar messages to wrap onto multiple lines instead of truncating */
  .message {
    margin-right: auto;
    max-width: 48rem;
    overflow: visible;
    text-overflow: unset;
    white-space: normal;
    word-break: break-word; /* break long words/URLs if needed */
  }
  /* Allow multiline expanded view when user opens notifications dialog; keep single-line by default */
  button {
    display: flex;
    align-self: stretch;
    align-items: center;
    margin: 0;
    padding: 0;
    border: none;

    background-color: transparent;
    -webkit-tap-highlight-color: transparent;
    cursor: pointer;
    position: relative;
  }
  button :global(svg) {
    width: 1.5rem;
    height: 1.5rem;
  }

  .action {
    color: var(--m3-scheme-inverse-primary);
    padding: 0 0.5rem;
  }
  .actions { display:flex; align-items:center; gap:0.25rem; }
  .close {
    color: var(--m3-scheme-inverse-on-surface);
    padding: 0 0.75rem;
    margin-right: 0;
  }
</style>
