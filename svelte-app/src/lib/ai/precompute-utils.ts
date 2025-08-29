export function shouldRequestSummary(thread: any): boolean {
  try {
    // Follow precompute's invariant: never request a summary when a cached
    // summary exists. Only request when missing or explicitly none/error.
    if (!thread) return true;
    const raw = thread.summary;
    const hasSummary = typeof raw === 'string' ? !!String(raw).trim() : !!raw;
    return !hasSummary || thread.summaryStatus === 'none' || thread.summaryStatus === 'error';
  } catch {
    return true;
  }
}


