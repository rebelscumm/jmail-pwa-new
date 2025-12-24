/**
 * Server Status Store
 * 
 * Tracks the backend server's connectivity status and provides
 * human-friendly feedback for offline/error states.
 */
import { writable, derived, get } from 'svelte/store';

export type ServerState = 
  | 'online'      // Server is responding normally
  | 'checking'    // Currently checking server status
  | 'offline'     // Network is offline (navigator.onLine = false)
  | 'unreachable' // Server not responding (network error, timeout)
  | 'error'       // Server returned error (5xx, etc)
  | 'auth-error'; // Authentication required (401)

export interface ServerStatusState {
  state: ServerState;
  lastCheck: number | null;
  lastSuccess: number | null;
  lastError: string | null;
  errorCode: number | null;
  retryCount: number;
  nextRetryAt: number | null;
}

const initialState: ServerStatusState = {
  state: 'online',
  lastCheck: null,
  lastSuccess: null,
  lastError: null,
  errorCode: null,
  retryCount: 0,
  nextRetryAt: null
};

const { subscribe, set, update } = writable<ServerStatusState>(initialState);

// Human-friendly messages for each state
export const stateMessages: Record<ServerState, { title: string; description: string; icon: string }> = {
  online: {
    title: 'Connected',
    description: 'Server is responding normally',
    icon: 'check_circle'
  },
  checking: {
    title: 'Checking...',
    description: 'Verifying server connection',
    icon: 'sync'
  },
  offline: {
    title: 'You\'re Offline',
    description: 'Check your internet connection and try again',
    icon: 'cloud_off'
  },
  unreachable: {
    title: 'Server Unavailable',
    description: 'The server is not responding. This might be temporary.',
    icon: 'cloud_off'
  },
  error: {
    title: 'Server Error',
    description: 'Something went wrong on the server. Please try again later.',
    icon: 'error'
  },
  'auth-error': {
    title: 'Session Expired',
    description: 'Please sign in again to continue',
    icon: 'lock'
  }
};

// Retry delays with exponential backoff (in ms)
const RETRY_DELAYS = [2000, 5000, 10000, 30000, 60000];

function getRetryDelay(retryCount: number): number {
  return RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];
}

/**
 * Check server status by probing a lightweight endpoint
 */
async function checkServerStatus(signal?: AbortSignal): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    // First check if browser is online
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return { ok: false, error: 'offline' };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    
    const response = await fetch('/api/health', {
      method: 'GET',
      credentials: 'include',
      signal: signal || controller.signal
    }).catch(async () => {
      // Fallback: try the Gmail profile endpoint if health endpoint doesn't exist
      return fetch('/api/gmail/profile', {
        method: 'GET',
        credentials: 'include',
        signal: signal || controller.signal
      });
    });
    
    clearTimeout(timeoutId);

    if (response.ok) {
      return { ok: true, status: response.status };
    } else if (response.status === 401) {
      return { ok: false, status: 401, error: 'auth-error' };
    } else if (response.status >= 500) {
      return { ok: false, status: response.status, error: 'server-error' };
    } else {
      // 4xx other than 401 - still consider server reachable
      return { ok: true, status: response.status };
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    
    if (err.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    
    // Network errors (fetch failed entirely)
    if (err.message.includes('Failed to fetch') || 
        err.message.includes('NetworkError') ||
        err.message.includes('net::')) {
      return { ok: false, error: 'network-error' };
    }
    
    return { ok: false, error: err.message };
  }
}

/**
 * Perform a server health check and update the store
 */
export async function performHealthCheck(): Promise<ServerState> {
  update(s => ({ ...s, state: 'checking' }));
  
  const now = Date.now();
  const result = await checkServerStatus();
  
  if (result.ok) {
    set({
      state: 'online',
      lastCheck: now,
      lastSuccess: now,
      lastError: null,
      errorCode: null,
      retryCount: 0,
      nextRetryAt: null
    });
    return 'online';
  }
  
  // Determine the state based on the error
  let state: ServerState;
  if (result.error === 'offline') {
    state = 'offline';
  } else if (result.error === 'auth-error') {
    state = 'auth-error';
  } else if (result.status && result.status >= 500) {
    state = 'error';
  } else {
    state = 'unreachable';
  }
  
  update(s => {
    const newRetryCount = s.retryCount + 1;
    return {
      state,
      lastCheck: now,
      lastSuccess: s.lastSuccess,
      lastError: result.error || 'Unknown error',
      errorCode: result.status || null,
      retryCount: newRetryCount,
      nextRetryAt: now + getRetryDelay(newRetryCount)
    };
  });
  
  return state;
}

/**
 * Reset the error state (e.g., after user manually triggers refresh)
 */
export function resetErrorState(): void {
  update(s => ({
    ...s,
    retryCount: 0,
    nextRetryAt: null
  }));
}

/**
 * Mark as online (called when a successful API call is made)
 */
export function markOnline(): void {
  const now = Date.now();
  set({
    state: 'online',
    lastCheck: now,
    lastSuccess: now,
    lastError: null,
    errorCode: null,
    retryCount: 0,
    nextRetryAt: null
  });
}

/**
 * Mark an error state with details
 */
export function markError(error: string, code?: number): void {
  update(s => {
    const isAuthError = code === 401;
    const isServerError = code && code >= 500;
    
    let state: ServerState = 'unreachable';
    if (isAuthError) state = 'auth-error';
    else if (isServerError) state = 'error';
    else if (!navigator.onLine) state = 'offline';
    
    const now = Date.now();
    const newRetryCount = s.retryCount + 1;
    
    return {
      state,
      lastCheck: now,
      lastSuccess: s.lastSuccess,
      lastError: error,
      errorCode: code || null,
      retryCount: newRetryCount,
      nextRetryAt: now + getRetryDelay(newRetryCount)
    };
  });
}

// Derived store for whether we can retry
export const canRetry = derived(
  { subscribe },
  ($status) => {
    if ($status.state === 'online' || $status.state === 'checking') {
      return true;
    }
    if ($status.nextRetryAt === null) {
      return true;
    }
    return Date.now() >= $status.nextRetryAt;
  }
);

// Derived store for human-friendly status message
export const statusMessage = derived(
  { subscribe },
  ($status) => {
    const info = stateMessages[$status.state];
    let detail = info.description;
    
    if ($status.state === 'error' && $status.errorCode) {
      detail = `Server returned error ${$status.errorCode}. ${info.description}`;
    }
    
    if ($status.lastError && $status.state !== 'online') {
      // Add a hint about what went wrong
      if ($status.lastError.includes('timeout')) {
        detail = 'Request timed out. The server might be busy.';
      } else if ($status.lastError.includes('network')) {
        detail = 'Network error. Check your connection.';
      }
    }
    
    return {
      ...info,
      description: detail,
      retryCount: $status.retryCount,
      canRetry: $status.nextRetryAt === null || Date.now() >= $status.nextRetryAt
    };
  }
);

// Export the store
export const serverStatus = { subscribe, set, update };

// Auto-check when coming back online
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.log('[ServerStatus] Browser came online, checking server...');
    performHealthCheck();
  });
  
  window.addEventListener('offline', () => {
    console.log('[ServerStatus] Browser went offline');
    update(s => ({
      ...s,
      state: 'offline',
      lastCheck: Date.now(),
      lastError: 'Browser offline'
    }));
  });
}














