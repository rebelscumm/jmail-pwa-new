import { fetchTokenInfo } from '$lib/gmail/auth';
import { pushGmailDiag, getAndClearGmailDiagnostics } from '$lib/gmail/diag';
import { getLocalhostToken } from '$lib/gmail/localhost-auth';
import type { GmailLabel, GmailMessage, GmailAttachment } from '$lib/types';

const GMAIL_PROXY_BASE = '/api/gmail';

export class GmailApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'GmailApiError';
    this.status = status;
    this.details = details;
  }
}

// Re-export diagnostics getter for UI consumption
export { getAndClearGmailDiagnostics } from '$lib/gmail/diag';

export async function copyGmailDiagnosticsToClipboard(extra?: Record<string, unknown>): Promise<boolean> {
  try {
    const entries = getAndClearGmailDiagnostics();
    // Summarize current outbox to aid debugging
    let outbox: any = undefined;
    let tokenInfo: any = undefined;
    try {
      const { getDB } = await import('$lib/db/indexeddb');
      const db = await getDB();
      const ops = await db.getAll('ops');
      outbox = {
        count: ops.length,
        sample: ops.slice(0, 10).map((o: any) => ({
          id: o.id,
          type: o.op?.type,
          attempts: o.attempts,
          nextAttemptAt: o.nextAttemptAt,
          lastError: o.lastError,
          scopeKey: o.scopeKey
        }))
      };
    } catch (_) {}
    try {
      tokenInfo = await fetchTokenInfo();
    } catch (_) {}
    // Ensure `extra` is a plain object before spreading to avoid runtime errors
    const safeExtra = (extra && typeof extra === 'object') ? Array.isArray(extra) ? { extra } : extra : {};
    // Build a curated list of recent network requests/responses for easy debugging
    try {
      const networkCandidates = (entries || []).filter((e: any) => ['api_request', 'api_response', 'api_error'].includes(e.type));
      const networkRequests = networkCandidates.slice(-20).map((e: any) => ({
        time: e.time,
        type: e.type,
        path: e.path,
        method: e.method,
        fullUrl: e.fullUrl || undefined,
        status: e.status || undefined,
        statusText: e.statusText || undefined,
        responseSnippet: typeof e.body === 'string' ? e.body.slice(0, 1024) : (typeof e.responseSnippet === 'string' ? e.responseSnippet.slice(0,1024) : undefined),
        tokenInfo: e.tokenInfo || undefined,
        details: e.details || undefined
      }));
      (safeExtra as any).networkRequests = networkRequests;
    } catch (_) {}

    const data = { entries, outbox, tokenInfo, ...safeExtra } as Record<string, unknown>;
    // Include stack trace if available in extra
    try {
      if (extra && typeof extra === 'object' && 'error' in extra) {
        const err = (extra as any).error;
        if (err instanceof Error) data.stack = err.stack;
        else if (typeof err === 'string') data.stack = err;
      }
    } catch (_) {}
    const text = JSON.stringify(data, null, 2);
    // eslint-disable-next-line no-console
    console.log('[GmailAPI] Diagnostics', data);
    
    // Try modern clipboard API first
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (clipboardError) {
        console.warn('[GmailAPI] Clipboard API failed:', clipboardError);
        // Continue to fallback methods
      }
    }
    
    // Fallback 1: Try document.execCommand (older browsers)
    if (typeof document !== 'undefined' && document.queryCommandSupported && document.queryCommandSupported('copy')) {
      try {
        // Create a temporary textarea element
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        
        if (successful) {
          return true;
        }
      } catch (execCommandError) {
        console.warn('[GmailAPI] execCommand fallback failed:', execCommandError);
      }
    }
    
    // Fallback 2: Surface via snackbar/log for manual copy (last resort)
    try {
      const { show } = await import('$lib/containers/snackbar');
      show({ message: 'Clipboard access blocked. Open console to copy diagnostics.', timeout: 6000, closable: true });
    } catch (_) {
      // If snackbar import fails (non-UI context), proceed silently
    }
    try {
      console.log('[GmailAPI] Diagnostics (manual copy)', data);
    } catch (_) {}
    // Additionally attempt to place a short summary on the clipboard synchronously
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        // Attempt a best-effort short copy of the top-level keys to help debugging in restricted contexts
        const short = JSON.stringify({ entries: (entries || []).length, outbox: outbox ? { count: outbox.count } : undefined, tokenInfo: tokenInfo ? { scope: tokenInfo.scope, expires_in: tokenInfo.expires_in } : undefined });
        await navigator.clipboard.writeText(short);
      }
    } catch (_) {}
    return false; // Not technically copied full diagnostics to clipboard
    
  } catch (error) {
    console.error('[GmailAPI] copyGmailDiagnosticsToClipboard failed:', error);
  }
  return false;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let tokenInfoAtRequest: { scope?: string; expires_in?: string; aud?: string } | undefined;
  try { tokenInfoAtRequest = await fetchTokenInfo(); } catch (_) {}
  pushGmailDiag({ type: 'api_request', path, method: (init && 'method' in (init as any) && (init as any).method) ? (init as any).method : 'GET', tokenInfo: tokenInfoAtRequest });
  
  // Check if localhost and if we have a stored GIS token
  const isLocalhost = typeof window !== 'undefined' && 
    (window.location.hostname === 'localhost' || 
     window.location.hostname === '127.0.0.1' || 
     window.location.hostname.startsWith('192.168.'));
  
  if (isLocalhost) {
    const localhostToken = localStorage.getItem('LOCALHOST_ACCESS_TOKEN');
    const tokenExpiry = localStorage.getItem('LOCALHOST_TOKEN_EXPIRY');
    
    if (localhostToken && tokenExpiry && Date.now() < parseInt(tokenExpiry)) {
      // Use direct Gmail API with localhost token
      pushGmailDiag({ type: 'using_localhost_direct_api', path });
      const directUrl = `https://gmail.googleapis.com/gmail/v1/users/me${path}`;
      let res = await fetch(directUrl, {
        ...init,
        headers: {
          'Authorization': `Bearer ${localhostToken}`,
          'Content-Type': 'application/json',
          ...(init?.headers || {})
        }
      });
      
      if (res.ok) {
        const text = await res.text();
        pushGmailDiag({ type: 'localhost_direct_api_success', path, status: res.status });
        try {
          return JSON.parse(text) as T;
        } catch (_) {
          return undefined as unknown as T;
        }
      } else {
        pushGmailDiag({ type: 'localhost_direct_api_failed', path, status: res.status });
        // Fall through to proxy attempt
      }
    }
  }
  
  // Default: use server proxy
  // Check if we should use SWA CLI port for localhost
  let apiBase = '';
  if (isLocalhost && window.location.port.startsWith('517')) {
    // Running on Vite dev server, check if SWA CLI is available on port 4280
    try {
      const swaResponse = await fetch('http://localhost:4280/api/google-me', {
        method: 'HEAD',
        credentials: 'include',
        signal: AbortSignal.timeout(1000) // 1 second timeout
      });
      if (swaResponse.status !== 0 && swaResponse.status !== 404) {
        apiBase = 'http://localhost:4280';
        pushGmailDiag({ type: 'api_using_swa_cli', port: '4280', path });
      }
    } catch (e) {
      // SWA CLI not available, use default
    }
  }
  
  const apiUrl = apiBase ? `${apiBase}${GMAIL_PROXY_BASE}${path}` : `${GMAIL_PROXY_BASE}${path}`;
  let res = await fetch(apiUrl, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    },
    credentials: 'include'
  });
  if (!res.ok) {
    // If server returns 404, check if we have an existing localhost token to use
    // But don't auto-initialize auth - that should only happen on user action
    if (res.status === 404 && isLocalhost) {
      pushGmailDiag({ type: 'server_proxy_404', path });
      // Only use existing token if available - don't trigger new auth
      const clientToken = getLocalhostToken();
      
      if (clientToken) {
        pushGmailDiag({ type: 'using_existing_localhost_token', path });
        const directUrl = `https://gmail.googleapis.com/gmail/v1/users/me${path}`;
        const clientRes = await fetch(directUrl, {
          ...init,
          headers: {
            'Authorization': `Bearer ${clientToken}`,
            'Content-Type': 'application/json',
            ...(init?.headers || {})
          }
        });
        
        if (clientRes.ok) {
          const text = await clientRes.text();
          pushGmailDiag({ type: 'localhost_token_success', path, status: clientRes.status });
          try {
            return JSON.parse(text) as T;
          } catch (_) {
            return undefined as unknown as T;
          }
        } else {
          pushGmailDiag({ type: 'localhost_token_api_error', path, status: clientRes.status });
          // Fall through to error handling
        }
      } else {
        pushGmailDiag({ type: 'server_proxy_404_no_token', path });
        // Don't auto-initialize auth here - let it fail gracefully
        // User should click "Sign in" button to authenticate
      }
    }
    
    let message = `Gmail API error ${res.status}`;
    let details: unknown;
    try {
      const text = await res.text();
      if (text) {
        try {
          const body = JSON.parse(text);
          details = body;
          // Common Google error shape: { error: { code, message, status, errors } }
          const googleMessage = (body as any)?.error?.message || (body as any)?.message;
          if (googleMessage) message = googleMessage as string;
        } catch (_) {
          details = { nonJsonBody: text.slice(0, 256) };
        }
      }
    } catch (_) {
      // ignore parse errors
    }
    const body = sanitize(details);
    // Detect Gmail's 403 FORBIDDEN variant that can occur with quota or restricted data
    const statusText = (body as any)?.error?.status || (body as any)?.status;
    const reason = Array.isArray((body as any)?.error?.errors) ? (body as any).error.errors.map((e: any) => e?.reason).join(',') : undefined;
    pushGmailDiag({ type: 'api_error', path, status: res.status, message, contentType: res.headers.get('content-type') || undefined, details: body, statusText, reason });
    // If the server proxy reports an unauthenticated session, initiate the
    // server-managed login flow so the server can set the required cookies.
    // However, rate limit these redirects to avoid excessive popups.
    try {
      const unauth = (body as any)?.error === 'unauthenticated' || (body as any)?.authenticated === false;
      if (typeof window !== 'undefined' && res.status === 401 && unauth) {
        // Rate limit server login redirects
        const lastServerRedirect = Number(localStorage.getItem('jmail_last_server_redirect') || '0');
        const minIntervalMs = 60000; // 1 minute minimum between server redirects
        const now = Date.now();
        if (lastServerRedirect && (now - lastServerRedirect) < minIntervalMs) {
          pushGmailDiag({ type: 'server_redirect_rate_limited', path, lastRedirect: lastServerRedirect, minInterval: minIntervalMs });
          throw new GmailApiError(`Server authentication rate limited. Please wait ${Math.ceil((minIntervalMs - (now - lastServerRedirect)) / 1000)} seconds before trying again.`, res.status, details);
        }
        pushGmailDiag({ type: 'server_login_redirect', path, reason: 'unauthenticated_proxy' });
        // Preserve current location so server can return after auth
        const returnTo = typeof window !== 'undefined' ? window.location.href : '/';
        // Resolve server base for API endpoints. Prefer explicit runtime config
        // via `window.__ENV__.APP_BASE_URL` or Vite env `import.meta.env.VITE_APP_BASE_URL`.
        const resolveServerBase = () => {
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
        };
        const serverBase = resolveServerBase();
        const loginUrl = new URL('/api/google-login', serverBase);
        loginUrl.searchParams.set('return_to', returnTo);
        // Before redirecting, perform a short probe to check if the API host is reachable
        // and not returning the frontend SPA HTML for /api routes. If the probe looks
        // suspicious, present a user confirm dialog instead of blindly navigating.
        let proceed = true;
        try {
          const probeUrl = new URL('/api/gmail/profile', serverBase).toString();
          const ctrl = new AbortController();
          const id = setTimeout(() => ctrl.abort(), 3000);
          const r2 = await fetch(probeUrl, { method: 'GET', credentials: 'include', signal: ctrl.signal });
          clearTimeout(id);
          let bodyText: string | undefined = undefined;
          try { bodyText = await r2.text(); } catch (_) { bodyText = undefined; }
          const isSpaHtml404 = r2.status === 404 && typeof bodyText === 'string' && /<!doctype html|<html/i.test(bodyText || '');
          const probeResult = { probeUrl, status: r2.status, isSpaHtml404 };
          pushGmailDiag({ type: 'server_probe', ...probeResult });
          // Fire-and-forget: post probe telemetry to server diagnostics endpoint if available
          try {
            void fetch(new URL('/api/collect-diagnostics', serverBase).toString(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'server_probe', probe: probeResult, timestamp: new Date().toISOString(), location: typeof window !== 'undefined' ? window.location.href : undefined }) });
          } catch (_) {}
          if (isSpaHtml404) {
            const ok = window.confirm('API host appears to be serving frontend HTML (404). The API may not be running. Open server login anyway?');
            if (!ok) proceed = false;
          } else if (!r2.ok) {
            // For 401 (unauthenticated), proceed automatically without confirmation
            if (r2.status === 401) {
              proceed = true;
            } else {
              const ok = window.confirm(`API probe returned ${r2.status}. Open server login anyway?`);
              if (!ok) proceed = false;
            }
          }
        } catch (probeErr) {
          pushGmailDiag({ type: 'server_probe_error', error: probeErr instanceof Error ? probeErr.message : String(probeErr) });
          try {
            void fetch(new URL('/api/collect-diagnostics', serverBase).toString(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'server_probe_error', error: probeErr instanceof Error ? probeErr.message : String(probeErr), timestamp: new Date().toISOString(), location: typeof window !== 'undefined' ? window.location.href : undefined }) });
          } catch (_) {}
          const ok = window.confirm('Could not reach API host. Open server login anyway?');
          if (!ok) proceed = false;
        }
        if (!proceed) throw new GmailApiError('Server login cancelled by user', 401, details);
        
        // Record that we're redirecting to server login to enforce rate limiting
        localStorage.setItem('jmail_last_server_redirect', String(Date.now()));
        
        // Perform a full-page navigation to establish server session cookies
        window.location.href = loginUrl.toString();
        // Halt further execution — navigation will unload the page.
        throw new GmailApiError('Redirecting to server login', 401, details);
      }
    } catch (_) {}
    throw new GmailApiError(message, res.status, details);
  }
  // Some Gmail endpoints (e.g., batchModify) return 204 No Content.
  // Safely handle empty bodies and non-JSON responses.
  try {
    const text = await res.text();
    pushGmailDiag({ type: 'api_response', path, status: res.status, contentType: res.headers.get('content-type') || undefined, bodyLength: (text || '').length });
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch (_) {
      // If the response isn't JSON, return undefined to avoid throwing
      return undefined as unknown as T;
    }
  } catch (_) {
    return undefined as unknown as T;
  }
}

