<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { messages, threads } from "$lib/stores/threads";
  import { archiveThread, trashThread, spamThread, undoLast } from "$lib/queue/intents";
  import { snoozeThreadByRule, manualUnsnoozeThread, isSnoozedThread } from "$lib/snooze/actions";
  import { settings } from "$lib/stores/settings";
  import Button from "$lib/buttons/Button.svelte";
  import { show as showSnackbar } from "$lib/containers/snackbar";
  import Card from "$lib/containers/Card.svelte";
  import Divider from "$lib/utils/Divider.svelte";
  import LoadingIndicator from "$lib/forms/LoadingIndicator.svelte";
  import { getMessageFull, copyGmailDiagnosticsToClipboard, sendMessageRaw, getProfile, getMessageRaw } from "$lib/gmail/api";
  import { getThreadSummary } from "$lib/gmail/api";
  import { getDB } from "$lib/db/indexeddb";
  import { acquireTokenForScopes, SCOPES, fetchTokenInfo, signOut, acquireTokenInteractive } from "$lib/gmail/auth";
import {
  aiSummarizeEmailWithDiagnostics,
  aiSummarizeSubject,
  aiDraftReply,
  findUnsubscribeTarget,
  aiExtractUnsubscribeUrl,
  getFriendlyAIErrorMessage,
  AIProviderError,
  aiSummarizeAttachment,
  simpleHash,
  prepareEmailSummaryContext,
  type AISummaryDiagnostics
} from "$lib/ai/providers";
  import { filters, deleteSavedFilter, type ThreadFilter } from "$lib/stores/filters";
  import { applyFilterToThreads } from "$lib/stores/filters";
  import FilterBar from "$lib/utils/FilterBar.svelte";
  import Menu from "$lib/containers/Menu.svelte";
  import MenuItem from "$lib/containers/MenuItem.svelte";
  import Icon from "$lib/misc/_icon.svelte";
  import iconGmail from "$lib/icons/gmail";
import iconBack from "@ktibow/iconset-material-symbols/chevron-left";
import iconForward from "@ktibow/iconset-material-symbols/chevron-right";
import iconArrowDown from "@ktibow/iconset-material-symbols/arrow-downward";
import iconArrowUp from "@ktibow/iconset-material-symbols/arrow-upward";
import iconSparkles from "@ktibow/iconset-material-symbols/auto-awesome";
import iconCopy from "@ktibow/iconset-material-symbols/content-copy-outline";
import iconMore from "@ktibow/iconset-material-symbols/more-vert";
import iconFilter from "@ktibow/iconset-material-symbols/filter-list";
import iconArchive from "@ktibow/iconset-material-symbols/archive";
import iconDelete from "@ktibow/iconset-material-symbols/delete";
import iconReportSpam from "@ktibow/iconset-material-symbols/report";
import iconSnooze from "@ktibow/iconset-material-symbols/snooze";
import iconUnsnooze from "@ktibow/iconset-material-symbols/alarm-off";
import iconSummarize from "@ktibow/iconset-material-symbols/summarize";
import iconReply from "@ktibow/iconset-material-symbols/reply";
import iconUnsubscribe from "@ktibow/iconset-material-symbols/unsubscribe";
import iconMarkEmailUnread from "@ktibow/iconset-material-symbols/mark-email-unread";
import iconBugReport from "@ktibow/iconset-material-symbols/bug-report";
import iconKey from "@ktibow/iconset-material-symbols/key";
import iconLogin from "@ktibow/iconset-material-symbols/login";
import iconSchool from "@ktibow/iconset-material-symbols/school";
import iconRefresh from "@ktibow/iconset-material-symbols/refresh";
import iconDownload from "@ktibow/iconset-material-symbols/download";
import iconClose from "@ktibow/iconset-material-symbols/close";
import iconTask from "@ktibow/iconset-material-symbols/task-alt";
import iconSubject from "@ktibow/iconset-material-symbols/subject";
import iconScrollDown from "@ktibow/iconset-material-symbols/keyboard-arrow-down";
import iconOpenInNew from "@ktibow/iconset-material-symbols/open-in-new";
import iconExpand from "@ktibow/iconset-material-symbols/keyboard-arrow-down";
  import Dialog from "$lib/containers/Dialog.svelte";
  import { searchQuery } from "$lib/stores/search";
  import RecipientBadges from "$lib/utils/RecipientBadges.svelte";
  import { getGmailMessageUrl, getGmailThreadUrl, openGmailPopup, openGmailMessagePopup } from "$lib/utils/gmail-links";
  import CalendarPopover from "$lib/snooze/CalendarPopover.svelte";
