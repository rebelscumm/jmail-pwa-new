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
import Icon from '$lib/misc/_icon.svelte';

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

// Comprehensive diagnostics runner
async function runFullDiagnostics() {
	fullDiagnostics.running = true;
	fullDiagnostics.results = [
		{ name: 'Environment Check', status: 'pending' },
		{ name: 'Server Session Verification', status: 'pending' },
		{ name: 'Authentication Status', status: 'pending' },
		{ name: 'Localhost Auth Configuration', status: 'pending' },
		{ name: 'Action Queue Health', status: 'pending' },
		{ name: 'Inbox Sync Status', status: 'pending' },
		{ name: 'Gmail API Connectivity', status: 'pending' },
		{ name: 'Client Storage Health', status: 'pending' },
		{ name: 'Cookie Configuration', status: 'pending' }
	];
	
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
		
		// 2. Server Session Verification
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
		
		// 3. Authentication Status
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
		
		// 4. Localhost Auth Configuration
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
		
		// 5. Action Queue Health
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
		
		// 6. Inbox Sync Status
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
		
		// 7. Gmail API Connectivity
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
		
		// 8. Client Storage Health
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
		
		// 9. Cookie Configuration
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
	} finally {
		fullDiagnostics.running = false;
		updateDiagnosticsSummary();
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
		alert('Localhost auth status copied to clipboard! Check logs for details.');
	} catch (e) {
		addLog('error', ['checkLocalhostAuthStatus failed', e]);
		alert('Failed to check localhost auth status: ' + String(e));
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
			addLog('info', [`probe ${ep}`, results[ep]]);
		} catch (e) {
			results[ep] = { error: String(e) };
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
		alert('Diagnostics copied to clipboard');
	} catch (e) {
		addLog('error', ['failed to copy diagnostics', e]);
		alert('Failed to copy diagnostics: ' + String(e));
	}
}

// Copy functions for individual sections
async function copySection(sectionName: string, data: any) {
	try {
		const content = JSON.stringify(data, null, 2);
		await navigator.clipboard.writeText(content);
		addLog('info', [`copied ${sectionName} to clipboard`]);
		alert(`${sectionName} copied to clipboard`);
	} catch (e) {
		addLog('error', [`failed to copy ${sectionName}`, e]);
		alert(`Failed to copy ${sectionName}: ` + String(e));
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
		alert('All diagnostics sections copied to clipboard');
	} catch (e) {
		addLog('error', ['failed to copy all diagnostics sections', e]);
		alert('Failed to copy all diagnostics sections: ' + String(e));
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

loadApiBaseOverride();

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
		<h1>Diagnostics</h1>
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
		<div class="controls">
			<Button variant="tonal" onclick={clearAuthCache}>Clear authentication cache</Button>
			<Button variant="outlined" onclick={openAuthSettings}>Open authentication settings</Button>
			<Button variant="outlined" onclick={resetAuthRateLimit}>Reset authentication rate limits</Button>
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
			<Button variant="tonal" onclick={async ()=>{ const ok = await copyParsedDiagnostics(); if(ok) alert('Parsed diagnostics copied'); else alert('Failed to copy parsed diagnostics'); }}>Copy parsed diagnostics</Button>
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
			<Button variant="filled" onclick={debugInboxSync}>Debug inbox sync state</Button>
			<Button variant="tonal" onclick={compareInboxCounts}>Compare local vs Gmail counts</Button>
			<Button variant="outlined" color="error" onclick={clearLocalInboxData}>Clear local inbox data</Button>
			<Button variant="outlined" onclick={testGmailPagination}>Test Gmail API pagination</Button>
			<Button variant="text" onclick={identifyStaleThreads}>Identify stale threads</Button>
			<Button variant="text" onclick={testPaginationHealth}>Test pagination health</Button>
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
				<Button variant="tonal" iconType="left" onclick={async ()=>{ try { await navigator.clipboard.writeText(JSON.stringify(endpointResults, null, 2)); alert('Copied endpoint results'); addLog('info',['copied endpointResults']); } catch(e){ alert('Copy failed: '+String(e)); } }}>
					<Icon icon={iconCopy} />
					Copy endpoint results
				</Button>
				<Button variant="outlined" iconType="left" onclick={async ()=>{ const full = { endpointResults, profileResult, parsedDiag, logs: logs.slice(-200) }; try { await navigator.clipboard.writeText(JSON.stringify(full, null, 2)); alert('Copied full guided report'); addLog('info',['copied full guided report']); } catch(e){ alert('Copy failed: '+String(e)); } }}>
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


