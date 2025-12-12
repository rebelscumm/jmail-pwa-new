<script lang="ts">
import { onMount, onDestroy } from 'svelte';
import Button from '$lib/buttons/Button.svelte';
import Card from '$lib/containers/Card.svelte';
import iconCopy from '@ktibow/iconset-material-symbols/content-copy-outline';
import iconSelectAll from '@ktibow/iconset-material-symbols/select-all';
import iconCheck from '@ktibow/iconset-material-symbols/check-circle';
import iconError from '@ktibow/iconset-material-symbols/error';
import iconWarning from '@ktibow/iconset-material-symbols/warning';
import iconPlayArrow from '@ktibow/iconset-material-symbols/play-arrow';
import iconBack from '@ktibow/iconset-material-symbols/chevron-left';
import iconDiagnostics from '@ktibow/iconset-material-symbols/bug-report-outline';
import Icon from '$lib/misc/_icon.svelte';
import { show as showSnackbar } from '$lib/containers/snackbar';
import { checkForUpdateOnce } from '$lib/update/checker';
import { aiSummarizeEmail, aiSummarizeSubject } from '$lib/ai/providers';
import { pullForwardSnoozedEmails } from '$lib/snooze/pull-forward';
import { getAndClearGmailDiagnostics } from '$lib/gmail/api';

type LogEntry = { level: 'log' | 'warn' | 'error' | 'info'; msg: any[]; ts: string };

let logs: LogEntry[] = [];

function addLog(level: LogEntry['level'], args: any[]) {
	logs = [...logs, { level, msg: args.map(a => trySerialize(a)), ts: new Date().toISOString() }];
}

function trySerialize(v: any) {
	try {
		if (v instanceof Error) {
			return { message: v.message, stack: v.stack };
		}
		return JSON.parse(JSON.stringify(v));
	} catch (e) {
		return String(v);
	}
}

const nativeConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };

// Wizard state
let step = 1;
let serverProbeResult: Record<string, any> | null = null;
let profileResult: Record<string, any> | null = null;
let serverProbeError: string | null = null;
let verifying = false;

// Paste/parse diagnostics state
let pastedText = '';
let parsedDiag: any = null;
let parseError: string | null = null;
let diagSummary: Record<string, any> | null = null;

// Inbox sync diagnostics state
let inboxDiagnostics: Record<string, any> | null = null;

// Full diagnostics runner state
let fullDiagnostics: {
	running: boolean;
	results: Array<{
		name: string;
		status: 'pending' | 'running' | 'success' | 'warning' | 'error';
		message?: string;
		data?: any;
	}>;
	summary?: {
		total: number;
		success: number;
		warning: number;
		error: number;
		pending: number;
	};
} = {
	running: false,
	results: []
};

// App Update check state
let updateCheckResult: any = null;
let checkingUpdate = false;

// AI Summary testing state
let testSubject = 'Service is Complete for Your 2022 Ford Mustang Mach-E';
let testBodyText = 'Dear Customer,\n\nYour vehicle service appointment has been completed. Here are the details:\n\n• Oil change service completed\n• Tire rotation performed\n• Battery check passed\n• Brake inspection completed - all good\n• Next service due in 6 months\n\nTotal cost: $127.50\n\nThank you for choosing our service center!';
let aiSummaryTestResult: any = null;
let testingAiSummary = false;

// Android overflow button diagnostics state
let androidDiagnostics: {
	deviceInfo: any;
	navigationTests: Array<{name: string; status: 'pending' | 'success' | 'error'; message?: string; data?: any}>;
	touchEventTests: Array<{name: string; status: 'pending' | 'success' | 'error'; message?: string; data?: any}>;
	snoozeMenuTests: Array<{name: string; status: 'pending' | 'success' | 'error'; message?: string; data?: any}>;
	running: boolean;
} = {
	deviceInfo: null,
	navigationTests: [],
	touchEventTests: [],
	snoozeMenuTests: [],
	running: false
};

// College recruiting moderation diagnostics state
let recruitingDiagnostics: {
	stats: {
		total: number;
		match: number;
		not_match: number;
		unknown: number;
		error: number;
		labeled: number;
	} | null;
	threads: Array<any>;
	running: boolean;
} = {
	stats: null,
	threads: [],
	running: false
};

// Settings persistence debug state
let settingsDebugResult: {
	isPersistent: boolean;
	storageEstimate: { usage: number; quota: number } | null;
	appSettings: boolean;
	hasApiKey: boolean;
	aiProvider: string | null;
	labelMappingCount: number;
	precomputeSummaries: boolean;
	rawData: any;
} | null = null;
let settingsDebugRunning = false;

async function debugSettingsPersistence() {
	settingsDebugRunning = true;
	addLog('info', ['Starting settings persistence debug...']);
	
	try {
		const { getDB } = await import('$lib/db/indexeddb');
		const db = await getDB();
		
		// Check storage persistence
		let isPersistent = false;
		let storageEstimate: { usage: number; quota: number } | null = null;
		
		if (navigator.storage && navigator.storage.persisted) {
			isPersistent = await navigator.storage.persisted();
			addLog('info', ['Storage persistent:', isPersistent]);
		}
		
		if (navigator.storage && navigator.storage.estimate) {
			const estimate = await navigator.storage.estimate();
			storageEstimate = {
				usage: estimate.usage || 0,
				quota: estimate.quota || 0
			};
			addLog('info', ['Storage estimate:', storageEstimate]);
		}
		
		// Read settings from IndexedDB
		const [appSettings, labelMapping] = await Promise.all([
			db.get('settings', 'app'),
			db.get('settings', 'labelMapping')
		]);
		
		addLog('info', ['Raw app settings from IndexedDB:', appSettings]);
		addLog('info', ['Raw label mapping from IndexedDB:', labelMapping]);
		
		const appSettingsObj = appSettings as any;
		
		settingsDebugResult = {
			isPersistent,
			storageEstimate,
			appSettings: !!appSettings,
			hasApiKey: !!appSettingsObj?.aiApiKey,
			aiProvider: appSettingsObj?.aiProvider || null,
			labelMappingCount: labelMapping ? Object.keys(labelMapping as object).filter(k => !!(labelMapping as any)[k]).length : 0,
			precomputeSummaries: !!appSettingsObj?.precomputeSummaries,
			rawData: {
				appSettings: appSettings || null,
				labelMapping: labelMapping || null,
				checkedAt: new Date().toISOString()
			}
		};
		
		showSnackbar({ message: 'Settings debug complete - check results below', closable: true });
	} catch (e) {
		addLog('error', ['Settings debug failed:', e]);
		showSnackbar({ message: `Settings debug failed: ${String(e)}`, closable: true });
	} finally {
		settingsDebugRunning = false;
	}
}

async function requestStoragePersistence() {
	addLog('info', ['Requesting persistent storage...']);
	
	try {
		if (navigator.storage && navigator.storage.persist) {
			const wasGranted = await navigator.storage.persist();
			addLog('info', ['Persistent storage request result:', wasGranted]);
			
			if (wasGranted) {
				showSnackbar({ message: '✅ Persistent storage granted - data will not be cleared', closable: true });
			} else {
				showSnackbar({ message: '⚠️ Persistent storage denied - browser may clear data under storage pressure', closable: true });
			}
			
			// Refresh the debug info
			await debugSettingsPersistence();
		} else {
			showSnackbar({ message: 'Storage API not available in this browser', closable: true });
		}
	} catch (e) {
		addLog('error', ['Request persistent storage failed:', e]);
		showSnackbar({ message: `Failed to request persistent storage: ${String(e)}`, closable: true });
	}
}

async function runRecruitingDiagnostics() {
	recruitingDiagnostics.running = true;
	try {
		const { getDB } = await import('$lib/db/indexeddb');
		const db = await getDB();
		const allThreads = await db.getAll('threads');
		
		const stats = {
			total: 0,
			match: 0,
			not_match: 0,
			unknown: 0,
			error: 0,
			labeled: 0
		};
		
		const threadsWithModeration: any[] = [];
		
		for (const thread of allThreads) {
			const moderation = thread.autoModeration?.college_recruiting_v1;
			if (moderation) {
				stats.total++;
				if (moderation.status === 'match') stats.match++;
				if (moderation.status === 'not_match') stats.not_match++;
				if (moderation.status === 'unknown') stats.unknown++;
				if (moderation.status === 'error') stats.error++;
				if (moderation.actionTaken === 'label_enqueued') stats.labeled++;
				
				threadsWithModeration.push({
					threadId: thread.threadId,
					subject: thread.lastMsgMeta?.subject || '(no subject)',
					from: thread.lastMsgMeta?.from || '(unknown)',
					status: moderation.status,
					actionTaken: moderation.actionTaken,
					raw: moderation.raw,
					updatedAt: new Date(moderation.updatedAt).toLocaleString(),
					lastError: moderation.lastError,
					labels: thread.labelIds
				});
			}
		}
		
		recruitingDiagnostics.stats = stats;
		recruitingDiagnostics.threads = threadsWithModeration.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		showSnackbar({ message: `Found ${stats.total} threads with moderation results`, closable: true });
	} catch (e) {
		showSnackbar({ message: `Failed to load moderation diagnostics: ${String(e)}`, closable: true });
	} finally {
		recruitingDiagnostics.running = false;
	}
}

async function clearRecruitingModeration() {
	if (!confirm('Clear all college recruiting moderation data? This will cause threads to be re-checked on next precompute.')) return;
	
	try {
		const { getDB } = await import('$lib/db/indexeddb');
		const db = await getDB();
		const allThreads = await db.getAll('threads');
		
		const tx = db.transaction('threads', 'readwrite');
		let cleared = 0;
		
		for (const thread of allThreads) {
			if (thread.autoModeration?.college_recruiting_v1) {
				const updated = { ...thread };
				if (updated.autoModeration) {
					delete updated.autoModeration.college_recruiting_v1;
					if (Object.keys(updated.autoModeration).length === 0) {
						delete updated.autoModeration;
					}
				}
				await tx.store.put(updated);
				cleared++;
			}
		}
		
		await tx.done;
		showSnackbar({ message: `Cleared moderation data from ${cleared} threads`, closable: true });
		await runRecruitingDiagnostics(); // Refresh
	} catch (e) {
		showSnackbar({ message: `Failed to clear moderation data: ${String(e)}`, closable: true });
	}
}

// Comprehensive diagnostics runner
async function runFullDiagnostics() {
	fullDiagnostics.running = true;
	fullDiagnostics.results = [
		{ name: 'Environment Check', status: 'pending' },
		{ name: 'Azure Configuration Check', status: 'pending' },
		{ name: 'Server Session Verification', status: 'pending' },
		{ name: 'Authentication Status', status: 'pending' },
		{ name: 'Localhost Auth Configuration', status: 'pending' },
		{ name: 'Action Queue Health', status: 'pending' },
		{ name: 'Inbox Sync Status', status: 'pending' },
		{ name: 'Gmail API Connectivity', status: 'pending' },
		{ name: 'Client Storage Health', status: 'pending' },
		{ name: 'Cookie Configuration', status: 'pending' }
	];
	
	// Show immediate feedback that diagnostics are starting
	showSnackbar({
		message: 'Starting system health check...',
		timeout: 3000,
		closable: true
	});
	
	try {
		// 1. Environment Check
		await runDiagnosticStep('Environment Check', async () => {
			const result = await probeServer();
			const hasErrors = Object.values(result).some((r: any) => r.error || (!r.ok && r.status >= 400));
			return {
				status: hasErrors ? 'warning' : 'success',
				message: hasErrors ? 'Some endpoints not responding correctly' : 'All endpoints accessible',
				data: result
			};
		});
		
		// 2. Azure Configuration Check
		await runDiagnosticStep('Azure Configuration Check', async () => {
			// Check if google-login endpoint is returning status 0 or 500 (config issues)
			const loginEndpoint = fullDiagnostics.results.find(r => r.name === 'Environment Check')?.data?.['/api/google-login'];
			
			if (!loginEndpoint) {
				return {
					status: 'warning',
					message: 'Could not determine login endpoint status',
					data: { note: 'Run Environment Check first' }
				};
			}
			
			// Status 0 = endpoint not responding (likely missing env vars or not deployed)
			if (loginEndpoint.status === 0) {
				return {
					status: 'error',
					message: 'Login endpoint not responding - environment variables likely missing',
					data: {
						issue: 'API endpoint returns status 0',
						likelyCause: 'Missing environment variables in Azure Static Web App configuration',
						requiredVariables: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_BASE_URL', 'ENCRYPTION_KEY'],
						action: 'Go to Azure Portal → Static Web App → Configuration and add environment variables',
						azurePortalLink: 'https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.Web%2FStaticSites'
					}
				};
			}
			
			// Status 500 with specific error message
			if (loginEndpoint.status === 500 && loginEndpoint.body?.error?.includes('Missing GOOGLE')) {
				return {
					status: 'error',
					message: 'Missing Google OAuth credentials',
					data: {
						issue: loginEndpoint.body.error,
						requiredVariables: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
						action: 'Configure these in Azure Portal → Static Web App → Configuration'
					}
				};
			}
			
			// Status 302 (redirect to Google) = properly configured
			if (loginEndpoint.status === 302 || loginEndpoint.status === 0) {
				// Note: fetch with redirect:manual returns status 0 for redirects in some browsers
				if (loginEndpoint.headers?.location?.includes('accounts.google.com')) {
					return {
						status: 'success',
						message: 'Azure environment variables properly configured',
						data: {
							redirectLocation: loginEndpoint.headers.location,
							note: 'Login endpoint correctly redirects to Google OAuth'
						}
					};
				}
			}
			
			return {
				status: 'success',
				message: 'Configuration appears valid (endpoint responding)',
				data: {
					status: loginEndpoint.status,
					note: 'Login endpoint is responding, configuration may be valid'
				}
			};
		});
		
		// 3. Server Session Verification
		await runDiagnosticStep('Server Session Verification', async () => {
			try {
				const r = await fetch('/api/gmail/profile', { method: 'GET', credentials: 'include' });
				if (r.ok) {
					const profile = tryParseJson(await r.text());
					return {
						status: 'success',
						message: `Authenticated as ${profile.emailAddress || 'unknown user'}`,
						data: profile
					};
				} else {
					return {
						status: 'warning',
						message: `Not authenticated (${r.status})`,
						data: { status: r.status, statusText: r.statusText }
					};
				}
			} catch (e) {
				return {
					status: 'error',
					message: 'Failed to check server session',
					data: { error: String(e) }
				};
			}
		});
		
		// 4. Authentication Status
		await runDiagnosticStep('Authentication Status', async () => {
			const authCache = {
				jmail_last_interactive_auth: localStorage.getItem('jmail_last_interactive_auth'),
				jmail_last_scope_auth: localStorage.getItem('jmail_last_scope_auth'),
				jmail_last_server_redirect: localStorage.getItem('jmail_last_server_redirect'),
				LOCALHOST_ACCESS_TOKEN: localStorage.getItem('LOCALHOST_ACCESS_TOKEN') ? 'Present' : 'Not found',
				LOCALHOST_TOKEN_EXPIRY: localStorage.getItem('LOCALHOST_TOKEN_EXPIRY')
			};
			
			const hasTokens = authCache.LOCALHOST_ACCESS_TOKEN === 'Present' || 
							 authCache.jmail_last_interactive_auth || 
							 authCache.jmail_last_scope_auth;
			
			return {
				status: hasTokens ? 'success' : 'warning',
				message: hasTokens ? 'Authentication tokens found' : 'No authentication tokens found',
				data: authCache
			};
		});
		
		// 5. Localhost Auth Configuration
		await runDiagnosticStep('Localhost Auth Configuration', async () => {
			const hostname = window.location.hostname;
			const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.');
			
			if (!isLocalhost) {
				return {
					status: 'success',
					message: 'Running on production domain',
					data: { hostname, isLocalhost }
				};
			}
			
			const clientIds = {
				LOCALHOST_GOOGLE_CLIENT_ID: localStorage.getItem('LOCALHOST_GOOGLE_CLIENT_ID'),
				DEV_GOOGLE_CLIENT_ID: localStorage.getItem('DEV_GOOGLE_CLIENT_ID'),
				VITE_GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID
			};
			
			const hasClientId = Object.values(clientIds).some(id => id && id.trim());
			
			return {
				status: hasClientId ? 'success' : 'warning',
				message: hasClientId ? 'Localhost client ID configured' : 'No localhost client ID configured',
				data: { hostname, isLocalhost, clientIds }
			};
		});
		
		// 6. Action Queue Health
		await runDiagnosticStep('Action Queue Health', async () => {
			try {
				const { getDB } = await import('$lib/db/indexeddb');
				const db = await getDB();
				
				const ops = await db.getAll('ops');
				const now = Date.now();
				const pending = ops.filter(o => o.nextAttemptAt <= now);
				const failed = ops.filter(o => o.attempts > 3);
				
				let status: 'success' | 'warning' | 'error' = 'success';
				let message = 'Queue healthy';
				
				if (failed.length > 0) {
					status = 'error';
					message = `${failed.length} failed operations need attention`;
				} else if (pending.length > 10) {
					status = 'warning';
					message = `${pending.length} operations pending`;
				}
				
				return {
					status,
					message,
					data: { totalOps: ops.length, pendingOps: pending.length, failedOps: failed.length }
				};
			} catch (e) {
				return {
					status: 'error',
					message: 'Failed to check action queue',
					data: { error: String(e) }
				};
			}
		});
		
		// 7. Inbox Sync Status
		await runDiagnosticStep('Inbox Sync Status', async () => {
			try {
				const { getDB } = await import('$lib/db/indexeddb');
				const { getLabel } = await import('$lib/gmail/api');
				
				const db = await getDB();
				const localThreads = await db.getAll('threads');
				const localInboxThreads = localThreads.filter((t: any) => 
					Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
				);
				
				const gmailInboxLabel = await getLabel('INBOX');
				const discrepancy = Math.abs(localInboxThreads.length - (gmailInboxLabel.threadsTotal || 0));
				
				let status: 'success' | 'warning' | 'error' = 'success';
				let message = 'Inbox sync healthy';
				
				if (discrepancy > 50) {
					status = 'error';
					message = `Large discrepancy: ${discrepancy} threads`;
				} else if (discrepancy > 10) {
					status = 'warning';
					message = `Minor discrepancy: ${discrepancy} threads`;
				}
				
				return {
					status,
					message,
					data: {
						localThreads: localInboxThreads.length,
						gmailThreads: gmailInboxLabel.threadsTotal,
						discrepancy
					}
				};
			} catch (e) {
				return {
					status: 'error',
					message: 'Failed to check inbox sync',
					data: { error: String(e) }
				};
			}
		});
		
		// 8. Gmail API Connectivity
		await runDiagnosticStep('Gmail API Connectivity', async () => {
			try {
				const { listInboxMessageIds } = await import('$lib/gmail/api');
				const page = await listInboxMessageIds(10);
				
				return {
					status: 'success',
					message: `API responding (${page.ids.length} messages)`,
					data: { messageCount: page.ids.length, hasNextToken: !!page.nextPageToken }
				};
			} catch (e) {
				return {
					status: 'error',
					message: 'Gmail API not accessible',
					data: { error: String(e) }
				};
			}
		});
		
		// 9. Client Storage Health
		await runDiagnosticStep('Client Storage Health', async () => {
			try {
				const { getDB } = await import('$lib/db/indexeddb');
				const db = await getDB();
				
				const stores = ['threads', 'messages', 'ops', 'journal'] as const;
				const counts: Record<string, number | string> = {};
				
				for (const store of stores) {
					try {
						const items = await db.getAll(store);
						counts[store] = items.length;
					} catch (e) {
						counts[store] = `Error: ${String(e)}`;
					}
				}
				
				const hasData = Object.values(counts).some(count => typeof count === 'number' && count > 0);
				
				return {
					status: hasData ? 'success' : 'warning',
					message: hasData ? 'IndexedDB accessible with data' : 'IndexedDB accessible but empty',
					data: counts
				};
			} catch (e) {
				return {
					status: 'error',
					message: 'IndexedDB not accessible',
					data: { error: String(e) }
				};
			}
		});
		
		// 10. Cookie Configuration
		await runDiagnosticStep('Cookie Configuration', async () => {
			try {
				const raw = document.cookie || '';
				const clientCookies: Record<string, string> = {};
				raw.split(';').forEach((p) => { 
					const i = p.indexOf('='); 
					if (i === -1) return; 
					const k = p.slice(0, i).trim(); 
					const v = p.slice(i + 1).trim(); 
					clientCookies[k] = v; 
				});
				
				// Check if server session is working (indicates HttpOnly cookies are present)
				let serverCookiesPresent = false;
				try {
					const r = await fetch('/api/google-me', { method: 'GET', credentials: 'include' });
					serverCookiesPresent = r.ok && r.status === 200;
				} catch (_) {
					serverCookiesPresent = false;
				}
				
				const clientCookieCount = Object.keys(clientCookies).length;
				let status: 'success' | 'warning' | 'error' = 'success';
				let message = '';
				
				if (serverCookiesPresent && clientCookieCount === 0) {
					status = 'success';
					message = 'Server authentication cookies present (HttpOnly)';
				} else if (serverCookiesPresent && clientCookieCount > 0) {
					status = 'success';
					message = `Server auth cookies + ${clientCookieCount} client cookies`;
				} else if (!serverCookiesPresent && clientCookieCount > 0) {
					status = 'warning';
					message = `${clientCookieCount} client cookies, no server auth`;
				} else {
					status = 'warning';
					message = 'No cookies detected';
				}
				
				return {
					status,
					message,
					data: {
						clientCookies,
						serverAuthCookiesPresent: serverCookiesPresent,
						note: 'HttpOnly server cookies cannot be read by JavaScript'
					}
				};
			} catch (e) {
				return {
					status: 'error',
					message: 'Failed to check cookies',
					data: { error: String(e) }
				};
			}
		});
		
	} catch (e) {
		addLog('error', ['Full diagnostics failed', e]);
		// Show error feedback
		showSnackbar({
			message: `Health check interrupted: ${e instanceof Error ? e.message : String(e)}`,
			timeout: 6000,
			closable: true,
			actions: {
				'Copy details': async () => {
					try {
						await navigator.clipboard.writeText(String(e));
						showSnackbar({ message: 'Error details copied', timeout: 2000 });
					} catch {
						showSnackbar({ message: 'Copy failed', timeout: 3000 });
					}
				}
			}
		});
	} finally {
		fullDiagnostics.running = false;
		updateDiagnosticsSummary();
		
		// Show completion feedback with summary
		if (fullDiagnostics.summary) {
			const { success, warning, error, total } = fullDiagnostics.summary;
			let message = `Health check complete: ${success}/${total} passed`;
			let timeout = 4000;
			
			if (error > 0) {
				message += `, ${error} ${error === 1 ? 'issue' : 'issues'} found`;
				timeout = 6000; // Longer timeout for errors
			}
			if (warning > 0) {
				message += `, ${warning} ${warning === 1 ? 'warning' : 'warnings'}`;
			}
			
			showSnackbar({
				message,
				timeout,
				closable: true,
				actions: {
					'Copy summary': async () => {
						try {
							const resultsText = fullDiagnostics.results
								.map(r => `${r.name}: ${r.status}${r.message ? ` - ${r.message}` : ''}`)
								.join('\n');
							await navigator.clipboard.writeText(`System Health Summary:\n${resultsText}`);
							showSnackbar({ message: 'Summary copied', timeout: 2000 });
						} catch {
							showSnackbar({ message: 'Copy failed', timeout: 3000 });
						}
					}
				}
			});
		}
	}
}

