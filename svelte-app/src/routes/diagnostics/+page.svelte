<script lang="ts">
import { onMount, onDestroy } from 'svelte';

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
			const res = await fetch(ep, { method: 'GET', credentials: 'include' });
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

loadApiBaseOverride();

</script>

<style>
pre.diag { 
  max-height: 40vh; 
  overflow: auto; 
  background: rgb(var(--m3-scheme-surface-variant)); 
  color: rgb(var(--m3-scheme-on-surface-variant)); 
  padding: 8px; 
  border-radius: 6px;
}
.controls { display:flex; gap:8px; margin-bottom:8px }
.wizard { 
  margin: 0.5rem 0 1rem 0; 
  padding: 0.5rem; 
  border: 1px solid rgb(var(--m3-scheme-outline-variant)); 
  border-radius: 6px; 
  background: rgb(var(--m3-scheme-surface));
}
.step { margin-bottom: 0.5rem; }
.pastebox { 
  width:100%; 
  min-height: 8rem; 
  font-family: monospace; 
  background: rgb(var(--m3-scheme-surface)); 
  color: rgb(var(--m3-scheme-on-surface)); 
  border: 1px solid rgb(var(--m3-scheme-outline));
}
.summary { 
  background: rgb(var(--m3-scheme-surface-variant)); 
  color: rgb(var(--m3-scheme-on-surface-variant)); 
  padding: 0.5rem; 
  border-radius: 6px; 
  margin-top: 0.5rem; 
}
</style>

<div>
	<h1>Diagnostics</h1>
	<div class="controls">
		<button on:click={runStep1EnvChecks}>Run environment checks</button>
		<button on:click={tryVerifyServerSession} disabled={verifying}>Verify server session</button>
		<button on:click={startServerLogin}>Start server login</button>
		<button on:click={copyDiagnostics}>Copy diagnostics to clipboard</button>
		<button on:click={clearLogs}>Clear client logs</button>
	</div>

	<div class="controls">
		<h3>Authentication Management</h3>
		<button on:click={clearAuthCache}>Clear authentication cache</button>
		<button on:click={openAuthSettings}>Open authentication settings</button>
		<button on:click={resetAuthRateLimit}>Reset authentication rate limits</button>
	</div>

	<div class="controls">
		<h3>Localhost Authentication Setup</h3>
		<button on:click={configureLocalhostClientId}>Configure localhost Google Client ID</button>
		<button on:click={checkLocalhostAuthStatus}>Check localhost auth status</button>
		<button on:click={setupServerAuth}>Setup server authentication (SWA CLI)</button>
		<button on:click={showOAuthInstructions}>Show OAuth setup instructions</button>
	</div>

	<div class="wizard">
		<h2>Wizard</h2>
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
					<div class="warn">Probe error: {serverProbeError}</div>
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
	</div>

	<div class="wizard">
		<h2>Paste diagnostics</h2>
		<p>Paste diagnostics JSON (from the "Copy diagnostics to clipboard" button or saved diagnostics) then click "Process" to summarize and surface auth-related findings.</p>
		<textarea class="pastebox" bind:value={pastedText} placeholder='Paste diagnostics JSON here'></textarea>
		<div style="display:flex; gap:0.5rem; margin-top:0.5rem">
			<button on:click={processPastedDiagnostics}>Process pasted diagnostics</button>
			<button on:click={async ()=>{ const ok = await copyParsedDiagnostics(); if(ok) alert('Parsed diagnostics copied'); else alert('Failed to copy parsed diagnostics'); }}>Copy parsed diagnostics</button>
			<button on:click={submitParsedDiagnostics} disabled={!parsedDiag}>Submit parsed diagnostics</button>
		</div>
		{#if parseError}
			<div class="warn">Parse error: {parseError}</div>
		{/if}
		{#if diagSummary}
			<div class="summary">
				<strong>Summary</strong>
				<pre style="white-space:pre-wrap">{JSON.stringify(diagSummary, null, 2)}</pre>
			</div>
		{/if}
		{#if parsedDiag}
			<div style="margin-top:0.5rem">
				<details>
					<summary>Show parsed diagnostics</summary>
					<pre class="diag">{JSON.stringify(parsedDiag, null, 2)}</pre>
				</details>
			</div>
		{/if}
	</div>

	<div class="wizard">
		<h2>Action Queue Diagnostics</h2>
		<p>Diagnose issues with deletes, archives, snoozes not being saved properly.</p>
		<div class="controls">
			<button on:click={checkActionQueue}>Check action queue status</button>
			<button on:click={checkJournal}>Check action journal</button>
			<button on:click={forceFlushQueue}>Force flush queue</button>
			<button on:click={clearFailedOps}>Clear failed operations</button>
			<button on:click={checkFlushLoop}>Check flush loop status</button>
		</div>
		{#if queueDiagnostics}
			<div class="summary">
				<strong>Queue Status</strong>
				<pre style="white-space:pre-wrap">{JSON.stringify(queueDiagnostics, null, 2)}</pre>
			</div>
		{/if}
	</div>

	<div class="wizard">
		<h2>Guided actions</h2>
		<p>Use these quick actions to validate API base, endpoints, and client cookies.</p>
		<div style="display:flex; gap:0.5rem; align-items:center; margin-bottom:0.5rem">
			<input placeholder="optional APP_BASE_URL override" bind:value={apiBaseOverride} style="width:60%" />
			<button on:click={saveApiBaseOverride}>Save override</button>
			<button on:click={() => { loadApiBaseOverride(); alert('Loaded override: ' + (apiBaseOverride || '(none)')); }}>Reload</button>
		</div>
		<div style="display:flex; gap:0.5rem; margin-bottom:0.5rem">
			<button on:click={() => checkEndpoint('/api/google-login')}>Check /api/google-login</button>
			<button on:click={() => checkEndpoint('/api/google-callback')}>Check /api/google-callback</button>
			<button on:click={() => checkEndpoint('/api/google-me')}>Check /api/google-me</button>
			<button on:click={() => checkEndpoint('/api/gmail/profile')}>Check /api/gmail/profile</button>
		</div>
		<div style="display:flex; gap:0.5rem; margin-bottom:0.5rem">
			<button on:click={listClientCookies}>List client cookies</button>
			<button on:click={clearClientCookies}>Clear client cookies (non-httpOnly)</button>
		</div>
		{#if Object.keys(endpointResults).length}
			<div style="display:flex; gap:0.5rem; margin-bottom:0.5rem">
				<button on:click={async ()=>{ try { await navigator.clipboard.writeText(JSON.stringify(endpointResults, null, 2)); alert('Copied endpoint results'); addLog('info',['copied endpointResults']); } catch(e){ alert('Copy failed: '+String(e)); } }}>Copy endpoint results</button>
				<button on:click={async ()=>{ const full = { endpointResults, profileResult, parsedDiag, logs: logs.slice(-200) }; try { await navigator.clipboard.writeText(JSON.stringify(full, null, 2)); alert('Copied full guided report'); addLog('info',['copied full guided report']); } catch(e){ alert('Copy failed: '+String(e)); } }}>Copy full guided report</button>
			</div>
			<pre class="diag">{JSON.stringify(endpointResults, null, 2)}</pre>
		{/if}
	</div>

	<h2>Client logs</h2>
	<pre class="diag">{JSON.stringify(logs.slice(-200), null, 2)}</pre>
</div>