export async function listLabels(): Promise<GmailLabel[]> {
  const data = await api<{ labels?: GmailLabel[] }>(`/labels`);
  // Defensive: ensure we don't read .labels from undefined response bodies
  if (!data || !Array.isArray((data as any).labels)) {
    pushGmailDiag({ type: 'labels_missing_or_invalid', dataSummary: summarizeListData(data) });
    return [];
  }
  return (data.labels as GmailLabel[]) || [];
}

export async function listInboxMessageIds(maxResults = 25, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }> {
  const q = new URLSearchParams({ maxResults: String(maxResults) });
  q.append('labelIds', 'INBOX');
  if (pageToken) q.set('pageToken', pageToken);
  
  if (import.meta.env.DEV) {
    console.log(`[Gmail API] listInboxMessageIds: maxResults=${maxResults}, pageToken=${pageToken || 'none'}, query=${q.toString()}`);
  }
  
  const data = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
    `/messages?${q.toString()}`
  );
  const ids = (data?.messages || []).map((m) => m.id);
  
  if (import.meta.env.DEV) {
    console.log(`[Gmail API] listInboxMessageIds response: ${ids.length} messages, nextToken: ${!!data?.nextPageToken}, resultSample:`, ids.slice(0, 3));
  }
  
  if (!ids.length) {
    pushGmailDiag({ type: 'inbox_empty', fn: 'listInboxMessageIds', params: { maxResults, pageToken, labelIds: 'INBOX' }, data: summarizeListData(data) });
  } else {
    pushGmailDiag({ type: 'inbox_page', fn: 'listInboxMessageIds', params: { maxResults, pageToken, labelIds: 'INBOX' }, count: ids.length, nextPageToken: data?.nextPageToken });
  }
  return { ids, nextPageToken: data?.nextPageToken };
}