async function runDiagnosticStep(name: string, testFn: () => Promise<{ status: 'success' | 'warning' | 'error'; message: string; data?: any }>) {
	const resultIndex = fullDiagnostics.results.findIndex(r => r.name === name);
	if (resultIndex === -1) return;
	
	fullDiagnostics.results[resultIndex].status = 'running';
	fullDiagnostics = { ...fullDiagnostics }; // Trigger reactivity
	
	try {
		const result = await testFn();
		fullDiagnostics.results[resultIndex] = {
			name,
			status: result.status,
			message: result.message,
			data: result.data
		};
		addLog('info', [`Diagnostic ${name}: ${result.status}`, result]);
	} catch (e) {
		fullDiagnostics.results[resultIndex] = {
			name,
			status: 'error',
			message: `Test failed: ${String(e)}`,
			data: { error: String(e) }
		};
		addLog('error', [`Diagnostic ${name} failed`, e]);
	}
	
	fullDiagnostics = { ...fullDiagnostics }; // Trigger reactivity
}

function updateDiagnosticsSummary() {
	const total = fullDiagnostics.results.length;
	const success = fullDiagnostics.results.filter(r => r.status === 'success').length;
	const warning = fullDiagnostics.results.filter(r => r.status === 'warning').length;
	const error = fullDiagnostics.results.filter(r => r.status === 'error').length;
	const pending = fullDiagnostics.results.filter(r => r.status === 'pending').length;
	
	fullDiagnostics.summary = { total, success, warning, error, pending };
}

// Authentication management functions
async function clearStaleOAuthCookies() {
	try {
		addLog('info', ['Clearing stale OAuth flow cookies...']);
		
		// Clear the temporary OAuth flow cookies (g_pkce, g_state)
		// These should only exist during an active OAuth flow
		document.cookie = 'g_pkce=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Secure; SameSite=Lax';
		document.cookie = 'g_state=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Secure; SameSite=Lax';
		
		addLog('info', ['Stale OAuth cookies cleared']);
		
		// Try to refresh the session if we have a valid refresh token
		addLog('info', ['Attempting to refresh session...']);
		const { sessionManager } = await import('$lib/auth/session-manager');
		const success = await sessionManager.refreshSession();
		
		if (success) {
			addLog('info', ['Session refreshed successfully!']);
			alert('Stale cookies cleared and session refreshed successfully! You should be able to use the app without logging in again.');
			
			// Re-run diagnostics to verify
			setTimeout(() => runFullDiagnostics(), 1000);
		} else {
			addLog('warn', ['Session refresh failed - you may need to log in again']);
			alert('Stale cookies cleared, but session refresh failed. You may need to log in again.');
		}
	} catch (e) {
		addLog('error', ['clearStaleOAuthCookies failed', e]);
		alert('Failed to clear stale cookies: ' + String(e));
	}
}

function clearAuthCache() {
	try {
		// Clear localStorage auth-related items
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
		
		addLog('info', ['Cleared authentication cache']);
		alert('Authentication cache cleared. This will allow immediate authentication requests.');
	} catch (e) {
		addLog('error', ['clearAuthCache failed', e]);
		alert('Failed to clear authentication cache: ' + String(e));
	}
}

async function refreshServerSession() {
	try {
		addLog('info', ['Attempting to refresh server session...']);
		
		// Use the session manager to refresh
		const success = await import('$lib/auth/session-manager').then(m => m.sessionManager.refreshSession());
		
		if (success) {
			addLog('info', ['Session refresh successful']);
			alert('Server session refreshed successfully! The session should now be valid for another hour.');
			
			// Verify the refresh worked by checking the profile
			setTimeout(async () => {
				try {
					const { sessionManager } = await import('$lib/auth/session-manager');
					const status = await sessionManager.checkSessionStatus();
					addLog('info', ['Profile verification after refresh', status]);
				} catch (e) {
					addLog('error', ['Profile verification failed', e]);
				}
			}, 1000);
			
		} else {
			addLog('error', ['Session refresh failed']);
			alert(`Session refresh failed.\n\nThis usually means:\n1. Your refresh token has expired (need to re-login)\n2. The server is not configured properly\n3. Network connectivity issues`);
		}
	} catch (e) {
		addLog('error', ['refreshServerSession failed', e]);
		alert('Failed to refresh server session: ' + String(e));
	}
}

async function checkSessionExpiry() {
	try {
		addLog('info', ['Checking session expiry status...']);
		
		// Use the session manager to check status safely
		const { sessionManager } = await import('$lib/auth/session-manager');
		const status = await sessionManager.checkSessionStatus();
		
		// Analyze the results
		const analysis = {
			timestamp: new Date().toISOString(),
			status,
			diagnosis: analyzeSessionState(status)
		};
		
		addLog('info', ['Session expiry check completed', analysis]);
		
		const message = `Session Status Analysis:
${analysis.diagnosis.summary}

Details:
- Google OAuth endpoints: ${analysis.diagnosis.oauthWorking ? '✓ Working' : '✗ Not working'}  
- Gmail API: ${analysis.diagnosis.gmailWorking ? '✓ Working' : '✗ Not working'}
- Likely issue: ${analysis.diagnosis.likelyIssue}

${analysis.diagnosis.recommendation}`;
		
		alert(message);
		
	} catch (e) {
		addLog('error', ['checkSessionExpiry failed', e]);
		alert('Failed to check session expiry: ' + String(e));
	}
}

function analyzeSessionState(status: { gmailWorking: boolean; oauthWorking: boolean }) {
	const gmailWorking = status.gmailWorking;
	const oauthWorking = status.oauthWorking;
	
	let summary = '';
	let likelyIssue = '';
	let recommendation = '';
	
	if (gmailWorking && oauthWorking) {
		summary = 'All authentication systems working normally';
		likelyIssue = 'No issues detected';
		recommendation = 'No action needed';
	} else if (gmailWorking && !oauthWorking) {
		summary = 'Gmail API working but OAuth endpoints failing';
		likelyIssue = 'Session cookie expired (1 hour limit) but refresh token still valid';
		recommendation = 'Click "Refresh server session" to extend the session for another hour';
	} else if (!gmailWorking && oauthWorking) {
		summary = 'OAuth working but Gmail API failing';  
		likelyIssue = 'Unexpected state - OAuth tokens present but Gmail proxy failing';
		recommendation = 'Check server logs and try refreshing session';
	} else {
		summary = 'Both Gmail API and OAuth endpoints failing';
		likelyIssue = 'Complete authentication failure - refresh token may have expired';
		recommendation = 'Try refreshing session first, then re-login if that fails';
	}
	
	return {
		summary,
		likelyIssue,
		recommendation,
		gmailWorking,
		oauthWorking
	};
}

async function forceReauth() {
	try {
		const confirmed = confirm(`This will force a complete re-authentication by clearing all local auth data and redirecting to login.

Current session will be lost. Continue?`);
		
		if (!confirmed) return;
		
		addLog('info', ['Starting forced re-authentication...']);
		
		// Use the session manager to handle re-auth
		const { sessionManager } = await import('$lib/auth/session-manager');
		await sessionManager.forceReauth();
		
	} catch (e) {
		addLog('error', ['forceReauth failed', e]);
		alert('Failed to force re-authentication: ' + String(e));
	}
}

let globalInterceptorEnabled = false;
let uninstallGlobalInterceptor: (() => void) | null = null;

async function enableGlobalInterceptor() {
	try {
		if (globalInterceptorEnabled) {
			// Disable it
			if (uninstallGlobalInterceptor) {
				uninstallGlobalInterceptor();
				uninstallGlobalInterceptor = null;
			}
			globalInterceptorEnabled = false;
			addLog('info', ['Global auth interceptor disabled']);
			alert('Global auto-refresh interceptor disabled.');
		} else {
			// Enable it
			const { installGlobalAuthInterceptor } = await import('$lib/auth/session-manager');
			uninstallGlobalInterceptor = installGlobalAuthInterceptor();
			globalInterceptorEnabled = true;
			addLog('info', ['Global auth interceptor enabled']);
			alert('Global auto-refresh interceptor enabled! It will automatically handle 401 errors by refreshing your session.\n\nNote: This is experimental. If you experience issues, click this button again to disable it.');
		}
	} catch (e) {
		addLog('error', ['enableGlobalInterceptor failed', e]);
		alert('Failed to toggle global interceptor: ' + String(e));
	}
}

function openAuthSettings() {
	try {
		window.location.href = '/settings?tab=auth';
	} catch (e) {
		addLog('error', ['openAuthSettings failed', e]);
		alert('Failed to open authentication settings: ' + String(e));
	}
}

function resetAuthRateLimit() {
	try {
		localStorage.removeItem('jmail_last_interactive_auth');
		localStorage.removeItem('jmail_last_scope_auth');
		localStorage.removeItem('jmail_last_server_redirect');
		
		addLog('info', ['Reset authentication rate limits']);
		alert('Authentication rate limits reset. You can now immediately trigger authentication requests.');
	} catch (e) {
		addLog('error', ['resetAuthRateLimit failed', e]);
		alert('Failed to reset authentication rate limits: ' + String(e));
	}
}

// Localhost authentication diagnostic functions
function configureLocalhostClientId() {
	try {
		const currentId = localStorage.getItem('LOCALHOST_GOOGLE_CLIENT_ID') || 
						 localStorage.getItem('DEV_GOOGLE_CLIENT_ID') || 
						 import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
		
		const instructions = `To fix localhost authentication, you need a Google Client ID configured for localhost:

1. Go to Google Cloud Console: https://console.cloud.google.com/apis/credentials
2. Create or edit an OAuth 2.0 Client ID
3. Add these to "Authorized JavaScript origins":
   - http://localhost:5173
   - http://127.0.0.1:5173
4. Copy the Client ID and enter it below

Current Client ID: ${currentId ? currentId.slice(0, 20) + '...' : 'Not set'}`;
		
		const newId = prompt(instructions, currentId);
		if (newId && newId.trim()) {
			localStorage.setItem('LOCALHOST_GOOGLE_CLIENT_ID', newId.trim());
			addLog('info', ['Configured localhost Google Client ID', newId.slice(0, 20) + '...']);
			alert('Localhost Google Client ID saved! Reload the page to use it.');
		}
	} catch (e) {
		addLog('error', ['configureLocalhostClientId failed', e]);
		alert('Failed to configure client ID: ' + String(e));
	}
}

async function checkLocalhostAuthStatus() {
	try {
		const hostname = window.location.hostname;
		const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.');
		
		const status = {
			isLocalhost,
			hostname,
			clientIds: {
				LOCALHOST_GOOGLE_CLIENT_ID: localStorage.getItem('LOCALHOST_GOOGLE_CLIENT_ID'),
				DEV_GOOGLE_CLIENT_ID: localStorage.getItem('DEV_GOOGLE_CLIENT_ID'),
				VITE_GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID,
				fallback: '49551890193-e6n262ccj95229ftp2dh6k9s2boo1kip.apps.googleusercontent.com'
			},
			tokens: {
				LOCALHOST_ACCESS_TOKEN: localStorage.getItem('LOCALHOST_ACCESS_TOKEN') ? 'Present' : 'Not found',
				LOCALHOST_TOKEN_EXPIRY: localStorage.getItem('LOCALHOST_TOKEN_EXPIRY'),
				expired: localStorage.getItem('LOCALHOST_TOKEN_EXPIRY') ? 
					Date.now() >= parseInt(localStorage.getItem('LOCALHOST_TOKEN_EXPIRY') || '0') : 'N/A'
			},
			serverPorts: {} as Record<string, string>,
			authCache: {
				jmail_last_interactive_auth: localStorage.getItem('jmail_last_interactive_auth'),
				jmail_last_scope_auth: localStorage.getItem('jmail_last_scope_auth'),
				jmail_last_server_redirect: localStorage.getItem('jmail_last_server_redirect')
			}
		};
		
		// Test server ports
		for (const port of ['4280', '7071']) {
			const portLabel = port === '4280' ? 'SWA CLI port' : 'Azure Functions port';
			try {
				const response = await fetch(`http://localhost:${port}/api/google-me`, {
					method: 'GET',
					credentials: 'include'
				});
				status.serverPorts[port] = `${portLabel} - ${response.status}`;
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				status.serverPorts[port] = `${portLabel} - Error: ${error}`;
			}
		}
		
		addLog('info', ['Localhost auth status', status]);
		await navigator.clipboard.writeText(JSON.stringify(status, null, 2));
		showSnackbar({ message: 'Localhost auth status copied to clipboard! Check logs for details.', closable: true });
	} catch (e) {
		addLog('error', ['checkLocalhostAuthStatus failed', e]);
		showSnackbar({ message: 'Failed to check localhost auth status: ' + String(e), closable: true });
	}
}

function setupServerAuth() {
	try {
		const instructions = `To set up server authentication (SWA CLI) for long-lasting tokens:

STEP 1: Install tools
pnpm install -g @azure/static-web-apps-cli azure-functions-core-tools@4

STEP 2: Create api/local.settings.json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "GOOGLE_CLIENT_ID": "your-client-id",
    "GOOGLE_CLIENT_SECRET": "your-client-secret",
    "APP_BASE_URL": "http://localhost:4280",
    "COOKIE_SECRET": "your-32-char-secret-key-here-123456",
    "COOKIE_SIGNING_SECRET": "your-other-32-char-secret-here-78901",
    "COOKIE_SECURE": "false"
  }
}

STEP 3: Update Google Cloud Console
Add redirect URI: http://localhost:4280/api/google-callback

STEP 4: Run SWA CLI
swa start ./svelte-app --api-location ./api --run "pnpm run dev --prefix svelte-app"

This gives you long-lasting authentication like production!`;
		
		addLog('info', ['Server auth setup instructions displayed']);
		alert(instructions);
	} catch (e) {
		addLog('error', ['setupServerAuth failed', e]);
		alert('Failed to show setup instructions: ' + String(e));
	}
}

function showOAuthInstructions() {
	try {
		const instructions = `Google OAuth Setup for Localhost Development:

OPTION 1: Quick Client-Side Auth (1 hour tokens)
1. Go to: https://console.cloud.google.com/apis/credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add Authorized JavaScript origins:
   - http://localhost:5173
   - http://127.0.0.1:5173
4. Copy Client ID and click "Configure localhost Google Client ID" button

OPTION 2: Server Auth Setup (Long-lasting tokens)
1. Create OAuth 2.0 Client ID (Web application) 
2. Add Authorized redirect URIs:
   - http://localhost:4280/api/google-callback
3. Copy Client ID AND Client Secret
4. Click "Setup server authentication" button for full instructions

CURRENT ISSUE: Your localhost auth popup is closing because the Client ID doesn't have localhost:5173 as an authorized origin.

Choose Option 1 for quick testing or Option 2 for full server auth.`;
		
		addLog('info', ['OAuth instructions displayed']);
		alert(instructions);
	} catch (e) {
		addLog('error', ['showOAuthInstructions failed', e]);
		alert('Failed to show OAuth instructions: ' + String(e));
	}
}

onMount(() => {
	console.log = (...args: any[]) => { addLog('log', args); nativeConsole.log.apply(console, args); };
	console.warn = (...args: any[]) => { addLog('warn', args); nativeConsole.warn.apply(console, args); };
	console.error = (...args: any[]) => { addLog('error', args); nativeConsole.error.apply(console, args); };
	console.info = (...args: any[]) => { addLog('info', args); nativeConsole.info.apply(console, args); };

	// Wrap fetch to capture requests/responses to server endpoints
	const originalFetch = window.fetch.bind(window);
	// @ts-ignore
	window.fetch = async (input: RequestInfo, init?: RequestInit) => {
		const start = Date.now();
		try {
			const res = await originalFetch(input, init);
			const clone = res.clone();
			let body = null;
			try { body = await clone.text(); } catch (e) { body = `<<unreadable: ${e}>>`; }
			addLog('info', [`fetch ${String(input)} ${init ? JSON.stringify(init) : ''} -> ${res.status}`, { status: res.status, url: res.url, body }]);
			return res;
		} catch (err) {
			addLog('error', [`fetch ${String(input)} failed`, err]);
			throw err;
		} finally {
			const dur = Date.now() - start;
			addLog('log', [`fetch ${String(input)} duration ${dur}ms`]);
		}
	};

	return () => {
		console.log = nativeConsole.log;
		console.warn = nativeConsole.warn;
		console.error = nativeConsole.error;
		console.info = nativeConsole.info;
		// @ts-ignore
		window.fetch = originalFetch;
	};
});

