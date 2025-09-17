<script lang="ts">
import { onMount, onDestroy } from 'svelte';
import { sessionManager, type SessionState } from '$lib/auth/session-manager';
import Button from '$lib/buttons/Button.svelte';
import Icon from '$lib/misc/_icon.svelte';
import { show as showSnackbar } from '$lib/containers/snackbar';
import iconRefresh from '@ktibow/iconset-material-symbols/refresh';
import iconWarning from '@ktibow/iconset-material-symbols/warning';
import iconCheck from '@ktibow/iconset-material-symbols/check-circle';
import iconError from '@ktibow/iconset-material-symbols/error';

let sessionState: SessionState = {
	authenticated: false,
	lastRefresh: null,
	refreshInProgress: false,
	sessionExpiry: null
};

let unsubscribe: (() => void) | null = null;
let checkingStatus = false;

onMount(() => {
	// Subscribe to session state changes
	unsubscribe = sessionManager.subscribe((state) => {
		sessionState = state;
	});

	// Initial status check
	checkSessionStatus();
});

onDestroy(() => {
	if (unsubscribe) {
		unsubscribe();
	}
});

async function checkSessionStatus() {
	checkingStatus = true;
	try {
		// Prefer local sessionManager state when available to avoid transient snackbars
		const localState = sessionManager.getState();
		let status = { gmailWorking: false, oauthWorking: false } as any;
		try {
			status = await sessionManager.checkSessionStatus();
		} catch (e) {
			// If the probe fails, fall back to local state
			status = { gmailWorking: !!localState.authenticated, oauthWorking: !!localState.authenticated };
		}
		
		// Only show warnings if there are actual problems that affect user functionality
		// If Gmail API is working, the user can successfully use the app even if OAuth probe fails
		if (status.gmailWorking && !status.oauthWorking) {
			// Only show this if the user might actually need to refresh soon
			const needsRefresh = sessionManager.needsRefresh();
			if (needsRefresh) {
				showSnackbar({
					message: 'Session will expire soon - consider refreshing',
					timeout: 5000,
					closable: true,
					actions: {
						'Refresh': refreshSession
					}
				});
			}
		} else if (!status.gmailWorking && !status.oauthWorking) {
			// Only show authentication required if we're on a page that actually needs auth
			const needsAuth = window.location.pathname.startsWith('/inbox') || 
							 window.location.pathname.startsWith('/snoozed') || 
							 window.location.pathname.startsWith('/outbox') ||
							 window.location.pathname.startsWith('/viewer');
			
			// Check if the session manager thinks we're authenticated (from successful operations)
			const sessionAuthenticated = sessionManager.getState().authenticated;
			
			if (needsAuth && !sessionAuthenticated) {
				// Only show this warning if the session manager also thinks we're not authenticated
				// This prevents false positives when endpoint probes fail but actual operations work
				showSnackbar({
					message: 'Authentication required - please sign in',
					timeout: 8000,
					closable: true,
					actions: {
						'Sign In': () => {
							const loginUrl = new URL('/api/google-login', window.location.origin);
							loginUrl.searchParams.set('return_to', window.location.href);
							window.location.href = loginUrl.toString();
						}
					}
				});
			}
		}
	} catch (error) {
		console.error('[SessionStatus] Failed to check session status:', error);
	} finally {
		checkingStatus = false;
	}
}

async function refreshSession() {
	try {
		const success = await sessionManager.refreshSession();
		
		if (success) {
			showSnackbar({
				message: 'Session refreshed successfully!',
				timeout: 3000,
				closable: true
			});
		} else {
			showSnackbar({
				message: 'Session refresh failed - you may need to sign in again',
				timeout: 5000,
				closable: true,
				actions: {
					'Sign In': () => sessionManager.forceReauth()
				}
			});
		}
	} catch (error) {
		console.error('[SessionStatus] Session refresh failed:', error);
		showSnackbar({
			message: 'Session refresh error: ' + String(error),
			timeout: 5000,
			closable: true
		});
	}
}

function getStatusIcon() {
	if (sessionState.refreshInProgress || checkingStatus) {
		return iconRefresh;
	} else if (sessionState.authenticated) {
		return iconCheck;
	} else {
		return iconError;
	}
}

function getStatusColor() {
	if (sessionState.refreshInProgress || checkingStatus) {
		return 'primary';
	} else if (sessionState.authenticated) {
		return 'tertiary';
	} else {
		return 'error';
	}
}