import Layer from "$lib/misc/Layer.svelte";
import BottomSheet from "$lib/containers/BottomSheet.svelte";
  // Derive threadId defensively in case params are briefly undefined during navigation
  const threadId = $derived((() => {
    try { const id = $page?.params?.threadId; if (id) return id; } catch {}
    try {
      if (typeof location !== 'undefined') {
        const m = location.pathname.match(/\/viewer\/([^\/?#]+)/);
        return m ? decodeURIComponent(m[1]) : '';
      }
    } catch {}
    return '';
  })());
  // Guard against any undefined/non-thread entries that may transiently appear in the store
  const allThreads = $derived(($threads || []).filter((t) => !!t && typeof (t as any).threadId === 'string'));
  const currentThread = $derived(allThreads.find((t) => t.threadId === threadId));
  // Decode basic HTML entities (e.g., &#39; → ') for plain-text/snippet render paths
  function decodeEntities(input?: string): string {
    try {
      if (!input) return '';
      const map: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#34;': '"',
        '&#39;': "'",
        '&apos;': "'",
        '&nbsp;': ' '
      };
      return input.replace(/&(amp|lt|gt|quot|apos|nbsp);|&#(34|39);/g, (m) => map[m] ?? m);
    } catch { return input || ''; }
  }

  // Convert URLs in plain text to clickable links that open in new tabs
  function linkifyText(text: string): string {
    if (!text) return '';
    
    // URL regex pattern that matches http, https, and www links
    const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+|www\.[^\s<>"{}|\\^`[\]]+)/gi;
    
    return text.replace(urlRegex, (url) => {
      // Add protocol if missing for www links
      const href = url.toLowerCase().startsWith('www.') ? `https://${url}` : url;
      // Escape any HTML characters in the URL for display
      const displayUrl = url.replace(/[&<>"']/g, (char) => {
        const entities: Record<string, string> = {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        };
        return entities[char] || char;
      });
      return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color: rgb(var(--m3-scheme-primary)); text-decoration: underline;">${displayUrl}</a>`;
    });
  }

  // Svelte action to set target="_blank" on all links in HTML content after it's rendered
  function processHtmlLinks(element: HTMLElement) {
    if (!element) return;
    
    const links = element.querySelectorAll('a');
    links.forEach(link => {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    });
    
    // Return cleanup function (not needed here but required by Svelte action interface)
    return {
      destroy() {
        // No cleanup needed
      }
    };
  }
  async function copyText(text: string) { 
    try {
      await navigator.clipboard.writeText(text);
      showSnackbar({ message: 'Copied to clipboard', closable: true });
    } catch (e) {
      console.error('[Viewer] Failed to copy text:', e);
      showSnackbar({ message: 'Failed to copy text', closable: true });
    }
  }
  let loadingMap: Record<string, boolean> = $state({});
  let errorMap: Record<string, string> = $state({});
  let autoTried: Record<string, boolean> = $state({});
  // Local AI action busy flags (prevents duplicate requests and enables immediate feedback)
  let summarizing: boolean = $state(false);
  let replying: boolean = $state(false);
  let extractingUnsub: boolean = $state(false);
  let unsubscribeDialogOpen = $state(false);
  let unsubscribeMailtoInfo: { to: string; subject: string; body: string; target: string } | null = $state(null);
  let sendingUnsubscribeEmail = $state(false);
  
  // Parse a mailto: URL to extract recipient, subject, and body
  function parseMailtoUrl(mailto: string): { to: string; subject: string; body: string } | null {
    try {
      if (!mailto.startsWith('mailto:')) return null;
      const url = new URL(mailto);
      const to = url.pathname || '';
      const subject = url.searchParams.get('subject') || 'Unsubscribe';
      const body = url.searchParams.get('body') || 'Please unsubscribe me from this mailing list.';
      return { to, subject, body };
    } catch {
      // Fallback for malformed mailto: links
      const match = mailto.match(/^mailto:([^?]+)/i);
      if (match && match[1]) {
        return { to: match[1], subject: 'Unsubscribe', body: 'Please unsubscribe me from this mailing list.' };
      }
      return null;
    }
  }

  // Create RFC 2822 raw email for sending
  function createRawEmail(from: string, to: string, subject: string, body: string): string {
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const email = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      body
    ].join('\r\n');
    // Base64 encode for Gmail API (URL-safe base64)
    const base64 = btoa(unescape(encodeURIComponent(email)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return base64;
  }
  let aiSubjectSummary: string | null = $state(null);
  let aiBodySummary: string | null = $state(null);
  let aiDiagnostics: AISummaryDiagnostics | null = $state(null);
  let diagnosticsSheetOpen: boolean = $state(false);
  let lastSummarizedMid: string | null = $state(null);
  // Recruiting moderation diagnostic state
  let recruitingDiagOpen: boolean = $state(false);
  let recruitingDiagResult: any = $state(null);
  let runningRecruitingDiag: boolean = $state(false);
  // Attachment summary dialog state
  let attDialogOpen: boolean = $state(false);
  let attDialogTitle: string | null = $state(null);
  let attDialogText: string | null = $state(null);
  let attBusy: Record<string, boolean> = $state({});
  // Filter popup state
  let filterPopupOpen: boolean = $state(false);
  // Snooze menu state
  let snoozeMenuOpen: boolean = $state(false);
  let snoozeDetails: HTMLDetailsElement | null = $state(null);
  // Message expansion state - track which messages are expanded (default: only the latest)
  let expandedMessages: Set<string> = $state(new Set());
  // Derive adjacent thread navigation using Inbox context + global search/filter/sort
  const inboxThreads = $derived((allThreads || []).filter((t) => (t.labelIds || []).includes('INBOX')));
  const visibleCandidates = $derived((() => {
    const q = ($searchQuery || '').trim().toLowerCase();
    if (!q) return inboxThreads;
    return inboxThreads.filter((t) => {
      const subj = (t.lastMsgMeta.subject || '').toLowerCase();
      const from = (t.lastMsgMeta.from || '').toLowerCase();
      return subj.includes(q) || from.includes(q);
    });
  })());
  const filteredCandidates = $derived(applyFilterToThreads(visibleCandidates, $messages || {}, $filters.active));
  function cmp(a: string, b: string): number { return a.localeCompare(b); }
  function num(n: unknown): number { return typeof n === 'number' && !Number.isNaN(n) ? n : 0; }
  function getSender(a: import('$lib/types').GmailThread): string {
    const raw = a.lastMsgMeta.from || '';
    const m = raw.match(/^(.*?)\s*<([^>]+)>/);
    return (m ? (m[1] || m[2]) : raw).toLowerCase();
  }
  function extractSender(raw?: string): string {
    try {
      const r = raw || '';
      const m = r.match(/^\s*"?([^"<]+)"?\s*<[^>]+>\s*$/);
      if (m && m[1]) return m[1].trim();
      const lt = r.indexOf('<');
      if (lt > 0) return r.slice(0, lt).trim();
      const at = r.indexOf('@');
      if (at > 0) return r.slice(0, at).trim();
      return r.trim();
    } catch { return raw || ''; }
  }
  function getThreadSubject(thread: import('$lib/types').GmailThread | undefined): string {
    if (!thread) return '(no subject)';
    const aiSubject = (thread as any).aiSubjectStatus === 'ready' && (thread as any).aiSubject 
      ? (thread as any).aiSubject 
      : thread.lastMsgMeta?.subject || '(no subject)';
    return aiSubject;
  }
  function formatDeletedMessage(thread: import('$lib/types').GmailThread | undefined): string {
    if (!thread) return 'Deleted';
    const sender = extractSender(thread.lastMsgMeta?.from);
    const subject = getThreadSubject(thread);
    if (sender) {
      return `Deleted • ${sender}: ${subject}`;
    }
    return `Deleted • ${subject}`;
  }
  function formatArchivedMessage(thread: import('$lib/types').GmailThread | undefined): string {
    if (!thread) return 'Archived';
    const sender = extractSender(thread.lastMsgMeta?.from);
    const subject = getThreadSubject(thread);
    if (sender) {
      return `Archived • ${sender}: ${subject}`;
    }
    return `Archived • ${subject}`;
  }
  function formatSnoozedMessage(thread: import('$lib/types').GmailThread | undefined, ruleKey: string): string {
    if (!thread) return `Snoozed • ${ruleKey}`;
    const sender = extractSender(thread.lastMsgMeta?.from);
    const subject = getThreadSubject(thread);
    if (sender) {
      return `Snoozed • ${sender}: ${subject} • ${ruleKey}`;
    }
    return `Snoozed • ${subject} • ${ruleKey}`;
  }
  function formatSpamMessage(thread: import('$lib/types').GmailThread | undefined): string {
    if (!thread) return 'Marked as spam';
    const sender = extractSender(thread.lastMsgMeta?.from);
    const subject = getThreadSubject(thread);
    if (sender) {
      return `Marked as spam • ${sender}: ${subject}`;
    }
    return `Marked as spam • ${subject}`;
  }
  function formatUnsnoozedMessage(thread: import('$lib/types').GmailThread | undefined): string {
    if (!thread) return 'Unsnoozed';
    const sender = extractSender(thread.lastMsgMeta?.from);
    const subject = getThreadSubject(thread);
    if (sender) {
      return `Unsnoozed • ${sender}: ${subject}`;
    }
    return `Unsnoozed • ${subject}`;
  }
  async function copyAiSubject() {
    try {
      if (!aiSubjectSummary) { showSnackbar({ message: 'No AI subject', closable: true }); return; }
      await navigator.clipboard.writeText(aiSubjectSummary);
      showSnackbar({ message: 'AI subject copied', closable: true });
    } catch (e) { showSnackbar({ message: 'Failed to copy AI subject', closable: true }); }
  }

  async function copyAiBody() {
    try {
      if (!aiBodySummary) { showSnackbar({ message: 'No AI summary', closable: true }); return; }
      await navigator.clipboard.writeText(aiBodySummary);
      showSnackbar({ message: 'AI summary copied', closable: true });
    } catch (e) { showSnackbar({ message: 'Failed to copy AI summary', closable: true }); }
  }

  async function copyEmailSource(mid: string) {
    try {
      showSnackbar({ message: 'Fetching email source…', closable: true });
      const raw = await getMessageRaw(mid);
      await navigator.clipboard.writeText(raw);
      showSnackbar({ message: 'Email source copied to clipboard', closable: true });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      showSnackbar({ message: `Failed to copy email source: ${errorMsg}`, closable: true });
    }
  }
  function fmtIso(input?: string | null): string {
    if (!input) return '—';
    try { return new Date(input).toLocaleString(); } catch { return input; }
  }
  function fmtDuration(ms?: number | null): string {
    if (typeof ms !== 'number' || Number.isNaN(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
    return `${(ms / 60000).toFixed(2)} min`;
  }
  function openDiagnosticsSheet() {
    if (!aiDiagnostics) {
      showSnackbar({ message: 'No diagnostics captured yet', closable: true });
      return;
    }
    diagnosticsSheetOpen = true;
  }
  async function copyAiDiagnostics() {
    try {
      if (!aiDiagnostics) {
        showSnackbar({ message: 'No diagnostics to copy', closable: true });
        return;
      }
      const payload = {
        viewer: {
          reason: 'viewer_ai_diagnostics',
          page: 'viewer',
          at: new Date().toISOString(),
          threadId,
          messageId: lastSummarizedMid,
          subject: currentThread?.lastMsgMeta?.subject,
          runId: aiDiagnostics.runId
        },
        ai: aiDiagnostics,
        summary: {
          subject: aiSubjectSummary,
          body: aiBodySummary
        }
      };
      const ok = await copyGmailDiagnosticsToClipboard(payload);
      showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
    } catch (e) {
      console.error('[Viewer] Failed to copy AI diagnostics', e);
      showSnackbar({ message: 'Failed to copy diagnostics', closable: true });
    }
  }
  function triggerDiagnosticsRerun() {
    if (!lastSummarizedMid) {
      showSnackbar({ message: 'No previous AI run yet', closable: true });
      return;
    }
    diagnosticsSheetOpen = false;
    summarize(lastSummarizedMid, true);
  }

  async function runRecruitingDiagnostic() {
    try {
      runningRecruitingDiag = true;
      recruitingDiagResult = null;
      
      if (!currentThread) {
        showSnackbar({ message: 'No thread loaded', closable: true });
        return;
      }
      
      const s = get(settings);
      if (!s?.aiApiKey) {
        showSnackbar({ message: 'AI API key required. Set it in Settings.', timeout: 5000 });
        return;
      }
      
      // Get thread data from IndexedDB
      const db = await getDB();
      const thread = await db.get('threads', threadId);
      
      if (!thread) {
        showSnackbar({ message: 'Thread not found in local database', closable: true });
        return;
      }
      
      // Get the last message with full body
      const lastMsgId = thread.messageIds?.[thread.messageIds.length - 1];
      if (!lastMsgId) {
        showSnackbar({ message: 'No messages found in thread', closable: true });
        return;
      }
      
      const msg = await getMessageFull(lastMsgId);
      const subject = thread.lastMsgMeta?.subject || msg.headers?.Subject || '';
      const from = thread.lastMsgMeta?.from || msg.headers?.From || '';
      
      // Import and run the AI detection
      const { aiDetectCollegeRecruiting } = await import('$lib/ai/providers');
      const startTime = Date.now();
      const result = await aiDetectCollegeRecruiting(subject, msg.bodyText, msg.bodyHtml, from);
      const duration = Date.now() - startTime;
      
      // Check if thread has existing moderation data
      const existingModeration = thread.autoModeration?.college_recruiting_v1;
      
      recruitingDiagResult = {
        verdict: result.verdict,
        raw: result.raw,
        duration,
        subject,
        from,
        hasBody: !!(msg.bodyText || msg.bodyHtml),
        bodyPreview: (msg.bodyText || msg.bodyHtml || '').slice(0, 500),
        existingModeration,
        threadLabels: thread.labelIds,
        isInInbox: thread.labelIds?.includes('INBOX')
      };
      
             recruitingDiagOpen = true;
             
             showSnackbar({ 
               message: `AI verdict: ${result.verdict.toUpperCase()}`, 
               timeout: 4000,
               closable: true
             });
           } catch (e) {
             console.error('[Viewer] Recruiting diagnostic failed:', e);
             
             // Provide more helpful error messages for common Gemini issues
             let errorMessage = e instanceof Error ? e.message : String(e);
             if (errorMessage.includes('Gemini error 404')) {
               errorMessage = 'Gemini API key not found or invalid. Check your API key in Settings > API.';
             } else if (errorMessage.includes('Gemini API key not set')) {
               errorMessage = 'Gemini API key is required. Set it in Settings > API.';
             } else if (errorMessage.includes('Gemini invalid API key')) {
               errorMessage = 'Gemini API key is invalid. Check your API key in Settings > API.';
             }
             
             showSnackbar({ 
               message: `Diagnostic failed: ${errorMessage}`, 
               timeout: 6000,
               actions: {
                 'Go to Settings': () => { location.href = '/settings'; }
               }
             });
             recruitingDiagResult = {
               error: errorMessage
             };
           } finally {
      runningRecruitingDiag = false;
    }
  }

  function getSubject(a: import('$lib/types').GmailThread): string { return (a.lastMsgMeta.subject || '').toLowerCase(); }
  function getDate(a: import('$lib/types').GmailThread): number {
    const d = a.lastMsgMeta?.date;
    if (typeof d === 'number' && !Number.isNaN(d)) return d;
    if (typeof d === 'string') {
      const parsed = Number(d);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  }
  function isUnread(a: import('$lib/types').GmailThread): boolean { return (a.labelIds || []).includes('UNREAD'); }
  const currentSort: NonNullable<import('$lib/stores/settings').AppSettings['inboxSort']> = $derived(($settings.inboxSort || 'date_desc') as NonNullable<import('$lib/stores/settings').AppSettings['inboxSort']>);
  const sortedCandidates = $derived((() => {
    const arr = [...filteredCandidates];
    
    // Sort comparison that ensures consistent ordering
    function dateCompareDesc(a: import('$lib/types').GmailThread, b: import('$lib/types').GmailThread): number {
      const dateA = getDate(a);
      const dateB = getDate(b);
      // Threads without dates (0) go to the end
      if (dateA === 0 && dateB === 0) return 0;
      if (dateA === 0) return 1;
      if (dateB === 0) return -1;
      return dateB - dateA;
    }
    function dateCompareAsc(a: import('$lib/types').GmailThread, b: import('$lib/types').GmailThread): number {
      const dateA = getDate(a);
      const dateB = getDate(b);
      if (dateA === 0 && dateB === 0) return 0;
      if (dateA === 0) return 1;
      if (dateB === 0) return -1;
      return dateA - dateB;
    }
    
    switch (currentSort) {
      case 'date_asc':
        arr.sort(dateCompareAsc);
        break;
      case 'unread_first':
        arr.sort((a, b) => {
          const d = (isUnread(b) as any) - (isUnread(a) as any);
          if (d !== 0) return d;
          return dateCompareDesc(a, b);
        });
        break;
      case 'sender_az':
        arr.sort((a, b) => {
          const s = cmp(getSender(a), getSender(b));
          if (s !== 0) return s;
          return dateCompareDesc(a, b);
        });
        break;
      case 'sender_za':
        arr.sort((a, b) => {
          const s = cmp(getSender(b), getSender(a));
          if (s !== 0) return s;
          return dateCompareDesc(a, b);
        });
        break;
      case 'subject_az':
        arr.sort((a, b) => {
          const s = cmp(getSubject(a), getSubject(b));
          if (s !== 0) return s;
          return dateCompareDesc(a, b);
        });
        break;
      case 'subject_za':
        arr.sort((a, b) => {
          const s = cmp(getSubject(b), getSubject(a));
          if (s !== 0) return s;
          return dateCompareDesc(a, b);
        });
        break;
      case 'date_desc':
      default:
        arr.sort(dateCompareDesc);
        break;
    }
    return arr;
  })());
  const currentIndex = $derived(sortedCandidates.findIndex((t) => (t as any)?.threadId === threadId));
  const prevThreadId = $derived(currentIndex > 0 ? (sortedCandidates[currentIndex - 1]?.threadId || null) : null);
  const nextThreadId = $derived(currentIndex >= 0 && currentIndex < sortedCandidates.length - 1 ? (sortedCandidates[currentIndex + 1]?.threadId || null) : null);
  async function safeGoto(href: string) {
    try { await goto(href); }
    catch (_) { try { location.href = href; } catch {} }
  }
  function gotoPrev() { if (prevThreadId) safeGoto(`/viewer/${prevThreadId}`); }
  function gotoNext() { if (nextThreadId) safeGoto(`/viewer/${nextThreadId}`); }
  async function navigateToInbox(refresh = false) {
    try {
      await goto('/inbox');
      if (refresh) {
        try { window.dispatchEvent(new CustomEvent('jmail:refresh')); } catch {}
      }
    } catch (_) {
      try { location.href = '/inbox'; } catch {}
    }
  }
  let threadLoading: boolean = $state(false);
  let threadError: string | null = $state(null);
  // Reset AI summaries when navigating between threads
  $effect(() => {
    const _tid = currentThread?.threadId;
    aiSubjectSummary = null;
    aiBodySummary = null;
    aiDiagnostics = null;
    diagnosticsSheetOpen = false;
    lastSummarizedMid = null;
    summarizing = false;
  });
  // Surface precomputed summaries if present
  $effect(() => {
    try {
      const ct = currentThread;
      if (!ct) return;
      
      // Don't override local state if we're currently summarizing or have just set new values
      if (summarizing) return;
      
      if (ct.summary && ct.summaryStatus === 'ready') {
        // Only set if we don't already have a local value (to avoid overriding fresh regenerations)
        if (!aiBodySummary) {
          aiBodySummary = ct.summary;
        }
      }
      const subj = (ct as any).aiSubject as string | undefined;
      const subjStatus = (ct as any).aiSubjectStatus as ('none'|'pending'|'ready'|'error') | undefined;
      if (subj && subjStatus === 'ready') {
        // Only set if we don't already have a local value (to avoid overriding fresh regenerations)
        if (!aiSubjectSummary) {
          aiSubjectSummary = subj;
        }
      }
    } catch (_) {}
  });
  function formatDateTime(ts?: number | string): string {
    if (!ts) return '';
    const n = typeof ts === 'string' ? Number(ts) : ts;
    try {
      const date = new Date(n);
      const today = new Date();
      const timeStr = date.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' });

      // Compute days difference (positive for past dates)
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const diffDays = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86400000);

      if (diffDays === 0) return `Today, ${timeStr}`;
      if (diffDays === 1) return `Yesterday, ${timeStr}`;

      let relative = '';
      if (diffDays < 7) {
        relative = `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
      } else if (diffDays < 30) {
        const weeks = Math.floor(diffDays / 7);
        relative = `${weeks} week${weeks === 1 ? '' : 's'} ago`;
      } else {
        const months = Math.round(diffDays / 30);
        relative = `${months} month${months === 1 ? '' : 's'} ago`;
      }

      const full = date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
      return `${relative}, ${full}`;
    } catch { return ''; }
  }
  async function copyDiagnostics(reason: string, mid?: string, error?: unknown) {
    try {
      const ids = currentThread?.messageIds || [];
      const msgSummaries = ids.map((id) => {
        const m = $messages[id];
        return m ? { id, hasBodyText: !!m.bodyText, hasBodyHtml: !!m.bodyHtml, hasSnippet: !!m.snippet, labelIds: m.labelIds } : { id, missing: true };
      });
      const payload = {
        viewer: {
          reason,
          page: 'viewer',
          at: new Date().toISOString(),
          location: typeof location !== 'undefined' ? location.href : undefined,
          threadId,
          currentThread: currentThread ? { messageIds: currentThread.messageIds?.length, labelIds: currentThread.labelIds?.length, lastMsgMeta: currentThread.lastMsgMeta } : null,
          requestedMid: mid,
          loadingMap,
          errorMap,
          messages: msgSummaries
        },
        error: error instanceof Error ? { name: error.name, message: error.message } : (error ? String(error) : undefined)
      };
      const ok = await copyGmailDiagnosticsToClipboard(payload);
      if (!ok) {
        // eslint-disable-next-line no-console
        console.log('[Viewer] Diagnostics (clipboard blocked):', payload);
      }
    } catch (_) {
      // best-effort only
    }
  }
  async function downloadMessage(mid: string) {
    if (loadingMap[mid]) return;
    loadingMap[mid] = true;
    errorMap[mid] = ''; // Clear any previous error
    try {
      const full = await getMessageFull(mid);
      messages.set({ ...$messages, [mid]: full });
      errorMap[mid] = '';
      if (!full?.bodyText && !full?.bodyHtml) {
        // eslint-disable-next-line no-console
        console.error('[Viewer] Message did not load body; see diagnostics.', { mid });
        await copyDiagnostics('download_no_body', mid);
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      errorMap[mid] = errorMsg;
      // eslint-disable-next-line no-console
      console.error('[Viewer] Failed to load message', mid, e);
      void copyDiagnostics('download_failed', mid, e);
    } finally {
      loadingMap[mid] = false;
    }
  }

  async function grantAccess(mid?: string) {
    try {
      const info = await fetchTokenInfo();
      const hasBodyScopes = !!info?.scope && (info.scope.includes('gmail.readonly') || info.scope.includes('gmail.modify'));
      const ok = hasBodyScopes ? true : await acquireTokenForScopes(SCOPES, 'consent', 'viewer_grant_click');
      if (ok && mid) await downloadMessage(mid);
    } catch (_) {}
  }

  async function relogin(mid?: string) {
    try {
      await signOut();
      await acquireTokenInteractive('consent', 'viewer_relogin');
      if (mid) await downloadMessage(mid);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[Viewer] Re-login failed', e);
      void copyDiagnostics('viewer_relogin_failed', mid, e);
    }
  }

  // Fallback: if the thread is not present (e.g., deep link to an older thread), try to fetch a summary
  $effect(() => {
    if (currentThread || threadLoading) return;
    if (!threadId) return;
    (async () => {
      // Avoid triggering any auth flow on navigation: only fetch if we already have a token
      try {
        const info = await fetchTokenInfo();
        if (!info) return; // not authorized in this session; skip remote fetch
      } catch (_) { return; }
      threadLoading = true;
      threadError = null;
      try {
        const { thread, messages: metas } = await getThreadSummary(threadId);
        // Persist to DB and hydrate stores
        try {
          const db = await getDB();
          const txMsgs = db.transaction('messages', 'readwrite');
          for (const m of metas) await txMsgs.store.put(m);
          await txMsgs.done;
          const txThreads = db.transaction('threads', 'readwrite');
          await txThreads.store.put(thread);
          await txThreads.done;
        } catch (_) {}
        // Update stores
        threads.set([...(Array.isArray($threads) ? $threads : []), thread].reduce((acc, t) => {
          const idx = acc.findIndex((x) => x.threadId === t.threadId);
          if (idx >= 0) acc[idx] = t; else acc.push(t);
          return acc;
        }, [] as typeof $threads));
        const dict: Record<string, import('$lib/types').GmailMessage> = { ...$messages };
        for (const m of metas) {
          try {
            const existing = dict[m.id];
            const existingHasBody = !!(existing?.bodyText || existing?.bodyHtml);
            const incomingHasBody = !!(m as any)?.bodyText || !!(m as any)?.bodyHtml;
            // Preserve existing full body if incoming is metadata-only
            if (existingHasBody && !incomingHasBody) continue;
            // Merge fields to avoid losing any previously loaded properties
            dict[m.id] = { ...(existing || {}), ...m } as any;
          } catch (_) {
            dict[m.id] = m as any;
          }
        }
        messages.set(dict);
      } catch (e) {
        threadError = e instanceof Error ? e.message : String(e);
        // Best-effort: attach diagnostics
        void copyDiagnostics('viewer_thread_fallback_failed', undefined, e);
      } finally {
        threadLoading = false;
      }
    })();
  });

  // Create sorted message list with all messages from the thread, ensuring chronological order
  const sortedMessageIds = $derived((() => {
    if (!currentThread?.messageIds?.length) return [];
    const ids = currentThread.messageIds;
    // Get messages and sort by date to ensure chronological order (oldest first)
    const messagesWithDates = ids.map((id) => {
      const m = $messages[id];
      const date = m?.internalDate || (m?.headers?.Date ? Date.parse(m.headers.Date) : 0) || 0;
      return { id, date };
    });
    // Sort by date (ascending - oldest first)
    messagesWithDates.sort((a, b) => a.date - b.date);
    return messagesWithDates.map((m) => m.id);
  })());

  // Initialize expanded messages - only the latest message should be expanded by default
  let previousThreadId: string | undefined = $state(undefined);
  $effect(() => {
    // Reset expanded messages when thread changes
    if (threadId !== previousThreadId) {
      previousThreadId = threadId;
      if (sortedMessageIds.length > 0) {
        const latestMessageId = sortedMessageIds[sortedMessageIds.length - 1];
        if (latestMessageId) {
          expandedMessages.clear();
          expandedMessages.add(latestMessageId);
        }
      } else {
        expandedMessages.clear();
      }
    }
  });

  // Toggle message expansion
  function toggleMessageExpansion(mid: string) {
    if (expandedMessages.has(mid)) {
      expandedMessages.delete(mid);
    } else {
      expandedMessages.add(mid);
    }
    expandedMessages = new Set(expandedMessages); // Trigger reactivity
  }

  // Auto-load messages' full content progressively (only if body scopes already granted)
  $effect(() => {
    if (!currentThread || !sortedMessageIds.length) return;
    // Load messages progressively, starting with the first few
    const maxAutoLoad = 3; // Auto-load first 3 messages
    for (let i = 0; i < Math.min(maxAutoLoad, sortedMessageIds.length); i++) {
      const mid = sortedMessageIds[i];
      if (!mid) continue;
      const m = $messages[mid];
      if (!m?.bodyText && !m?.bodyHtml && !loadingMap[mid] && !autoTried[mid]) {
        autoTried[mid] = true;
        (async () => {
          // Attempt auto-fetch regardless of tokeninfo availability.
          // The API layer will surface a clear 403 if scopes are insufficient.
          loadingMap[mid] = true;
          getMessageFull(mid)
            .then((full) => { messages.set({ ...$messages, [mid]: full }); errorMap[mid] = ''; })
            .catch((e) => {
              errorMap[mid] = e instanceof Error ? e.message : String(e);
              // eslint-disable-next-line no-console
              console.error('[Viewer] Failed to auto-load message', mid, e);
              void copyDiagnostics('auto_load_failed', mid, e);
              const msg = e instanceof Error ? e.message : String(e);
              if (typeof msg === 'string' && msg.toLowerCase().includes('permissions') || msg.toLowerCase().includes('scope')) {
                void copyDiagnostics('scope_after_upgrade_failed', mid, e);
              }
            })
            .finally(() => { loadingMap[mid] = false; });
        })();
      }
    }
  });
  async function summarize(mid: string, force = false) {
    if (summarizing) return;
    let m = $messages[mid];
    if (!m) return;
    // Use cached AI results if available to avoid redundant calls
    try {
      const ct = currentThread;
      if (ct) {
        const hasSubject = !!(ct as any).aiSubject && ((ct as any).aiSubjectStatus === 'ready');
        const hasSummary = !!ct.summary && ct.summaryStatus === 'ready';
        if (hasSubject || hasSummary) {
          if (!force) {
            if (hasSubject) aiSubjectSummary = (ct as any).aiSubject;
            if (hasSummary) aiBodySummary = ct.summary || null;
            showSnackbar({
              message: 'AI summary ready (cached)',
              actions: {
                Regenerate: () => { void summarize(mid, true); }
              },
              closable: true
            });
            return;
          }
        }
      }
    } catch (_) {}
    if (force) { aiSubjectSummary = null; aiBodySummary = null; }
    aiDiagnostics = null;
    diagnosticsSheetOpen = false;
    lastSummarizedMid = mid;
    summarizing = true;
    try { showSnackbar({ message: 'Summarizing…' }); } catch {}
    try {
      const subject = m.headers?.Subject || currentThread?.lastMsgMeta?.subject || '';
      // Ensure we have full message (body + attachments) before summarizing
      try {
        const hasBody = !!(m.bodyText || m.bodyHtml);
        const hasAtt = Array.isArray(m.attachments);
        let hasScopes = false;
        try { const info = await fetchTokenInfo(); hasScopes = !!info?.scope && (info.scope.includes('gmail.readonly') || info.scope.includes('gmail.modify')); } catch (_) {}
        if ((!hasBody || !hasAtt) && hasScopes) {
          const full = await getMessageFull(mid);
          messages.set({ ...$messages, [mid]: full });
          m = full;
        }
      } catch (_) {}
      // Prefer full body text, fall back to snippet or whatever is rendered in the viewer DOM
      let bodyText = m.bodyText || m.snippet || '';
      const bodyHtml = m.bodyHtml;
      if (!bodyText) {
        try {
          if (typeof document !== 'undefined') {
            // Try to extract the visible text for this message from the rendered viewer.
            const el = document.querySelector(`[data-mid="${mid}"] .html-body`) || document.querySelector(`[data-mid="${mid}"] pre`) || document.querySelector(`[data-mid="${mid}"]`);
            if (el && typeof (el as HTMLElement).innerText === 'string') {
              bodyText = (el as HTMLElement).innerText.trim();
            }
          }
        } catch (_) {}
      }
      // Compute full message summary first (token heavy), then derive subject from it (token light)
      const { summary: bodyResult, diagnostics } = await aiSummarizeEmailWithDiagnostics(subject, bodyText, bodyHtml, m.attachments, currentThread?.threadId, mid, { force });
      const bodyTextOut = bodyResult.text || '';
      const subjectText = await aiSummarizeSubject(subject, undefined, undefined, bodyTextOut);
      aiSubjectSummary = subjectText;
      aiBodySummary = bodyTextOut;
      aiDiagnostics = diagnostics;
      diagnosticsSheetOpen = true;
      // Persist AI results to cache to minimize future calls
      try {
        const db = await getDB();
        const ct = currentThread;
        if (ct) {
          const { combinedForHash } = prepareEmailSummaryContext(subject, bodyText, bodyHtml, m.attachments);
          const bodyHash = simpleHash(combinedForHash || subject || ct.threadId);
          const nowMs = Date.now();
          const next = {
            ...ct,
            summary: (bodyTextOut || '').trim() || ct.summary,
            summaryStatus: (bodyTextOut && bodyTextOut.trim()) ? 'ready' : (ct.summaryStatus || 'error'),
            // Preserve summaryUpdatedAt and bodyHash; do not write legacy version fields
            summaryUpdatedAt: nowMs,
            bodyHash,
            aiSubject: (subjectText || '').trim() || (ct as any).aiSubject,
            aiSubjectStatus: (subjectText && subjectText.trim()) ? 'ready' : ((ct as any).aiSubjectStatus || 'error'),
            aiSubjectUpdatedAt: nowMs
          } as import('$lib/types').GmailThread as any;
          await db.put('threads', next);
          threads.update((arr) => {
            const idx = arr.findIndex((t) => t.threadId === ct.threadId);
            if (idx >= 0) { const copy = arr.slice(); (copy as any)[idx] = next; return copy as any; }
            return arr as any;
          });
        }
      } catch (_) {}
      showSnackbar({ 
        message: 'AI summary ready', 
        actions: {
          Regenerate: () => { void summarize(mid, true); }
        },
        closable: true 
      });
    } catch (e) {
      const { message, retryAfterSeconds } = getFriendlyAIErrorMessage(e, 'Summarize');
      const rootCauses = 'Possible root causes: missing summary field, precompute disabled, missing Gmail body scopes, filtered threads, previous precompute failure.';
      showSnackbar({
        message: `${message}\n${rootCauses}`,
        actions: {
          Retry: () => { void summarize(mid); },
          Copy: async () => {
            const diag = buildAiDiag('ai_summarize_error', e, { mid });
            const ok = await copyGmailDiagnosticsToClipboard(diag);
            showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
          }
        },
        closable: true,
        timeout: retryAfterSeconds && retryAfterSeconds > 0 ? Math.min(8000, (retryAfterSeconds + 2) * 1000) : 6000
      });
    } finally {
      summarizing = false;
    }
  }

  async function summarizeAttachment(mid: string, attIndex: number) {
    const key = `${mid}:${attIndex}`;
    if (attBusy[key]) return;
    let m = $messages[mid];
    if (!m) return;
    try {
      // Ensure attachments are available
      const hasAtt = Array.isArray(m.attachments);
      let hasScopes = false;
      try { const info = await fetchTokenInfo(); hasScopes = !!info?.scope && (info.scope.includes('gmail.readonly') || info.scope.includes('gmail.modify')); } catch (_) {}
      if (!hasAtt && hasScopes) {
        const full = await getMessageFull(mid);
        messages.set({ ...$messages, [mid]: full });
        m = full;
      }
    } catch (_) {}
    const att = (m.attachments || [])[attIndex];
    if (!att) return;
    attDialogTitle = att.filename || att.mimeType || 'Attachment';
    attDialogText = null;
    attDialogOpen = true;
    attBusy[key] = true;
    try {
      const text = await aiSummarizeAttachment(m.headers?.Subject, att);
      attDialogText = text || '(No summary)';
    } catch (e) {
      const { message } = getFriendlyAIErrorMessage(e, 'Attachment summary');
      attDialogText = message;
    } finally {
      attBusy[key] = false;
    }
  }
  async function replyDraft(mid: string) {
    if (replying) return;
    const m = $messages[mid]; if (!m) return;
    replying = true;
    try { showSnackbar({ message: 'Generating reply…' }); } catch {}
    try {
      const draft = await aiDraftReply(m.headers?.Subject || '', m.bodyText, m.bodyHtml);
      await navigator.clipboard.writeText(draft);
      showSnackbar({ message: 'Reply draft copied to clipboard', closable: true });
    } catch (e) {
      const { message, retryAfterSeconds } = getFriendlyAIErrorMessage(e, 'Reply');
      showSnackbar({
        message,
        actions: {
          Retry: () => { void replyDraft(mid); },
          Copy: async () => {
            const diag = buildAiDiag('ai_reply_error', e, { mid });
            const ok = await copyGmailDiagnosticsToClipboard(diag);
            showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
          }
        },
        closable: true,
        timeout: retryAfterSeconds && retryAfterSeconds > 0 ? Math.min(8000, (retryAfterSeconds + 2) * 1000) : 6000
      });
    } finally {
      replying = false;
    }
  }
  async function unsubscribe(mid: string) {
    if (extractingUnsub) return;
    const m = $messages[mid]; if (!m) return;
    extractingUnsub = true;
    try { showSnackbar({ message: 'Looking for unsubscribe link…' }); } catch {}
    try {
      let target = findUnsubscribeTarget(m.headers, m.bodyHtml);
      if (!target) target = await aiExtractUnsubscribeUrl(m.headers?.Subject || '', m.bodyText, m.bodyHtml);
      if (target) {
        // Handle mailto: links - show modal dialog to confirm sending email
        if (target.toLowerCase().startsWith('mailto:')) {
          const mailto = parseMailtoUrl(target);
          if (mailto) {
            unsubscribeMailtoInfo = {
              to: mailto.to,
              subject: mailto.subject,
              body: mailto.body,
              target: target
            };
            unsubscribeDialogOpen = true;
          } else {
            // Malformed mailto, open in default email client
            window.open(target, '_blank');
            showSnackbar({ message: 'Opened in email client', closable: true });
          }
          return;
        }
        
        // Handle http/https links - open directly without asking
        window.open(target, '_blank');
      } else {
        showSnackbar({ message: 'No unsubscribe target found', closable: true });
      }
    } catch (e) {
      const { message } = getFriendlyAIErrorMessage(e, 'Unsubscribe');
      showSnackbar({
        message,
        actions: {
          Retry: () => { void unsubscribe(mid); },
          Copy: async () => {
            const diag = buildAiDiag('ai_unsubscribe_error', e, { mid });
            const ok = await copyGmailDiagnosticsToClipboard(diag);
            showSnackbar({ message: ok ? 'Diagnostics copied' : 'Failed to copy diagnostics', closable: true });
          }
        },
        closable: true,
        timeout: 6000
      });
    } finally {
      extractingUnsub = false;
    }
  }

  async function sendUnsubscribeEmail(): Promise<void> {
    if (!unsubscribeMailtoInfo || sendingUnsubscribeEmail) return;
    sendingUnsubscribeEmail = true;
    try {
      const profile = await getProfile();
      if (!profile.emailAddress) {
        showSnackbar({ message: 'Could not get your email address', closable: true });
        unsubscribeDialogOpen = false;
        return;
      }
      const raw = createRawEmail(profile.emailAddress, unsubscribeMailtoInfo.to, unsubscribeMailtoInfo.subject, unsubscribeMailtoInfo.body);
      await sendMessageRaw(raw);
      unsubscribeDialogOpen = false;
      showSnackbar({ 
        message: `✓ Unsubscribe email sent to ${unsubscribeMailtoInfo.to}`, 
        closable: true, 
        timeout: 6000 
      });
      unsubscribeMailtoInfo = null;
    } catch (sendErr) {
      console.error('Failed to send unsubscribe email:', sendErr);
      showSnackbar({ 
        message: 'Failed to send unsubscribe email. Try opening in your email client.', 
        actions: {
          Open: () => {
            if (unsubscribeMailtoInfo) {
              window.open(unsubscribeMailtoInfo.target, '_blank');
            }
          }
        },
        closable: true, 
        timeout: 8000 
      });
    } finally {
      sendingUnsubscribeEmail = false;
    }
  }

  function buildAiDiag(reason: string, e: unknown, extra?: Record<string, unknown>) {
    let status: number | undefined;
    let headers: Record<string, string | null> | undefined;
    let requestId: string | null | undefined;
    let retryAfterSeconds: number | null | undefined;
    let body: unknown;
    if (e instanceof AIProviderError) {
      status = e.status;
      headers = e.headers;
      requestId = e.requestId;
      retryAfterSeconds = e.retryAfterSeconds;
      body = e.body;
    }
    return {
      reason,
      error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e),
      status,
      requestId,
      retryAfterSeconds,
      headers,
      body,
      ...extra
    };
  }
  async function createTask(mid: string) {
    const m = $messages[mid]; if (!m) return;
    const link = `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`;
    const subject = aiSubjectSummary || m.headers?.Subject || 'Email';
    const line = `[${subject}](${link})`;
    try {
      // Desktop: copy; user can paste into their task file
      await navigator.clipboard.writeText(line);
      // Verify clipboard actually contains the line; if read is blocked or mismatch, fallback to showing the text
      try {
        const readBack = await navigator.clipboard.readText();
        if (readBack === line) {
          showSnackbar({ message: 'Task line copied to clipboard.', closable: true });
        } else {
          showSnackbar({ message: line, closable: true });
        }
      } catch (_) {
        // If we cannot read the clipboard (permission), show the line for manual copy
        showSnackbar({ message: line, closable: true });
      }
    } catch { showSnackbar({ message: line, closable: true }); }
  }
  async function loadForEdit(filter: ThreadFilter) {
    // This function is not yet implemented in FilterBar, so surface via snackbar for now
    showSnackbar({ message: `Load filter "${filter.name}" for editing.`, closable: true });
    // In a real app, you'd set the filter's state in FilterBar
  }
  async function onDeleteSavedFilter(id: string) {
    if (confirm(`Are you sure you want to delete filter with ID "${id}"? This action cannot be undone.`)) {
      await deleteSavedFilter(id);
      showSnackbar({ message: 'Filter deleted', closable: true });
    }
  }
  if (typeof window !== 'undefined') {
    (window as any).__copyViewerDiagnostics = async () => { await copyDiagnostics('viewer_toolbar_copy'); };
  }

  // Snooze functionality
  async function onSnoozeSelect(ruleKey: string) {
    if (!currentThread) return;
    const threadIdToSnooze = currentThread.threadId;
    // Close the snooze menu immediately
    if (snoozeDetails) snoozeDetails.open = false;
    // Navigate to inbox immediately (before optimistic updates can cause thread to disappear)
    // This ensures the user doesn't see "thread not loaded" message
    navigateToInbox(true).catch(() => {
      // Fallback navigation if goto fails
      try { location.href = '/inbox'; } catch {}
    });
    // Perform snooze operation (may complete after navigation)
    try {
      await snoozeThreadByRule(threadIdToSnooze, ruleKey);
      showSnackbar({ 
        message: formatSnoozedMessage(currentThread, ruleKey), 
        actions: { Undo: () => undoLast(1) },
        closable: true 
      });
    } catch (error) {
      console.error('Failed to snooze thread:', error);
      showSnackbar({ message: 'Failed to snooze thread', closable: true });
    }
  }

  // Local autoclose action for details menus
  const autoclose = (node: HTMLDetailsElement) => {
    const close = (e: Event) => {
      const target = e.target as Element | null;
      if (!target) { node.open = false; return; }
      if (target.closest('summary')) return;
      const inside = node.contains(target);
      if (inside) {
        if (target.closest('.picker')) return;
        if (target.closest('button, [role="menuitem"], a[href]')) {
          node.open = false;
          return;
        }
        return;
      }
      node.open = false;
    };
    window.addEventListener('click', close, true);
    return { destroy() { window.removeEventListener('click', close, true); } };
  };

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function scrollToBottom() {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
}

// Keyboard shortcuts for viewer
function isEventFromTextInput(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = (t.tagName || '').toLowerCase();
  const editable = (t as any).isContentEditable;
  return tag === 'input' || tag === 'textarea' || editable;
}

function onKeyDown(e: KeyboardEvent) {
  // Ignore when typing
  if (isEventFromTextInput(e)) return;
  
  // Esc: close dialogs/popups first, then navigate back to inbox
  if (e.key === 'Escape') {
    e.preventDefault();
    // Close any open dialogs/popups first
    if (attDialogOpen) {
      attDialogOpen = false;
      attDialogTitle = null;
      attDialogText = null;
      return;
    }
    if (filterPopupOpen) {
      filterPopupOpen = false;
      return;
    }
    if (snoozeMenuOpen) {
      snoozeMenuOpen = false;
      try {
        const d = snoozeDetails;
        if (d) d.open = false;
      } catch (_) {}
      return;
    }
    if (recruitingDiagOpen) {
      recruitingDiagOpen = false;
      return;
    }
    // If no dialogs are open, navigate back to inbox
    const ct = currentThread;
    if (ct) {
      navigateToInbox(false);
    }
    return;
  }
  
  // Skip other handlers if attachment dialog is open
  if (attDialogOpen) return;
  const ct = currentThread;
  if (!ct) return;
  // b: open snooze menu
  if (e.key === 'b' || e.key === 'B') {
    e.preventDefault();
    try {
      const d = snoozeDetails;
      if (d) {
        d.open = true;
        snoozeMenuOpen = true;
      }
    } catch (_) {}
    return;
  }
  // j/k: next/previous thread
  if (e.key === 'j' || e.key === 'J') {
    e.preventDefault();
    gotoNext();
    return;
  }
  if (e.key === 'k' || e.key === 'K') {
    e.preventDefault();
    gotoPrev();
    return;
  }
  // e or y: archive
  if ((e.key === 'e' || e.key === 'E' || e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    archiveThread(ct.threadId).then(async () => {
      try { showSnackbar({ message: formatArchivedMessage(ct), actions: { Undo: () => undoLast(1) } }); } catch {}
      await navigateToInbox(true);
    });
    return;
  }
  // Delete or # : delete
  if (e.key === 'Delete' || e.key === '#') {
    // Optional confirm via settings
    if ($settings.confirmDelete) {
      const ok = confirm('Delete this conversation?');
      if (!ok) return;
    }
    e.preventDefault();
    trashThread(ct.threadId).then(async () => {
      try { showSnackbar({ message: formatDeletedMessage(ct), actions: { Undo: () => undoLast(1) } }); } catch {}
      await navigateToInbox(true);
    });
    return;
  }
  // z: undo
  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    void undoLast(1);
    return;
  }
  // 1: snooze 1 hour
  if (e.key === '1') {
    e.preventDefault();
    snoozeThreadByRule(ct.threadId, '1h').then(async () => {
      showSnackbar({ message: formatSnoozedMessage(ct, '1h'), actions: { Undo: () => undoLast(1) } });
      await navigateToInbox(true);
    });
    return;
  }
  // 2: snooze 2 hours
  if (e.key === '2') {
    e.preventDefault();
    snoozeThreadByRule(ct.threadId, '2h').then(async () => {
      showSnackbar({ message: formatSnoozedMessage(ct, '2h'), actions: { Undo: () => undoLast(1) } });
      await navigateToInbox(true);
    });
    return;
  }
}

onMount(() => {
  try { window.addEventListener('keydown', onKeyDown); } catch {}
  return () => { try { window.removeEventListener('keydown', onKeyDown); } catch {} };
});

</script>

{#if currentThread}
  <div style="display:flex; flex-direction:column; gap:0.75rem; max-width:64rem; margin:0 auto;">

    {#if summarizing || aiSubjectSummary || aiBodySummary}
      <div style="display:flex; flex-direction:column; gap:0.5rem;">
        <!-- AI subject (prominent/up top). Use sparkles icon next to copy button instead of a text label. -->
        <Card variant="elevated">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem;">
            <div style="flex:1; margin:0 0 0.25rem;">
              {#if summarizing && !aiSubjectSummary}
                <div style="display:flex; align-items:center; gap:0.5rem;"></div>
              {/if}
            </div>
            <div style="display:flex; gap:0.25rem; align-items:center;">
              <Icon icon={iconSparkles} />
              <Button variant="text" onclick={copyAiSubject} title="Copy" aria-label="Copy AI subject">
                <Icon icon={iconCopy} />
              </Button>
            </div>
          </div>
          {#if summarizing && !aiSubjectSummary}
            <LoadingIndicator size={20} />
          {:else if aiSubjectSummary}
            <h2 class="m3-font-title-large" style="margin:0; overflow-wrap:anywhere; word-break:break-word;">{aiSubjectSummary}</h2>
          {/if}
        </Card>

        <!-- AI body summary (slightly larger font) -->
        <Card variant="outlined">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem;">
            <div style="flex:1; margin:0 0 0.25rem;"></div>
            <div style="display:flex; gap:0.25rem; align-items:center;">
              <Icon icon={iconSparkles} />
              <Button variant="text" onclick={copyAiBody} title="Copy" aria-label="Copy AI summary">
                <Icon icon={iconCopy} />
              </Button>
            </div>
          </div>
          {#if summarizing && !aiBodySummary}
            <LoadingIndicator size={20} />
          {:else if aiBodySummary}
            <pre class="m3-font-body-medium" style="white-space:pre-wrap; margin:0; font-size:115%;">{aiBodySummary}</pre>
          {/if}
        </Card>
      </div>
    {/if}

    <!-- Real subject (less prominent) -->
    <Card variant="outlined">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem;">
        <h3 class="m3-font-title-small" style="margin:0; display:flex; flex-wrap:wrap; align-items:baseline; gap:0.5rem; flex:1;">
          <span style="overflow-wrap:anywhere; word-break:break-word;">{currentThread.lastMsgMeta.subject}</span>
          {#if currentThread.lastMsgMeta.from}
            <span class="from">{currentThread.lastMsgMeta.from}</span>
          {/if}
          {#if currentThread.lastMsgMeta?.date}
            <span class="badge m3-font-label-small">{formatDateTime(currentThread.lastMsgMeta.date)}</span>
          {/if}
        </h3>
        <Button variant="text" iconType="full" aria-label="Open thread in Gmail" onclick={() => openGmailPopup(currentThread.threadId)}>
          <Icon icon={iconGmail} width="1rem" height="1rem" />
        </Button>
      </div>
    </Card>

    <!-- Primary Action Bar - Material Design 3 compliant -->
    <div class="action-bar" role="toolbar" aria-label="Email actions">
      <!-- Primary Actions Group -->
      <div class="action-group primary-actions">
        <Button variant="filled" onclick={() => archiveThread(currentThread.threadId).then(async ()=> { showSnackbar({ message: formatArchivedMessage(currentThread), actions: { Undo: () => undoLast(1) } }); await navigateToInbox(true); })} aria-label="Archive conversation">
          <Icon icon={iconArchive} />
          Archive
        </Button>
        <Button variant="tonal" color="error" onclick={() => trashThread(currentThread.threadId).then(async ()=> { showSnackbar({ message: formatDeletedMessage(currentThread), actions: { Undo: () => undoLast(1) } }); await navigateToInbox(true); })} aria-label="Delete conversation">
          <Icon icon={iconDelete} />
          Delete
        </Button>
        <Button variant="outlined" onclick={() => spamThread(currentThread.threadId).then(()=> showSnackbar({ message: formatSpamMessage(currentThread), actions: { Undo: () => undoLast(1) } }))} aria-label="Mark as spam">
          <Icon icon={iconReportSpam} />
          Spam
        </Button>
      </div>

      <!-- Snooze Actions Group -->
      {#if isSnoozedThread(currentThread) || Object.keys($settings.labelMapping || {}).some((k)=>['10m','3h','1d'].includes(k) && $settings.labelMapping[k])}
        <div class="action-group snooze-actions">
          {#if isSnoozedThread(currentThread)}
            <Button variant="text" onclick={() => manualUnsnoozeThread(currentThread.threadId).then(()=> showSnackbar({ message: formatUnsnoozedMessage(currentThread), actions: { Undo: () => undoLast(1) } }))}>
              <Icon icon={iconUnsnooze} />
              Unsnooze
            </Button>
          {/if}
          {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='3h' && $settings.labelMapping[k])}
            <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '3h').then(async ()=> { showSnackbar({ message: formatSnoozedMessage(currentThread, '3h'), actions: { Undo: () => undoLast(1) } }); await navigateToInbox(true); })}>
              <Icon icon={iconSnooze} />
              3h
            </Button>
          {/if}
          {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='1d' && $settings.labelMapping[k])}
            <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '1d').then(async ()=> { showSnackbar({ message: formatSnoozedMessage(currentThread, '1d'), actions: { Undo: () => undoLast(1) } }); await navigateToInbox(true); })}>
              <Icon icon={iconSnooze} />
              1d
            </Button>
          {/if}
          <!-- Snooze Menu Button -->
          <div class="snooze-menu-wrapper">
            <details class="snooze-menu-toggle" bind:this={snoozeDetails} use:autoclose ontoggle={(e) => { const isOpen = (e.currentTarget as HTMLDetailsElement).open; snoozeMenuOpen = isOpen; }}>
              <summary aria-label="Snooze menu" aria-haspopup="menu" aria-expanded={snoozeMenuOpen} onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); const d = snoozeDetails; if (!d) return; d.open = !d.open; }}>
                <Button variant="text">
                  <Icon icon={iconSnooze} />
                  Snooze
                  <Icon icon={iconExpand} />
                </Button>
              </summary>
              <div class="snooze-menu-content">
                <Menu>
                  <CalendarPopover onSelect={onSnoozeSelect} />
                </Menu>
              </div>
            </details>
          </div>
        </div>
      {/if}

      <!-- AI Actions Group -->
      {#if currentThread.messageIds?.length}
        {@const mid = currentThread.messageIds[currentThread.messageIds.length-1]}
        <div class="action-group ai-actions">
          <Button variant="text" onclick={() => summarize(mid)} disabled={summarizing} aria-label="Generate AI summary">
            <Icon icon={iconSummarize} />
            {summarizing ? 'Summarizing…' : 'AI Summary'}
          </Button>
          <Button variant="text" onclick={() => replyDraft(mid)} disabled={replying} aria-label="Generate AI reply">
            <Icon icon={iconReply} />
            {replying ? 'Generating…' : 'Reply (AI)'}
          </Button>
          <Button variant="text" onclick={() => unsubscribe(mid)} disabled={extractingUnsub} aria-label="Find unsubscribe link">
            <Icon icon={iconUnsubscribe} />
            {extractingUnsub ? 'Finding…' : 'Unsubscribe'}
          </Button>
          <Button variant="text" onclick={openDiagnosticsSheet} disabled={!aiDiagnostics} aria-label="Open AI diagnostics">
            <Icon icon={iconBugReport} />
            Diagnostics
          </Button>
        </div>
      {/if}

      <!-- Secondary Actions Menu -->
      <div class="action-group secondary-actions">
        <details class="more-menu">
          <summary class="more-menu-button" aria-label="More actions">
            <Icon icon={iconMore} />
          </summary>
          <div class="menu-container">
            <Menu>
              <MenuItem onclick={(e) => {
                copyText(currentThread.lastMsgMeta.subject || '');
                // Close the details menu
                if (e?.target && e.target instanceof HTMLElement) {
                  const details = e.target.closest('details');
                  if (details) details.open = false;
                }
              }}>
                <Icon icon={iconSubject} />
                Copy Subject
              </MenuItem>
              {#if currentThread.messageIds?.length}
                {@const mid = currentThread.messageIds[currentThread.messageIds.length-1]}
                <MenuItem onclick={async (e) => {
                  await copyEmailSource(mid);
                  // Close the details menu
                  if (e?.target && e.target instanceof HTMLElement) {
                    const details = e.target.closest('details');
                    if (details) details.open = false;
                  }
                }}>
                  <Icon icon={iconCopy} />
                  Copy Email Source
                </MenuItem>
                <MenuItem onclick={() => createTask(mid)}>
                  <Icon icon={iconTask} />
                  Create Task
                </MenuItem>
              {/if}
              <MenuItem onclick={() => { filterPopupOpen = true; }}>
                <Icon icon={iconFilter} />
                Filter Options
              </MenuItem>
              {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='10m' && $settings.labelMapping[k])}
                <MenuItem onclick={() => snoozeThreadByRule(currentThread.threadId, '10m').then(async ()=> { showSnackbar({ message: formatSnoozedMessage(currentThread, '10m'), actions: { Undo: () => undoLast(1) } }); await navigateToInbox(true); })}>
                  <Icon icon={iconSnooze} />
                  Snooze 10m
                </MenuItem>
              {/if}
              <MenuItem onclick={(e) => {
                runRecruitingDiagnostic();
                if (e?.target && e.target instanceof HTMLElement) {
                  const details = e.target.closest('details');
                  if (details) details.open = false;
                }
              }} disabled={runningRecruitingDiag}>
                <Icon icon={iconSchool} />
                {runningRecruitingDiag ? 'Checking...' : 'Test Recruiting Filter'}
              </MenuItem>
              <MenuItem onclick={() => relogin(currentThread.messageIds?.[0])}>
                <Icon icon={iconLogin} />
                Re-login
              </MenuItem>
              <MenuItem onclick={(e) => {
                scrollToBottom();
                // Close the details menu
                if (e?.target && e.target instanceof HTMLElement) {
                  const details = e.target.closest('details');
                  if (details) details.open = false;
                }
              }}>
                <Icon icon={iconScrollDown} />
                Scroll to Bottom
              </MenuItem>
            </Menu>
          </div>
        </details>
      </div>

      <!-- Navigation Controls -->
      <div class="action-group navigation-controls">
        <Button variant="text" iconType="left" disabled={!prevThreadId} onclick={gotoPrev} aria-label="Previous conversation">
          {#snippet children()}
            <Icon icon={iconBack} />
            <span class="label">Previous</span>
          {/snippet}
        </Button>
        <Button variant="text" iconType="left" disabled={!nextThreadId} onclick={gotoNext} aria-label="Next conversation">
          {#snippet children()}
            <Icon icon={iconForward} />
            <span class="label">Next</span>
          {/snippet}
        </Button>
      </div>
    </div>

    <Divider />

    <div class="messages">
      {#each sortedMessageIds as mid, idx}
        {@const m = $messages[mid]}
        {@const isExpanded = expandedMessages.has(mid)}
        {@const isLatest = idx === sortedMessageIds.length - 1}
        {#if idx > 0}
          <Divider />
        {/if}
        <Card variant="outlined" data-mid={mid} class="message-card">
          {#if loadingMap[mid]}
            <div style="display:flex; align-items:center; gap:0.75rem; padding:1rem;">
              <LoadingIndicator size={24} />
              <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">Loading message{idx > 0 ? ` ${idx + 1}` : ''}…</p>
            </div>
          {:else if errorMap[mid]}
            <div style="padding:1rem;">
              <p class="m3-font-body-medium" style="margin:0 0 0.75rem 0; color:rgb(var(--m3-scheme-error))">Failed to load message{idx > 0 ? ` ${idx + 1}` : ''}: {errorMap[mid]}</p>
              <div style="display:flex; flex-wrap:wrap; gap:0.5rem; align-items:center;">
                <Button variant="text" onclick={() => copyDiagnostics('viewer_manual_copy', mid)}>
                  <Icon icon={iconBugReport} />
                  Copy diagnostics
                </Button>
                <Button variant="text" onclick={() => grantAccess(mid)}>
                  <Icon icon={iconKey} />
                  Grant access
                </Button>
                <Button variant="text" onclick={() => relogin(mid)}>
                  <Icon icon={iconLogin} />
                  Re-login
                </Button>
                <Button variant="text" onclick={() => downloadMessage(mid)}>
                  <Icon icon={iconRefresh} />
                  Retry
                </Button>
              </div>
            </div>
          {:else if !isExpanded && !isLatest}
            <!-- Collapsed message view -->
            <div 
              style="padding:0.75rem 1rem; cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:0.75rem;"
              onclick={() => toggleMessageExpansion(mid)}
              role="button"
              tabindex="0"
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMessageExpansion(mid); } }}
            >
              <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.25rem;">
                  {#if m?.headers?.From || m?.headers?.from}
                    <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface)); font-weight:500;">
                      {extractSender(m.headers.From || m.headers.from)}
                    </p>
                  {/if}
                  {#if m?.internalDate}
                    <p class="m3-font-body-small" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant));">
                      {formatDateTime(m.internalDate)}
                    </p>
                  {/if}
                </div>
                {#if m?.snippet}
                  <p class="m3-font-body-small" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    {decodeEntities(m.snippet)}
                  </p>
                {:else if m?.bodyText}
                  <p class="m3-font-body-small" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    {decodeEntities(m.bodyText.slice(0, 100))}{m.bodyText.length > 100 ? '...' : ''}
                  </p>
                {:else if m?.bodyHtml}
                  <p class="m3-font-body-small" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant));">
                    (HTML message)
                  </p>
                {/if}
              </div>
              <Icon icon={iconExpand} width="1.25rem" height="1.25rem" style="flex-shrink:0; color:rgb(var(--m3-scheme-on-surface-variant));" />
            </div>
          {:else if m?.bodyHtml}
              {#if !isLatest}
                <!-- Collapse button for expanded messages -->
                <div 
                  style="padding:0.5rem 1rem; cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:0.75rem; border-bottom:1px solid rgb(var(--m3-scheme-outline-variant));"
                  onclick={() => toggleMessageExpansion(mid)}
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMessageExpansion(mid); } }}
                >
                  <div style="flex:1; min-width:0;">
                    {#if m?.headers?.From || m?.headers?.from}
                      <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface)); font-weight:500;">
                        {extractSender(m.headers.From || m.headers.from)}
                      </p>
                    {/if}
                    {#if m?.internalDate}
                      <p class="m3-font-body-small" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant));">
                        {formatDateTime(m.internalDate)}
                      </p>
                    {/if}
                  </div>
                  <Icon icon={iconArrowUp} width="1.25rem" height="1.25rem" style="flex-shrink:0; color:rgb(var(--m3-scheme-on-surface-variant));" />
                </div>
              {/if}
              <div style="padding: 0 1rem;">
                {#if m?.internalDate}
                  <div style="display:flex; align-items:center; justify-content:space-between; margin:0.25rem 0;">
                    <p class="m3-font-body-small" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">{formatDateTime(m.internalDate)}</p>
                    <div style="display:flex; align-items:center; gap:0.25rem;">
                      <Button variant="text" iconType="full" aria-label="Copy email source" onclick={() => copyEmailSource(mid)}>
                        <Icon icon={iconCopy} width="1rem" height="1rem" />
                      </Button>
                      <Button variant="text" iconType="full" aria-label="Open message in Gmail" onclick={() => openGmailMessagePopup(threadId, mid)}>
                        <Icon icon={iconGmail} width="1rem" height="1rem" />
                      </Button>
                    </div>
                  </div>
                {/if}
                {#if m?.headers}
                  <RecipientBadges 
                    to={m.headers.To || m.headers.to || ''} 
                    cc={m.headers.Cc || m.headers.cc || ''} 
                    bcc={m.headers.Bcc || m.headers.bcc || ''} 
                    maxDisplayCount={4}
                    compact={true} 
                  />
                {/if}
                <div class="html-body" style="white-space:normal; overflow-wrap:anywhere;" use:processHtmlLinks>{@html m.bodyHtml}</div>
              </div>
              {#if Array.isArray(m?.attachments) && m.attachments.length}
                <div class="attachments">
                  {#each m.attachments as a, i}
                    <div class="attachment-item">
                      <span class="attachment-name">{a.filename || a.mimeType || 'attachment'}</span>
                      <Button variant="text" iconType="full" aria-label="AI summary" onclick={() => summarizeAttachment(mid, i)}>
                        {#snippet children()}
                          {#if attBusy[`${mid}:${i}`]}
                            <LoadingIndicator size={18} />
                          {:else}
                            <Icon icon={iconSparkles} />
                          {/if}
                        {/snippet}
                      </Button>
                    </div>
                  {/each}
                </div>
              {/if}
            {:else if m?.bodyText}
              {#if !isLatest}
                <!-- Collapse button for expanded messages -->
                <div 
                  style="padding:0.5rem 1rem; cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:0.75rem; border-bottom:1px solid rgb(var(--m3-scheme-outline-variant));"
                  onclick={() => toggleMessageExpansion(mid)}
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMessageExpansion(mid); } }}
                >
                  <div style="flex:1; min-width:0;">
                    {#if m?.headers?.From || m?.headers?.from}
                      <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface)); font-weight:500;">
                        {extractSender(m.headers.From || m.headers.from)}
                      </p>
                    {/if}
                    {#if m?.internalDate}
                      <p class="m3-font-body-small" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant));">
                        {formatDateTime(m.internalDate)}
                      </p>
                    {/if}
                  </div>
                  <Icon icon={iconArrowUp} width="1.25rem" height="1.25rem" style="flex-shrink:0; color:rgb(var(--m3-scheme-on-surface-variant));" />
                </div>
              {/if}
              <div style="padding: 0 1rem;">
                {#if m?.internalDate}
                  <div style="display:flex; align-items:center; justify-content:space-between; margin:0.25rem 0;">
                    <p class="m3-font-body-small" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">{formatDateTime(m.internalDate)}</p>
                    <div style="display:flex; align-items:center; gap:0.25rem;">
                      <Button variant="text" iconType="full" aria-label="Copy email source" onclick={() => copyEmailSource(mid)}>
                        <Icon icon={iconCopy} width="1rem" height="1rem" />
                      </Button>
                      <Button variant="text" iconType="full" aria-label="Open message in Gmail" onclick={() => openGmailMessagePopup(threadId, mid)}>
                        <Icon icon={iconGmail} width="1rem" height="1rem" />
                      </Button>
                    </div>
                  </div>
                {/if}
                {#if m?.headers}
                  <RecipientBadges 
                    to={m.headers.To || m.headers.to || ''} 
                    cc={m.headers.Cc || m.headers.cc || ''} 
                    bcc={m.headers.Bcc || m.headers.bcc || ''} 
                    maxDisplayCount={4}
                    compact={true} 
                  />
                {/if}
                <div style="white-space:pre-wrap; font-family: monospace;">{@html linkifyText(decodeEntities(m.bodyText))}</div>
              </div>
              {#if Array.isArray(m?.attachments) && m.attachments.length}
                <div class="attachments">
                  {#each m.attachments as a, i}
                    <div class="attachment-item">
                      <span class="attachment-name">{a.filename || a.mimeType || 'attachment'}</span>
                      <Button variant="text" iconType="full" aria-label="AI summary" onclick={() => summarizeAttachment(mid, i)}>
                        {#snippet children()}
                          {#if attBusy[`${mid}:${i}`]}
                            <LoadingIndicator size={18} />
                          {:else}
                            <Icon icon={iconSparkles} />
                          {/if}
                        {/snippet}
                      </Button>
                    </div>
                  {/each}
                </div>
              {/if}
            {:else if m?.snippet}
              <div style="padding:1rem;">
                {#if m?.internalDate}
                  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.5rem;">
                    <p class="m3-font-body-small" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">{formatDateTime(m.internalDate)}</p>
                    <div style="display:flex; align-items:center; gap:0.25rem;">
                      <Button variant="text" iconType="full" aria-label="Copy email source" onclick={() => copyEmailSource(mid)}>
                        <Icon icon={iconCopy} width="1rem" height="1rem" />
                      </Button>
                      <Button variant="text" iconType="full" aria-label="Open message in Gmail" onclick={() => openGmailMessagePopup(threadId, mid)}>
                        <Icon icon={iconGmail} width="1rem" height="1rem" />
                      </Button>
                    </div>
                  </div>
                {/if}
                {#if m?.headers}
                  <RecipientBadges 
                    to={m.headers.To || m.headers.to || ''} 
                    cc={m.headers.Cc || m.headers.cc || ''} 
                    bcc={m.headers.Bcc || m.headers.bcc || ''} 
                    maxDisplayCount={4}
                    compact={true} 
                  />
                {/if}
                <p class="m3-font-body-medium" style="margin:0.5rem 0 0 0; color:rgb(var(--m3-scheme-on-surface-variant))">{decodeEntities(m.snippet)}</p>
                <div style="display:flex; flex-wrap:wrap; gap:0.5rem; align-items:center; margin-top:0.75rem;">
                  <Button variant="text" onclick={() => downloadMessage(mid)}>
                    <Icon icon={iconDownload} />
                    Load full message
                  </Button>
                  <Button variant="text" onclick={() => copyDiagnostics('viewer_manual_copy', mid)}>
                    <Icon icon={iconBugReport} />
                    Copy diagnostics
                  </Button>
                  <Button variant="text" onclick={() => grantAccess(mid)}>
                    <Icon icon={iconKey} />
                    Grant access
                  </Button>
                  <Button variant="text" onclick={() => relogin(mid)}>
                    <Icon icon={iconLogin} />
                    Re-login
                  </Button>
                </div>
              </div>
            {:else}
              <div style="padding:1rem;">
                <p class="m3-font-body-medium" style="margin:0 0 0.75rem 0; color:rgb(var(--m3-scheme-on-surface-variant))">Message {idx + 1} metadata not available</p>
                <div style="display:flex; flex-wrap:wrap; gap:0.5rem; align-items:center;">
                  <Button variant="text" onclick={() => downloadMessage(mid)}>
                    <Icon icon={iconDownload} />
                    Load message
                  </Button>
                  <Button variant="text" onclick={() => copyDiagnostics('viewer_manual_copy', mid)}>
                    <Icon icon={iconBugReport} />
                    Copy diagnostics
                  </Button>
                  <Button variant="text" onclick={() => grantAccess(mid)}>
                    <Icon icon={iconKey} />
                    Grant access
                  </Button>
                  <Button variant="text" onclick={() => relogin(mid)}>
                    <Icon icon={iconLogin} />
                    Re-login
                  </Button>
                </div>
              </div>
            {/if}
        </Card>
      {/each}
    </div>

    <Divider inset />
    <Divider />

    <!-- Bottom Action Bar - duplicate of top -->
    <div class="action-bar" role="toolbar" aria-label="Email actions">
      <!-- Primary Actions Group -->
      <div class="action-group primary-actions">
        <Button variant="filled" onclick={() => archiveThread(currentThread.threadId).then(async ()=> { showSnackbar({ message: formatArchivedMessage(currentThread), actions: { Undo: () => undoLast(1) } }); await navigateToInbox(true); })} aria-label="Archive conversation">
          <Icon icon={iconArchive} />
          Archive
        </Button>
        <Button variant="tonal" color="error" onclick={() => trashThread(currentThread.threadId).then(async ()=> { showSnackbar({ message: formatDeletedMessage(currentThread), actions: { Undo: () => undoLast(1) } }); await navigateToInbox(true); })} aria-label="Delete conversation">
          <Icon icon={iconDelete} />
          Delete
        </Button>
        <Button variant="outlined" onclick={() => spamThread(currentThread.threadId).then(()=> showSnackbar({ message: formatSpamMessage(currentThread), actions: { Undo: () => undoLast(1) } }))} aria-label="Mark as spam">
          <Icon icon={iconReportSpam} />
          Spam
        </Button>
      </div>

      <!-- Snooze Actions Group -->
      {#if isSnoozedThread(currentThread) || Object.keys($settings.labelMapping || {}).some((k)=>['10m','3h','1d'].includes(k) && $settings.labelMapping[k])}
        <div class="action-group snooze-actions">
          {#if isSnoozedThread(currentThread)}
            <Button variant="text" onclick={() => manualUnsnoozeThread(currentThread.threadId).then(()=> showSnackbar({ message: formatUnsnoozedMessage(currentThread), actions: { Undo: () => undoLast(1) } }))}>
              <Icon icon={iconUnsnooze} />
              Unsnooze
            </Button>
          {/if}
          {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='3h' && $settings.labelMapping[k])}
            <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '3h').then(async ()=> { showSnackbar({ message: formatSnoozedMessage(currentThread, '3h'), actions: { Undo: () => undoLast(1) } }); await navigateToInbox(true); })}>
              <Icon icon={iconSnooze} />
              3h
            </Button>
          {/if}
          {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='1d' && $settings.labelMapping[k])}
            <Button variant="text" onclick={() => snoozeThreadByRule(currentThread.threadId, '1d').then(async ()=> { showSnackbar({ message: formatSnoozedMessage(currentThread, '1d'), actions: { Undo: () => undoLast(1) } }); await navigateToInbox(true); })}>
              <Icon icon={iconSnooze} />
              1d
            </Button>
          {/if}
          <!-- Snooze Menu Button -->
          <div class="snooze-menu-wrapper">
            <details class="snooze-menu-toggle" bind:this={snoozeDetails} use:autoclose ontoggle={(e) => { const isOpen = (e.currentTarget as HTMLDetailsElement).open; snoozeMenuOpen = isOpen; }}>
              <summary aria-label="Snooze menu" aria-haspopup="menu" aria-expanded={snoozeMenuOpen} onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); const d = snoozeDetails; if (!d) return; d.open = !d.open; }}>
                <Button variant="text">
                  <Icon icon={iconSnooze} />
                  Snooze
                  <Icon icon={iconExpand} />
                </Button>
              </summary>
              <div class="snooze-menu-content">
                <Menu>
                  <CalendarPopover onSelect={onSnoozeSelect} />
                </Menu>
              </div>
            </details>
          </div>
        </div>
      {/if}

      <!-- AI Actions Group -->
      {#if currentThread.messageIds?.length}
        {@const mid = currentThread.messageIds[currentThread.messageIds.length-1]}
        <div class="action-group ai-actions">
          <Button variant="text" onclick={() => summarize(mid)} disabled={summarizing} aria-label="Generate AI summary">
            <Icon icon={iconSummarize} />
            {summarizing ? 'Summarizing…' : 'AI Summary'}
          </Button>
          <Button variant="text" onclick={() => replyDraft(mid)} disabled={replying} aria-label="Generate AI reply">
            <Icon icon={iconReply} />
            {replying ? 'Generating…' : 'Reply (AI)'}
          </Button>
          <Button variant="text" onclick={() => unsubscribe(mid)} disabled={extractingUnsub} aria-label="Find unsubscribe link">
            <Icon icon={iconUnsubscribe} />
            {extractingUnsub ? 'Finding…' : 'Unsubscribe'}
          </Button>
          <Button variant="text" onclick={openDiagnosticsSheet} disabled={!aiDiagnostics} aria-label="Open AI diagnostics">
            <Icon icon={iconBugReport} />
            Diagnostics
          </Button>
        </div>
      {/if}

      <!-- Secondary Actions Menu -->
      <div class="action-group secondary-actions">
        <details class="more-menu">
          <summary class="more-menu-button" aria-label="More actions">
            <Icon icon={iconMore} />
          </summary>
          <div class="menu-container">
            <Menu>
              <MenuItem onclick={(e) => {
                copyText(currentThread.lastMsgMeta.subject || '');
                // Close the details menu
                if (e?.target && e.target instanceof HTMLElement) {
                  const details = e.target.closest('details');
                  if (details) details.open = false;
                }
              }}>
                <Icon icon={iconSubject} />
                Copy Subject
              </MenuItem>
              {#if currentThread.messageIds?.length}
                {@const mid = currentThread.messageIds[currentThread.messageIds.length-1]}
                <MenuItem onclick={async (e) => {
                  await copyEmailSource(mid);
                  // Close the details menu
                  if (e?.target && e.target instanceof HTMLElement) {
                    const details = e.target.closest('details');
                    if (details) details.open = false;
                  }
                }}>
                  <Icon icon={iconCopy} />
                  Copy Email Source
                </MenuItem>
                <MenuItem onclick={() => createTask(mid)}>
                  <Icon icon={iconTask} />
                  Create Task
                </MenuItem>
              {/if}
              <MenuItem onclick={() => { filterPopupOpen = true; }}>
                <Icon icon={iconFilter} />
                Filter Options
              </MenuItem>
              {#if Object.keys($settings.labelMapping || {}).some((k)=>k==='10m' && $settings.labelMapping[k])}
                <MenuItem onclick={() => snoozeThreadByRule(currentThread.threadId, '10m').then(async ()=> { showSnackbar({ message: formatSnoozedMessage(currentThread, '10m'), actions: { Undo: () => undoLast(1) } }); await navigateToInbox(true); })}>
                  <Icon icon={iconSnooze} />
                  Snooze 10m
                </MenuItem>
              {/if}
              <MenuItem onclick={(e) => {
                runRecruitingDiagnostic();
                if (e?.target && e.target instanceof HTMLElement) {
                  const details = e.target.closest('details');
                  if (details) details.open = false;
                }
              }} disabled={runningRecruitingDiag}>
                <Icon icon={iconSchool} />
                {runningRecruitingDiag ? 'Checking...' : 'Test Recruiting Filter'}
              </MenuItem>
              <MenuItem onclick={() => relogin(currentThread.messageIds?.[0])}>
                <Icon icon={iconLogin} />
                Re-login
              </MenuItem>
              <MenuItem onclick={(e) => {
                scrollToBottom();
                // Close the details menu
                if (e?.target && e.target instanceof HTMLElement) {
                  const details = e.target.closest('details');
                  if (details) details.open = false;
                }
              }}>
                <Icon icon={iconScrollDown} />
                Scroll to Bottom
              </MenuItem>
            </Menu>
          </div>
        </details>
      </div>

      <!-- Navigation Controls -->
      <div class="action-group navigation-controls">
        <Button variant="text" iconType="left" disabled={!prevThreadId} onclick={gotoPrev} aria-label="Previous conversation">
          {#snippet children()}
            <Icon icon={iconBack} />
            <span class="label">Previous</span>
          {/snippet}
        </Button>
        <Button variant="text" iconType="left" disabled={!nextThreadId} onclick={gotoNext} aria-label="Next conversation">
          {#snippet children()}
            <Icon icon={iconForward} />
            <span class="label">Next</span>
          {/snippet}
        </Button>
      </div>
    </div>

    <!-- Bottom Navigation Bar -->
    <div class="bottom-navigation" role="navigation" aria-label="Page navigation">
      <Button variant="text" iconType="left" onclick={() => navigateToInbox(false)} aria-label="Back to inbox">
        {#snippet children()}
          <Icon icon={iconBack} />
          <span class="label">Back to inbox</span>
        {/snippet}
      </Button>
      
      <div class="navigation-spacer"></div>
      
      <div class="thread-navigation">
        <Button variant="text" iconType="left" disabled={!prevThreadId} onclick={gotoPrev} aria-label="Previous conversation">
          {#snippet children()}
            <Icon icon={iconBack} />
            <span class="label">Previous</span>
          {/snippet}
        </Button>
        <Button variant="text" iconType="left" disabled={!nextThreadId} onclick={gotoNext} aria-label="Next conversation">
          {#snippet children()}
            <Icon icon={iconForward} />
            <span class="label">Next</span>
          {/snippet}
        </Button>
        <Button variant="text" iconType="left" onclick={scrollToTop} aria-label="Scroll to top">
          {#snippet children()}
            <Icon icon={iconArrowUp} />
            <span class="label">Top</span>
          {/snippet}
        </Button>
      </div>
    </div>
  </div>

  <!-- Filter Options Dialog -->
  <Dialog headline="Filter Options" bind:open={filterPopupOpen} closeOnClick={true}>
    {#snippet children()}
      <div class="filter-dialog-content">
        <h3 class="m3-font-title-medium" style="margin:0 0 1rem;">Create Filter from this Thread</h3>
        <FilterBar thread={currentThread} />
        
        <div style="margin-top:1.5rem;">
          <h4 class="m3-font-title-small" style="margin:0 0 0.5rem;">Manage Saved Filters</h4>
          {#if ($filters.saved || []).length === 0}
            <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-on-surface-variant))">No saved filters yet.</p>
          {:else}
            <div class="saved-filters-list">
              {#each $filters.saved as f}
                <div class="filter-item">
                  <Button variant="text" onclick={() => loadForEdit(f)} style="flex:1; justify-content:flex-start;">
                    <Icon icon={iconFilter} />
                    {f.name}{f.autoApply ? ' • Auto' : ''}{f.action && f.action !== 'none' ? ` • ${f.action}` : ''}
                  </Button>
                  <Button variant="text" color="error" onclick={() => onDeleteSavedFilter(f.id)}>
                    <Icon icon={iconDelete} />
                    Delete
                  </Button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/snippet}
    {#snippet buttons()}
      <Button variant="text" onclick={() => { filterPopupOpen = false; }}>
        <Icon icon={iconClose} />
        Close
      </Button>
    {/snippet}
  </Dialog>

  <Dialog headline={attDialogTitle || 'Attachment summary'} bind:open={attDialogOpen} closeOnClick={true}>
    {#snippet children()}
      {#if attDialogText == null}
        <div style="display:flex; justify-content:center; padding:0.5rem;">
          <LoadingIndicator size={20} />
        </div>
      {:else}
        <pre class="m3-font-body-medium" style="white-space:pre-wrap; margin:0;">{attDialogText}</pre>
      {/if}
    {/snippet}
    {#snippet buttons()}
      <Button variant="text" onclick={() => { try { if (attDialogText) navigator.clipboard.writeText(attDialogText); showSnackbar({ message: 'Copied', closable: true }); } catch {} }}>
        <Icon icon={iconCopy} />
        Copy
      </Button>
      <Button variant="text" onclick={() => { attDialogOpen = false; }}>
        <Icon icon={iconClose} />
        Close
      </Button>
    {/snippet}
  </Dialog>

  <Dialog icon={iconMarkEmailUnread} headline="Send unsubscribe email?" bind:open={unsubscribeDialogOpen} closeOnClick={false}>
    {#snippet children()}
      {#if unsubscribeMailtoInfo}
        <div style="display:flex; flex-direction:column; gap:0.75rem;">
          <p class="m3-font-body-medium">
            This will send an unsubscribe email to <strong>{unsubscribeMailtoInfo.to}</strong>.
          </p>
          {#if unsubscribeMailtoInfo.subject || unsubscribeMailtoInfo.body}
            <div style="padding:0.75rem; background:rgb(var(--m3-scheme-surface-container)); border-radius:8px; font-size:0.875rem;">
              {#if unsubscribeMailtoInfo.subject}
                <div style="margin-bottom:0.5rem;"><strong>Subject:</strong> {unsubscribeMailtoInfo.subject}</div>
              {/if}
              {#if unsubscribeMailtoInfo.body}
                <div style="white-space:pre-wrap;"><strong>Body:</strong> {unsubscribeMailtoInfo.body}</div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/snippet}
    {#snippet buttons()}
      <Button variant="text" onclick={() => { unsubscribeDialogOpen = false; unsubscribeMailtoInfo = null; }} disabled={sendingUnsubscribeEmail}>
        Cancel
      </Button>
      <Button variant="filled" onclick={sendUnsubscribeEmail} disabled={sendingUnsubscribeEmail || !unsubscribeMailtoInfo}>
        {sendingUnsubscribeEmail ? 'Sending…' : 'Send'}
      </Button>
    {/snippet}
  </Dialog>

  <Dialog headline="College Recruiting Filter Test" bind:open={recruitingDiagOpen} closeOnClick={true}>
    {#snippet children()}
      {#if runningRecruitingDiag}
        <div style="display:flex; justify-content:center; padding:2rem;">
          <LoadingIndicator size={24} />
        </div>
      {:else if recruitingDiagResult}
        {#if recruitingDiagResult.error}
          <div style="padding: 1rem; background: rgb(var(--m3-scheme-error-container)); border-radius: 12px; color: rgb(var(--m3-scheme-on-error-container));">
            <strong>Error:</strong> {recruitingDiagResult.error}
          </div>
        {:else}
          <div style="display: flex; flex-direction: column; gap: 1rem;">
            <div style="background: {recruitingDiagResult.verdict === 'match' ? 'rgb(var(--m3-scheme-error-container))' : recruitingDiagResult.verdict === 'not_match' ? 'rgb(var(--m3-scheme-tertiary-container))' : 'rgb(var(--m3-scheme-surface-variant))'}; padding: 1rem; border-radius: 12px;">
              <div style="font-weight: 500; margin-bottom: 0.5rem;">AI Verdict</div>
              <div style="font-size: 1.5rem; font-weight: 600; text-transform: uppercase; color: {recruitingDiagResult.verdict === 'match' ? 'rgb(var(--m3-scheme-on-error-container))' : recruitingDiagResult.verdict === 'not_match' ? 'rgb(var(--m3-scheme-on-tertiary-container))' : 'rgb(var(--m3-scheme-on-surface-variant))'}">{recruitingDiagResult.verdict}</div>
              <div style="font-size: 0.875rem; margin-top: 0.5rem; opacity: 0.8;">Processed in {recruitingDiagResult.duration}ms</div>
            </div>
            
            <div>
              <strong>Subject:</strong>
              <div style="margin-top: 0.25rem; padding: 0.5rem; background: rgb(var(--m3-scheme-surface-container)); border-radius: 8px;">{recruitingDiagResult.subject || '(no subject)'}</div>
            </div>
            
            <div>
              <strong>From:</strong>
              <div style="margin-top: 0.25rem; padding: 0.5rem; background: rgb(var(--m3-scheme-surface-container)); border-radius: 8px;">{recruitingDiagResult.from || '(unknown)'}</div>
            </div>
            
            <div>
              <strong>Email Status:</strong>
              <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
                <span style="padding: 0.25rem 0.75rem; background: rgb(var(--m3-scheme-surface-variant)); border-radius: 16px; font-size: 0.75rem;">
                  {recruitingDiagResult.isInInbox ? '📥 In INBOX' : '📭 Not in INBOX'}
                </span>
                <span style="padding: 0.25rem 0.75rem; background: rgb(var(--m3-scheme-surface-variant)); border-radius: 16px; font-size: 0.75rem;">
                  {recruitingDiagResult.hasBody ? '✅ Has body content' : '❌ No body content'}
                </span>
              </div>
            </div>
            
            {#if recruitingDiagResult.existingModeration}
              <div style="padding: 0.75rem; background: rgb(var(--m3-scheme-tertiary-container)); border-radius: 8px;">
                <strong style="color: rgb(var(--m3-scheme-on-tertiary-container));">Previous Result:</strong>
                <div style="margin-top: 0.5rem; font-size: 0.875rem; color: rgb(var(--m3-scheme-on-tertiary-container));">
                  Status: {recruitingDiagResult.existingModeration.status}<br/>
                  {#if recruitingDiagResult.existingModeration.actionTaken}
                    Action: {recruitingDiagResult.existingModeration.actionTaken}<br/>
                  {/if}
                  Updated: {new Date(recruitingDiagResult.existingModeration.updatedAt).toLocaleString()}
                </div>
              </div>
            {/if}
            
            {#if recruitingDiagResult.raw}
              <details style="background: rgb(var(--m3-scheme-surface-container)); padding: 0.75rem; border-radius: 8px;">
                <summary style="cursor: pointer; font-weight: 500; color: rgb(var(--m3-scheme-primary));">View AI Response</summary>
                <pre style="white-space: pre-wrap; margin-top: 0.5rem; padding: 0.5rem; background: rgb(var(--m3-scheme-surface)); border-radius: 4px; overflow-x: auto; font-size: 0.875rem;">{recruitingDiagResult.raw}</pre>
              </details>
            {/if}
            
            {#if recruitingDiagResult.bodyPreview}
              <details style="background: rgb(var(--m3-scheme-surface-container)); padding: 0.75rem; border-radius: 8px;">
                <summary style="cursor: pointer; font-weight: 500;">View Body Preview (first 500 chars)</summary>
                <pre style="white-space: pre-wrap; margin-top: 0.5rem; padding: 0.5rem; background: rgb(var(--m3-scheme-surface)); border-radius: 4px; overflow-x: auto; font-size: 0.75rem;">{recruitingDiagResult.bodyPreview}</pre>
              </details>
            {/if}
          </div>
        {/if}
      {/if}
    {/snippet}
    {#snippet buttons()}
      {#if recruitingDiagResult && !runningRecruitingDiag}
        {#if recruitingDiagResult.verdict === 'match'}
          <Button variant="filled" color="error" onclick={async () => {
            try {
              const { moderateThreadManually } = await import('$lib/ai/precompute');
              const moderationResult = await moderateThreadManually(threadId);
              if (moderationResult.success) {
                showSnackbar({ 
                  message: moderationResult.message, 
                  timeout: 4000,
                  closable: true 
                });
                recruitingDiagOpen = false;
                // Navigate back to inbox since thread is no longer there
                setTimeout(() => {
                  if (typeof window !== 'undefined') {
                    window.location.href = '/inbox';
                  }
                }, 1000);
              } else {
                showSnackbar({ 
                  message: `Failed to apply label: ${moderationResult.message}`, 
                  timeout: 5000,
                  closable: true 
                });
              }
            } catch (e) {
              showSnackbar({ 
                message: `Error applying label: ${e instanceof Error ? e.message : String(e)}`, 
                timeout: 5000,
                closable: true 
              });
            }
          }}>
            <Icon icon={iconSchool} />
            Apply Label
          </Button>
        {/if}
        {#if recruitingDiagResult.existingModeration && recruitingDiagResult.existingModeration.status === 'match' && recruitingDiagResult.existingModeration.actionTaken !== 'label_enqueued'}
          <Button variant="outlined" onclick={async () => {
            try {
              const { clearModerationDataForThread } = await import('$lib/ai/precompute');
              const result = await clearModerationDataForThread(threadId);
              if (result.success) {
                showSnackbar({ 
                  message: result.message, 
                  timeout: 4000,
                  closable: true 
                });
                recruitingDiagOpen = false;
              } else {
                showSnackbar({ 
                  message: `Failed to clear moderation data: ${result.message}`, 
                  timeout: 5000,
                  closable: true 
                });
              }
            } catch (e) {
              showSnackbar({ 
                message: `Error clearing moderation data: ${e instanceof Error ? e.message : String(e)}`, 
                timeout: 5000,
                closable: true 
              });
            }
          }}>
            Clear Moderation Data
          </Button>
        {/if}
        <Button variant="text" onclick={() => {
          try {
            navigator.clipboard.writeText(JSON.stringify(recruitingDiagResult, null, 2));
            showSnackbar({ message: 'Diagnostic results copied', closable: true });
          } catch (e) {
            showSnackbar({ message: 'Failed to copy', closable: true });
          }
        }}>
          <Icon icon={iconCopy} />
          Copy
        </Button>
      {/if}
      <Button variant="text" onclick={() => { recruitingDiagOpen = false; }}>
        <Icon icon={iconClose} />
        Close
      </Button>
    {/snippet}
  </Dialog>

  {#if diagnosticsSheetOpen && aiDiagnostics}
    {@const diag = aiDiagnostics}
    <BottomSheet close={() => { diagnosticsSheetOpen = false; }}>
      <div class="diag-sheet" role="dialog" aria-label="AI diagnostics">
        <div class="diag-sheet__header">
          <h2 class="m3-font-title-large">AI Diagnostics</h2>
          <p class="m3-font-body-small">Model {diag.prompt.model} · Provider {diag.prompt.provider}</p>
        </div>
        <div class="diag-sheet__actions">
          <Button variant="text" onclick={copyAiDiagnostics}>
            <Icon icon={iconCopy} /> Copy payload
          </Button>
          <Button variant="text" onclick={triggerDiagnosticsRerun}>
            <Icon icon={iconRefresh} /> Rerun
          </Button>
          <Button variant="text" onclick={() => { diagnosticsSheetOpen = false; }}>
            <Icon icon={iconClose} /> Close
          </Button>
        </div>

        <div class="diag-grid">
          <section>
            <h3 class="m3-font-title-small">Run</h3>
            <dl>
              <div>
                <dt>Run ID</dt>
                <dd>{diag.runId}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{fmtIso(diag.startedAt)}</dd>
              </div>
              <div>
                <dt>Completed</dt>
                <dd>{fmtIso(diag.completedAt)}</dd>
              </div>
              <div>
                <dt>Queue size</dt>
                <dd>{diag.queue.pendingBefore} → {diag.queue.pendingAfter}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3 class="m3-font-title-small">Prompt</h3>
            <dl>
              <div>
                <dt>Template</dt>
                <dd>{diag.prompt.template}</dd>
              </div>
              <div>
                <dt>Has body</dt>
                <dd>{diag.prompt.hasBody ? 'Yes' : 'No'}</dd>
              </div>
              <div>
                <dt>Text prompt</dt>
                <dd><pre>{diag.prompt.textPrompt || '(n/a)'}</pre></dd>
              </div>
            </dl>
          </section>

          <section>
            <h3 class="m3-font-title-small">Response</h3>
            <dl>
              <div>
                <dt>Summary</dt>
                <dd><pre>{diag.summary.text || '(empty)'}</pre></dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{fmtDuration(diag.summary.metadata?.durationMs)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{diag.summary.metadata?.httpStatus ?? '—'}</dd>
              </div>
              <div>
                <dt>Request ID</dt>
                <dd>{diag.summary.metadata?.requestId || '—'}</dd>
              </div>
              {#if diag.summary.error}
                <div>
                  <dt>Error</dt>
                  <dd><pre>{diag.summary.error.message}</pre></dd>
                </div>
              {/if}
            </dl>
          </section>
        </div>

        {#if diag.prompt.attachments.length}
          <section class="diag-attachments">
            <h3 class="m3-font-title-small">Attachments ({diag.prompt.attachments.length})</h3>
            <ul>
              {#each diag.prompt.attachments as att}
                <li>
                  <div class="name">{att.name || att.mimeType || 'Attachment'}</div>
                  <div class="meta">{att.mimeType || '—'} {att.textLength ? `· ${att.textLength} chars` : ''}</div>
                  {#if att.textPreview}
                    <pre>{att.textPreview}</pre>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if diag.prompt.partsPreview?.length}
          <section class="diag-parts">
            <h3 class="m3-font-title-small">Prompt Parts</h3>
            <ol>
              {#each diag.prompt.partsPreview as part, idx}
                <li>
                  {#if part.text}
                    <pre>{part.text}</pre>
                  {:else if part.inlineData}
                    <p>Inline data ({part.inlineData.mimeType || 'unknown'}, {part.inlineData.bytes ?? '—'} bytes)</p>
                  {:else}
                    <p>(Empty part)</p>
                  {/if}
                </li>
              {/each}
            </ol>
          </section>
        {/if}

        {#if diag.summary.metadata?.headers}
          {@const headerEntries = Object.entries(diag.summary.metadata.headers).filter(([_, v]) => v)}
          {#if headerEntries.length}
            <section class="diag-headers">
              <h3 class="m3-font-title-small">Response Headers</h3>
              <dl>
                {#each headerEntries as [key, value]}
                  <div>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                {/each}
              </dl>
            </section>
          {/if}
        {/if}

        <section class="diag-hash">
          <h3 class="m3-font-title-small">Content Hash</h3>
          <p class="m3-font-body-small">{diag.hashes.content}</p>
        </section>
      </div>
    </BottomSheet>
  {/if}
{:else}
  {#if threadLoading}
    <div style="display:flex; justify-content:center; padding:1rem;"><LoadingIndicator size={24} /></div>
  {:else}
    <p>Thread not loaded.</p>
    {#if threadError}
      <p class="m3-font-body-medium" style="margin:0; color:rgb(var(--m3-scheme-error))">{threadError}</p>
    {/if}
  {/if}
{/if}

<!-- page options moved to +page.ts -->

<style>
  .messages {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .message-card {
    transition: box-shadow 200ms cubic-bezier(0, 0, 0.2, 1);
  }
  .message-card:hover {
    box-shadow: var(--m3-util-elevation-1);
  }
  .from {
    color: rgb(var(--m3-scheme-on-surface-variant));
    font-weight: 400;
  }
  .badge {
    display: inline-block;
    padding: 0.125rem 0.375rem;
    border-radius: var(--m3-util-rounding-extra-small);
    background: rgb(var(--m3-scheme-secondary-container));
    color: rgb(var(--m3-scheme-on-secondary-container));
    white-space: nowrap;
  }
  /* Ensure HTML emails are responsive and wrap on narrow screens */
  .html-body {
    min-width: 0;
    max-width: 100%;
    word-break: break-word;
  }
  :global(.html-body *), :global(.html-body *::before), :global(.html-body *::after) {
    box-sizing: border-box;
  }
  :global(.html-body table) {
    width: 100% !important;
    max-width: 100% !important;
    table-layout: fixed !important;
    border-collapse: collapse;
  }
  :global(.html-body td), :global(.html-body th) {
    word-break: break-word;
  }
  :global(.html-body pre), :global(.html-body code) {
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  :global(.html-body img), :global(.html-body svg), :global(.html-body video), :global(.html-body iframe), :global(.html-body canvas) {
    max-width: 100% !important;
    height: auto !important;
  }
  /* Style links in HTML emails */
  :global(.html-body a) {
    color: rgb(var(--m3-scheme-primary));
    text-decoration: underline;
  }
  /* Mobile: avoid clipping wide email layouts; prefer container scroll to hidden overflow */
  .html-body {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  /* Attachments list */
  .attachments {
    margin-top: 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .attachment-item {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-radius: var(--m3-util-rounding-extra-small);
    background: rgb(var(--m3-scheme-surface-container-lowest));
    color: rgb(var(--m3-scheme-on-surface));
  }
  .attachment-name { max-width: 18rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Avoid viewport expansion from wide children on mobile browsers */
  :global(.html-body > *) {
    max-width: 100% !important;
  }
  /* Neutralize common email inline styles that force wide layout */
  :global(.html-body [style*="min-width"]) {
    min-width: 0 !important;
  }
  :global(.html-body [style*="width:"]) {
    max-width: 100% !important;
  }
  :global(.html-body [width]) {
    max-width: 100% !important;
  }
  /* Override inline min-widths commonly set by marketing emails */
  :global(.html-body [style*="min-width"]) {
    min-width: 0 !important;
  }
  /* Ensure attribute-sized tables scale down */
  :global(.html-body table[width]) {
    width: 100% !important;
    max-width: 100% !important;
  }

  /* Action Bar Styles - Material Design 3 compliant */
  .action-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: flex-start;
    padding: 0.75rem 0;
    border-radius: var(--m3-util-rounding-medium);
    background: rgb(var(--m3-scheme-surface-container-lowest));
    padding: 1rem;
    margin: 0.5rem 0;
  }

  .action-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .action-group.primary-actions {
    flex: 0 0 auto;
  }

  .action-group.navigation-controls {
    margin-left: auto;
  }

  .action-group.secondary-actions {
    margin-left: auto;
  }

  /* Responsive adjustments */
  @media (max-width: 768px) {
    .action-bar {
      gap: 0.75rem;
      padding: 0.75rem;
    }
    
    .action-group.navigation-controls {
      margin-left: 0;
      order: -1;
      flex: 1 0 100%;
      justify-content: space-between;
    }

    .action-group.secondary-actions {
      margin-left: 0;
    }
  }

  /* Bottom Navigation Styles */
  .bottom-navigation {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 1rem 0;
    border-top: 1px solid rgb(var(--m3-scheme-outline-variant));
    margin-top: 1rem;
  }

  .navigation-spacer {
    flex: 1;
  }

  .thread-navigation {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  @media (max-width: 640px) {
    .bottom-navigation {
      flex-direction: column;
      align-items: stretch;
    }
    
    .navigation-spacer {
      display: none;
    }
    
    .thread-navigation {
      justify-content: space-between;
    }
  }

  /* More Menu Styles */
  .more-menu {
    position: relative;
  }

  .more-menu summary {
    list-style: none;
    cursor: pointer;
  }

  .more-menu summary::-webkit-details-marker {
    display: none;
  }

  .more-menu-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--m3-util-rounding-full);
    background: transparent;
    color: rgb(var(--m3-scheme-on-surface));
    border: none;
    cursor: pointer;
    transition: background-color 150ms cubic-bezier(0.4, 0.0, 0.2, 1);
    -webkit-tap-highlight-color: transparent;
  }

  .more-menu-button:hover {
    background: rgb(var(--m3-scheme-on-surface) / 0.08);
  }

  .more-menu-button:focus-visible {
    outline: 2px solid rgb(var(--m3-scheme-primary) / 0.6);
    outline-offset: -2px;
  }

  .menu-container {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 1000;
    margin-top: 0.25rem;
  }

  .more-menu[open] .menu-container {
    animation: menuFadeIn 150ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }

  @keyframes menuFadeIn {
    from {
      opacity: 0;
      transform: translateY(-0.5rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Filter Dialog Styles */
  .filter-dialog-content {
    max-width: 100%;
    min-width: 0;
  }

  .saved-filters-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .filter-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem;
    border-radius: var(--m3-util-rounding-small);
    background: rgb(var(--m3-scheme-surface-container-lowest));
  }

  /* Snooze Menu Styles */
  .snooze-menu-wrapper {
    display: inline-flex;
    align-items: center;
    position: relative;
  }

  .snooze-menu-toggle {
    position: relative;
  }

  .snooze-menu-toggle > summary {
    list-style: none;
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .snooze-menu-toggle summary::-webkit-details-marker {
    display: none;
  }

  /* Hide the menu content when closed */
  .snooze-menu-toggle > :global(:not(summary)) {
    display: none;
  }

  /* When the details element is open, display/position the popover as an overlay */
  .snooze-menu-toggle[open] > :global(:not(summary)) {
    display: block;
    position: fixed !important;
    z-index: 1000;
    left: 50%;
    top: 50%;
    pointer-events: auto;
    transform: translate(-50%, -50%);
    margin: 0;
  }

  .snooze-menu-content :global(.m3-container) {
    padding: 0.75rem;
    max-width: 24rem;
    max-height: min(95vh, 44rem);
    box-shadow: var(--m3-util-elevation-3);
  }

  .snooze-menu-toggle[open] .snooze-menu-content {
    animation: menuFadeIn 150ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }

  @keyframes menuFadeIn {
    from {
      opacity: 0;
      transform: translate(-50%, -50%) translateY(-0.5rem);
    }
    to {
      opacity: 1;
      transform: translate(-50%, -50%) translateY(0);
    }
  }

  .diag-sheet {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 0 0 2rem;
    max-height: min(80vh, 38rem);
    overflow-y: auto;
  }

  .diag-sheet__header h2 {
    margin: 0;
  }

  .diag-sheet__actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .diag-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  }

  .diag-grid section {
    padding: 0.75rem;
    border-radius: var(--m3-util-rounding-medium);
    background: rgb(var(--m3-scheme-surface-container-low));
  }

  .diag-grid dl {
    margin: 0;
    display: grid;
    gap: 0.5rem;
  }

  .diag-grid dt {
    font-weight: 600;
    font-size: 0.85rem;
    color: rgb(var(--m3-scheme-on-surface-variant));
  }

  .diag-grid dd {
    margin: 0;
    font-family: var(--m3-font-family-mono);
    font-size: 0.85rem;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .diag-attachments ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.5rem;
  }

  .diag-attachments li {
    padding: 0.5rem;
    border-radius: var(--m3-util-rounding-small);
    background: rgb(var(--m3-scheme-surface-container-lowest));
  }

  .diag-attachments .name {
    font-weight: 600;
  }

  .diag-attachments .meta {
    font-size: 0.8rem;
    color: rgb(var(--m3-scheme-on-surface-variant));
  }

  .diag-parts ol {
    margin: 0;
    padding-left: 1.1rem;
    display: grid;
    gap: 0.5rem;
  }

  .diag-parts pre,
  .diag-attachments pre,
  .diag-grid pre {
    margin: 0.25rem 0 0;
    padding: 0.5rem;
    border-radius: var(--m3-util-rounding-small);
    background: rgb(var(--m3-scheme-surface-container-highest));
    font-family: var(--m3-font-family-mono);
    font-size: 0.8rem;
    max-height: 10rem;
    overflow-y: auto;
  }

  .diag-headers dl {
    margin: 0;
    display: grid;
    gap: 0.5rem;
  }

  .diag-hash {
    padding: 0.75rem;
    border-radius: var(--m3-util-rounding-medium);
    background: rgb(var(--m3-scheme-surface-container-low));
  }

  .diag-hash p {
    margin: 0;
    font-family: var(--m3-font-family-mono);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
</style>

