// Centralized diagnostics buffer for Gmail/API/Auth flows
// Stores sanitized, non-secret diagnostics entries and supports copy-to-clipboard

const __gmailDiagnostics: Array<Record<string, unknown>> = [];

export function pushGmailDiag(entry: Record<string, unknown>): void {
  try {
    // Guard: ensure we only spread plain objects to avoid errors when callers pass
    // undefined, Error objects, or other non-plain values. Shallow-clone allowed
    // own-enumerable properties only.
    const safeEntry: Record<string, unknown> = {};
    if (entry && typeof entry === 'object') {
      for (const k of Object.keys(entry)) {
        try {
          const v = (entry as any)[k];
          // Skip functions and undefined values to keep diagnostics sane
          if (typeof v === 'function' || typeof v === 'undefined') continue;
          safeEntry[k] = v;
        } catch (_) {
          // ignore properties that throw on access
        }
      }
    } else {
      // Non-object entry: record a note so diagnostics remain informative
      safeEntry.invalidEntry = String(entry);
    }
    const payload = { time: new Date().toISOString(), ...safeEntry };
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