async function probeServer() {
	const endpoints = [
		'/api/google-login',
		'/api/google-callback',
		'/api/google-me',
		'/api/google-refresh',
		'/api/google-logout',
		'/api/google-tokeninfo'
	];

	const results: Record<string, any> = {};

	for (const ep of endpoints) {
		try {
			const res = await fetch(ep, { method: 'GET', credentials: 'include', redirect: 'manual' });
			let body: any = null;
			try { body = await res.text(); body = tryParseJson(body); } catch (e) { body = `<<unreadable: ${e}>>`; }
			// capture response headers and status
			const headers: Record<string,string> = {};
			try { for (const k of Array.from(res.headers.keys())) headers[k] = res.headers.get(k) as string; } catch (_) {}
			results[ep] = { status: res.status, ok: res.ok, headers, body };
			
			// Special handling for status 0 (network failure / not deployed)
			if (res.status === 0) {
				results[ep].diagnosis = 'Function not responding - likely not deployed, runtime error, or CORS issue';
				results[ep].actionable = [
					'Check Azure Portal: Ensure the function app is running',
					'Check environment variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_BASE_URL',
					'Check deployment logs for errors',
					'Try redeploying the Azure Functions'
				];
			}
			
			addLog('info', [`probe ${ep}`, results[ep]]);
		} catch (e) {
			results[ep] = { error: String(e), diagnosis: 'Network error or function crash' };
			addLog('error', [`probe ${ep} failed`, e]);
		}
	}

	return results;
}

function tryParseJson(s: string) {
	try { return JSON.parse(s); } catch { return s; }
}

async function copyDiagnostics() {
	const serverProbeLocal = await probeServer();
	const diag = { ts: new Date().toISOString(), userAgent: navigator.userAgent, logs, serverProbe: serverProbeLocal };
	try {
		await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
		addLog('info', ['copied diagnostics to clipboard']);
		showSnackbar({ message: 'Diagnostics copied to clipboard', closable: true });
	} catch (e) {
		addLog('error', ['failed to copy diagnostics', e]);
		showSnackbar({ message: 'Failed to copy diagnostics: ' + String(e), closable: true });
	}
}

// Copy functions for individual sections
async function copySection(sectionName: string, data: any) {
	try {
		const content = JSON.stringify(data, null, 2);
		await navigator.clipboard.writeText(content);
		addLog('info', [`copied ${sectionName} to clipboard`]);
		showSnackbar({ message: `${sectionName} copied to clipboard`, closable: true });
	} catch (e) {
		addLog('error', [`failed to copy ${sectionName}`, e]);
		showSnackbar({ message: `Failed to copy ${sectionName}: ` + String(e), closable: true });
	}
}

async function copyAllSections() {
	try {
		const allData = {
			timestamp: new Date().toISOString(),
			userAgent: navigator.userAgent,
			environmentChecks: serverProbeResult,
			profileResult,
			parsedDiagnostics: parsedDiag,
			diagnosticsSummary: diagSummary,
			inboxDiagnostics,
			queueDiagnostics,
			endpointResults,
			logs: logs.slice(-200),
			authCache: {
				jmail_last_interactive_auth: localStorage.getItem('jmail_last_interactive_auth'),
				jmail_last_scope_auth: localStorage.getItem('jmail_last_scope_auth'),
				jmail_last_server_redirect: localStorage.getItem('jmail_last_server_redirect'),
				LOCALHOST_ACCESS_TOKEN: localStorage.getItem('LOCALHOST_ACCESS_TOKEN') ? 'Present' : 'Not found',
				LOCALHOST_TOKEN_EXPIRY: localStorage.getItem('LOCALHOST_TOKEN_EXPIRY')
			}
		};
		const content = JSON.stringify(allData, null, 2);
		await navigator.clipboard.writeText(content);
		addLog('info', ['copied all diagnostics sections to clipboard']);
		showSnackbar({ message: 'All diagnostics sections copied to clipboard', closable: true });
	} catch (e) {
		addLog('error', ['failed to copy all diagnostics sections', e]);
		showSnackbar({ message: 'Failed to copy all diagnostics sections: ' + String(e), closable: true });
	}
}

// Helper: ensure comprehensive analysis is available and copy to clipboard
async function copyComprehensiveAnalysis() {
	try {
		// Ensure analysis exists
        if (!inboxDiagnostics || !inboxDiagnostics.comprehensiveAnalysis) {
            addLog('info', ['Comprehensive analysis missing - running now']);
            await comprehensiveSyncAnalysis();
        }

        // Build a richer diagnostics payload but avoid including secrets
        const extra = {
            comprehensiveAnalysis: inboxDiagnostics?.comprehensiveAnalysis || null,
            profileResult: profileResult || null,
            endpointResults: endpointResults || null,
            parsedDiag: parsedDiag || null,
            logs: logs.slice(-300)
        };

        // Reuse centralized helper which already implements robust clipboard fallbacks
        const { copyGmailDiagnosticsToClipboard } = await import('$lib/gmail/api');
        const ok = await copyGmailDiagnosticsToClipboard(extra);

        if (ok) {
            addLog('info', ['copied comprehensive analysis via centralized helper']);
            showSnackbar({ message: 'Comprehensive analysis copied to clipboard', closable: true });
        } else {
            // The helper already attempted fallbacks; surface a friendly note
            addLog('info', ['centralized copy helper returned false; fallback applied']);
            showSnackbar({ message: 'Comprehensive analysis prepared (see console). Clipboard fallback may be restricted.', closable: true });
        }
    } catch (e) {
        addLog('error', ['failed to copy comprehensive analysis', e]);
        showSnackbar({ message: 'Failed to copy comprehensive analysis: ' + String(e), closable: true });
    }
}

function clearLogs() { logs = []; }

onDestroy(() => {
	// no-op: cleanup handled by onMount return
});

// Wizard actions
export async function runStep1EnvChecks() {
	serverProbeError = null;
	serverProbeResult = null;
	try {
		serverProbeResult = await probeServer();
		step = 2;
	} catch (e) {
		serverProbeError = e instanceof Error ? e.message : String(e);
	}
}

export async function tryVerifyServerSession() {
	verifying = true;
	profileResult = null;
	try {
		// Try server-side profile first
		const r = await fetch('/api/gmail/profile', { method: 'GET', credentials: 'include' });
		if (r.ok) {
			try { profileResult = tryParseJson(await r.text()); } catch (_) { profileResult = { ok: true, status: r.status }; }
			addLog('info', ['server profile ok', profileResult]);
			step = 4;
		} else {
			addLog('warn', ['server profile not ok', r.status]);
			step = 3; // suggest login
		}
	} catch (e) {
		addLog('error', ['verify server session failed', e]);
		step = 3;
	} finally {
		verifying = false;
	}
}

function resolveServerBase(): string {
	try {
		const w = (window as any) || {};
		if (w.__ENV__ && w.__ENV__.APP_BASE_URL) return String(w.__ENV__.APP_BASE_URL);
	} catch (_) {}
	try {
		const env = (import.meta as any).env;
		if (env && env.VITE_APP_BASE_URL) return String(env.VITE_APP_BASE_URL);
	} catch (_) {}
	try {
		const ls = localStorage.getItem('APP_BASE_URL') || localStorage.getItem('VITE_APP_BASE_URL');
		if (ls) return ls;
	} catch (_) {}
	try { return window.location.origin; } catch (_) { return '/'; }
}

export async function startServerLogin() {
	// Build login URL preserving return_to
	const serverBase = resolveServerBase();
	const loginUrl = new URL('/api/google-login', serverBase);
	loginUrl.searchParams.set('return_to', window.location.href);

	// Probe server quickly to see if it's reachable
	try {
		const probeUrl = new URL('/api/gmail/profile', serverBase).toString();
		const ctrl = new AbortController();
		const id = setTimeout(() => ctrl.abort(), 3000);
		const r2 = await fetch(probeUrl, { method: 'GET', credentials: 'include', signal: ctrl.signal });
		clearTimeout(id);
		let bodyText: string | undefined = undefined;
		try { bodyText = await r2.text(); } catch (_) { bodyText = undefined; }
		const isSpaHtml404 = r2.status === 404 && typeof bodyText === 'string' && /<!doctype html|<html/i.test(bodyText || '');
		addLog('info', ['server probe before login', { status: r2.status, isSpaHtml404 }]);
		if (isSpaHtml404) {
			const ok = window.confirm('API host appears to be serving frontend HTML (404). The API may not be running. Open server login anyway?');
			if (!ok) return;
		} else if (!r2.ok) {
			const ok = window.confirm(`API probe returned ${r2.status}. Open server login anyway?`);
			if (!ok) return;
		}
	} catch (probeErr) {
		addLog('error', ['server probe error before login', probeErr]);
		const ok = window.confirm('Could not reach API host. Open server login anyway?');
		if (!ok) return;
	}

	// Navigate to server login (full page)
	window.location.href = loginUrl.toString();
}

// Diagnostics parsing and summarization
function summarizeParsedDiagnostics(d: any) {
	try {
		const summary: any = {};
		if (!d) return { empty: true };
		if (d.entries && Array.isArray(d.entries)) summary.entries = d.entries.length;
		if (d.serverProbe) summary.serverProbe = Object.keys(d.serverProbe).length;
		// detect auth related flags
		if (d.tokenInfo) summary.tokenScope = (d.tokenInfo.scope || '').slice(0, 200);
		if (d.profile) summary.profile = { emailAddress: d.profile.emailAddress, messagesTotal: d.profile.messagesTotal };
		// extract top-level keys
		summary.keys = Object.keys(d).slice(0, 50);
		return summary;
	} catch (_) { return { error: 'summarize_failed' }; }
}

export function processPastedDiagnostics() {
	parseError = null;
	parsedDiag = null;
	diagSummary = null;
	try {
		if (!pastedText || pastedText.trim().length === 0) throw new Error('No diagnostics text');
		const obj = JSON.parse(pastedText);
		parsedDiag = obj;
		diagSummary = summarizeParsedDiagnostics(obj);
		addLog('info', ['parsed diagnostics', diagSummary]);
	} catch (e) {
		parseError = e instanceof Error ? e.message : String(e);
		addLog('error', ['parse diagnostics failed', parseError]);
	}
}

export async function copyParsedDiagnostics() {
	if (!parsedDiag) return false;
	try {
		await navigator.clipboard.writeText(JSON.stringify(parsedDiag, null, 2));
		addLog('info', ['copied parsed diagnostics']);
		return true;
	} catch (e) {
		addLog('error', ['copy parsed diagnostics failed', e]);
		return false;
	}
}

export async function submitParsedDiagnostics() {
	if (!parsedDiag) {
		alert('No parsed diagnostics to submit.');
		return;
	}
	try {
		const r = await fetch('/api/collect-diagnostics', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(parsedDiag)
		});
		if (r.ok) {
			addLog('info', ['Submitted parsed diagnostics to server']);
			alert('Parsed diagnostics submitted successfully!');
		} else {
			addLog('error', [`Failed to submit parsed diagnostics: ${r.status} ${r.statusText}`]);
			alert(`Failed to submit parsed diagnostics: ${r.status} ${r.statusText}`);
		}
	} catch (e) {
		addLog('error', ['Error submitting parsed diagnostics', e]);
		alert('Error submitting parsed diagnostics: ' + String(e));
	}
}

// Action queue diagnostics
let queueDiagnostics: Record<string, any> | null = null;

// Guided actions: per-user interactive checks
let apiBaseOverride = 'https://jmail-pwa-new-api.azurewebsites.net';
let endpointResults: Record<string, any> = {};

async function checkActionQueue() {
	try {
		const { getDB } = await import('$lib/db/indexeddb');
		const db = await getDB();
		
		// Get all queued operations
		const ops = await db.getAll('ops');
		const journal = await db.getAll('journal');
		
		// Analyze the queue
		const now = Date.now();
		const pending = ops.filter(o => o.nextAttemptAt <= now);
		const failed = ops.filter(o => o.attempts > 0);
		const recentJournal = journal.slice(-20);
		
		// Group operations by type
		const opsByType = ops.reduce((acc, op) => {
			const type = op.op?.type || 'unknown';
			acc[type] = (acc[type] || 0) + 1;
			return acc;
		}, {} as Record<string, number>);
		
		queueDiagnostics = {
			timestamp: new Date().toISOString(),
			totalOps: ops.length,
			pendingOps: pending.length,
			failedOps: failed.length,
			opsByType,
			recentJournal: recentJournal.map(entry => ({
				id: entry.id,
				type: entry.intent?.type,
				threadId: entry.threadId,
				createdAt: new Date(entry.createdAt).toISOString(),
				ruleKey: entry.intent?.ruleKey
			})),
			sampleFailedOps: failed.slice(0, 5).map(op => ({
				id: op.id,
				type: op.op?.type,
				attempts: op.attempts,
				lastError: op.lastError,
				nextAttemptAt: new Date(op.nextAttemptAt).toISOString(),
				scopeKey: op.scopeKey
			}))
		};
		
		addLog('info', ['Queue diagnostics collected', queueDiagnostics]);
	} catch (e) {
		addLog('error', ['Failed to check action queue', e]);
		alert('Failed to check action queue: ' + String(e));
	}
}

async function checkJournal() {
	try {
		const { getDB } = await import('$lib/db/indexeddb');
		const db = await getDB();
		
		const journal = await db.getAll('journal');
		const recent = journal.slice(-50).reverse(); // Most recent first
		
		const summary = {
			totalEntries: journal.length,
			recentEntries: recent.map(entry => ({
				id: entry.id,
				type: entry.intent?.type,
				threadId: entry.threadId,
				createdAt: new Date(entry.createdAt).toISOString(),
				addLabels: entry.intent?.addLabelIds,
				removeLabels: entry.intent?.removeLabelIds,
				ruleKey: entry.intent?.ruleKey
			}))
		};
		
		addLog('info', ['Journal check completed', summary]);
		alert(`Journal contains ${journal.length} entries. Check logs for details.`);
	} catch (e) {
		addLog('error', ['Failed to check journal', e]);
		alert('Failed to check journal: ' + String(e));
	}
}

async function forceFlushQueue() {
	try {
		const { flushOnce } = await import('$lib/queue/flush');
		addLog('info', ['Starting forced queue flush']);
		await flushOnce();
		addLog('info', ['Queue flush completed']);
		
		// Refresh queue status
		await checkActionQueue();
		alert('Queue flush completed. Check the queue status for results.');
	} catch (e) {
		addLog('error', ['Failed to flush queue', e]);
		alert('Failed to flush queue: ' + String(e));
	}
}

async function clearFailedOps() {
	try {
		const { getDB } = await import('$lib/db/indexeddb');
		const db = await getDB();
		
		const ops = await db.getAll('ops');
		const failed = ops.filter(o => o.attempts > 3); // Operations with multiple failures
		
		if (failed.length === 0) {
			alert('No failed operations to clear.');
			return;
		}
		
		const confirmed = confirm(`Clear ${failed.length} failed operations? This action cannot be undone.`);
		if (!confirmed) return;
		
		const tx = db.transaction('ops', 'readwrite');
		for (const op of failed) {
			await tx.store.delete(op.id);
		}
		await tx.done;
		
		addLog('info', [`Cleared ${failed.length} failed operations`]);
		await checkActionQueue(); // Refresh status
		alert(`Cleared ${failed.length} failed operations.`);
	} catch (e) {
		addLog('error', ['Failed to clear failed operations', e]);
		alert('Failed to clear failed operations: ' + String(e));
	}
}

async function checkFlushLoop() {
	try {
		// Start the flush loop if it's not running
		const { startFlushLoop } = await import('$lib/queue/flush');
		startFlushLoop();
		
		addLog('info', ['Flush loop started/verified']);
		alert('Flush loop has been started/verified. It runs every 2 seconds to process queued actions.');
	} catch (e) {
		addLog('error', ['Failed to check/start flush loop', e]);
		alert('Failed to check flush loop: ' + String(e));
	}
}

function loadApiBaseOverride() {
	try { apiBaseOverride = localStorage.getItem('VITE_APP_BASE_URL') || localStorage.getItem('APP_BASE_URL') || ''; } catch (_) { apiBaseOverride = ''; }
}

function saveApiBaseOverride() {
	try {
		if (apiBaseOverride && apiBaseOverride.trim()) {
			localStorage.setItem('APP_BASE_URL', apiBaseOverride.trim());
		} else {
			localStorage.removeItem('APP_BASE_URL');
		}
		addLog('info', ['Saved APP_BASE_URL override', apiBaseOverride]);
		alert('Saved APP_BASE_URL override. Re-run environment checks to apply.');
	} catch (e) {
		addLog('error', ['Failed to save APP_BASE_URL override', e]);
		alert('Failed to save override: ' + String(e));
	}
}

async function checkEndpoint(path: string) {
	const serverBase = resolveServerBase();
	const url = new URL(path, serverBase).toString();
	try {
		const r = await fetch(url, { method: 'GET', credentials: 'include' });
		let body: any = null;
		try { body = await r.text(); body = tryParseJson(body); } catch (_) { body = '<<unreadable>>'; }
		endpointResults[path] = { status: r.status, ok: r.ok, headers: (() => { const o: any = {}; try { for (const k of Array.from(r.headers.keys())) o[k] = r.headers.get(k); } catch (_) {} return o; })(), body };
		addLog('info', ['endpoint check', path, endpointResults[path]]);
	} catch (e) {
		endpointResults[path] = { error: String(e) };
		addLog('error', ['endpoint check failed', path, e]);
	}
}

function listClientCookies() {
	try {
		const raw = document.cookie || '';
		const out: Record<string,string> = {};
		raw.split(';').forEach((p) => { const i = p.indexOf('='); if (i === -1) return; const k = p.slice(0,i).trim(); const v = p.slice(i+1).trim(); out[k]=v; });
		addLog('info', ['client cookies', out]);
		endpointResults['__cookies'] = out;
	} catch (e) {
		addLog('error', ['listClientCookies failed', e]);
	}
}

function clearClientCookies() {
	try {
 		const raw = document.cookie || '';
 		raw.split(';').forEach((p) => {
 			const i = p.indexOf('='); if (i === -1) return;
 			const k = p.slice(0,i).trim();
 			document.cookie = k + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
 		});
 		addLog('info', ['cleared non-httpOnly client cookies']);
 		alert('Cleared non-httpOnly cookies. httpOnly cookies (server-set) cannot be removed from JS; clear them in browser settings.');
 	} catch (e) { addLog('error', ['clearClientCookies failed', e]); }
}