export async function listMessageIdsByLabelId(labelId: string, maxResults = 25, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }> {
  const q = new URLSearchParams({ maxResults: String(maxResults) });
  q.append('labelIds', labelId);
  if (pageToken) q.set('pageToken', pageToken);
  const data = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
    `/messages?${q.toString()}`
  );
  return { ids: (data?.messages || []).map((m) => m.id), nextPageToken: data?.nextPageToken };
}

export async function listThreadIdsByLabelId(labelId: string, maxResults = 25, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }> {
  const q = new URLSearchParams({ maxResults: String(maxResults) });
  q.append('labelIds', labelId);
  if (pageToken) q.set('pageToken', pageToken);
  const data = await api<{ threads?: { id: string }[]; nextPageToken?: string }>(
    `/threads?${q.toString()}`
  );
  
  const result = { ids: (data?.threads || []).map((t) => t.id), nextPageToken: data?.nextPageToken };
  
  // Debug logging for thread listing
  if (import.meta.env.DEV && labelId === 'INBOX') {
    console.log(`[Gmail API] listThreadIds: ${result.ids.length} threads, nextToken: ${!!result.nextPageToken}, pageToken: ${pageToken || 'none'}`);
  }
  
  return result;
}

export async function getMessageMetadata(id: string): Promise<GmailMessage> {
  type GmailMessageApiResponse = {
    id: string;
    threadId: string;
    snippet?: string;
    internalDate?: string | number;
    labelIds?: string[];
    payload?: { headers?: { name: string; value: string }[] };
  };
  const data = await api<GmailMessageApiResponse>(
    `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc`
  );
  const headers: Record<string, string> = {};
  for (const h of data.payload?.headers || []) headers[h.name] = h.value;
  const message: GmailMessage = {
    id: data.id,
    threadId: data.threadId,
    snippet: data.snippet,
    headers,
    labelIds: data.labelIds || [],
    internalDate: data.internalDate ? Number(data.internalDate) : undefined
  };
  return message;
}

