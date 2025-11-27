<script lang="ts">
import { sessionManager } from '$lib/auth/session-manager';
import Button from '$lib/buttons/Button.svelte';
import Icon from '$lib/misc/_icon.svelte';
import { show as showSnackbar } from '$lib/containers/snackbar';
import { markOnline, markError, serverStatus } from '$lib/stores/server-status';
import iconRefresh from '@ktibow/iconset-material-symbols/refresh';
import iconWifiOff from '@ktibow/iconset-material-symbols/wifi-off';
import iconCloudOff from '@ktibow/iconset-material-symbols/cloud-off';

export let variant: 'filled' | 'outlined' | 'text' | 'tonal' = 'text';
export let compact = false;

let refreshing = false;

// Check if there's a server error state
$: hasServerError = $serverStatus.state === 'offline' || 
                    $serverStatus.state === 'unreachable' || 
                    $serverStatus.state === 'error';

// Choose icon based on server state
$: buttonIcon = $serverStatus.state === 'offline' ? iconWifiOff :
                hasServerError ? iconCloudOff : iconRefresh;

async function handleRefresh() {
	if (refreshing) return;
	
	// Check if browser is offline first
	if (typeof navigator !== 'undefined' && !navigator.onLine) {
		showSnackbar({
			message: '📵 You\'re offline - connect to the internet first',
			timeout: 5000,
			closable: true
		});
		return;
	}
	
	refreshing = true;
	try {
		const success = await sessionManager.refreshSession();
		
		if (success) {
			markOnline();
			showSnackbar({
				message: '✓ Session refreshed successfully!',
				timeout: 3000,
				closable: true
			});
		} else {
			showSnackbar({
				message: '🔐 Session refresh failed - you may need to sign in again',
				timeout: 5000,
				closable: true,
				actions: {
					'Sign In': () => sessionManager.forceReauth()
				}
			});
		}
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		console.error('[SessionRefreshButton] Refresh failed:', error);
		
		// Categorize the error
		const msg = err.message.toLowerCase();
		
		if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('net::')) {
			markError('Network error', undefined);
			showSnackbar({
				message: '🔌 Server not responding - check your connection',
				timeout: 6000,
				closable: true,
				actions: {
					'Retry': () => handleRefresh()
				}
			});
		} else if (msg.includes('timeout')) {
			markError('Request timeout', undefined);
			showSnackbar({
				message: '⏱️ Request timed out - server may be busy',
				timeout: 6000,
				closable: true,
				actions: {
					'Retry': () => handleRefresh()
				}
			});
		} else if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
			const code = msg.match(/\d{3}/)?.[0];
			markError('Server error', code ? parseInt(code) : 500);
			showSnackbar({
				message: '⚠️ Server error - please try again later',
				timeout: 6000,
				closable: true,
				actions: {
					'Retry': () => handleRefresh(),
					'Diagnostics': () => { location.href = '/diagnostics'; }
				}
			});
		} else {
			showSnackbar({
				message: `❌ Session refresh error: ${err.message.slice(0, 40)}${err.message.length > 40 ? '...' : ''}`,
				timeout: 5000,
				closable: true,
				actions: {
					'Retry': () => handleRefresh()
				}
			});
		}
	} finally {
		refreshing = false;
	}
}
</script>

<div class="session-refresh-wrapper" class:has-error={hasServerError}>
	<Button 
		{variant}
		iconType="left" 
		onclick={handleRefresh}
		disabled={refreshing}
		title={hasServerError ? `Server ${$serverStatus.state} - tap to retry` : 'Refresh authentication session'}
	>
		<div class="icon-container" class:spin={refreshing}>
			<Icon icon={buttonIcon} />
		</div>
		{#if compact}
			{#if refreshing}
				Refreshing...
			{:else if $serverStatus.state === 'offline'}
				Offline
			{:else if hasServerError}
				Retry
			{:else}
				Refresh
			{/if}
		{:else}
			{#if refreshing}
				Refreshing session...
			{:else if $serverStatus.state === 'offline'}
				You're offline
			{:else if hasServerError}
				Retry connection
			{:else}
				Refresh session
			{/if}
		{/if}
	</Button>
</div>

<style>
	.session-refresh-wrapper {
		display: inline-flex;
		position: relative;
	}
	
	.icon-container {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	
	.icon-container.spin {
		animation: spin 1s linear infinite;
	}
	
	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}
	
	.has-error :global(.m3-container) {
		border-color: rgb(var(--m3-scheme-error)) !important;
		color: rgb(var(--m3-scheme-error)) !important;
	}
</style>
