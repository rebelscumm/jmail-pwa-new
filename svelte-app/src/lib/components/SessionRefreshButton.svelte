<script lang="ts">
import { sessionManager } from '$lib/auth/session-manager';
import Button from '$lib/buttons/Button.svelte';
import Icon from '$lib/misc/_icon.svelte';
import { show as showSnackbar } from '$lib/containers/snackbar';
import iconRefresh from '@ktibow/iconset-material-symbols/refresh';

export let variant: 'filled' | 'outlined' | 'text' | 'tonal' = 'text';
export let compact = false;

let refreshing = false;

async function handleRefresh() {
	if (refreshing) return;
	
	refreshing = true;
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
		console.error('[SessionRefreshButton] Refresh failed:', error);
		showSnackbar({
			message: 'Session refresh error: ' + String(error),
			timeout: 5000,
			closable: true
		});
	} finally {
		refreshing = false;
	}
}
</script>

<Button 
	{variant}
	iconType="left" 
	onclick={handleRefresh}
	disabled={refreshing}
	title="Refresh authentication session"
>
	<Icon icon={iconRefresh} />
	{#if compact}
		{refreshing ? 'Refreshing...' : 'Refresh'}
	{:else}
		{refreshing ? 'Refreshing session...' : 'Refresh session'}
	{/if}
</Button>
