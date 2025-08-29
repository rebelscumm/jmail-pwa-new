// Simple registry to show a pre-auth dialog before any Google popup
import { pushGmailDiag } from '$lib/gmail/diag';
import { copyGmailDiagnosticsToClipboard } from '$lib/gmail/api';

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
  // If no preauth UI is registered, return immediately to preserve the
  // original user gesture so that popups opened by GIS are not blocked by
  // the browser. If an implementation exists, defer to it as before.
  if (!showImpl) {
    try { pushGmailDiag({ type: 'preauth_no_impl' }); } catch (_) {}
    return;
  }
  try {
    // If an implementation is registered, call it directly.
    await showImpl(details);
    try { pushGmailDiag({ type: 'preauth_completed' }); } catch (_) {}
    return;
  } catch (_) {}
}


