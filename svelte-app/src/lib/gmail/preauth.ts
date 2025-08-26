// Simple registry to show a pre-auth dialog before any Google popup
import { pushGmailDiag } from '$lib/gmail/diag';
import { copyGmailDiagnosticsToClipboard } from '$lib/gmail/api';
import { show as showSnackbar } from '$lib/containers/snackbar';

export type PreAuthDetails = {
  flow: 'interactive' | 'scope_upgrade';
  prompt: 'none' | 'consent' | 'select_account';
  reason?: string;
  requestedScopes?: string;
  missingScopes?: string[];
  tokenPresent?: boolean;
  tokenExpired?: boolean;
  diagnostics?: Record<string, unknown>;
};

let showImpl: ((details: PreAuthDetails) => Promise<void>) | null = null;
const waiters: Array<(fn: (details: PreAuthDetails) => Promise<void>) => void> = [];

export function registerPreAuth(fn: (details: PreAuthDetails) => Promise<void>): void {
  showImpl = fn;
  while (waiters.length) {
    const next = waiters.shift();
    try { next && next(fn); } catch (_) {}
  }
}

export async function confirmGooglePopup(details: PreAuthDetails): Promise<void> {
  try { pushGmailDiag({ type: 'preauth_invoked', haveImpl: !!showImpl, details }); } catch (_) {}
  // New behavior: non-blocking snackbar instead of modal dialog.
  try {
    showSnackbar({
      message: 'Google login required. You can copy help info.',
      actions: {
        Copy: async () => {
          try {
            const ok = await copyGmailDiagnosticsToClipboard({ source: 'pre_auth_snackbar', details });
            try { pushGmailDiag({ type: 'preauth_snackbar_copy', ok }); } catch (_) {}
          } catch (_) {}
        }
      },
      closable: true,
      timeout: 6000
    });
  } catch (_) {}
  // Preserve legacy modal flow if a custom UI registered, but don't block if not.
  try {
    // Wait briefly for registration if it's not ready yet
    const impl = await (async () => {
      if (showImpl) return showImpl;
      return await new Promise<(d: PreAuthDetails) => Promise<void>>((resolve) => {
        let settled = false;
        const id = setTimeout(() => { if (!settled) { settled = true; resolve(null as any); } }, 0);
        waiters.push((fn) => {
          if (settled) return; settled = true; clearTimeout(id); resolve(fn);
        });
      });
    })();
    if (impl) {
      await impl(details);
      try { pushGmailDiag({ type: 'preauth_completed' }); } catch (_) {}
      return;
    }
  } catch (_) {}
  // No blocking fallback anymore; proceed without extra interaction.
}


