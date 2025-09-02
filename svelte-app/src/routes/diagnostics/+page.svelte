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

</script>

<style>
pre.diag { max-height: 40vh; overflow: auto; background: #111; color: #eee; padding: 8px; }
.controls { display:flex; gap:8px; margin-bottom:8px }
.wizard { margin: 0.5rem 0 1rem 0; padding: 0.5rem; border: 1px solid rgba(0,0,0,0.06); border-radius: 6px; }
.step { margin-bottom: 0.5rem; }
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

	<h2>Client logs</h2>
	<pre class="diag">{JSON.stringify(logs.slice(-200), null, 2)}</pre>
</div>


