/**
 * Gmail link utilities for generating URLs to Gmail web interface
 */

/**
 * Generate a Gmail URL for a specific thread
 * @param threadId - Gmail thread ID
 * @returns Gmail web interface URL for the thread
 */
export function getGmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
}

/**
 * Generate a Gmail URL for a specific message within a thread
 * @param threadId - Gmail thread ID
 * @param messageId - Gmail message ID
 * @returns Gmail web interface URL for the specific message
 */
export function getGmailMessageUrl(threadId: string, messageId: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${threadId}/${messageId}`;
}

/**
 * Generate a Gmail popup URL for a specific thread (minimal interface)
 * @param threadId - Gmail thread ID
 * @returns Gmail popup URL for the thread
 */
export function getGmailPopupUrl(threadId: string): string {
  // Format the thread ID for Gmail's popup URL format
  const formattedThreadId = threadId.startsWith('#thread-f:') ? threadId : `#thread-f:${threadId}`;
  const encodedThreadId = encodeURIComponent(formattedThreadId);
  return `https://mail.google.com/mail/u/0/popout?ver=zs1qyhlt6gr6&search=inbox&type=%2523thread-f%253A${threadId}&th=${encodedThreadId}&cvid=2`;
}

/**
 * Open a Gmail thread in a popup window (minimal interface)
 * @param threadId - Gmail thread ID
 */
export function openGmailPopup(threadId: string): void {
  // Use the reliable standard URL but in a popup window to achieve a minimal feel
  const url = getGmailThreadUrl(threadId);
  const width = 980;
  const height = 800;
  const left = Math.max(0, Math.floor((window.screen.width - width) / 2));
  const top = Math.max(0, Math.floor((window.screen.height - height) / 2));
  const features = [
    'width=' + width,
    'height=' + height,
    'left=' + left,
    'top=' + top,
    'scrollbars=1',
    'resizable=1',
    'toolbar=0',
    'menubar=0',
    'location=0',
    'status=0'
  ].join(',');
  const popup = window.open(url, '', features);
  
  // Focus the popup window if it opened successfully
  if (popup) { try { popup.opener = null; } catch {} try { popup.focus(); } catch {} }
  // Fallback: if popup blocked, open in a new tab
  if (!popup) {
    try { window.open(url, '_blank'); } catch { try { location.href = url; } catch {} }
  }
}

/**
 * Open a specific Gmail message in a popup window
 */
export function openGmailMessagePopup(threadId: string, messageId: string): void {
  const url = getGmailMessageUrl(threadId, messageId);
  const width = 980;
  const height = 800;
  const left = Math.max(0, Math.floor((window.screen.width - width) / 2));
  const top = Math.max(0, Math.floor((window.screen.height - height) / 2));
  const features = [
    'width=' + width,
    'height=' + height,
    'left=' + left,
    'top=' + top,
    'scrollbars=1',
    'resizable=1',
    'toolbar=0',
    'menubar=0',
    'location=0',
    'status=0'
  ].join(',');
  const popup = window.open(url, '', features);
  if (popup) { try { popup.opener = null; } catch {} try { popup.focus(); } catch {} }
  if (!popup) {
    try { window.open(url, '_blank'); } catch { try { location.href = url; } catch {} }
  }
}

/**
 * Generate a Gmail URL for a thread, preferring message-specific URL if messageId is provided
 * @param threadId - Gmail thread ID  
 * @param messageId - Optional Gmail message ID
 * @returns Gmail web interface URL
 */
export function getGmailUrl(threadId: string, messageId?: string): string {
  return messageId 
    ? getGmailMessageUrl(threadId, messageId)
    : getGmailThreadUrl(threadId);
}
