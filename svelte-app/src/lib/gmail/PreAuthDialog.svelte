<script lang="ts">
  import Dialog from "$lib/containers/Dialog.svelte";
  import Button from "$lib/buttons/Button.svelte";
  import { copyGmailDiagnosticsToClipboard } from "$lib/gmail/api";
  import type { PreAuthDetails } from "$lib/gmail/preauth";
  import { getDB } from "$lib/db/indexeddb";

  let open = $state(false);
  let details = $state<PreAuthDetails | undefined>(undefined);
  let resolveFn: ((ok: boolean) => void) | null = null;
  let pendingOpsCount = $state<number | null>(null);

  export function show(d: PreAuthDetails): Promise<void> {
    details = d;
    open = true;
    // Fire-and-forget pending ops count for helpful messaging
    (async () => {
      try {
        const db = await getDB();
        const ops = await db.getAll('ops');
        pendingOpsCount = ops?.length ?? 0;
      } catch (_) {
        pendingOpsCount = null;
      }
    })();
    return new Promise<void>((resolve, reject) => {
      resolveFn = (ok: boolean) => {
        open = false;
        if (ok) resolve();
        else reject(new Error("User cancelled pre-auth"));
      };
    });
  }

  async function doCopy(): Promise<void> {
    const extra = {
      source: "pre_auth",
      details,
      href: typeof window !== "undefined" ? window.location.href : undefined,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined
    } as const;
    const ok = await copyGmailDiagnosticsToClipboard(extra as any);
    // Optional feedback via console; snackbar handled globally elsewhere
    try { console.log("[PreAuth] copy diagnostics:", ok); } catch {}
  }

  function doContinue(): void {
    resolveFn?.(true);
  }

  // No cancel: flow proceeds after user hits Continue
</script>

<Dialog headline="About to open Google sign-in" bind:open closeOnClick={false} closeOnEsc={false}>
  {#snippet children()}
    <div class="content">
      <p class="m3-font-body-medium">We’ll ask Google for permission to continue. You can copy diagnostics first.</p>
      {#if typeof pendingOpsCount === 'number' && pendingOpsCount > 0}
        <p class="m3-font-body-medium warn">{pendingOpsCount} operation{pendingOpsCount === 1 ? '' : 's'} pending. After signing in, they’ll sync automatically.</p>
      {/if}
      {#if details}
        <ul class="kv">
          <li><span class="k">Flow</span><span class="v">{details.flow}</span></li>
          <li><span class="k">Prompt</span><span class="v">{details.prompt}</span></li>
          {#if details.reason}<li><span class="k">Reason</span><span class="v">{details.reason}</span></li>{/if}
          {#if details.requestedScopes}<li><span class="k">Requested scopes</span><span class="v small">{details.requestedScopes}</span></li>{/if}
          {#if details.missingScopes?.length}
            <li><span class="k">Missing scopes</span><span class="v small">{details.missingScopes.join(" ")}</span></li>
          {/if}
          <li><span class="k">Token present</span><span class="v">{String(!!details.tokenPresent)}</span></li>
          <li><span class="k">Token expired</span><span class="v">{String(!!details.tokenExpired)}</span></li>
        </ul>
        {#if (!details.tokenPresent || details.tokenExpired) }
          <div class="tips">
            <div class="tips-title">Having to sign in repeatedly?</div>
            <ul>
              <li>Allow third‑party cookies for accounts.google.com and this site.</li>
              <li>Disable strict tracking protection or ad‑blockers for this site.</li>
              <li>Avoid Private/Incognito windows; they clear Google session cookies.</li>
              <li>Use the same URL/domain you originally connected with.</li>
            </ul>
          </div>
        {/if}
      {/if}
    </div>
  {/snippet}
  {#snippet buttons()}
    <div class="btns">
      <Button variant="outlined" onclick={doCopy}>Copy diagnostics</Button>
      <Button variant="filled" onclick={doContinue}>Continue</Button>
    </div>
  {/snippet}
  
</Dialog>

<style>
  .content { display:flex; flex-direction:column; gap:0.5rem; }
  .kv { list-style:none; display:flex; flex-direction:column; gap:0.25rem; padding:0; margin:0.5rem 0 0 0; }
  .kv .k { color: rgb(var(--m3-scheme-on-surface-variant)); margin-inline-end: 0.5rem; }
  .kv .v { color: rgb(var(--m3-scheme-on-surface)); }
  .kv .small { font-size: 0.8125rem; word-break: break-all; }
  .btns { display:flex; gap:0.5rem; justify-content:flex-end; }
  .tips { margin-top: 0.5rem; padding: 0.5rem 0.75rem; border-radius: 8px; background: color-mix(in oklab, rgb(var(--m3-scheme-primary)) 8%, transparent); }
  .tips-title { font-weight: 600; margin-bottom: 0.25rem; }
  .tips ul { margin: 0; padding-left: 1rem; }
  .warn { color: rgb(var(--m3-scheme-tertiary)); }
</style>


