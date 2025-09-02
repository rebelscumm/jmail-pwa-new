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
    const serverProbe = await probeServer();
    const diag = { ts: new Date().toISOString(), userAgent: navigator.userAgent, logs, serverProbe };
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
</script>

<style>
pre.diag { max-height: 40vh; overflow: auto; background: #111; color: #eee; padding: 8px; }
.controls { display:flex; gap:8px; margin-bottom:8px }
</style>

<div>
    <h1>Diagnostics</h1>
    <div class="controls">
        <button on:click={copyDiagnostics}>Copy diagnostics to clipboard</button>
        <button on:click={clearLogs}>Clear client logs</button>
    </div>

    <h2>Client logs</h2>
    <pre class="diag">{JSON.stringify(logs.slice(-200), null, 2)}</pre>
</div>


