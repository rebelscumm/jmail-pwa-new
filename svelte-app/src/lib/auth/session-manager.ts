/**
 * Session Manager - Handles automatic session refresh and auth state management
 */

export interface SessionState {
	authenticated: boolean;
	lastRefresh: number | null;
	refreshInProgress: boolean;
	sessionExpiry: number | null;
}

class SessionManager {
	private state: SessionState = {
		authenticated: false,
		lastRefresh: null,
		refreshInProgress: false,
		sessionExpiry: null
	};

	private refreshPromise: Promise<boolean> | null = null;
	private callbacks: ((state: SessionState) => void)[] = [];
	private originalFetch: typeof fetch | null = null;

	/**
	 * Set the original fetch function to avoid recursion
	 */
	setOriginalFetch(originalFetch: typeof fetch) {
		this.originalFetch = originalFetch;
	}

	/**
	 * Get fetch function (original if available, otherwise global)
	 */
	private getFetch(): typeof fetch {
		return this.originalFetch || fetch;
	}

	/**
	 * Subscribe to session state changes
	 */
	subscribe(callback: (state: SessionState) => void): () => void {
		this.callbacks.push(callback);
		// Immediately call with current state
		callback(this.state);
		
		return () => {
			const index = this.callbacks.indexOf(callback);
			if (index > -1) {
				this.callbacks.splice(index, 1);
			}
		};
	}

	/**
	 * Get current session state
	 */
	getState(): SessionState {
		return { ...this.state };
	}

	/**
	 * Update session state and notify subscribers
	 */
	private setState(updates: Partial<SessionState>) {
		this.state = { ...this.state, ...updates };
		this.callbacks.forEach(callback => callback(this.state));
	}

	/**
	 * Check if session needs refresh (within 5 minutes of expiry)
	 */
	needsRefresh(): boolean {
		if (!this.state.sessionExpiry) return false;
		const fiveMinutes = 5 * 60 * 1000;
		return Date.now() > (this.state.sessionExpiry - fiveMinutes);
	}

	/**
	 * Attempt to refresh the session
	 */
	async refreshSession(): Promise<boolean> {
		// Prevent concurrent refresh attempts
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		this.setState({ refreshInProgress: true });

		this.refreshPromise = this.performRefresh();
		const result = await this.refreshPromise;
		this.refreshPromise = null;

		this.setState({ 
			refreshInProgress: false,
			lastRefresh: Date.now(),
			authenticated: result,
			sessionExpiry: result ? Date.now() + (60 * 60 * 1000) : null // 1 hour from now
		});

		return result;
	}

	/**
	 * Perform the actual session refresh
	 */
	private async performRefresh(): Promise<boolean> {
		try {
			const fetchFn = this.getFetch();
			const response = await fetchFn('/api/google-refresh', {
				method: 'POST',
				credentials: 'include'
			});

			if (response.ok) {
				console.log('[SessionManager] Session refreshed successfully');
				return true;
			} else {
				const errorText = await response.text().catch(() => 'Unknown error');
				console.warn('[SessionManager] Session refresh failed:', response.status, errorText);
				return false;
			}
		} catch (error) {
			console.error('[SessionManager] Session refresh error:', error);
			return false;
		}
	}

	/**
	 * Check session status by probing endpoints
	 */
	async checkSessionStatus(): Promise<{ gmailWorking: boolean; oauthWorking: boolean }> {
		const fetchFn = this.getFetch();
		const results = await Promise.allSettled([
			fetchFn('/api/gmail/profile', { method: 'GET', credentials: 'include' }),
			fetchFn('/api/google-me', { method: 'GET', credentials: 'include' })
		]);

		const gmailWorking = results[0].status === 'fulfilled' && results[0].value.ok;
		const oauthWorking = results[1].status === 'fulfilled' && results[1].value.ok;

		this.setState({ 
			authenticated: gmailWorking || oauthWorking 
		});

		return { gmailWorking, oauthWorking };
	}

	/**
	 * Handle 401 responses automatically
	 */
	async handle401(url: string): Promise<boolean> {
		console.log('[SessionManager] 🔒 Handling 401 for:', url);
		
		// Check if we can refresh the session
		const status = await this.checkSessionStatus();
		
		if (status.gmailWorking && !status.oauthWorking) {
			// Classic session expiry - try refresh
			console.log('[SessionManager] 🔄 Session expired, attempting automatic refresh');
			const refreshed = await this.refreshSession();
			
			if (refreshed) {
				console.log('[SessionManager] ✅ Session refreshed automatically, can retry request');
				return true;
			}
		}

		// Refresh failed or other auth issue
		console.log('[SessionManager] ❌ Cannot recover from 401, user intervention needed');
		return false;
	}

	/**
	 * Force complete re-authentication
	 */
	async forceReauth(): Promise<void> {
		// Clear local auth state
		this.setState({
			authenticated: false,
			lastRefresh: null,
			sessionExpiry: null
		});

		// Clear localStorage auth items
		const keysToRemove = [
			'jmail_last_interactive_auth',
			'jmail_last_scope_auth', 
			'jmail_last_server_redirect',
			'LOCALHOST_ACCESS_TOKEN',
			'LOCALHOST_TOKEN_EXPIRY'
		];
		
		keysToRemove.forEach(key => {
			try {
				localStorage.removeItem(key);
			} catch (_) {}
		});

		// Clear client-side cookies
		try {
			const raw = document.cookie || '';
			raw.split(';').forEach((p) => {
				const i = p.indexOf('='); 
				if (i === -1) return;
				const k = p.slice(0,i).trim();
				document.cookie = k + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
			});
		} catch (_) {}

		// Redirect to login
		const loginUrl = new URL('/api/google-login', window.location.origin);
		loginUrl.searchParams.set('return_to', window.location.href);
		window.location.href = loginUrl.toString();
	}

	/**
	 * Start periodic session monitoring
	 */
	startMonitoring(intervalMs: number = 5 * 60 * 1000): () => void {
		const interval = setInterval(async () => {
			if (this.needsRefresh() && !this.state.refreshInProgress) {
				console.log('[SessionManager] Proactive session refresh');
				await this.refreshSession();
			}
		}, intervalMs);

		return () => clearInterval(interval);
	}
}

// Global session manager instance
export const sessionManager = new SessionManager();

/**
 * Install global fetch interceptor for automatic 401 handling
 */
export function installGlobalAuthInterceptor(): () => void {
	if (typeof window === 'undefined') return () => {};
	
	const originalFetch = window.fetch;
	
	// Give session manager access to original fetch to avoid recursion
	sessionManager.setOriginalFetch(originalFetch);
	
	// @ts-ignore
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		// Only intercept API calls
		const url = typeof input === 'string' ? input : input.toString();
		if (!url.startsWith('/api/')) {
			// Pass through non-API calls
			return originalFetch(input, init);
		}
		
		// Check if this is already a retry to prevent infinite loops
		const isRetry = (init as any)?.__isRetry === true;
		
		// Use original fetch for the initial request
		const response = await originalFetch(input, init);
		
		// Handle 401 responses automatically (but only on first attempt)
		if (response.status === 401 && !isRetry) {
			console.log('[fetchWithAuth] 🚨 401 detected for:', url);
			const canRetry = await sessionManager.handle401(url);
			
			if (canRetry) {
				// Retry the request once using original fetch to avoid recursion
				console.log('[fetchWithAuth] 🔄 Retrying request after session refresh');
				const retryInit = { ...init, __isRetry: true };
				return originalFetch(input, retryInit);
			}
		}
		
		return response;
	};

	return () => {
		// @ts-ignore
		window.fetch = originalFetch;
	};
}
