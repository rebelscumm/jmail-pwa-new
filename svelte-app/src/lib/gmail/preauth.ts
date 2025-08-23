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
  try {
    // Wait briefly for registration if it's not ready yet
    const impl = await (async () => {
      if (showImpl) return showImpl;
      return await new Promise<(d: PreAuthDetails) => Promise<void>>((resolve, reject) => {
        let settled = false;
        const id = setTimeout(() => { if (!settled) { settled = true; resolve(null as any); } }, 700);
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
  // Fallback: minimal native prompts so we still pause before Google popup
  try {
    const msg =
      `We are about to request Google permissions.\n` +
      `Flow: ${details.flow}, Prompt: ${details.prompt}${details.reason ? `, Reason: ${details.reason}` : ''}.\n` +
      `Copy diagnostics first?`;
    const copyFirst = typeof window !== 'undefined' ? window.confirm(msg) : false;
    if (copyFirst) {
      try {
        const ok = await copyGmailDiagnosticsToClipboard({ source: 'pre_auth_fallback', details });
        try { pushGmailDiag({ type: 'preauth_fallback_copy', ok }); } catch (_) {}
      } catch (_) {}
    }
  } catch (_) {}
}


