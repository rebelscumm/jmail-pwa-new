<script lang="ts">
  import type { Snippet } from "svelte";
  import iconHome from "@ktibow/iconset-material-symbols/home-outline";
  import iconHomeS from "@ktibow/iconset-material-symbols/home";
  import iconPalette from "@ktibow/iconset-material-symbols/palette-outline";
  import iconPaletteS from "@ktibow/iconset-material-symbols/palette";
  import iconOutbox from "@ktibow/iconset-material-symbols/outbox-outline";
  import iconOutboxS from "@ktibow/iconset-material-symbols/outbox";
  import iconBook from "@ktibow/iconset-material-symbols/book-2-outline";
  import iconBookS from "@ktibow/iconset-material-symbols/book-2";
  import iconAnimation from "@ktibow/iconset-material-symbols/animation";
  import iconAnimationS from "@ktibow/iconset-material-symbols/animation";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import NavCMLX from "$lib/nav/NavCMLX.svelte";
  import NavCMLXItem from "$lib/nav/NavCMLXItem.svelte";
  import { styling } from "./themeStore";
  import "../app.css";
  import { startFlushLoop } from "$lib/queue/flush";
  import TopAppBar from "$lib/misc/TopAppBar.svelte";
  import { refreshSyncState } from "$lib/stores/queue";
  import FAB from "$lib/buttons/FAB.svelte";
  import Snackbar from "$lib/containers/Snackbar.svelte";
  import iconCompose from "@ktibow/iconset-material-symbols/edit";
  import BottomSheet from "$lib/containers/BottomSheet.svelte";
  import TextField from "$lib/forms/TextField.svelte";
  import TextFieldMultiline from "$lib/forms/TextFieldMultiline.svelte";
  import Button from "$lib/buttons/Button.svelte";
  import { queueSendRaw } from "$lib/queue/intents";
  
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      const msg = e.data || {};
      if (msg.type === 'NOTIFICATION_ACTION') {
        const data = msg.data || {};
        if (msg.action === 'archive' && data.threadId) {
          import('$lib/queue/intents').then((m) => m.archiveThread(data.threadId));
        }
        if (msg.action === 'snooze1h' && data.threadId) {
          import('$lib/snooze/actions').then((m) => m.snoozeThreadByRule(data.threadId, '1h'));
        }
      }
      if (msg.type === 'SYNC_TICK') {
        import('$lib/db/backups').then((m) => m.maybeCreateWeeklySnapshot());
      }
    });
  }

  if (typeof window !== 'undefined') {
    startFlushLoop();
    // Load settings at app start
    import('$lib/stores/settings').then((m)=>m.loadSettings());
    refreshSyncState();
    import('$lib/db/backups').then((m) => m.maybeCreateWeeklySnapshot());
    // Keep optional: legacy local snooze viewer; safe if empty
    import('$lib/stores/snooze').then((m)=>m.loadSnoozes());

    // Offline banner
    const updateBanner = () => {
      const el = document.querySelector('#offline-banner');
      if (!el) return;
      el.classList.toggle('visible', !navigator.onLine);
    };
    window.addEventListener('online', updateBanner);
    window.addEventListener('offline', updateBanner);
    setTimeout(updateBanner, 0);

    // Ensure first-run shows connect wizard at root
    (async () => {
      try {
        const { getDB } = await import('$lib/db/indexeddb');
        const db = await getDB();
        const account = await db.get('auth', 'me');
        if (!account) {
          const target = (base || '') + '/';
          if (location.pathname !== target) {
            location.href = target;
          }
        }
      } catch (_) {}
    })();
  }

  let { children }: { children: Snippet } = $props();

  const paths = [
    { path: base + "/inbox", icon: iconHome, iconS: iconHomeS, label: "Inbox" },
    { path: base + "/snoozed", icon: iconBook, iconS: iconBookS, label: "Snoozed" },
    { path: base + "/settings", icon: iconPalette, iconS: iconPaletteS, label: "Settings" },
    { path: base + "/theme", icon: iconPalette, iconS: iconPaletteS, label: "Theme" },
    { path: base + "/outbox", icon: iconOutbox, iconS: iconOutboxS, label: "Outbox" }
  ];
  const normalizePath = (path: string) => {
    const u = new URL(path, page.url.href);
    path = u.pathname;
    if (path.endsWith("/")) path = path.slice(0, -1);
    return path || "/";
  };

  // Compose sheet state
  let showCompose = $state(false);
  let to = $state("");
  let subject = $state("");
  let body = $state("");
  let snackbar: ReturnType<typeof Snackbar>;

  function makeRfc2822(): string {
    const boundary = `----jmail-${Math.random().toString(36).slice(2)}`;
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
</script>

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
    <TopAppBar onSyncNow={() => refreshSyncState()} />
    <div id="offline-banner" class="offline">You are offline. Actions will be queued.</div>
    {@render children()}
    <div class="fab-holder">
      <FAB color="primary" icon={iconCompose} onclick={() => (showCompose = true)} />
    </div>
    <Snackbar bind:this={snackbar} />
  </div>
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
    padding: 1rem;
  }
  @media (width < 52.5rem) {
    .container {
      grid-template-rows: 1fr auto;
      --m3-util-bottom-offset: 5rem;
    }
    .sidebar {
      flex-direction: column;
      bottom: 0;
      width: 100%;
      z-index: 3;
      grid-row: 2;
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
      padding: 1.5rem;
      grid-column: 2;
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

{#if showCompose}
  <BottomSheet close={() => (showCompose = false)}>
    <div style="display:grid; gap:0.5rem; padding-bottom:1rem;">
      <h3 class="m3-font-title-medium" style="margin:0.25rem 0 0 0">New message</h3>
      <TextField label="To" bind:value={to} type="email" />
      <TextField label="Subject" bind:value={subject} />
      <TextFieldMultiline label="Message" bind:value={body} rows={8} />
      <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
        <Button variant="text" onclick={() => (showCompose = false)}>Discard</Button>
        <Button variant="filled" onclick={sendCompose}>Send</Button>
      </div>
    </div>
  </BottomSheet>
{/if}