function getStatusText() {
	if (sessionState.refreshInProgress) {
		return 'Refreshing session...';
	} else if (checkingStatus) {
		return 'Checking status...';
	} else if (sessionState.authenticated) {
		const lastRefresh = sessionState.lastRefresh;
		if (lastRefresh) {
			const ago = Math.round((Date.now() - lastRefresh) / 60000);
			return `Session active (refreshed ${ago}m ago)`;
		}
		return 'Session active';
	} else {
		return 'Authentication required';
	}
}

function getTimeUntilExpiry(): string | null {
	if (!sessionState.sessionExpiry) return null;
	
	const remaining = sessionState.sessionExpiry - Date.now();
	if (remaining <= 0) return 'Expired';
	
	const minutes = Math.round(remaining / 60000);
	if (minutes < 60) {
		return `${minutes}m remaining`;
	}
	
	const hours = Math.round(minutes / 60);
	return `${hours}h remaining`;
}

// Auto-refresh when getting close to expiry
$: if (sessionState.sessionExpiry && !sessionState.refreshInProgress) {
	const fiveMinutes = 5 * 60 * 1000;
	const timeUntilExpiry = sessionState.sessionExpiry - Date.now();
	
	if (timeUntilExpiry > 0 && timeUntilExpiry <= fiveMinutes) {
		// Auto-refresh when within 5 minutes of expiry
		setTimeout(() => {
			if (!sessionState.refreshInProgress) {
				console.log('[SessionStatus] Auto-refreshing session near expiry');
				refreshSession();
			}
		}, 1000);
	}
}
</script>

<style>
.session-status {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	padding: 0.5rem 1rem;
	border-radius: var(--m3-util-rounding-medium);
	background: rgb(var(--m3-scheme-surface-container));
	border: 1px solid rgb(var(--m3-scheme-outline-variant));
	font-size: 0.875rem;
}

.session-status.authenticated {
	border-color: rgb(var(--m3-scheme-tertiary));
	background: rgb(var(--m3-scheme-tertiary-container) / 0.1);
}

.session-status.unauthenticated {
	border-color: rgb(var(--m3-scheme-error));
	background: rgb(var(--m3-scheme-error-container) / 0.1);
}

.session-status.refreshing {
	border-color: rgb(var(--m3-scheme-primary));
	background: rgb(var(--m3-scheme-primary-container) / 0.1);
}

.status-icon {
	flex-shrink: 0;
	width: 1.25rem;
	height: 1.25rem;
}

.status-icon :global(svg) {
	width: 1.25rem;
	height: 1.25rem;
}

.status-icon.primary :global(svg) {
	color: rgb(var(--m3-scheme-primary));
	animation: spin 1s linear infinite;
}

.status-icon.tertiary :global(svg) {
	color: rgb(var(--m3-scheme-tertiary));
}

.status-icon.error :global(svg) {
	color: rgb(var(--m3-scheme-error));
}

.status-content {
	flex: 1;
	min-width: 0;
}

.status-text {
	color: rgb(var(--m3-scheme-on-surface));
	font-weight: 500;
	line-height: 1.25;
}

.status-detail {
	color: rgb(var(--m3-scheme-on-surface-variant));
	font-size: 0.8125rem;
	line-height: 1.25;
	margin-top: 0.125rem;
}

.status-actions {
	display: flex;
	gap: 0.5rem;
	flex-shrink: 0;
}

@keyframes spin {
	0% { transform: rotate(0deg); }
	100% { transform: rotate(360deg); }
}
</style>

<div class="session-status {sessionState.refreshInProgress || checkingStatus ? 'refreshing' : sessionState.authenticated ? 'authenticated' : 'unauthenticated'}">
	<div class="status-icon {getStatusColor()}">
		<Icon icon={getStatusIcon()} />
	</div>
	
	<div class="status-content">
		<div class="status-text">{getStatusText()}</div>
		{#if getTimeUntilExpiry()}
			<div class="status-detail">{getTimeUntilExpiry()}</div>
		{/if}
	</div>
	
	<div class="status-actions">
		{#if !sessionState.authenticated}
			<Button 
				variant="filled" 
				onclick={() => sessionManager.forceReauth()}
			>
				Sign In
			</Button>
		{:else if sessionManager.needsRefresh() && !sessionState.refreshInProgress}
			<Button 
				variant="tonal" 
				iconType="left"
				onclick={refreshSession}
			>
				<Icon icon={iconRefresh} />
				Refresh
			</Button>
		{:else}
			<Button 
				variant="text" 
				iconType="left"
				onclick={checkSessionStatus}
				disabled={checkingStatus}
			>
				<Icon icon={iconRefresh} />
				Check
			</Button>
		{/if}
	</div>
</div>
