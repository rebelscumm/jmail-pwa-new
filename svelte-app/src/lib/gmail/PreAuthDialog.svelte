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
  let currentHref = $state<string | undefined>(undefined);
  let currentOrigin = $state<string | undefined>(undefined);
  let firstConnectedUrl = $state<string | undefined>(undefined);
  let firstConnectedOrigin = $state<string | undefined>(undefined);
  let lastConnectedUrl = $state<string | undefined>(undefined);
  let authMetaSnapshot: any = undefined;

  function siteDetailsLink(site?: string): string | undefined {
    if (!site) return undefined;
    try { return `chrome://settings/content/siteDetails?site=${encodeURIComponent(site)}`; } catch (_) { return undefined; }
  }
  const cookiesSettingsLink = 'chrome://settings/cookies';
  const privacySettingsLink = 'chrome://settings/privacy';
  const popupsSettingsLink = 'chrome://settings/content/popups';
  const extensionsLink = 'chrome://extensions';
  const siteDataLink = 'chrome://settings/siteData';
  const googlePermissionsLink = 'https://myaccount.google.com/permissions';
  const cookieHelpLink = 'https://support.google.com/chrome/answer/95647';
  const popupsHelpLink = 'https://support.google.com/chrome/answer/95472';

  export function show(d: PreAuthDetails): Promise<void> {
    details = d;
    open = true;
    // Fire-and-forget pending ops count for helpful messaging
    (async () => {
      try {
        const db = await getDB();
        const ops = await db.getAll('ops');
        pendingOpsCount = ops?.length ?? 0;
        // Capture current and historical connection metadata
        currentHref = typeof window !== 'undefined' ? window.location.href : undefined;
        currentOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
        const auth = (await db.get('auth', 'me')) as any | undefined;
        authMetaSnapshot = auth;
        firstConnectedUrl = auth?.firstConnectedUrl;
        firstConnectedOrigin = auth?.firstConnectedOrigin;
        lastConnectedUrl = auth?.lastConnectedUrl;
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
      origin: typeof window !== "undefined" ? window.location.origin : undefined,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      authMeta: authMetaSnapshot,
      firstConnectedUrl,
      firstConnectedOrigin,
      lastConnectedUrl
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
            <div class="subtle">Links labeled as Chrome open browser settings; they may not work in other browsers.</div>
            <div class="kv small">
              <div><span class="k">Current URL</span><span class="v small">{currentHref}</span></div>
              {#if firstConnectedUrl}
                <div><span class="k">Originally connected</span><span class="v small">{firstConnectedUrl}</span></div>
                {#if currentOrigin && firstConnectedOrigin && currentOrigin !== firstConnectedOrigin}
                  <div class="warn">This origin differs from the original. Consider using the original domain.</div>
                  <div class="links">
                    <a href={firstConnectedOrigin} target="_blank" rel="noopener">Open original domain</a>
                  </div>
                {/if}
              {/if}
            </div>
            <ul>
              <li>
                Allow third‑party cookies for accounts.google.com and this site.
                <div class="links">
                  {#if siteDetailsLink('https://accounts.google.com')}<a href={siteDetailsLink('https://accounts.google.com')}>Accounts site settings (Chrome)</a>{/if}
                  {#if siteDetailsLink(currentOrigin)}<a href={siteDetailsLink(currentOrigin)}>This site settings (Chrome)</a>{/if}
                  <a href={cookiesSettingsLink}>Cookie settings (Chrome)</a>
                  <a href={cookieHelpLink} target="_blank" rel="noopener">Cookie help</a>
                </div>
              </li>
              <li>
                Disable strict tracking protection or ad‑blockers for this site.
                <div class="links">
                  <a href={extensionsLink}>Open extensions (Chrome)</a>
                  <a href={privacySettingsLink}>Privacy & security (Chrome)</a>
                </div>
              </li>
              <li>Avoid Private/Incognito windows; they clear Google session cookies.</li>
              <li>
                Use the same URL/domain you originally connected with.
                {#if siteDetailsLink(currentOrigin) || siteDetailsLink(firstConnectedOrigin)}
                  <div class="links">
                    {#if siteDetailsLink(currentOrigin)}<a href={siteDetailsLink(currentOrigin)}>This site settings (Chrome)</a>{/if}
                    {#if siteDetailsLink(firstConnectedOrigin)}<a href={siteDetailsLink(firstConnectedOrigin!)}>Original site settings (Chrome)</a>{/if}
                    <a href={googlePermissionsLink} target="_blank" rel="noopener">Review Google account access</a>
                  </div>
                {/if}
              </li>
              <li>
                If a pop‑up was blocked, allow pop‑ups for this site.
                <div class="links">
                  <a href={popupsSettingsLink}>Pop‑ups and redirects (Chrome)</a>
                  {#if siteDetailsLink(currentOrigin)}<a href={siteDetailsLink(currentOrigin)}>This site settings (Chrome)</a>{/if}
                  <a href={popupsHelpLink} target="_blank" rel="noopener">Pop‑ups help</a>
                </div>
              </li>
              <li>
                Clear site data for accounts.google.com or this site if issues persist.
                <div class="links">
                  <a href={siteDataLink}>Site data (Chrome)</a>
                  {#if siteDetailsLink('https://accounts.google.com')}<a href={siteDetailsLink('https://accounts.google.com')}>Accounts site settings (Chrome)</a>{/if}
                  {#if siteDetailsLink(currentOrigin)}<a href={siteDetailsLink(currentOrigin)}>This site settings (Chrome)</a>{/if}
                </div>
              </li>
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
  .tips .links { display:flex; flex-wrap: wrap; gap:0.5rem; margin-top: 0.25rem; }
  .tips .links a { font-size: 0.8125rem; text-decoration: underline; }
  .subtle { color: rgb(var(--m3-scheme-on-surface-variant)); font-size: 0.8125rem; }
  .warn { color: rgb(var(--m3-scheme-tertiary)); }
</style>