export async function batchModify(ids: string[], addLabelIds: string[], removeLabelIds: string[]) {
  await api<unknown>(`/messages/batchModify`, {
    method: 'POST',
    body: JSON.stringify({ ids, addLabelIds, removeLabelIds })
  });
}

export async function getMessageFull(id: string): Promise<GmailMessage> {
  type GmailMessageApiResponse = {
    id: string;
    threadId: string;
    snippet?: string;
    internalDate?: string | number;
    labelIds?: string[];
    payload?: { mimeType?: string; body?: { data?: string; size?: number }; parts?: any[]; headers?: { name: string; value: string }[] };
  };
  let data: GmailMessageApiResponse | undefined;
  try {
    data = await api<GmailMessageApiResponse>(`/messages/${id}?format=full`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isScopeOrPermission = e instanceof GmailApiError && e.status === 403 && typeof msg === 'string' && (msg.toLowerCase().includes('metadata scope') || msg.toLowerCase().includes('insufficient') || msg.toLowerCase().includes('permission'));
    if (isScopeOrPermission) {
      // Do NOT attempt an automatic interactive scope upgrade here.
      // Surface a consistent error so the UI can offer a "Grant access" button.
      try {
        const before = await fetchTokenInfo();
        const hasBodyScopes = !!before?.scope && (before.scope.includes('gmail.readonly') || before.scope.includes('gmail.modify'));
        pushGmailDiag({ type: 'tokeninfo_snapshot', id, tokenInfo: before, hasBodyScopes });
      } catch (_) {}
      pushGmailDiag({ type: 'scope_upgrade_needed', id, error: msg, autoPromptSuppressed: true });
      throw new GmailApiError('Additional Gmail permissions are required to read this message body. Please grant access.', 403, { reason: 'scope_upgrade_required', id });
    } else {
      throw e;
    }
  }
  const headers: Record<string, string> = {};
  for (const h of data.payload?.headers || []) headers[h.name] = h.value;
  function decode(b64?: string): string | undefined {
    if (!b64) return undefined;
    try {
      // Normalize URL-safe base64 and fix padding
      let base64 = b64.replace(/-/g, '+').replace(/_/g, '/');
      const pad = base64.length % 4;
      if (pad) base64 = base64 + '='.repeat(4 - pad);
      // Decode to binary string
      const binary = atob(base64);
      // Convert binary string to UTF-8 string reliably
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (_) {
      try {
        // Fallback to legacy escape/unescape path
        return decodeURIComponent(escape(atob(b64.replace(/-/g, '+').replace(/_/g, '/'))));
      } catch { return undefined; }
    }
  }
  function toStandardBase64(b64url?: string): string | undefined {
    if (!b64url) return undefined;
    try {
      let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      const pad = b64.length % 4;
      if (pad) b64 = b64 + '='.repeat(4 - pad);
      return b64;
    } catch { return undefined; }
  }
  function approximateBase64Bytes(stdB64: string): number {
    try {
      const len = stdB64.length;
      const pad = stdB64.endsWith('==') ? 2 : (stdB64.endsWith('=') ? 1 : 0);
      return Math.max(0, Math.floor(len * 3 / 4) - pad);
    } catch (_) { return 0; }
  }
  async function getAttachmentData(messageId: string, attachmentId: string): Promise<string | undefined> {
    type AttachmentResponse = { data?: string; size?: number };
    try {
      const res = await api<AttachmentResponse>(`/messages/${messageId}/attachments/${attachmentId}`);
      return res?.data;
    } catch (e) {
      pushGmailDiag({ type: 'attachment_fetch_error', fn: 'getMessageFull', id: messageId, attachmentId, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }
  async function extractText(payload: any): Promise<{ text?: string; html?: string; attachments: GmailAttachment[]; diag: any }> {
    if (!payload) return { diag: { reason: 'no_payload' } } as any;
    const out: { text?: string; html?: string } = {};
    const attachments: GmailAttachment[] = [];
    const diagnostics = { rootMimeType: payload?.mimeType, visited: 0, textParts: 0, htmlParts: 0, attachmentFetches: 0, structure: [] as Array<{ mimeType?: string; hasData?: boolean; hasAttachmentId?: boolean; parts?: number; size?: number }> };
    const stack = [payload];
    while (stack.length) {
      const p = stack.pop();
      if (!p) continue;
      diagnostics.visited++;
      diagnostics.structure.push({ mimeType: p.mimeType, hasData: !!p?.body?.data, hasAttachmentId: !!p?.body?.attachmentId, parts: Array.isArray(p.parts) ? p.parts.length : undefined, size: p?.body?.size });
      const filename = (p.filename || '').trim();
      const mimeType: string | undefined = p.mimeType;
      const size = typeof p?.body?.size === 'number' ? p.body.size : undefined;
      const attachmentId: string | undefined = p?.body?.attachmentId;
      const isAttachment = !!filename;
      // Inline data
      if (p.mimeType === 'text/plain') {
        if (p.body?.data) {
          out.text = (out.text || '') + (decode(p.body.data) || '');
          diagnostics.textParts++;
        } else if (p.body?.attachmentId) {
          const adata = await getAttachmentData(id, p.body.attachmentId);
          if (adata) {
            out.text = (out.text || '') + (decode(adata) || '');
            diagnostics.attachmentFetches++;
          }
        }
      }
      if (p.mimeType === 'text/html') {
        if (p.body?.data) {
          out.html = (out.html || '') + (decode(p.body.data) || '');
          diagnostics.htmlParts++;
        } else if (p.body?.attachmentId) {
          const adata = await getAttachmentData(id, p.body.attachmentId);
          if (adata) {
            out.html = (out.html || '') + (decode(adata) || '');
            diagnostics.attachmentFetches++;
          }
        }
      }
      // Collect attachment metadata and best-effort text content for text-like attachments
      if (isAttachment) {
        let textContent: string | undefined = undefined;
        let dataBase64: string | undefined = undefined;
        const isTextLike = !!mimeType && (/^text\//i.test(mimeType) || /(json|xml|csv|html)/i.test(mimeType));
        const isDocLike = !!mimeType && /(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)/i.test(mimeType);
        const MAX_INLINE_BYTES = 10 * 1024 * 1024; // 10 MB cap for inline AI processing
        if (isTextLike) {
          try {
            if (p.body?.data) {
              textContent = decode(p.body.data) || undefined;
            } else if (attachmentId) {
              const adata = await getAttachmentData(id, attachmentId);
              if (adata) {
                textContent = decode(adata) || undefined;
                diagnostics.attachmentFetches++;
              }
            }
          } catch (_) {}
        }
        // For select document types (pdf/doc/docx), capture a limited base64 for AI inline ingestion
        try {
          const knownTooLarge = typeof size === 'number' ? size > MAX_INLINE_BYTES : false;
          if (isDocLike && !knownTooLarge) {
            let raw: string | undefined = undefined;
            if (p.body?.data) {
              raw = p.body.data;
            } else if (attachmentId) {
              raw = await getAttachmentData(id, attachmentId);
              if (raw) diagnostics.attachmentFetches++;
            }
            if (raw) {
              const std = toStandardBase64(raw);
              if (std) {
                const approx = approximateBase64Bytes(std);
                if (approx <= MAX_INLINE_BYTES) {
                  dataBase64 = std;
                }
              }
            }
          }
        } catch (_) {}
        attachments.push({ id: attachmentId, filename, mimeType, size, textContent, dataBase64 });
      }
      if (Array.isArray(p.parts)) for (const c of p.parts) stack.push(c);
    }
    
    // Post-process: if we have both text and html from multipart/alternative, prefer HTML
    if (out.text && out.html && payload?.mimeType === 'multipart/alternative') {
      pushGmailDiag({ type: 'multipart_alternative_detected', id, preferringHtml: true, textLen: out.text.length, htmlLen: out.html.length });
      out.text = undefined; // Remove text to avoid duplication, keep HTML
    }
    
    return { ...out, attachments, diag: diagnostics };
  }
  const body = await extractText(data.payload);
  pushGmailDiag({
    type: 'message_full_extracted',
    id: data.id,
    threadId: data.threadId,
    payloadMimeType: data.payload?.mimeType,
    hasText: !!body.text,
    hasHtml: !!body.html,
    textLen: body.text?.length,
    htmlLen: body.html?.length,
    attachmentFetches: (body as any)?.diag?.attachmentFetches,
    visitedParts: (body as any)?.diag?.visited,
    alternativeParts: (body as any)?.diag?.alternativeParts,
    structure: (body as any)?.diag?.structure,
    attachmentsLen: Array.isArray((body as any)?.attachments) ? (body as any).attachments.length : 0
  });
  const message: GmailMessage = {
    id: data.id,
    threadId: data.threadId,
    snippet: data.snippet,
    headers,
    labelIds: data.labelIds || [],
    internalDate: data.internalDate ? Number(data.internalDate) : undefined,
    bodyText: body.text,
    bodyHtml: body.html,
    attachments: body.attachments
  };
  return message;
}

export async function sendMessageRaw(raw: string, threadId?: string): Promise<{ id: string; threadId: string }> {
  type SendResponse = { id: string; threadId: string };
  const body: Record<string, unknown> = { raw };
  if (threadId) body.threadId = threadId;
  return await api<SendResponse>(`/messages/send`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export async function getMessageRaw(id: string): Promise<string> {
  type GmailMessageRawResponse = {
    id: string;
    threadId: string;
    raw?: string;
  };
  const data = await api<GmailMessageRawResponse>(`/messages/${id}?format=raw`);
  if (!data.raw) {
    throw new GmailApiError('Raw email source not available', 404);
  }
  // Decode base64url-encoded raw email (RFC 2822 format)
  try {
    // Gmail API returns raw email as base64url-encoded string
    // Normalize URL-safe base64 and fix padding
    let base64 = data.raw.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    if (pad) base64 = base64 + '='.repeat(4 - pad);
    // Decode to binary string (RFC 2822 emails are ASCII-compatible)
    const binary = atob(base64);
    // Convert binary string to UTF-8 string reliably
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (e) {
    // Fallback: try simple atob if TextDecoder fails
    try {
      let base64 = data.raw.replace(/-/g, '+').replace(/_/g, '/');
      const pad = base64.length % 4;
      if (pad) base64 = base64 + '='.repeat(4 - pad);
      return atob(base64);
    } catch (fallbackError) {
      throw new GmailApiError(`Failed to decode raw email: ${e instanceof Error ? e.message : String(e)}`, 500);
    }
  }
}

// Quick profile ping to gauge account message/thread totals for diagnostics
export async function getProfile(): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string }> {
  const data = await api<{ emailAddress?: string; messagesTotal?: number; threadsTotal?: number; historyId?: string }>(`/profile`);
  if (!data || typeof (data as any).emailAddress !== 'string') {
    pushGmailDiag({ type: 'profile_missing_or_invalid', dataSummary: summarizeListData(data) });
    // Return a safe default so callers don't crash
    return { emailAddress: '', messagesTotal: 0, threadsTotal: 0, historyId: '' };
  }
  pushGmailDiag({ type: 'profile', emailAddress: data.emailAddress, messagesTotal: data.messagesTotal, threadsTotal: data.threadsTotal });
  return data as { emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string };
}

export async function listHistory(startHistoryId: string): Promise<any> {
  const q = new URLSearchParams();
  q.set('startHistoryId', String(startHistoryId));
  // Request thread/message changes; let caller decide how to interpret
  // Use maxResults conservatively to avoid huge payloads
  q.set('maxResults', '1000');
  const data = await api<any>(`/history?${q.toString()}`);
  pushGmailDiag({ type: 'history_list', startHistoryId, dataSummary: Array.isArray((data || {}).history) ? { entries: (data as any).history.length } : undefined });
  return data;
}

export async function createLabel(name: string): Promise<GmailLabel & { id: string }> {
  const data = await api<GmailLabel & { id: string }>(`/labels`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    })
  });
  pushGmailDiag({ type: 'label_created', id: data.id, name: data.name });
  return data;
}

export async function getLabel(labelId: string): Promise<GmailLabel & { id: string }> {
  type LabelResponse = GmailLabel & {
    messageListVisibility?: string;
    labelListVisibility?: string;
    messagesTotal?: number;
    messagesUnread?: number;
    threadsTotal?: number;
    threadsUnread?: number;
  };
  const data = await api<LabelResponse>(`/labels/${encodeURIComponent(labelId)}`);
  if (!data || typeof (data as any).id !== 'string') {
    pushGmailDiag({ type: 'label_missing_or_invalid', id: labelId, dataSummary: summarizeListData(data) });
    // Return a safe minimal label so callers can continue
    return { id: labelId, name: '', type: 'user', messageListVisibility: undefined, labelListVisibility: undefined } as GmailLabel & { id: string };
  }
  pushGmailDiag({ type: 'label', id: data.id, name: (data as any)?.name, messagesTotal: (data as any)?.messagesTotal, threadsTotal: (data as any)?.threadsTotal, messagesUnread: (data as any)?.messagesUnread, threadsUnread: (data as any)?.threadsUnread });
  return data as GmailLabel & { id: string };
}

export async function getThreadSummary(threadId: string): Promise<{ thread: import('$lib/types').GmailThread; messages: import('$lib/types').GmailMessage[] }> {
  type ThreadResponse = {
    id: string;
    messages?: Array<{
      id: string;
      threadId: string;
      snippet?: string;
      internalDate?: string | number;
      labelIds?: string[];
      payload?: { headers?: { name: string; value: string }[] };
    }>;
  };
  // Use Gmail threads.get which returns the entire thread with message metadata
  const data = await api<ThreadResponse>(`/threads/${encodeURIComponent(threadId)}`);
  const msgsRaw = data?.messages || [];
  if (!msgsRaw.length) throw new GmailApiError('Thread not found or empty', 404);
  const outMsgs: import('$lib/types').GmailMessage[] = msgsRaw.map((m) => {
    const headers: Record<string, string> = {};
    for (const h of m.payload?.headers || []) headers[h.name] = h.value;
    return {
      id: m.id,
      threadId: m.threadId,
      snippet: m.snippet,
      headers,
      labelIds: m.labelIds || [],
      internalDate: m.internalDate ? Number(m.internalDate) : undefined
    } satisfies import('$lib/types').GmailMessage;
  });
  // Build thread summary like inbox
  const labelMap: Record<string, true> = {};
  const last: { from?: string; subject?: string; date?: number } = {};
  for (const m of outMsgs) {
    for (const lid of m.labelIds || []) labelMap[lid] = true;
    const date = m.internalDate || Date.parse(m.headers?.Date || '');
    if (!last.date || (date && date > last.date)) {
      last.from = m.headers?.From;
      last.subject = m.headers?.Subject;
      last.date = date;
    }
  }
  const thread: import('$lib/types').GmailThread = {
    threadId,
    messageIds: outMsgs.map((m) => m.id),
    lastMsgMeta: last,
    labelIds: Object.keys(labelMap)
  };
  return { thread, messages: outMsgs };
}

function summarizeListData(data: unknown) {
  try {
    const d: any = data || {};
    return { messagesLen: Array.isArray(d.messages) ? d.messages.length : undefined, nextPageToken: d.nextPageToken };
  } catch (_) {
    return undefined;
  }
}

function sanitize(value: unknown) {
  try {
    if (!value) return value;
    const v: any = value;
    // Best-effort sanitization: drop headers/tokens if present
    if (v && typeof v === 'object') {
      if ('Authorization' in v) delete v.Authorization;
      if ('access_token' in v) delete v.access_token;
    }
    return v;
  } catch (_) {
    return undefined;
  }
}

// Non-cryptographic token fingerprint so we can correlate diagnostics across requests
function fingerprintToken(token: string): string {
  try {
    let hash = 2166136261; // FNV-1a 32-bit offset basis
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = (hash * 16777619) >>> 0; // multiply prime and keep uint32
    }
    return hash.toString(16).padStart(8, '0');
  } catch (_) {
    return 'na';
  }
}

