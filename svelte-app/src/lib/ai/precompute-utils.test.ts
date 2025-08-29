import { describe, it, expect } from 'vitest';
import { shouldRequestSummary } from './precompute-utils';

describe('shouldRequestSummary', () => {
  it('returns true when thread is undefined', () => {
    expect(shouldRequestSummary(undefined)).toBe(true);
  });

  it('returns true when summary is missing', () => {
    expect(shouldRequestSummary({ threadId: 't1' })).toBe(true);
  });

  it('returns false when summary exists and status is ready', () => {
    expect(shouldRequestSummary({ summary: 'A summary', summaryStatus: 'ready' })).toBe(false);
  });

  it('returns true when summary exists but status is none', () => {
    expect(shouldRequestSummary({ summary: 'A summary', summaryStatus: 'none' })).toBe(true);
  });

  it('returns true when summary is empty string', () => {
    expect(shouldRequestSummary({ summary: '', summaryStatus: 'ready' })).toBe(true);
  });
});


