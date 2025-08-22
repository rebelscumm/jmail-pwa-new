// Centralized diagnostics buffer for Gmail/API/Auth flows
// Stores sanitized, non-secret diagnostics entries and supports copy-to-clipboard

const __gmailDiagnostics: Array<Record<string, unknown>> = [];

export function pushGmailDiag(entry: Record<string, unknown>): void {
  try {
    const payload = { time: new Date().toISOString(), ...entry };
    __gmailDiagnostics.push(payload);
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.debug('[GmailDiag]', payload);
    }
  } catch (_) {
    // ignore
  }
}

export function getAndClearGmailDiagnostics(): any[] {
  const copy = __gmailDiagnostics.slice();
  __gmailDiagnostics.length = 0;
  return copy;
}