// Inbox sync diagnostic functions
async function debugInboxSync() {
	try {
		addLog('info', ['Starting inbox sync debug...']);
		
		// Import necessary functions
		const { getDB } = await import('$lib/db/indexeddb');
		const { listInboxMessageIds, getLabel } = await import('$lib/gmail/api');
		
		const db = await getDB();
		
		// Get local data
		const localThreads = await db.getAll('threads');
		const localMessages = await db.getAll('messages');
		const localInboxThreads = localThreads.filter((t: any) => 
			Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
		);
		
		// Get Gmail data (first page only to avoid runaway)
		let gmailMessageIds: string[] = [];
		let gmailInboxLabel: any = null;
		try {
			const page = await listInboxMessageIds(50); // Small page for diagnostics
			gmailMessageIds = page.ids || [];
			gmailInboxLabel = await getLabel('INBOX');
		} catch (e) {
			addLog('error', ['Failed to fetch Gmail data', e]);
		}
		
		// Get trailing holds
		const { trailingHolds } = await import('$lib/stores/holds');
		let currentHolds: Record<string, number> = {};
		trailingHolds.subscribe(holds => { currentHolds = holds; })();
		
		const now = Date.now();
		const activeHolds = Object.entries(currentHolds).filter(([, timestamp]) => timestamp > now);
		
		inboxDiagnostics = {
			timestamp: new Date().toISOString(),
			localData: {
				totalThreads: localThreads.length,
				totalMessages: localMessages.length,
				inboxThreads: localInboxThreads.length,
				inboxThreadIds: localInboxThreads.map((t: any) => t.threadId).slice(0, 10)
			},
			gmailData: {
				firstPageMessageIds: gmailMessageIds.length,
				inboxLabelStats: gmailInboxLabel ? {
					messagesTotal: gmailInboxLabel.messagesTotal,
					messagesUnread: gmailInboxLabel.messagesUnread,
					threadsTotal: gmailInboxLabel.threadsTotal,
					threadsUnread: gmailInboxLabel.threadsUnread
				} : null
			},
			trailingHolds: {
				total: Object.keys(currentHolds).length,
				active: activeHolds.length,
				activeThreadIds: activeHolds.map(([threadId]) => threadId)
			}
		};
		// Enrich diagnostics with additional context useful for debugging sync issues
		let lastHistoryId: string | null = null;
		try {
			const meta = (await db.get('settings', 'lastHistoryId')) as any || {};
			lastHistoryId = meta?.value || null;
		} catch (_) { lastHistoryId = null; }
		inboxDiagnostics = {
			...inboxDiagnostics,
			gmailData: {
				...(inboxDiagnostics.gmailData || {}),
				firstPageSampleIds: gmailMessageIds.slice(0, 10),
				inboxLabelStats: inboxDiagnostics.gmailData && inboxDiagnostics.gmailData.inboxLabelStats ? { ...inboxDiagnostics.gmailData.inboxLabelStats, _raw: gmailInboxLabel } : inboxDiagnostics.gmailData?.inboxLabelStats
			},
			storage: { lastHistoryId }
		};
		addLog('info', ['Inbox sync debug completed', inboxDiagnostics]);
	} catch (e) {
		addLog('error', ['debugInboxSync failed', e]);
		inboxDiagnostics = { error: String(e) };
	}
}

async function compareInboxCounts() {
	try {
		addLog('info', ['Comparing local vs Gmail inbox counts...']);
		
		const { getDB } = await import('$lib/db/indexeddb');
		const { getLabel } = await import('$lib/gmail/api');
		
		const db = await getDB();
		const localThreads = await db.getAll('threads');
		const localInboxThreads = localThreads.filter((t: any) => 
			Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
		);
		
		const gmailInboxLabel = await getLabel('INBOX');
		
		const comparison = {
			local: {
				inboxThreads: localInboxThreads.length,
				totalThreads: localThreads.length
			},
			gmail: {
				threadsTotal: gmailInboxLabel.threadsTotal,
				threadsUnread: gmailInboxLabel.threadsUnread,
				messagesTotal: gmailInboxLabel.messagesTotal,
				messagesUnread: gmailInboxLabel.messagesUnread
			},
			discrepancy: {
				threadCountDiff: localInboxThreads.length - (gmailInboxLabel.threadsTotal || 0)
			}
		};
		
		inboxDiagnostics = { ...inboxDiagnostics, comparison };
		addLog('info', ['Count comparison completed', comparison]);
	} catch (e) {
		addLog('error', ['compareInboxCounts failed', e]);
	}
}

// Combined runner for the consolidated inbox sync button
async function runCombinedInboxDiagnostics() {
	try {
 		addLog('info', ['Running combined inbox diagnostics...']);
 		// Run the most impactful diagnostics and actions sequentially
 		await diagnoseSyncFailure();
 		await comprehensiveSyncAnalysis();
 		await compareInboxCounts();
		// Do not auto-run forced resync here to avoid destructive actions without explicit consent
		showSnackbar({ message: 'Combined inbox diagnostics completed. Review results and run resync if needed.', closable: true });
	} catch (e) {
		addLog('error', ['runCombinedInboxDiagnostics failed', e]);
		showSnackbar({ message: 'Combined inbox diagnostics failed', closable: true });
	}
}

async function clearLocalInboxData() {
	try {
		addLog('info', ['Clearing local inbox data...']);
		
		const { getDB } = await import('$lib/db/indexeddb');
		const { trailingHolds } = await import('$lib/stores/holds');
		
		const db = await getDB();
		
		// Clear threads and messages
		await db.clear('threads');
		await db.clear('messages');
		
		// Clear trailing holds
		trailingHolds.set({});
		
		// Clear optimistic counters
		const { resetOptimisticCounters } = await import('$lib/stores/optimistic-counters');
		resetOptimisticCounters();
		
		addLog('info', ['Local inbox data cleared successfully']);
		alert('Local inbox data cleared. Refresh the page to reload from Gmail.');
	} catch (e) {
		addLog('error', ['clearLocalInboxData failed', e]);
		alert('Failed to clear local data: ' + String(e));
	}
}

async function testGmailPagination() {
	try {
		addLog('info', ['Testing Gmail API pagination...']);
		
		const { listInboxMessageIds } = await import('$lib/gmail/api');
		
		let pageCount = 0;
		let totalMessages = 0;
		let pageToken: string | undefined = undefined;
		const maxPages = 5; // Safety limit for testing
		const results: any[] = [];
		
		while (pageCount < maxPages) {
			const page = await listInboxMessageIds(10, pageToken); // Small pages for testing
			pageCount++;
			totalMessages += page.ids.length;
			
			results.push({
				page: pageCount,
				messageCount: page.ids.length,
				hasNextToken: !!page.nextPageToken,
				sampleIds: page.ids.slice(0, 3)
			});
			
			if (!page.nextPageToken) break;
			pageToken = page.nextPageToken;
		}
		
		const paginationTest = {
			pagesRequested: pageCount,
			totalMessages,
			stoppedEarly: pageCount >= maxPages && pageToken,
			results
		};
		
		inboxDiagnostics = { ...inboxDiagnostics, paginationTest };
		addLog('info', ['Gmail pagination test completed', paginationTest]);
	} catch (e) {
		addLog('error', ['testGmailPagination failed', e]);
	}
}

async function comprehensiveSyncAnalysis() {
	try {
		addLog('info', ['Starting comprehensive sync analysis...']);
		
		const { getDB } = await import('$lib/db/indexeddb');
		const { listThreadIdsByLabelId, getLabel } = await import('$lib/gmail/api');
		
		const db = await getDB();
		
		// Get all local inbox threads
		const localThreads = await db.getAll('threads');
		const localInboxThreads = localThreads.filter((t: any) => 
			Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
		);
		
		// Get Gmail inbox label info
		const gmailInboxLabel = await getLabel('INBOX');
		
		// Get all Gmail thread IDs using efficient thread listing
		const gmailThreadIds = new Set<string>();
		const allGmailPages: Array<{pageNum: number, idsCount: number, pageToken?: string}> = [];
		let pageToken: string | undefined = undefined;
		let pageCount = 0;
		const maxPages = 50; // Increased limit to get full picture
		
		while (pageCount < maxPages) {
			const page = await listThreadIdsByLabelId('INBOX', 100, pageToken);
			pageCount++;
			
			allGmailPages.push({
				pageNum: pageCount,
				idsCount: page.ids?.length || 0,
				pageToken: pageToken
			});
			
			if (!page.ids?.length) {
				if (!page.nextPageToken) break;
				// Empty page but more pages - continue
				pageToken = page.nextPageToken;
				continue;
			}
			
			page.ids.forEach(tid => gmailThreadIds.add(tid));
			
			if (!page.nextPageToken) break;
			pageToken = page.nextPageToken;
		}
		
		// Find threads that are in Gmail but not in local DB (missing threads)
		const localThreadIds = new Set(localInboxThreads.map((t: any) => t.threadId));
		const missingThreads = Array.from(gmailThreadIds).filter(tid => !localThreadIds.has(tid));
		
		// Find stale threads (in local DB but not in Gmail)
		const staleThreads = localInboxThreads.filter((t: any) => 
			!gmailThreadIds.has(t.threadId)
		);
		
		const analysis = {
			timestamp: new Date().toISOString(),
			gmailInfo: {
				totalThreadsInLabel: gmailInboxLabel.threadsTotal,
				totalMessagesInLabel: gmailInboxLabel.messagesTotal,
				unreadThreads: gmailInboxLabel.threadsUnread,
				unreadMessages: gmailInboxLabel.messagesUnread
			},
			paginationInfo: {
				totalPagesScanned: pageCount,
				pagesWithData: allGmailPages.filter(p => p.idsCount > 0).length,
				pagesEmpty: allGmailPages.filter(p => p.idsCount === 0).length,
				detailsByPage: allGmailPages
			},
			localData: {
				inboxThreadsCount: localInboxThreads.length,
				totalThreadsCount: localThreads.length,
				localInboxThreadIds: localInboxThreads.map((t: any) => t.threadId).slice(0, 20)
			},
			discrepancy: {
				threadsInGmail: gmailThreadIds.size,
				threadsInLocal: localInboxThreads.length,
				threadCountDiff: localInboxThreads.length - gmailThreadIds.size,
				missingFromLocal: missingThreads.length,
				missingFromLocalIds: missingThreads.slice(0, 20),
				staleInLocal: staleThreads.length,
				staleInLocalIds: staleThreads.map((t: any) => t.threadId).slice(0, 20)
			}
		};
		
		inboxDiagnostics = { ...inboxDiagnostics, comprehensiveAnalysis: analysis };
		addLog('info', ['Comprehensive sync analysis completed', analysis]);
		
		// Show summary in alert for immediate feedback
		const summary = `Sync Analysis Results:
Gmail Reports: ${analysis.gmailInfo.totalThreadsInLabel} threads in INBOX
Gmail API Found: ${analysis.discrepancy.threadsInGmail} threads via pagination
Local Database: ${analysis.discrepancy.threadsInLocal} threads
Missing from local: ${analysis.discrepancy.missingFromLocal} threads
Stale in local: ${analysis.discrepancy.staleInLocal} threads`;
		alert(summary);
		
	} catch (e) {
		addLog('error', ['comprehensiveSyncAnalysis failed', e]);
	}
}

async function forcedInboxResync() {
	try {
		addLog('info', ['Starting forced inbox resync...']);
		
		const { getDB } = await import('$lib/db/indexeddb');
		const { listThreadIdsByLabelId, getThreadSummary } = await import('$lib/gmail/api');
		
		const db = await getDB();
		
		// Get all Gmail thread IDs
		const gmailThreadIds = new Set<string>();
		let pageToken: string | undefined = undefined;
		let pageCount = 0;
		const maxPages = 50;
		
		addLog('info', ['Fetching all Gmail thread IDs...']);
		
		while (pageCount < maxPages) {
			const page = await listThreadIdsByLabelId('INBOX', 100, pageToken);
			pageCount++;
			
			if (!page.ids?.length) {
				if (!page.nextPageToken) break;
				pageToken = page.nextPageToken;
				continue;
			}
			
			page.ids.forEach(tid => gmailThreadIds.add(tid));
			addLog('info', [`Page ${pageCount}: Found ${page.ids.length} threads, total so far: ${gmailThreadIds.size}`]);
			
			if (!page.nextPageToken) break;
			pageToken = page.nextPageToken;
		}
		
		addLog('info', [`Total Gmail threads found: ${gmailThreadIds.size}`]);
		
		// Get local threads to identify missing ones
		const localThreads = await db.getAll('threads');
		const localInboxThreads = localThreads.filter((t: any) => 
			Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
		);
		const localThreadIds = new Set(localInboxThreads.map((t: any) => t.threadId));
		
		// Find missing threads
		const missingThreadIds = Array.from(gmailThreadIds).filter(tid => !localThreadIds.has(tid));
		addLog('info', [`Missing threads to fetch: ${missingThreadIds.length}`]);
		
		if (missingThreadIds.length === 0) {
			alert('No missing threads found. Sync appears to be current.');
			return;
		}
		
		// Batch fetch missing threads with concurrency limit
		const batchSize = 5;
		let fetchedCount = 0;
		let errorCount = 0;
		
		for (let i = 0; i < missingThreadIds.length; i += batchSize) {
			const batch = missingThreadIds.slice(i, i + batchSize);
			
			const results = await Promise.allSettled(
				batch.map(async (threadId) => {
					try {
						const threadSummary = await getThreadSummary(threadId);
						
						// Store thread and messages in database
						const txMsgs = db.transaction('messages', 'readwrite');
						const txThreads = db.transaction('threads', 'readwrite');
						
						for (const msg of threadSummary.messages) {
							await txMsgs.store.put(msg);
						}
						await txMsgs.done;
						
						await txThreads.store.put(threadSummary.thread);
						await txThreads.done;
						
						return { success: true, threadId };
					} catch (e) {
						return { success: false, threadId, error: String(e) };
					}
				})
			);
			
			const successes = results.filter((r): r is PromiseFulfilledResult<{success: true, threadId: string}> => 
				r.status === 'fulfilled' && r.value.success
			).length;
			
			const failures = results.length - successes;
			fetchedCount += successes;
			errorCount += failures;
			
			addLog('info', [`Batch ${Math.floor(i/batchSize) + 1}: Fetched ${successes}/${batch.length} threads (${fetchedCount}/${missingThreadIds.length} total, ${errorCount} errors)`]);
		}
		
		const resyncResult = {
			timestamp: new Date().toISOString(),
			totalGmailThreads: gmailThreadIds.size,
			missingThreadsFound: missingThreadIds.length,
			threadsFetched: fetchedCount,
			fetchErrors: errorCount,
			success: errorCount === 0
		};
		
		inboxDiagnostics = { ...inboxDiagnostics, resyncResult };
		addLog('info', ['Forced resync completed', resyncResult]);
		
		alert(`Forced Resync Complete:
Found ${missingThreadIds.length} missing threads
Successfully fetched: ${fetchedCount}
Errors: ${errorCount}

${errorCount === 0 ? 'All missing threads have been synced!' : 'Some threads failed to sync - check logs for details'}`);
		
	} catch (e) {
		addLog('error', ['forcedInboxResync failed', e]);
		alert(`Resync failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

async function identifyStaleThreads() {
	try {
		addLog('info', ['Identifying stale threads...']);
		
		const { getDB } = await import('$lib/db/indexeddb');
		const { listThreadIdsByLabelId } = await import('$lib/gmail/api');
		
		const db = await getDB();
		
		// Get all local inbox threads
		const localThreads = await db.getAll('threads');
		const localInboxThreads = localThreads.filter((t: any) => 
			Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
		);
		
		// Get all Gmail thread IDs using efficient thread listing
		const gmailThreadIds = new Set<string>();
		let pageToken: string | undefined = undefined;
		let pageCount = 0;
		const maxPages = 20; // Safety limit
		
		while (pageCount < maxPages) {
			const page = await listThreadIdsByLabelId('INBOX', 100, pageToken);
			if (!page.ids?.length) break;
			
			page.ids.forEach(tid => gmailThreadIds.add(tid));
			
			pageCount++;
			if (!page.nextPageToken) break;
			pageToken = page.nextPageToken;
		}
		
		// Find stale threads (in local DB but not in Gmail)
		const staleThreads = localInboxThreads.filter((t: any) => 
			!gmailThreadIds.has(t.threadId)
		);
		
		const staleAnalysis = {
			localInboxThreads: localInboxThreads.length,
			gmailThreadIds: gmailThreadIds.size,
			staleThreads: staleThreads.length,
			staleThreadDetails: staleThreads.map((t: any) => ({
				threadId: t.threadId,
				labels: t.labelIds,
				lastMsgSubject: t.lastMsgMeta?.subject,
				lastMsgFrom: t.lastMsgMeta?.from
			}))
		};
		
		inboxDiagnostics = { ...inboxDiagnostics, staleAnalysis };
		addLog('info', ['Stale thread analysis completed', staleAnalysis]);
	} catch (e) {
		addLog('error', ['identifyStaleThreads failed', e]);
	}
}

async function testPaginationHealth() {
	try {
		addLog('info', ['Testing pagination health...']);
		
		const { listThreadIdsByLabelId } = await import('$lib/gmail/api');
		
		// Test pagination behavior
		let pageToken: string | undefined = undefined;
		let pageCount = 0;
		let totalThreads = 0;
		let consecutiveEmptyPages = 0;
		const maxTestPages = 10; // Safety limit for testing
		const pageSizes = [10, 50, 100]; // Test different page sizes
		
		const paginationTest = {
			timestamp: new Date().toISOString(),
			results: [] as Array<{
				pageSize: number;
				totalPages: number;
				totalThreads: number;
				consecutiveEmptyPages: number;
				avgThreadsPerPage: number;
				successful: boolean;
				error?: string;
			}>
		};
		
		for (const pageSize of pageSizes) {
			try {
				pageToken = undefined;
				pageCount = 0;
				totalThreads = 0;
				consecutiveEmptyPages = 0;
				let maxConsecutiveEmpty = 0;
				
				while (pageCount < maxTestPages) {
					const page = await listThreadIdsByLabelId('INBOX', pageSize, pageToken);
					pageCount++;
					
					if (!page.ids?.length) {
						consecutiveEmptyPages++;
						maxConsecutiveEmpty = Math.max(maxConsecutiveEmpty, consecutiveEmptyPages);
						if (consecutiveEmptyPages >= 3 || !page.nextPageToken) break;
					} else {
						totalThreads += page.ids.length;
						consecutiveEmptyPages = 0;
					}
					
					if (!page.nextPageToken) break;
					pageToken = page.nextPageToken;
				}
				
				paginationTest.results.push({
					pageSize,
					totalPages: pageCount,
					totalThreads,
					consecutiveEmptyPages: maxConsecutiveEmpty,
					avgThreadsPerPage: totalThreads > 0 ? totalThreads / pageCount : 0,
					successful: true
				});
				
			} catch (e) {
				paginationTest.results.push({
					pageSize,
					totalPages: pageCount,
					totalThreads,
					consecutiveEmptyPages,
					avgThreadsPerPage: 0,
					successful: false,
					error: String(e)
				});
			}
		}
		
		inboxDiagnostics = { ...inboxDiagnostics, paginationTest };
		addLog('info', ['Pagination health test completed', paginationTest]);
	} catch (e) {
		addLog('error', ['testPaginationHealth failed', e]);
	}
}

async function testAppUpdate() {
	checkingUpdate = true;
	updateCheckResult = null;
	try {
		addLog('info', ['Testing app update check...']);
		const result = await checkForUpdateOnce();
		updateCheckResult = {
			timestamp: new Date().toISOString(),
			checkResult: result,
			success: true
		};
		addLog('info', ['App update check completed', result]);
		showSnackbar({
			message: `Update check result: ${result.status}`,
			timeout: 3000,
			closable: true
		});
	} catch (e) {
		updateCheckResult = {
			timestamp: new Date().toISOString(),
			error: e instanceof Error ? e.message : String(e),
			success: false
		};
		addLog('error', ['testAppUpdate failed', e]);
		showSnackbar({
			message: 'Update check failed',
			timeout: 3000,
			closable: true
		});
	} finally {
		checkingUpdate = false;
	}
}

async function testAiSummary() {
	testingAiSummary = true;
	aiSummaryTestResult = null;
	try {
		addLog('info', ['Testing AI summary sequence...']);
		showSnackbar({ message: 'Testing AI summary sequence...', timeout: 3000, closable: true });
		
		const startTime = Date.now();
		
		// Step 1: Generate detailed bullet-point summary (should always be detailed now)
		addLog('info', ['Step 1: Generating detailed summary from subject + body']);
		const detailedSummary = await aiSummarizeEmail(testSubject, testBodyText);
		const step1Time = Date.now() - startTime;
		
		// Step 2: Generate short subject from the detailed summary
		addLog('info', ['Step 2: Generating short subject from detailed summary']);
		const shortSubject = await aiSummarizeSubject(testSubject, undefined, undefined, detailedSummary);
		const totalTime = Date.now() - startTime;
		
		aiSummaryTestResult = {
			timestamp: new Date().toISOString(),
			success: true,
			inputData: {
				subject: testSubject,
				bodyText: testBodyText
			},
			step1Result: {
				detailedSummary,
				timeMs: step1Time,
				isDetailedBullets: detailedSummary.includes('•') || detailedSummary.includes('-'),
				wordCount: detailedSummary.split(/\s+/).length
			},
			step2Result: {
				shortSubject,
				timeMs: totalTime - step1Time,
				wordCount: shortSubject.split(/\s+/).length,
				isDifferentFromDetailed: shortSubject !== detailedSummary
			},
			analysis: {
				correctSequence: detailedSummary !== shortSubject,
				detailedSummaryType: detailedSummary.includes('•') || detailedSummary.includes('-') ? 'bullet-points' : 'paragraph',
				shortSubjectType: shortSubject.split(/\s+/).length <= 15 ? 'short-subject' : 'too-long',
				totalTimeMs: totalTime
			}
		};
		
		addLog('info', ['AI summary test completed', aiSummaryTestResult]);
		
		// Show results summary
		const isWorking = aiSummaryTestResult.analysis.correctSequence;
		showSnackbar({
			message: isWorking ? 'AI summary sequence working correctly!' : 'Issue detected: Both summaries are identical',
			timeout: 5000,
			closable: true,
			actions: {
				'View Details': () => {
					// Details already shown in the UI below
				}
			}
		});
		
	} catch (e) {
		aiSummaryTestResult = {
			timestamp: new Date().toISOString(),
			error: e instanceof Error ? e.message : String(e),
			success: false
		};
		addLog('error', ['AI summary test failed', e]);
		showSnackbar({
			message: 'AI summary test failed',
			timeout: 5000,
			closable: true
		});
	} finally {
		testingAiSummary = false;
	}
}

// Pull Forward diagnostics state
let testingPullForward = false;
let pullForwardResult: any = null;

async function testPullForward() {
	testingPullForward = true;
	pullForwardResult = null;
	try {
		addLog('info', ['Testing Pull Forward emails...']);
		showSnackbar({ message: 'Testing Pull Forward...', timeout: 3000, closable: true });
		
		// Clear previous diagnostics to capture only relevant ones
		getAndClearGmailDiagnostics();
		
		const result = await pullForwardSnoozedEmails(5); // Try to pull 5 emails
		
		const diagEntries = getAndClearGmailDiagnostics();
		
		pullForwardResult = {
			timestamp: new Date().toISOString(),
			result,
			diagnostics: diagEntries,
			success: result.success
		};
		
		addLog('info', ['Pull Forward test completed', pullForwardResult]);
		
		if (result.success) {
			showSnackbar({
				message: `Pull Forward success: ${result.pulledCount} emails pulled.`,
				timeout: 5000,
				closable: true
			});
		} else {
			showSnackbar({
				message: `Pull Forward failed: ${result.error}`,
				timeout: 8000,
				closable: true
			});
		}
		
	} catch (e) {
		pullForwardResult = {
			timestamp: new Date().toISOString(),
			error: e instanceof Error ? e.message : String(e),
			success: false,
			diagnostics: getAndClearGmailDiagnostics()
		};
		addLog('error', ['Pull Forward test failed', e]);
		showSnackbar({
			message: 'Pull Forward test failed',
			timeout: 5000,
			closable: true
		});
	} finally {
		testingPullForward = false;
	}
}

async function diagnoseSyncFailure() {
	try {
		addLog('info', ['Starting detailed sync failure analysis...']);
		
		const { getDB } = await import('$lib/db/indexeddb');
		const { listThreadIdsByLabelId, getThreadSummary, getLabel } = await import('$lib/gmail/api');
		
		const db = await getDB();
		
		// Step 1: Check current local state
		const allLocalThreads = await db.getAll('threads');
		const localInboxThreads = allLocalThreads.filter((t: any) => 
			Array.isArray(t.labelIds) && t.labelIds.includes('INBOX')
		);
		
		addLog('info', [`Local state: ${allLocalThreads.length} total threads, ${localInboxThreads.length} inbox threads`]);
		
		// Step 2: Check Gmail state
		const inboxLabel = await getLabel('INBOX');
		const gmailThreadCount = inboxLabel.threadsTotal || 0;
		addLog('info', [`Gmail INBOX label shows ${gmailThreadCount} threads`]);
		
		// Step 3: Test API access - fetch first page of thread IDs
		let firstPageThreadIds: string[] = [];
		try {
			const firstPage = await listThreadIdsByLabelId('INBOX', 20, undefined);
			firstPageThreadIds = firstPage.ids || [];
			addLog('info', [`Successfully fetched first page: ${firstPageThreadIds.length} thread IDs`]);
			if (firstPageThreadIds.length > 0) {
				addLog('info', [`Sample thread IDs: ${firstPageThreadIds.slice(0, 3).join(', ')}`]);
			}
		} catch (e) {
			addLog('error', ['Failed to fetch thread IDs from Gmail', e]);
			return;
		}
		
		// Step 4: Test thread fetching - try to fetch one thread
		if (firstPageThreadIds.length > 0) {
			try {
				const sampleThreadId = firstPageThreadIds[0];
				addLog('info', [`Testing thread fetch for ${sampleThreadId}...`]);
				const threadSummary = await getThreadSummary(sampleThreadId);
				addLog('info', [`Successfully fetched thread ${sampleThreadId}:`]);
				addLog('info', [`  - Labels: ${threadSummary.thread.labelIds.join(', ')}`]);
				addLog('info', [`  - Messages: ${threadSummary.messages.length}`]);
				addLog('info', [`  - Subject: ${threadSummary.messages[0]?.headers?.Subject || 'No subject'}`]);
				
				// Step 5: Check if this thread exists locally
				const localThread = await db.get('threads', sampleThreadId);
				if (localThread) {
					addLog('info', [`Thread ${sampleThreadId} exists locally with labels: ${(localThread as any).labelIds?.join(', ') || 'none'}`]);
				} else {
					addLog('warn', [`Thread ${sampleThreadId} missing from local database!`]);
				}
			} catch (e) {
				addLog('error', ['Failed to fetch thread summary', e]);
			}
		}
		
		// Step 6: Check pending operations
		const allOps = await db.getAll('ops');
		const inboxOps = allOps.filter((op: any) => 
			op.op.type === 'batchModify' && 
			(op.op.addLabelIds.includes('INBOX') || op.op.removeLabelIds.includes('INBOX'))
		);
		addLog('info', [`Pending operations: ${allOps.length} total, ${inboxOps.length} affecting INBOX`]);
		
		// Step 7: Diagnosis summary
		const diagnosis = {
			timestamp: new Date().toISOString(),
			localInboxThreads: localInboxThreads.length,
			gmailThreadCount,
			discrepancy: gmailThreadCount - localInboxThreads.length,
			apiWorking: firstPageThreadIds.length > 0,
			pendingInboxOps: inboxOps.length,
			sampleFetch: firstPageThreadIds.length > 0 ? 'tested' : 'skipped',
			issue: localInboxThreads.length === 0 && gmailThreadCount > 0 ? 'zero_local_threads' : 'other'
		};
		
		addLog('info', ['Sync failure diagnosis complete', diagnosis]);
		
		// Provide specific recommendations
		if (diagnosis.issue === 'zero_local_threads') {
			addLog('info', ['🎯 DIAGNOSIS: Zero local inbox threads despite Gmail having threads']);
			addLog('info', ['RECOMMENDED ACTION: Use "Force resync missing emails" button below']);
			showSnackbar({
				message: `Found the issue: 0 local vs ${gmailThreadCount} Gmail threads. Use Force Resync button below.`,
				timeout: 8000,
				closable: true,
				actions: {
					'Force Resync': forcedInboxResync
				}
			});
		}
		
	} catch (e) {
		addLog('error', ['Sync failure diagnosis failed', e]);
		showSnackbar({
			message: 'Diagnosis failed - check logs for details',
			timeout: 5000,
			closable: true
		});
	}
}

loadApiBaseOverride();

// Android overflow button diagnostics
async function runAndroidDiagnostics() {
	androidDiagnostics.running = true;
	androidDiagnostics.deviceInfo = null;
	androidDiagnostics.navigationTests = [
		{ name: 'Settings Navigation (location.href)', status: 'pending' },
		{ name: 'Settings Navigation (pushState)', status: 'pending' },
		{ name: 'Check App Update Navigation', status: 'pending' },
		{ name: 'Overflow Menu Accessibility', status: 'pending' }
	];
	androidDiagnostics.touchEventTests = [
		{ name: 'Touch Event Detection', status: 'pending' },
		{ name: 'Click Event Propagation', status: 'pending' },
		{ name: 'MenuItem Button Response', status: 'pending' },
		{ name: 'Details/Summary Element Behavior', status: 'pending' }
	];
	androidDiagnostics.snoozeMenuTests = [
		{ name: 'Snooze Menu Element Detection', status: 'pending' },
		{ name: 'Snooze Menu Toggle Functionality', status: 'pending' },
		{ name: 'Trailing Action Visibility', status: 'pending' },
		{ name: 'Thread Row Touch Events', status: 'pending' }
	];
	
	addLog('info', ['Starting Android overflow button diagnostics...']);
	
	try {
		// Collect device information
		androidDiagnostics.deviceInfo = {
			userAgent: navigator.userAgent,
			isAndroid: /Android/i.test(navigator.userAgent),
			isPWA: window.matchMedia && window.matchMedia('(display-mode: standalone)').matches,
			touchSupport: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
			screen: {
				width: screen.width,
				height: screen.height,
				availWidth: screen.availWidth,
				availHeight: screen.availHeight
			},
			viewport: {
				width: window.innerWidth,
				height: window.innerHeight
			},
			pixelRatio: window.devicePixelRatio || 1
		};
		addLog('info', ['Device info collected', androidDiagnostics.deviceInfo]);
		
		// Test 1: Settings navigation with location.href
		androidDiagnostics.navigationTests[0].status = 'pending';
		addLog('info', ['Testing Settings navigation with location.href...']);
		try {
			// Test if we can read current location
			const currentLocation = window.location.href;
			addLog('info', ['Current location:', currentLocation]);
			androidDiagnostics.navigationTests[0] = {
				name: 'Settings Navigation (location.href)',
				status: 'success',
				message: 'Can read location.href',
				data: { currentLocation }
			};
		} catch (e) {
			androidDiagnostics.navigationTests[0] = {
				name: 'Settings Navigation (location.href)',
				status: 'error',
				message: `Failed to read location.href: ${e}`,
				data: { error: String(e) }
			};
		}
		
		// Test 2: Alternative navigation with pushState
		androidDiagnostics.navigationTests[1].status = 'pending';
		addLog('info', ['Testing pushState navigation capability...']);
		try {
			// Test if history.pushState is available and working
			if (typeof window.history.pushState === 'function') {
				androidDiagnostics.navigationTests[1] = {
					name: 'Settings Navigation (pushState)',
					status: 'success',
					message: 'history.pushState available',
					data: { historyLength: history.length }
				};
			} else {
				androidDiagnostics.navigationTests[1] = {
					name: 'Settings Navigation (pushState)',
					status: 'error',
					message: 'history.pushState not available'
				};
			}
		} catch (e) {
			androidDiagnostics.navigationTests[1] = {
				name: 'Settings Navigation (pushState)',
				status: 'error',
				message: `pushState test failed: ${e}`
			};
		}
		
		// Test 3: Check for app update functionality
		androidDiagnostics.navigationTests[2].status = 'pending';
		addLog('info', ['Testing Check for App Update functionality...']);
		try {
			// Test URL parameter addition
			const testUrl = new URL(window.location.href);
			testUrl.searchParams.set('refresh', '1');
			const testUrlString = testUrl.toString();
			
			androidDiagnostics.navigationTests[2] = {
				name: 'Check App Update Navigation',
				status: 'success',
				message: 'URL manipulation works',
				data: { testUrl: testUrlString }
			};
		} catch (e) {
			androidDiagnostics.navigationTests[2] = {
				name: 'Check App Update Navigation',
				status: 'error',
				message: `URL manipulation failed: ${e}`
			};
		}
		
		// Test 4: Overflow menu accessibility
		androidDiagnostics.navigationTests[3].status = 'pending';
		addLog('info', ['Testing overflow menu accessibility...']);
		try {
			// Look for overflow menu elements
			const overflowElements = document.querySelectorAll('.overflow, details.overflow');
			const summaryElements = document.querySelectorAll('summary.summary-btn');
			
			androidDiagnostics.navigationTests[3] = {
				name: 'Overflow Menu Accessibility',
				status: overflowElements.length > 0 ? 'success' : 'error',
				message: `Found ${overflowElements.length} overflow menus, ${summaryElements.length} summary buttons`,
				data: { 
					overflowCount: overflowElements.length,
					summaryCount: summaryElements.length,
					hasOverflowElements: overflowElements.length > 0
				}
			};
		} catch (e) {
			androidDiagnostics.navigationTests[3] = {
				name: 'Overflow Menu Accessibility',
				status: 'error',
				message: `Menu accessibility test failed: ${e}`
			};
		}
		
		// Touch event tests
		// Test 1: Touch event detection
		androidDiagnostics.touchEventTests[0].status = 'pending';
		addLog('info', ['Testing touch event detection...']);
		try {
			const touchEvents = {
				touchstart: 'ontouchstart' in window,
				touchend: 'ontouchend' in window,
				touchmove: 'ontouchmove' in window,
				pointerEvents: 'PointerEvent' in window,
				maxTouchPoints: navigator.maxTouchPoints
			};
			
			androidDiagnostics.touchEventTests[0] = {
				name: 'Touch Event Detection',
				status: touchEvents.touchstart ? 'success' : 'error',
				message: `Touch support: ${touchEvents.touchstart ? 'Available' : 'Not available'}`,
				data: touchEvents
			};
		} catch (e) {
			androidDiagnostics.touchEventTests[0] = {
				name: 'Touch Event Detection',
				status: 'error',
				message: `Touch detection failed: ${e}`
			};
		}
		
		// Test 2: Click event propagation test
		androidDiagnostics.touchEventTests[1].status = 'pending';
		addLog('info', ['Testing click event propagation...']);
		try {
			// Create a test element to verify event propagation
			const testDiv = document.createElement('div');
			testDiv.style.cssText = 'position:absolute;top:-1000px;left:-1000px;width:10px;height:10px;';
			document.body.appendChild(testDiv);
			
			let clickReceived = false;
			const clickHandler = () => { clickReceived = true; };
			testDiv.addEventListener('click', clickHandler);
			
			// Simulate a click
			const clickEvent = new MouseEvent('click', {
				bubbles: true,
				cancelable: true,
				view: window
			});
			testDiv.dispatchEvent(clickEvent);
			
			// Clean up
			testDiv.removeEventListener('click', clickHandler);
			document.body.removeChild(testDiv);
			
			androidDiagnostics.touchEventTests[1] = {
				name: 'Click Event Propagation',
				status: clickReceived ? 'success' : 'error',
				message: `Click events ${clickReceived ? 'working' : 'not working'} properly`,
				data: { clickReceived }
			};
		} catch (e) {
			androidDiagnostics.touchEventTests[1] = {
				name: 'Click Event Propagation',
				status: 'error',
				message: `Click propagation test failed: ${e}`
			};
		}
		
		// Test 3: MenuItem button response test
		androidDiagnostics.touchEventTests[2].status = 'pending';
		addLog('info', ['Testing MenuItem button response...']);
		try {
			// Look for menu item buttons in the overflow menu
			const menuItems = document.querySelectorAll('.overflow .item, .overflow button.item');
			
			androidDiagnostics.touchEventTests[2] = {
				name: 'MenuItem Button Response',
				status: menuItems.length > 0 ? 'success' : 'error',
				message: `Found ${menuItems.length} menu item buttons`,
				data: { 
					menuItemCount: menuItems.length,
					menuItemsFound: menuItems.length > 0
				}
			};
		} catch (e) {
			androidDiagnostics.touchEventTests[2] = {
				name: 'MenuItem Button Response',
				status: 'error',
				message: `MenuItem test failed: ${e}`
			};
		}
		
		// Test 4: Details/Summary element behavior
		androidDiagnostics.touchEventTests[3].status = 'pending';
		addLog('info', ['Testing Details/Summary element behavior...']);
		try {
			// Test if details/summary elements work properly
			const detailsSupport = 'open' in document.createElement('details');
			
			androidDiagnostics.touchEventTests[3] = {
				name: 'Details/Summary Element Behavior',
				status: detailsSupport ? 'success' : 'error',
				message: `Details/Summary elements ${detailsSupport ? 'supported' : 'not supported'}`,
				data: { detailsSupport }
			};
		} catch (e) {
			androidDiagnostics.touchEventTests[3] = {
				name: 'Details/Summary Element Behavior',
				status: 'error',
				message: `Details/Summary test failed: ${e}`
			};
		}
		
		// Snooze menu tests
		// Test 1: Snooze menu element detection
		androidDiagnostics.snoozeMenuTests[0].status = 'pending';
		addLog('info', ['Testing snooze menu element detection...']);
		try {
			const snoozeMenus = document.querySelectorAll('.menu-toggle, .snooze-menu-toggle, details[class*="snooze"]');
			const snoozeButtons = document.querySelectorAll('.snooze-wrap, .snooze-buttons');
			const trailingActions = document.querySelectorAll('.actions, .trailing, [class*="trailing"]');
			
			androidDiagnostics.snoozeMenuTests[0] = {
				name: 'Snooze Menu Element Detection',
				status: snoozeMenus.length > 0 || snoozeButtons.length > 0 ? 'success' : 'error',
				message: `Found ${snoozeMenus.length} snooze menus, ${snoozeButtons.length} snooze button groups, ${trailingActions.length} trailing action areas`,
				data: {
					snoozeMenuCount: snoozeMenus.length,
					snoozeButtonCount: snoozeButtons.length,
					trailingActionCount: trailingActions.length
				}
			};
		} catch (e) {
			androidDiagnostics.snoozeMenuTests[0] = {
				name: 'Snooze Menu Element Detection',
				status: 'error',
				message: `Element detection failed: ${e}`
			};
		}
		
		// Test 2: Snooze menu toggle functionality
		androidDiagnostics.snoozeMenuTests[1].status = 'pending';
		addLog('info', ['Testing snooze menu toggle functionality...']);
		try {
			// Check if details elements support the open property
			const testDetails = document.createElement('details');
			const hasOpenProperty = 'open' in testDetails;
			
			// Check for summary elements that should handle clicks
			const summaryElements = document.querySelectorAll('summary[aria-label*="Snooze"], summary[aria-haspopup="menu"]');
			
			androidDiagnostics.snoozeMenuTests[1] = {
				name: 'Snooze Menu Toggle Functionality',
				status: hasOpenProperty ? 'success' : 'error',
				message: `Details/open property ${hasOpenProperty ? 'supported' : 'not supported'}, found ${summaryElements.length} snooze summary elements`,
				data: {
					hasOpenProperty,
					summaryElementCount: summaryElements.length
				}
			};
		} catch (e) {
			androidDiagnostics.snoozeMenuTests[1] = {
				name: 'Snooze Menu Toggle Functionality',
				status: 'error',
				message: `Toggle test failed: ${e}`
			};
		}
		
		// Test 3: Trailing action visibility
		androidDiagnostics.snoozeMenuTests[2].status = 'pending';
		addLog('info', ['Testing trailing action visibility...']);
		try {
			// Check if thread rows are visible
			const threadRows = document.querySelectorAll('.row-container, [class*="thread"], [class*="row"]');
			const visibleRows = Array.from(threadRows).filter(row => {
				const rect = (row as HTMLElement).getBoundingClientRect();
				return rect.width > 0 && rect.height > 0;
			});
			
			androidDiagnostics.snoozeMenuTests[2] = {
				name: 'Trailing Action Visibility',
				status: visibleRows.length > 0 ? 'success' : 'error',
				message: `Found ${threadRows.length} thread rows, ${visibleRows.length} visible`,
				data: {
					totalRows: threadRows.length,
					visibleRows: visibleRows.length
				}
			};
		} catch (e) {
			androidDiagnostics.snoozeMenuTests[2] = {
				name: 'Trailing Action Visibility',
				status: 'error',
				message: `Visibility test failed: ${e}`
			};
		}
		
		// Test 4: Thread row touch events
		androidDiagnostics.snoozeMenuTests[3].status = 'pending';
		addLog('info', ['Testing thread row touch events...']);
		try {
			// Check for pointer event handling on thread rows
			const pointerSupport = 'PointerEvent' in window;
			const touchSupport = 'ontouchstart' in window;
			
			// Look for elements with pointer/touch event handlers
			const elementsWithPointerHandlers = document.querySelectorAll('[onpointerdown], [ontouchstart]');
			
			androidDiagnostics.snoozeMenuTests[3] = {
				name: 'Thread Row Touch Events',
				status: pointerSupport && touchSupport ? 'success' : 'error',
				message: `Pointer events: ${pointerSupport ? 'supported' : 'not supported'}, Touch: ${touchSupport ? 'supported' : 'not supported'}, ${elementsWithPointerHandlers.length} elements with handlers`,
				data: {
					pointerSupport,
					touchSupport,
					handlerElementCount: elementsWithPointerHandlers.length
				}
			};
		} catch (e) {
			androidDiagnostics.snoozeMenuTests[3] = {
				name: 'Thread Row Touch Events',
				status: 'error',
				message: `Touch event test failed: ${e}`
			};
		}
		
		addLog('info', ['Android diagnostics completed successfully']);
		showSnackbar({ message: 'Android diagnostics completed', closable: true });
		
	} catch (e) {
		addLog('error', ['Android diagnostics failed', e]);
		showSnackbar({ message: 'Android diagnostics failed: ' + String(e), closable: true });
	} finally {
		androidDiagnostics.running = false;
	}
}

// Alternative navigation functions for Android
async function navigateToSettingsAlternative() {
	addLog('info', ['Testing alternative Settings navigation...']);
	try {
		// Try using window.open first
		window.open('/settings', '_self');
		addLog('info', ['Used window.open for Settings navigation']);
	} catch (e) {
		addLog('error', ['window.open failed, trying pushState', e]);
		try {
			// Fallback to pushState + manual navigation
			history.pushState(null, '', '/settings');
			window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
			addLog('info', ['Used pushState for Settings navigation']);
		} catch (e2) {
			addLog('error', ['pushState also failed', e2]);
			showSnackbar({ message: 'Navigation failed. Try refreshing the app.', closable: true });
		}
	}
}

async function checkForUpdateAlternative() {
	addLog('info', ['Testing alternative Check for App Update...']);
	try {
		// Import and run the update check directly
		const updateResult = await checkForUpdateOnce();
		addLog('info', ['Update check completed:', updateResult]);
		showSnackbar({ message: updateResult ? 'Update check completed' : 'No updates available', closable: true });
	} catch (e) {
		addLog('error', ['Direct update check failed', e]);
		showSnackbar({ message: 'Update check failed: ' + String(e), closable: true });
	}
}

// Test snooze menu functionality specifically
async function testSnoozeMenuAndroid() {
	addLog('info', ['Testing snooze menu Android functionality...']);
	try {
		// Find snooze menu elements
		const snoozeMenus = document.querySelectorAll('.menu-toggle, details[class*="snooze"]');
		const summaryElements = document.querySelectorAll('summary[aria-label*="Snooze"]');
		
		addLog('info', [`Found ${snoozeMenus.length} snooze menu elements, ${summaryElements.length} summary elements`]);
		
		if (snoozeMenus.length === 0) {
			showSnackbar({ message: 'No snooze menus found. Navigate to inbox first.', closable: true });
			return;
		}
		
		// Try to programmatically open the first snooze menu
		const firstMenu = snoozeMenus[0] as HTMLDetailsElement;
		const wasOpen = firstMenu.open;
		
		addLog('info', [`Testing snooze menu toggle. Current state: ${wasOpen ? 'open' : 'closed'}`]);
		
		// Test the toggle
		firstMenu.open = !wasOpen;
		
		// Wait a bit and check if it worked
		setTimeout(() => {
			const newState = firstMenu.open;
			const worked = newState !== wasOpen;
			addLog('info', [`Toggle test result: ${worked ? 'SUCCESS' : 'FAILED'}. New state: ${newState ? 'open' : 'closed'}`]);
			
			// Reset to original state
			setTimeout(() => {
				firstMenu.open = wasOpen;
			}, 1000);
			
			showSnackbar({ 
				message: worked ? 'Snooze menu toggle test passed' : 'Snooze menu toggle test failed', 
				closable: true 
			});
		}, 100);
		
	} catch (e) {
		addLog('error', ['Snooze menu test failed', e]);
		showSnackbar({ message: 'Snooze menu test failed: ' + String(e), closable: true });
	}
}

// Test the original overflow menu toggle specifically
async function testOriginalOverflowMenu() {
	addLog('info', ['Testing original overflow menu functionality...']);
	try {
		// Find the overflow menu
		const overflowDetails = document.querySelector('.overflow') as HTMLDetailsElement;
		const overflowSummary = document.querySelector('.overflow summary') as HTMLElement;
		
		if (!overflowDetails) {
			showSnackbar({ message: 'No overflow menu found on this page.', closable: true });
			return;
		}
		
		addLog('info', [`Found overflow menu. Current state: ${overflowDetails.open ? 'open' : 'closed'}`]);
		
		// Test programmatic toggle
		const wasOpen = overflowDetails.open;
		overflowDetails.open = !wasOpen;
		
		setTimeout(() => {
			const newState = overflowDetails.open;
			const programmaticWorked = newState !== wasOpen;
			addLog('info', [`Programmatic toggle: ${programmaticWorked ? 'SUCCESS' : 'FAILED'}. New state: ${newState ? 'open' : 'closed'}`]);
			
			// Reset state
			overflowDetails.open = wasOpen;
			
			// Now test click simulation
			setTimeout(() => {
				if (overflowSummary) {
					addLog('info', ['Testing simulated click on summary element...']);
					const clickEvent = new MouseEvent('click', {
						bubbles: true,
						cancelable: true,
						view: window
					});
					
					const beforeClick = overflowDetails.open;
					overflowSummary.dispatchEvent(clickEvent);
					
					setTimeout(() => {
						const afterClick = overflowDetails.open;
						const clickWorked = afterClick !== beforeClick;
						addLog('info', [`Click simulation: ${clickWorked ? 'SUCCESS' : 'FAILED'}. Before: ${beforeClick}, After: ${afterClick}`]);
						
						// Reset to original state
						overflowDetails.open = wasOpen;
						
						showSnackbar({ 
							message: `Overflow menu test: Programmatic ${programmaticWorked ? 'OK' : 'FAILED'}, Click ${clickWorked ? 'OK' : 'FAILED'}`, 
							closable: true 
						});
					}, 100);
				}
			}, 100);
		}, 100);
		
	} catch (e) {
		addLog('error', ['Overflow menu test failed', e]);
		showSnackbar({ message: 'Overflow menu test failed: ' + String(e), closable: true });
	}
}

</script>

<style>
pre.diag { 
  max-height: 40vh; 
  overflow: auto; 
  background: rgb(var(--m3-scheme-surface-variant)); 
  color: rgb(var(--m3-scheme-on-surface-variant)); 
  padding: 1rem; 
  border-radius: var(--m3-util-rounding-medium);
  font-family: 'Roboto Mono', monospace;
  font-size: 0.875rem;
  line-height: 1.25rem;
}
.controls { 
  display: flex; 
  gap: 0.5rem; 
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}
.section-header h2, .section-header h3 {
  margin: 0;
  color: rgb(var(--m3-scheme-on-surface));
}
.section-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
:global(.copy-button) {
  flex-shrink: 0;
}
.step { 
  margin-bottom: 1rem;
  color: rgb(var(--m3-scheme-on-surface-variant));
}
.pastebox { 
  width: 100%; 
  min-height: 8rem; 
  font-family: 'Roboto Mono', monospace; 
  background: rgb(var(--m3-scheme-surface-container)); 
  color: rgb(var(--m3-scheme-on-surface)); 
  border: 1px solid rgb(var(--m3-scheme-outline));
  border-radius: var(--m3-util-rounding-medium);
  padding: 1rem;
  resize: vertical;
}
.summary { 
  background: rgb(var(--m3-scheme-surface-variant)); 
  color: rgb(var(--m3-scheme-on-surface-variant)); 
  padding: 1rem; 
  border-radius: var(--m3-util-rounding-medium); 
  margin-top: 1rem; 
}
.main-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2rem;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.main-header h1 {
  margin: 0;
  color: rgb(var(--m3-scheme-on-surface));
}
.copy-all-container {
  display: flex;
  gap: 0.5rem;
}

/* Add spacing between cards */
:global(.m3-container + .m3-container) {
  margin-top: 1.5rem;
}

/* Full diagnostics styles */
.diagnostics-summary {
  background: rgb(var(--m3-scheme-surface-container-high));
  border-radius: var(--m3-util-rounding-medium);
  padding: 1rem;
  margin-bottom: 1rem;
}

.summary-stats {
  display: flex;
  gap: 1.5rem;
  flex-wrap: wrap;
}

.stat {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 500;
}

.stat.success {
  color: rgb(var(--m3-scheme-tertiary));
}

.stat.warning {
  color: rgb(var(--m3-scheme-error));
}

.stat.error {
  color: rgb(var(--m3-scheme-error));
}

.stat :global(svg) {
  width: 1.25rem;
  height: 1.25rem;
}

.diagnostics-results {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.diagnostic-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-radius: var(--m3-util-rounding-medium);
  background: rgb(var(--m3-scheme-surface-container));
  border: 1px solid rgb(var(--m3-scheme-outline-variant));
}

.diagnostic-item.success {
  border-color: rgb(var(--m3-scheme-tertiary));
  background: rgb(var(--m3-scheme-tertiary-container) / 0.1);
}

.diagnostic-item.warning {
  border-color: rgb(var(--m3-scheme-error));
  background: rgb(var(--m3-scheme-error-container) / 0.1);
}

.diagnostic-item.error {
  border-color: rgb(var(--m3-scheme-error));
  background: rgb(var(--m3-scheme-error-container) / 0.2);
}

.diagnostic-item.running {
  border-color: rgb(var(--m3-scheme-primary));
  background: rgb(var(--m3-scheme-primary-container) / 0.1);
}

.diagnostic-icon {
  flex-shrink: 0;
  width: 1.5rem;
  height: 1.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.diagnostic-icon :global(svg) {
  width: 1.5rem;
  height: 1.5rem;
}

.diagnostic-item.success .diagnostic-icon :global(svg) {
  color: rgb(var(--m3-scheme-tertiary));
}

.diagnostic-item.warning .diagnostic-icon :global(svg) {
  color: rgb(var(--m3-scheme-error));
}

.diagnostic-item.error .diagnostic-icon :global(svg) {
  color: rgb(var(--m3-scheme-error));
}

.diagnostic-content {
  flex: 1;
  min-width: 0;
}

.diagnostic-name {
  font-weight: 500;
  color: rgb(var(--m3-scheme-on-surface));
  line-height: 1.25;
}

.diagnostic-message {
  font-size: 0.875rem;
  color: rgb(var(--m3-scheme-on-surface-variant));
  line-height: 1.25;
  margin-top: 0.25rem;
}

.spinner {
  width: 1.5rem;
  height: 1.5rem;
  border: 2px solid rgb(var(--m3-scheme-primary-container));
  border-top: 2px solid rgb(var(--m3-scheme-primary));
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.pending-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: rgb(var(--m3-scheme-outline));
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
</style>

	<div>
	<div class="main-header">
		<div class="header-left">
			<Button 
				variant="text" 
				iconType="left"
				onclick={async () => {
					try {
						// Android-friendly navigation back to inbox
						const isAndroid = /Android/i.test(navigator.userAgent);
						const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
						
						if (isAndroid || isPWA) {
							// Try multiple navigation methods for Android
							try {
								window.open('/', '_self');
								return;
							} catch (e) {
								console.log('[Diagnostics] window.open failed for inbox:', e);
								try {
									history.pushState(null, '', '/');
									window.location.reload();
									return;
								} catch (e2) {
									console.log('[Diagnostics] pushState failed for inbox:', e2);
								}
							}
						}
						
						// Default navigation
						location.href = '/';
					} catch (e) {
						console.error('[Diagnostics] All inbox navigation methods failed:', e);
						showSnackbar({ message: 'Navigation failed. Try typing / in your address bar.', closable: true });
					}
				}}
				aria-label="Back to inbox"
			>
				<Icon icon={iconBack} />
				Back to Inbox
			</Button>
			<h1>Diagnostics</h1>
		</div>
		<div class="copy-all-container">
			<Button variant="tonal" iconType="left" onclick={copyAllSections}>
				<Icon icon={iconSelectAll} />
				Copy All Sections
			</Button>
		</div>
	</div>
	
	<Card variant="filled">
		<div class="section-header">
			<div class="section-title">
				<h2>Full System Diagnostics</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Full System Diagnostics', fullDiagnostics)}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">Run comprehensive diagnostics to check all system components and get a summary with checkmarks and issues.</p>
		
		<div class="controls">
			<Button variant="filled" iconType="left" onclick={runFullDiagnostics} disabled={fullDiagnostics.running}>
				<Icon icon={iconPlayArrow} />
				{fullDiagnostics.running ? 'Running Diagnostics...' : 'Run Full Diagnostics'}
			</Button>
		</div>
		
		{#if fullDiagnostics.results.length > 0}
			<div style="margin-top: 1.5rem;">
				{#if fullDiagnostics.summary}
					<div class="diagnostics-summary">
						<div class="summary-stats">
							<div class="stat success">
								<Icon icon={iconCheck} />
								<span>{fullDiagnostics.summary.success} Passed</span>
							</div>
							<div class="stat warning">
								<Icon icon={iconWarning} />
								<span>{fullDiagnostics.summary.warning} Warnings</span>
							</div>
							<div class="stat error">
								<Icon icon={iconError} />
								<span>{fullDiagnostics.summary.error} Errors</span>
							</div>
						</div>
					</div>
				{/if}
				
				<!-- Show actionable warning when google-login is not responding -->
				{#if fullDiagnostics.results.find(r => r.name === 'Environment Check')?.data?.['/api/google-login']?.status === 0}
					<div style="margin-top: 1rem; padding: 1rem; background: rgb(var(--m3-scheme-error-container)); color: rgb(var(--m3-scheme-on-error-container)); border-radius: 12px;">
						<h4 style="margin: 0 0 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
							<Icon icon={iconError} />
							Critical: Login Endpoint Not Responding
						</h4>
						<p style="margin: 0 0 0.5rem;"><strong>Issue:</strong> /api/google-login returns status 0 (not deployed or runtime error)</p>
						<p style="margin: 0 0 0.5rem;"><strong>This prevents all Google OAuth logins from working.</strong></p>
						<details style="margin-top: 0.5rem;">
							<summary style="cursor: pointer; font-weight: 500; margin-bottom: 0.5rem;">Show troubleshooting steps</summary>
							<ol style="margin: 0.5rem 0; padding-left: 1.5rem;">
								<li>Check Azure Portal: Go to your Function App and verify it's running</li>
								<li>Check environment variables in Azure:
									<ul style="margin: 0.25rem 0;">
										<li><code>GOOGLE_CLIENT_ID</code></li>
										<li><code>GOOGLE_CLIENT_SECRET</code></li>
										<li><code>APP_BASE_URL</code> (should be https://polite-coast-0d53a9710.1.azurestaticapps.net)</li>
									</ul>
								</li>
								<li>Check deployment logs in Azure Portal for errors</li>
								<li>Try redeploying the Azure Functions from your repository</li>
								<li>Verify Google OAuth app is still active in Google Cloud Console</li>
							</ol>
						</details>
					</div>
				{/if}
				
				<div class="diagnostics-results">
					{#each fullDiagnostics.results as result}
						<div class="diagnostic-item {result.status}">
							<div class="diagnostic-icon">
								{#if result.status === 'success'}
									<Icon icon={iconCheck} />
								{:else if result.status === 'warning'}
									<Icon icon={iconWarning} />
								{:else if result.status === 'error'}
									<Icon icon={iconError} />
								{:else if result.status === 'running'}
									<div class="spinner"></div>
								{:else}
									<div class="pending-dot"></div>
								{/if}
							</div>
							<div class="diagnostic-content">
								<div class="diagnostic-name">{result.name}</div>
								{#if result.message}
									<div class="diagnostic-message">{result.message}</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h2>Inbox Sync Diagnostics</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Inbox Sync Diagnostics', inboxDiagnostics)}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">Debug inbox sync issues - excessive pages, wrong email counts, stale data.</p>
		<div class="controls">
			<!-- Combined comprehensive inbox sync button -->
			<Button variant="filled" onclick={runCombinedInboxDiagnostics} title="Run combined inbox diagnostics and actions">
				<Icon icon={iconDiagnostics} />
				Run Inbox Sync Diagnostics & Actions
			</Button>
			<Button variant="outlined" color="error" onclick={clearLocalInboxData}>Clear local inbox data</Button>
			<Button variant="tonal" iconType="left" onclick={copyComprehensiveAnalysis} title="Copy the comprehensive sync analysis to clipboard"> 
				<Icon icon={iconCopy} />
				Copy Comprehensive Analysis
			</Button>
			<Button variant="text" onclick={() => copySection('Inbox Sync Diagnostics', inboxDiagnostics)}>Copy Section</Button>
		</div>
		{#if inboxDiagnostics}
			<div class="summary">
				<strong>Inbox Sync Diagnostics</strong>
				<pre style="white-space:pre-wrap">{JSON.stringify(inboxDiagnostics, null, 2)}</pre>
			</div>
		{/if}
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h2>College Recruiting Moderation</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('College Recruiting Moderation', recruitingDiagnostics)}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">View statistics and results from AI-powered college recruiting email detection and auto-labeling.</p>
		<div class="controls">
			<Button variant="filled" onclick={runRecruitingDiagnostics} disabled={recruitingDiagnostics.running}>
				<Icon icon={iconDiagnostics} />
				{recruitingDiagnostics.running ? 'Loading...' : 'Load Moderation Stats'}
			</Button>
			<Button variant="outlined" color="error" onclick={clearRecruitingModeration}>Clear All Moderation Data</Button>
		</div>
		{#if recruitingDiagnostics.stats}
			<div class="summary" style="margin-top: 1rem;">
				<strong>Moderation Statistics</strong>
				<div style="margin-top: 0.5rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem;">
					<div style="background: rgb(var(--m3-scheme-surface-variant)); padding: 1rem; border-radius: 12px;">
						<div style="font-size: 0.875rem; color: rgb(var(--m3-scheme-on-surface-variant));">Total Checked</div>
						<div style="font-size: 1.5rem; font-weight: 500; color: rgb(var(--m3-scheme-on-surface));">{recruitingDiagnostics.stats.total}</div>
					</div>
					<div style="background: rgb(var(--m3-scheme-error-container)); padding: 1rem; border-radius: 12px;">
						<div style="font-size: 0.875rem; color: rgb(var(--m3-scheme-on-error-container));">Matches</div>
						<div style="font-size: 1.5rem; font-weight: 500; color: rgb(var(--m3-scheme-on-error-container));">{recruitingDiagnostics.stats.match}</div>
					</div>
					<div style="background: rgb(var(--m3-scheme-tertiary-container)); padding: 1rem; border-radius: 12px;">
						<div style="font-size: 0.875rem; color: rgb(var(--m3-scheme-on-tertiary-container));">Labeled</div>
						<div style="font-size: 1.5rem; font-weight: 500; color: rgb(var(--m3-scheme-on-tertiary-container));">{recruitingDiagnostics.stats.labeled}</div>
					</div>
					<div style="background: rgb(var(--m3-scheme-surface-variant)); padding: 1rem; border-radius: 12px;">
						<div style="font-size: 0.875rem; color: rgb(var(--m3-scheme-on-surface-variant));">Not Match</div>
						<div style="font-size: 1.5rem; font-weight: 500; color: rgb(var(--m3-scheme-on-surface));">{recruitingDiagnostics.stats.not_match}</div>
					</div>
					<div style="background: rgb(var(--m3-scheme-surface-variant)); padding: 1rem; border-radius: 12px;">
						<div style="font-size: 0.875rem; color: rgb(var(--m3-scheme-on-surface-variant));">Unknown</div>
						<div style="font-size: 1.5rem; font-weight: 500; color: rgb(var(--m3-scheme-on-surface));">{recruitingDiagnostics.stats.unknown}</div>
					</div>
					<div style="background: rgb(var(--m3-scheme-error-container)); padding: 1rem; border-radius: 12px;">
						<div style="font-size: 0.875rem; color: rgb(var(--m3-scheme-on-error-container));">Errors</div>
						<div style="font-size: 1.5rem; font-weight: 500; color: rgb(var(--m3-scheme-on-error-container));">{recruitingDiagnostics.stats.error}</div>
					</div>
				</div>
			</div>
			
			{#if recruitingDiagnostics.threads.length > 0}
				<div style="margin-top: 1.5rem;">
					<strong>Recent Moderation Results</strong>
					<div style="margin-top: 0.75rem; max-height: 400px; overflow-y: auto;">
						{#each recruitingDiagnostics.threads.slice(0, 20) as thread}
							<div style="background: rgb(var(--m3-scheme-surface-container)); padding: 0.75rem; border-radius: 8px; margin-bottom: 0.5rem;">
								<div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.5rem;">
									<div style="font-weight: 500; flex: 1;">{thread.subject}</div>
									<div style="font-size: 0.75rem; padding: 0.25rem 0.5rem; border-radius: 12px; background: {thread.status === 'match' ? 'rgb(var(--m3-scheme-error-container))' : thread.status === 'not_match' ? 'rgb(var(--m3-scheme-tertiary-container))' : 'rgb(var(--m3-scheme-surface-variant))'}; color: {thread.status === 'match' ? 'rgb(var(--m3-scheme-on-error-container))' : thread.status === 'not_match' ? 'rgb(var(--m3-scheme-on-tertiary-container))' : 'rgb(var(--m3-scheme-on-surface-variant))'}">{thread.status}</div>
								</div>
								<div style="font-size: 0.875rem; color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 0.25rem;">From: {thread.from}</div>
								<div style="font-size: 0.75rem; color: rgb(var(--m3-scheme-on-surface-variant));">Updated: {thread.updatedAt}</div>
								{#if thread.actionTaken}
									<div style="font-size: 0.75rem; color: rgb(var(--m3-scheme-tertiary)); margin-top: 0.25rem;">Action: {thread.actionTaken}</div>
								{/if}
								{#if thread.lastError}
									<div style="font-size: 0.75rem; color: rgb(var(--m3-scheme-error)); margin-top: 0.25rem;">Error: {thread.lastError}</div>
								{/if}
								{#if thread.raw}
									<details style="margin-top: 0.5rem; font-size: 0.75rem;">
										<summary style="cursor: pointer; color: rgb(var(--m3-scheme-primary));">AI Response</summary>
										<pre style="white-space: pre-wrap; margin-top: 0.25rem; padding: 0.5rem; background: rgb(var(--m3-scheme-surface)); border-radius: 4px; overflow-x: auto;">{thread.raw}</pre>
									</details>
								{/if}
							</div>
						{/each}
					</div>
					{#if recruitingDiagnostics.threads.length > 20}
						<div style="text-align: center; margin-top: 0.5rem; font-size: 0.875rem; color: rgb(var(--m3-scheme-on-surface-variant));">
							Showing 20 of {recruitingDiagnostics.threads.length} threads
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h2>Environment & Session</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Environment & Session', { serverProbeResult, profileResult, verifying, step })}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<div class="controls">
			<Button variant="filled" onclick={runStep1EnvChecks}>Run environment checks</Button>
			<Button variant="filled" onclick={tryVerifyServerSession} disabled={verifying}>
				{verifying ? 'Verifying...' : 'Verify server session'}
			</Button>
			<Button variant="tonal" onclick={startServerLogin}>Start server login</Button>
			<Button variant="outlined" onclick={copyDiagnostics}>Copy diagnostics to clipboard</Button>
			<Button variant="text" color="error" onclick={clearLogs}>Clear client logs</Button>
		</div>
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h3>Azure Environment Configuration</h3>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Azure Configuration', {
				requiredVariables: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_BASE_URL', 'ENCRYPTION_KEY'],
				currentAppBase: window.location.origin
			})}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">
			<strong>⚠️ Critical Configuration Required:</strong> Your Azure Static Web App needs environment variables configured for OAuth to work.
			If <code>/api/google-login</code> returns status 0, environment variables are likely missing or incorrect.
		</p>
		
		<details style="margin-bottom: 1rem; padding: 1rem; background: rgb(var(--m3-scheme-surface-variant) / 0.1); border-radius: 8px;">
			<summary style="cursor: pointer; font-weight: 500; margin-bottom: 0.5rem;">📋 Required Environment Variables</summary>
			<table style="width: 100%; margin-top: 0.5rem; border-collapse: collapse;">
				<thead>
					<tr style="text-align: left; border-bottom: 1px solid rgb(var(--m3-scheme-outline));">
						<th style="padding: 0.5rem;">Variable Name</th>
						<th style="padding: 0.5rem;">Required Value</th>
					</tr>
				</thead>
				<tbody>
					<tr style="border-bottom: 1px solid rgb(var(--m3-scheme-outline) / 0.3);">
						<td style="padding: 0.5rem;"><code>GOOGLE_CLIENT_ID</code></td>
						<td style="padding: 0.5rem;">Your Google OAuth Client ID (from Google Cloud Console)</td>
					</tr>
					<tr style="border-bottom: 1px solid rgb(var(--m3-scheme-outline) / 0.3);">
						<td style="padding: 0.5rem;"><code>GOOGLE_CLIENT_SECRET</code></td>
						<td style="padding: 0.5rem;">Your Google OAuth Client Secret (from Google Cloud Console)</td>
					</tr>
					<tr style="border-bottom: 1px solid rgb(var(--m3-scheme-outline) / 0.3);">
						<td style="padding: 0.5rem;"><code>APP_BASE_URL</code></td>
						<td style="padding: 0.5rem;"><code>{window.location.origin}</code></td>
					</tr>
					<tr>
						<td style="padding: 0.5rem;"><code>ENCRYPTION_KEY</code></td>
						<td style="padding: 0.5rem;">32+ character random string for cookie encryption</td>
					</tr>
				</tbody>
			</table>
		</details>

		<details style="margin-bottom: 1rem; padding: 1rem; background: rgb(var(--m3-scheme-primary-container) / 0.3); border-radius: 8px;">
			<summary style="cursor: pointer; font-weight: 500; margin-bottom: 0.5rem;">🔧 How to Configure in Azure Portal</summary>
			<ol style="margin: 0.5rem 0; padding-left: 1.5rem; line-height: 1.8;">
				<li>Go to <a href="https://portal.azure.com" target="_blank" rel="noopener">Azure Portal</a></li>
				<li>Search for and open: <strong>polite-coast-0d53a9710</strong> (your Static Web App)</li>
				<li>In the left menu, click <strong>Settings → Configuration</strong></li>
				<li>Under "Application settings", click <strong>+ Add</strong> for each variable</li>
				<li>Enter the Name and Value, then click <strong>OK</strong></li>
				<li>Click <strong>Save</strong> at the top</li>
				<li>Wait 2-3 minutes for changes to take effect</li>
				<li>Come back here and click "Run Full Diagnostics" to verify</li>
			</ol>
		</details>

		<details style="margin-bottom: 1rem; padding: 1rem; background: rgb(var(--m3-scheme-tertiary-container) / 0.3); border-radius: 8px;">
			<summary style="cursor: pointer; font-weight: 500; margin-bottom: 0.5rem;">🔐 How to Get Google OAuth Credentials</summary>
			<ol style="margin: 0.5rem 0; padding-left: 1.5rem; line-height: 1.8;">
				<li>Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console - Credentials</a></li>
				<li>Select your project (or create one)</li>
				<li>Click <strong>CREATE CREDENTIALS → OAuth client ID</strong></li>
				<li>Application type: <strong>Web application</strong></li>
				<li>Add Authorized redirect URI: <code>{window.location.origin}/api/google-callback</code></li>
				<li>Click <strong>Create</strong></li>
				<li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong></li>
				<li>Use these values in your Azure configuration</li>
			</ol>
		</details>

		<div class="controls">
			<Button variant="filled" onclick={() => window.open('https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.Web%2FStaticSites', '_blank')}>
				Open Azure Static Web Apps
			</Button>
			<Button variant="tonal" onclick={() => window.open('https://console.cloud.google.com/apis/credentials', '_blank')}>
				Open Google Cloud Console
			</Button>
			<Button variant="outlined" onclick={() => {
				const config = `Required Azure Static Web App Environment Variables:

GOOGLE_CLIENT_ID=<your-google-client-id>
GOOGLE_CLIENT_SECRET=<your-google-client-secret>
APP_BASE_URL=${window.location.origin}
ENCRYPTION_KEY=<32-character-random-string>

Current redirect URI for Google OAuth:
${window.location.origin}/api/google-callback`;
				navigator.clipboard.writeText(config);
				showSnackbar({ message: 'Configuration template copied to clipboard', closable: true });
			}}>
				Copy Configuration Template
			</Button>
		</div>
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h3>Authentication Management</h3>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Authentication Management', { 
				authCache: {
					jmail_last_interactive_auth: localStorage.getItem('jmail_last_interactive_auth'),
					jmail_last_scope_auth: localStorage.getItem('jmail_last_scope_auth'),
					jmail_last_server_redirect: localStorage.getItem('jmail_last_server_redirect')
				}
			})}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">
			<strong>Session Expiration Issue:</strong> Server-side sessions expire after 1 hour for security. 
			If Gmail API works but Google OAuth endpoints fail, your session cookie expired but refresh token is still valid. 
			Use "Refresh server session" to extend for another hour without re-logging in.
		</p>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">
			<strong>Stale OAuth Cookies:</strong> If you see old OAuth flow cookies (g_pkce, g_state) from a failed login attempt, 
			they can block new login attempts. Use "Clear stale cookies & refresh" to clean them up and try refreshing your session.
		</p>
		<div class="controls">
			<Button variant="filled" onclick={clearStaleOAuthCookies}>Clear stale cookies & refresh</Button>
			<Button variant="tonal" onclick={checkSessionExpiry}>Check session status</Button>
			<Button variant="tonal" onclick={refreshServerSession}>Refresh server session</Button>
			<Button variant="outlined" onclick={clearAuthCache}>Clear authentication cache</Button>
			<Button variant="outlined" onclick={openAuthSettings}>Open authentication settings</Button>
			<Button variant="outlined" onclick={resetAuthRateLimit}>Reset authentication rate limits</Button>
			<Button variant="outlined" onclick={enableGlobalInterceptor}>
				{globalInterceptorEnabled ? 'Disable auto-refresh' : 'Enable auto-refresh (experimental)'}
			</Button>
			<Button variant="text" color="error" onclick={forceReauth}>Force re-authentication</Button>
		</div>
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h3>Localhost Authentication Setup</h3>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={async () => {
				const localhostAuthData = {
					clientIds: {
						LOCALHOST_GOOGLE_CLIENT_ID: localStorage.getItem('LOCALHOST_GOOGLE_CLIENT_ID'),
						DEV_GOOGLE_CLIENT_ID: localStorage.getItem('DEV_GOOGLE_CLIENT_ID'),
						VITE_GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID
					},
					tokens: {
						LOCALHOST_ACCESS_TOKEN: localStorage.getItem('LOCALHOST_ACCESS_TOKEN') ? 'Present' : 'Not found',
						LOCALHOST_TOKEN_EXPIRY: localStorage.getItem('LOCALHOST_TOKEN_EXPIRY')
					}
				};
				await copySection('Localhost Authentication Setup', localhostAuthData);
			}}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<div class="controls">
			<Button variant="filled" onclick={configureLocalhostClientId}>Configure localhost Google Client ID</Button>
			<Button variant="tonal" onclick={checkLocalhostAuthStatus}>Check localhost auth status</Button>
			<Button variant="outlined" onclick={setupServerAuth}>Setup server authentication (SWA CLI)</Button>
			<Button variant="text" onclick={showOAuthInstructions}>Show OAuth setup instructions</Button>
		</div>
	</Card>

	<Card variant="filled">
		<div class="section-header">
			<div class="section-title">
				<h2>Setup Wizard</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Setup Wizard', { step, serverProbeResult, serverProbeError, profileResult, verifying })}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		{#if step === 1}
			<div class="step">
				<p>Step 1 — Environment checks. Click "Run environment checks" to probe server endpoints and check client runtime.</p>
			</div>
		{/if}
		{#if step === 2}
			<div class="step">
				<p>Step 2 — Server probe complete. Review results and either verify session or start server login.</p>
				{#if serverProbeResult}
					<pre class="diag">{JSON.stringify(serverProbeResult, null, 2)}</pre>
				{/if}
				{#if serverProbeError}
					<div style="color: rgb(var(--m3-scheme-error)); padding: 0.5rem; background: rgb(var(--m3-scheme-error-container) / 0.1); border-radius: var(--m3-util-rounding-small); margin-top: 0.5rem;">Probe error: {serverProbeError}</div>
				{/if}
			</div>
		{/if}
		{#if step === 3}
			<div class="step">
				<p>Step 3 — Server login required. Click <strong>Start server login</strong> to open the server-managed Google sign-in flow (preserves return URL).</p>
			</div>
		{/if}
		{#if step === 4}
			<div class="step">
				<p>Step 4 — Post-auth verification.</p>
				{#if profileResult}
					<pre class="diag">{JSON.stringify(profileResult, null, 2)}</pre>
				{/if}
			</div>
		{/if}
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h2>Android Overflow Button Diagnostics</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Android Overflow Button Diagnostics', androidDiagnostics)}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">
			Diagnose Android-specific issues with overflow menu buttons and snooze trailing action menus not responding to taps.
		</p>
		<div style="background: rgb(var(--m3-scheme-primary-container)); color: rgb(var(--m3-scheme-on-primary-container)); padding: 1rem; border-radius: var(--m3-util-rounding-medium); margin-bottom: 1rem;">
			<strong>📱 Testing Snooze Buttons:</strong> Snooze menus only exist on email thread rows. To test snooze functionality:
			<ol style="margin: 0.5rem 0; padding-left: 1.5rem;">
				<li>Navigate to <strong>Inbox</strong> using the "Back to Inbox" button above</li>
				<li>Find email threads with trailing action buttons (right side)</li>
				<li>Look for the snooze expand button (arrow ↓) next to time options like "1h", "30d"</li>
				<li>Tap the expand arrow to test the snooze menu - it should now work with Android fixes!</li>
			</ol>
		</div>
		
		<div class="controls">
			<Button variant="filled" iconType="left" onclick={runAndroidDiagnostics} disabled={androidDiagnostics.running}>
				<Icon icon={iconPlayArrow} />
				{androidDiagnostics.running ? 'Running Diagnostics...' : 'Run Android Diagnostics'}
			</Button>
			<Button variant="tonal" onclick={navigateToSettingsAlternative}>Try Alternative Settings Navigation</Button>
			<Button variant="tonal" onclick={checkForUpdateAlternative}>Try Alternative App Update</Button>
			<Button variant="tonal" onclick={testSnoozeMenuAndroid}>Test Snooze Menu Toggle</Button>
			<Button variant="outlined" onclick={testOriginalOverflowMenu}>Test Original Overflow Menu</Button>
		</div>
		
		{#if androidDiagnostics.deviceInfo}
			<div style="margin-top: 1.5rem;">
				<h3 style="color: rgb(var(--m3-scheme-on-surface)); margin-bottom: 0.5rem;">Device Information</h3>
				<div style="background: rgb(var(--m3-scheme-surface-variant)); color: rgb(var(--m3-scheme-on-surface-variant)); padding: 1rem; border-radius: var(--m3-util-rounding-medium); font-family: 'Roboto Mono', monospace; font-size: 0.875rem;">
					<div><strong>Android Device:</strong> {androidDiagnostics.deviceInfo.isAndroid ? 'Yes' : 'No'}</div>
					<div><strong>PWA Mode:</strong> {androidDiagnostics.deviceInfo.isPWA ? 'Yes' : 'No'}</div>
					<div><strong>Touch Support:</strong> {androidDiagnostics.deviceInfo.touchSupport ? 'Yes' : 'No'}</div>
					<div><strong>Screen:</strong> {androidDiagnostics.deviceInfo.screen.width}x{androidDiagnostics.deviceInfo.screen.height}</div>
					<div><strong>Viewport:</strong> {androidDiagnostics.deviceInfo.viewport.width}x{androidDiagnostics.deviceInfo.viewport.height}</div>
					<div><strong>Pixel Ratio:</strong> {androidDiagnostics.deviceInfo.pixelRatio}</div>
				</div>
			</div>
		{/if}
		
		{#if androidDiagnostics.navigationTests.length > 0}
			<div style="margin-top: 1.5rem;">
				<h3 style="color: rgb(var(--m3-scheme-on-surface)); margin-bottom: 1rem;">Navigation Tests</h3>
				<div class="diagnostics-results">
					{#each androidDiagnostics.navigationTests as result}
						<div class="diagnostic-item {result.status}">
							<div class="diagnostic-icon">
								{#if result.status === 'success'}
									<Icon icon={iconCheck} />
								{:else if result.status === 'error'}
									<Icon icon={iconError} />
								{:else}
									<div class="pending-dot"></div>
								{/if}
							</div>
							<div class="diagnostic-content">
								<div class="diagnostic-name">{result.name}</div>
								{#if result.message}
									<div class="diagnostic-message">{result.message}</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
		
		{#if androidDiagnostics.touchEventTests.length > 0}
			<div style="margin-top: 1.5rem;">
				<h3 style="color: rgb(var(--m3-scheme-on-surface)); margin-bottom: 1rem;">Touch Event Tests</h3>
				<div class="diagnostics-results">
					{#each androidDiagnostics.touchEventTests as result}
						<div class="diagnostic-item {result.status}">
							<div class="diagnostic-icon">
								{#if result.status === 'success'}
									<Icon icon={iconCheck} />
								{:else if result.status === 'error'}
									<Icon icon={iconError} />
								{:else}
									<div class="pending-dot"></div>
								{/if}
							</div>
							<div class="diagnostic-content">
								<div class="diagnostic-name">{result.name}</div>
								{#if result.message}
									<div class="diagnostic-message">{result.message}</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
		
		{#if androidDiagnostics.snoozeMenuTests.length > 0}
			<div style="margin-top: 1.5rem;">
				<h3 style="color: rgb(var(--m3-scheme-on-surface)); margin-bottom: 1rem;">Snooze Menu Tests</h3>
				<div class="diagnostics-results">
					{#each androidDiagnostics.snoozeMenuTests as result}
						<div class="diagnostic-item {result.status}">
							<div class="diagnostic-icon">
								{#if result.status === 'success'}
									<Icon icon={iconCheck} />
								{:else if result.status === 'error'}
									<Icon icon={iconError} />
								{:else}
									<div class="pending-dot"></div>
								{/if}
							</div>
							<div class="diagnostic-content">
								<div class="diagnostic-name">{result.name}</div>
								{#if result.message}
									<div class="diagnostic-message">{result.message}</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h2>Paste Diagnostics</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Paste Diagnostics', { parsedDiag, diagSummary, parseError, pastedText: pastedText ? 'Present' : 'Empty' })}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">Paste diagnostics JSON (from the "Copy diagnostics to clipboard" button or saved diagnostics) then click "Process" to summarize and surface auth-related findings.</p>
		<textarea class="pastebox" bind:value={pastedText} placeholder='Paste diagnostics JSON here'></textarea>
		<div class="controls">
			<Button variant="filled" onclick={processPastedDiagnostics}>Process pasted diagnostics</Button>
			<Button variant="tonal" onclick={async ()=>{ const ok = await copyParsedDiagnostics(); if(ok) showSnackbar({ message: 'Parsed diagnostics copied', closable: true }); else showSnackbar({ message: 'Failed to copy parsed diagnostics', closable: true }); }}>Copy parsed diagnostics</Button>
			<Button variant="outlined" onclick={submitParsedDiagnostics} disabled={!parsedDiag}>Submit parsed diagnostics</Button>
		</div>
		{#if parseError}
			<div style="color: rgb(var(--m3-scheme-error)); padding: 1rem; background: rgb(var(--m3-scheme-error-container) / 0.1); border-radius: var(--m3-util-rounding-medium); margin-top: 1rem;">Parse error: {parseError}</div>
		{/if}
		{#if diagSummary}
			<div class="summary">
				<strong>Summary</strong>
				<pre style="white-space:pre-wrap">{JSON.stringify(diagSummary, null, 2)}</pre>
			</div>
		{/if}
		{#if parsedDiag}
			<div style="margin-top: 1rem">
				<details>
					<summary style="cursor: pointer; color: rgb(var(--m3-scheme-primary)); padding: 0.5rem; border-radius: var(--m3-util-rounding-small);">Show parsed diagnostics</summary>
					<pre class="diag">{JSON.stringify(parsedDiag, null, 2)}</pre>
				</details>
			</div>
		{/if}
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h2>Inbox Sync Diagnostics</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Inbox Sync Diagnostics', inboxDiagnostics)}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">Debug inbox sync issues - excessive pages, wrong email counts, stale data.</p>
		<div class="controls">
			<!-- Combined comprehensive inbox sync button -->
			<Button variant="filled" onclick={runCombinedInboxDiagnostics} title="Run combined inbox diagnostics and actions">
				<Icon icon={iconDiagnostics} />
				Run Inbox Sync Diagnostics & Actions
			</Button>
			<Button variant="outlined" color="error" onclick={clearLocalInboxData}>Clear local inbox data</Button>
			<Button variant="text" onclick={() => copySection('Inbox Sync Diagnostics', inboxDiagnostics)}>Copy Section</Button>
		</div>
		{#if inboxDiagnostics}
			<div class="summary">
				<strong>Inbox Sync Diagnostics</strong>
				<pre style="white-space:pre-wrap">{JSON.stringify(inboxDiagnostics, null, 2)}</pre>
			</div>
		{/if}
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h2>Action Queue Diagnostics</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Action Queue Diagnostics', queueDiagnostics)}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">Diagnose issues with deletes, archives, snoozes not being saved properly.</p>
		<div class="controls">
			<Button variant="filled" onclick={checkActionQueue}>Check action queue status</Button>
			<Button variant="tonal" onclick={checkJournal}>Check action journal</Button>
			<Button variant="outlined" onclick={forceFlushQueue}>Force flush queue</Button>
			<Button variant="outlined" color="error" onclick={clearFailedOps}>Clear failed operations</Button>
			<Button variant="text" onclick={checkFlushLoop}>Check flush loop status</Button>
		</div>
		{#if queueDiagnostics}
			<div class="summary">
				<strong>Queue Status</strong>
				<pre style="white-space:pre-wrap">{JSON.stringify(queueDiagnostics, null, 2)}</pre>
			</div>
		{/if}
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h2>Guided Actions</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Guided Actions', { apiBaseOverride, endpointResults })}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">Use these quick actions to validate API base, endpoints, and client cookies.</p>
		<div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap;">
			<input 
				placeholder="optional APP_BASE_URL override" 
				bind:value={apiBaseOverride} 
				style="
					flex: 1;
					min-width: 200px;
					padding: 0.75rem 1rem;
					border: 1px solid rgb(var(--m3-scheme-outline));
					border-radius: var(--m3-util-rounding-small);
					background: rgb(var(--m3-scheme-surface));
					color: rgb(var(--m3-scheme-on-surface));
					font-family: inherit;
				" />
			<Button variant="tonal" onclick={saveApiBaseOverride}>Save override</Button>
			<Button variant="text" onclick={() => { loadApiBaseOverride(); alert('Loaded override: ' + (apiBaseOverride || '(none)')); }}>Reload</Button>
		</div>
		<div class="controls">
			<Button variant="filled" onclick={() => checkEndpoint('/api/google-login')}>Check /api/google-login</Button>
			<Button variant="filled" onclick={() => checkEndpoint('/api/google-callback')}>Check /api/google-callback</Button>
			<Button variant="filled" onclick={() => checkEndpoint('/api/google-me')}>Check /api/google-me</Button>
			<Button variant="filled" onclick={() => checkEndpoint('/api/gmail/profile')}>Check /api/gmail/profile</Button>
		</div>
		<div class="controls">
			<Button variant="tonal" onclick={listClientCookies}>List client cookies</Button>
			<Button variant="outlined" color="error" onclick={clearClientCookies}>Clear client cookies (non-httpOnly)</Button>
		</div>
		{#if Object.keys(endpointResults).length}
			<div class="controls">
			<Button variant="tonal" iconType="left" onclick={async ()=>{ try { await navigator.clipboard.writeText(JSON.stringify(endpointResults, null, 2)); showSnackbar({ message: 'Copied endpoint results', closable: true }); addLog('info',['copied endpointResults']); } catch(e){ showSnackbar({ message: 'Copy failed: '+String(e), closable: true }); } }}>
				<Icon icon={iconCopy} />
				Copy endpoint results
			</Button>
			<Button variant="outlined" iconType="left" onclick={async ()=>{ const full = { endpointResults, profileResult, parsedDiag, logs: logs.slice(-200) }; try { await navigator.clipboard.writeText(JSON.stringify(full, null, 2)); showSnackbar({ message: 'Copied full guided report', closable: true }); addLog('info',['copied full guided report']); } catch(e){ showSnackbar({ message: 'Copy failed: '+String(e), closable: true }); } }}>
				<Icon icon={iconCopy} />
				Copy full guided report
			</Button>
			</div>
			<pre class="diag">{JSON.stringify(endpointResults, null, 2)}</pre>
		{/if}
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h2>App Update Check</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('App Update Check', updateCheckResult)}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">Test the app update checking functionality to verify it can fetch and compare version information.</p>
		<div class="controls">
			<Button variant="filled" onclick={testAppUpdate} disabled={checkingUpdate}>
				{checkingUpdate ? 'Checking...' : 'Test Update Check'}
			</Button>
		</div>
		{#if updateCheckResult}
			<div class="summary">
				<strong>Update Check Result</strong>
				<pre style="white-space:pre-wrap">{JSON.stringify(updateCheckResult, null, 2)}</pre>
			</div>
		{/if}
	</Card>

	<Card variant="filled">
		<div class="section-header">
			<div class="section-title">
				<h2>AI Summary Testing</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('AI Summary Testing', aiSummaryTestResult)}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">Test the AI summary sequence to verify that step 1 generates detailed bullet-point summaries and step 2 generates short subject replacements.</p>
		
		<div style="margin-bottom: 1rem;">
			<label for="test-subject-input" style="display: block; margin-bottom: 0.5rem; font-weight: 500; color: rgb(var(--m3-scheme-on-surface));">Test Subject:</label>
			<input 
				id="test-subject-input"
				bind:value={testSubject}
				placeholder="Enter email subject to test"
				style="
					width: 100%;
					padding: 0.75rem 1rem;
					border: 1px solid rgb(var(--m3-scheme-outline));
					border-radius: var(--m3-util-rounding-small);
					background: rgb(var(--m3-scheme-surface));
					color: rgb(var(--m3-scheme-on-surface));
					font-family: inherit;
					margin-bottom: 1rem;
				" />
			
			<label for="test-body-textarea" style="display: block; margin-bottom: 0.5rem; font-weight: 500; color: rgb(var(--m3-scheme-on-surface));">Test Email Body:</label>
			<textarea 
				id="test-body-textarea"
				bind:value={testBodyText}
				placeholder="Enter email body content to test"
				rows="6"
				style="
					width: 100%;
					padding: 0.75rem 1rem;
					border: 1px solid rgb(var(--m3-scheme-outline));
					border-radius: var(--m3-util-rounding-small);
					background: rgb(var(--m3-scheme-surface));
					color: rgb(var(--m3-scheme-on-surface));
					font-family: inherit;
					resize: vertical;
				"></textarea>
		</div>

		<div class="controls">
			<Button variant="filled" onclick={testAiSummary} disabled={testingAiSummary}>
				<Icon icon={iconPlayArrow} />
				{testingAiSummary ? 'Testing AI Summary Sequence...' : 'Test AI Summary Sequence'}
			</Button>
		</div>
		
		{#if aiSummaryTestResult}
			<div class="summary">
				<strong>AI Summary Test Results</strong>
				{#if aiSummaryTestResult.success}
					<div style="margin-top: 1rem;">
						<div style="background: rgb(var(--m3-scheme-{aiSummaryTestResult.analysis.correctSequence ? 'tertiary' : 'error'}-container)); padding: 1rem; border-radius: var(--m3-util-rounding-small); margin-bottom: 1rem;">
							<strong style="color: rgb(var(--m3-scheme-{aiSummaryTestResult.analysis.correctSequence ? 'on-tertiary' : 'on-error'}-container));">
								{aiSummaryTestResult.analysis.correctSequence ? '✓ AI Summary Sequence Working Correctly' : '⚠ Issue: Both summaries are identical'}
							</strong>
						</div>
						
						<div style="display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); margin-bottom: 1rem;">
							<div style="background: rgb(var(--m3-scheme-surface-container-high)); padding: 1rem; border-radius: var(--m3-util-rounding-medium);">
								<h4 style="margin: 0 0 0.5rem; color: rgb(var(--m3-scheme-on-surface));">Step 1: Detailed Summary</h4>
								<div style="font-size: 0.875rem; color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 0.5rem;">
									Type: {aiSummaryTestResult.analysis.detailedSummaryType} • Words: {aiSummaryTestResult.step1Result.wordCount} • Time: {aiSummaryTestResult.step1Result.timeMs}ms
								</div>
								<div style="background: rgb(var(--m3-scheme-surface-container)); padding: 0.75rem; border-radius: var(--m3-util-rounding-small); font-family: monospace; font-size: 0.875rem; white-space: pre-wrap; max-height: 200px; overflow-y: auto;">{aiSummaryTestResult.step1Result.detailedSummary}</div>
							</div>
							
							<div style="background: rgb(var(--m3-scheme-surface-container-high)); padding: 1rem; border-radius: var(--m3-util-rounding-medium);">
								<h4 style="margin: 0 0 0.5rem; color: rgb(var(--m3-scheme-on-surface));">Step 2: Short Subject</h4>
								<div style="font-size: 0.875rem; color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 0.5rem;">
									Type: {aiSummaryTestResult.analysis.shortSubjectType} • Words: {aiSummaryTestResult.step2Result.wordCount} • Time: {aiSummaryTestResult.step2Result.timeMs}ms
								</div>
								<div style="background: rgb(var(--m3-scheme-surface-container)); padding: 0.75rem; border-radius: var(--m3-util-rounding-small); font-family: monospace; font-size: 0.875rem; white-space: pre-wrap; max-height: 200px; overflow-y: auto;">{aiSummaryTestResult.step2Result.shortSubject}</div>
							</div>
						</div>
						
						<details style="background: rgb(var(--m3-scheme-surface-container)); border-radius: var(--m3-util-rounding-small);">
							<summary style="cursor: pointer; padding: 1rem; color: rgb(var(--m3-scheme-primary)); font-weight: 500;">Show Full Test Results</summary>
							<div style="padding: 0 1rem 1rem;">
								<pre class="diag" style="margin: 0;">{JSON.stringify(aiSummaryTestResult, null, 2)}</pre>
							</div>
						</details>
					</div>
				{:else}
					<div style="color: rgb(var(--m3-scheme-error)); background: rgb(var(--m3-scheme-error-container) / 0.1); padding: 1rem; border-radius: var(--m3-util-rounding-small); margin-top: 1rem;">
						<strong>Test Failed:</strong> {aiSummaryTestResult.error}
					</div>
				{/if}
			</div>
		{/if}
	</Card>

	<Card variant="filled">
		<div class="section-header">
			<div class="section-title">
				<h2>Pull Forward Diagnostics</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Pull Forward Diagnostics', pullForwardResult)}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">
			Test pulling forward snoozed emails. This runs the actual pull forward logic and captures detailed diagnostics about label matching and potential errors.
		</p>
		
		<div class="controls">
			<Button variant="filled" onclick={testPullForward} disabled={testingPullForward}>
				<Icon icon={iconPlayArrow} />
				{testingPullForward ? 'Pulling Forward...' : 'Test Pull Forward (Fetch 5)'}
			</Button>
		</div>
		
		{#if pullForwardResult}
			<div class="summary">
				<strong>Pull Forward Results</strong>
				{#if pullForwardResult.success}
					<div style="margin-top: 1rem;">
						<div style="background: rgb(var(--m3-scheme-tertiary-container)); padding: 1rem; border-radius: var(--m3-util-rounding-small); margin-bottom: 1rem;">
							<strong style="color: rgb(var(--m3-scheme-on-tertiary-container));">
								✓ Success: Pulled {pullForwardResult.result.pulledCount} emails
							</strong>
						</div>
						
						<details open style="background: rgb(var(--m3-scheme-surface-container)); border-radius: var(--m3-util-rounding-small); margin-top: 1rem;">
							<summary style="cursor: pointer; padding: 1rem; color: rgb(var(--m3-scheme-primary)); font-weight: 500;">Diagnostic Logs</summary>
							<div style="padding: 0 1rem 1rem;">
								<pre class="diag" style="margin: 0;">{JSON.stringify(pullForwardResult.diagnostics, null, 2)}</pre>
							</div>
						</details>
					</div>
				{:else}
					<div style="color: rgb(var(--m3-scheme-error)); background: rgb(var(--m3-scheme-error-container) / 0.1); padding: 1rem; border-radius: var(--m3-util-rounding-small); margin-top: 1rem;">
						<strong>Test Failed:</strong> {pullForwardResult.error}
					</div>
					{#if pullForwardResult.diagnostics}
						<details open style="background: rgb(var(--m3-scheme-surface-container)); border-radius: var(--m3-util-rounding-small); margin-top: 1rem;">
							<summary style="cursor: pointer; padding: 1rem; color: rgb(var(--m3-scheme-primary)); font-weight: 500;">Diagnostic Logs</summary>
							<div style="padding: 0 1rem 1rem;">
								<pre class="diag" style="margin: 0;">{JSON.stringify(pullForwardResult.diagnostics, null, 2)}</pre>
							</div>
						</details>
					{/if}
				{/if}
			</div>
		{/if}
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h2>Settings Persistence Debug</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Settings Debug', settingsDebugResult)}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">
			Debug settings persistence issues. This checks what's stored in IndexedDB and whether storage is persistent.
		</p>
		<div class="controls">
			<Button variant="filled" onclick={debugSettingsPersistence} disabled={settingsDebugRunning}>
				{settingsDebugRunning ? 'Checking...' : 'Check Settings Storage'}
			</Button>
			<Button variant="outlined" onclick={requestStoragePersistence}>
				Request Persistent Storage
			</Button>
		</div>
		{#if settingsDebugResult}
			<div class="summary" style="margin-top: 1rem;">
				<strong>Storage Status:</strong>
				<ul style="margin: 0.5rem 0; padding-left: 1.5rem;">
					<li>Storage Persistent: {settingsDebugResult.isPersistent ? '✅ Yes' : '⚠️ No (browser may clear data)'}</li>
					<li>Storage Quota: {settingsDebugResult.storageEstimate ? `${Math.round(settingsDebugResult.storageEstimate.usage / 1024)} KB used of ${Math.round(settingsDebugResult.storageEstimate.quota / 1024 / 1024)} MB` : 'N/A'}</li>
				</ul>
				<strong>Settings in IndexedDB:</strong>
				<ul style="margin: 0.5rem 0; padding-left: 1.5rem;">
					<li>App Settings: {settingsDebugResult.appSettings ? '✅ Present' : '❌ Not found'}</li>
					<li>API Key: {settingsDebugResult.hasApiKey ? '✅ Configured' : '❌ Not set'}</li>
					<li>AI Provider: {settingsDebugResult.aiProvider || 'Not set'}</li>
					<li>Label Mapping: {settingsDebugResult.labelMappingCount} keys mapped</li>
					<li>Precompute Summaries: {settingsDebugResult.precomputeSummaries ? '✅ Enabled' : '❌ Disabled'}</li>
				</ul>
				<details style="margin-top: 0.5rem;">
					<summary style="cursor: pointer; color: rgb(var(--m3-scheme-primary));">Raw Settings Data</summary>
					<pre style="white-space:pre-wrap; font-size: 0.75rem; max-height: 300px; overflow: auto; margin-top: 0.5rem;">{JSON.stringify(settingsDebugResult.rawData, null, 2)}</pre>
				</details>
			</div>
		{/if}
	</Card>

	<Card variant="outlined">
		<div class="section-header">
			<div class="section-title">
				<h2>Client Logs</h2>
			</div>
			<Button variant="text" iconType="left" class="copy-button" onclick={() => copySection('Client Logs', { logs: logs.slice(-200), totalLogs: logs.length })}>
				<Icon icon={iconCopy} />
				Copy Section
			</Button>
		</div>
		<p style="color: rgb(var(--m3-scheme-on-surface-variant)); margin-bottom: 1rem;">Showing last 200 log entries (Total: {logs.length})</p>
		<pre class="diag">{JSON.stringify(logs.slice(-200), null, 2)}</pre>
	</Card>
</div>


