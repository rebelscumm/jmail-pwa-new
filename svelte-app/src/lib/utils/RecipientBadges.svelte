<script lang="ts">
  import Icon from '$lib/misc/_icon.svelte';
  import iconPerson from '@ktibow/iconset-material-symbols/person';
  import iconGroup from '@ktibow/iconset-material-symbols/group';
  import iconVisibility from '@ktibow/iconset-material-symbols/visibility';
  import iconMore from '@ktibow/iconset-material-symbols/more-horiz';
  import { userEmail } from '$lib/stores/user';

  let { 
    to = '', 
    cc = '', 
    bcc = '',
    maxDisplayCount = 3,
    compact = false 
  }: { 
    to?: string; 
    cc?: string; 
    bcc?: string; 
    maxDisplayCount?: number;
    compact?: boolean;
  } = $props();

  // Get current user's email from shared store
  const currentUserEmail = $derived($userEmail);

  // Parse email addresses from header strings
  function parseEmailAddresses(headerValue: string): Array<{email: string, name?: string}> {
    if (!headerValue) return [];
    
    const addresses: Array<{email: string, name?: string}> = [];
    
    // More robust parsing to handle various email formats
    // Split by comma but preserve quoted strings
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    let depth = 0;
    
    for (let i = 0; i < headerValue.length; i++) {
      const char = headerValue[i];
      
      if (char === '"' && (i === 0 || headerValue[i-1] !== '\\')) {
        inQuotes = !inQuotes;
      } else if (char === '<' && !inQuotes) {
        depth++;
      } else if (char === '>' && !inQuotes) {
        depth--;
      } else if (char === ',' && !inQuotes && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
      
      current += char;
    }
    
    if (current.trim()) {
      parts.push(current.trim());
    }
    
    for (const part of parts) {
      if (!part) continue;
      
      // Match various patterns:
      // "Display Name" <email@domain.com>
      // Display Name <email@domain.com>
      // email@domain.com
      // <email@domain.com>
      const patterns = [
        /^"([^"]+)"\s*<([^>]+)>$/,  // "Name" <email>
        /^([^<]+)\s*<([^>]+)>$/,    // Name <email>
        /^<([^>]+)>$/,              // <email>
        /^([^\s<>]+@[^\s<>]+)$/     // email
      ];
      
      let matched = false;
      for (const pattern of patterns) {
        const match = part.match(pattern);
        if (match) {
          let name: string | undefined;
          let email: string;
          
          if (pattern === patterns[0] || pattern === patterns[1]) {
            // Has both name and email
            name = match[1]?.trim();
            email = match[2]?.trim();
          } else if (pattern === patterns[2]) {
            // Just <email>
            email = match[1]?.trim();
          } else {
            // Just email
            email = match[1]?.trim();
          }
          
          if (email && email.includes('@')) {
            // Filter out the current user's email address
            if (currentUserEmail && email.toLowerCase() === currentUserEmail) {
              matched = true;
              break; // Skip adding this address
            }
            addresses.push({ 
              email, 
              name: name && name !== email ? name : undefined 
            });
            matched = true;
            break;
          }
        }
      }
      
      // Fallback: if no pattern matched, try to extract email
      if (!matched && part.includes('@')) {
        const emailMatch = part.match(/([^\s<>]+@[^\s<>]+)/);
        if (emailMatch) {
          const email = emailMatch[1].trim();
          // Filter out the current user's email address
          if (!currentUserEmail || email.toLowerCase() !== currentUserEmail) {
            addresses.push({ email });
          }
        }
      }
    }
    
    return addresses;
  }

  const toAddresses = $derived(parseEmailAddresses(to));
  const ccAddresses = $derived(parseEmailAddresses(cc));
  const bccAddresses = $derived(parseEmailAddresses(bcc));
  
  const allRecipients = $derived([
    ...toAddresses.map(addr => ({ ...addr, type: 'to' as const })),
    ...ccAddresses.map(addr => ({ ...addr, type: 'cc' as const })),
    ...bccAddresses.map(addr => ({ ...addr, type: 'bcc' as const }))
  ]);

  const displayRecipients = $derived(allRecipients.slice(0, maxDisplayCount));
  const remainingCount = $derived(Math.max(0, allRecipients.length - maxDisplayCount));

  function getRecipientIcon(type: 'to' | 'cc' | 'bcc') {
    switch (type) {
      case 'to': return iconPerson;
      case 'cc': return iconGroup;
      case 'bcc': return iconVisibility;
    }
  }

  function getRecipientLabel(recipient: {email: string, name?: string, type: 'to' | 'cc' | 'bcc'}) {
    const displayName = recipient.name || recipient.email;
    return compact ? displayName.split('@')[0] : displayName;
  }

  function getRecipientTitle(recipient: {email: string, name?: string, type: 'to' | 'cc' | 'bcc'}) {
    const typeLabel = recipient.type.toUpperCase();
    return `${typeLabel}: ${recipient.name || recipient.email}`;
  }

  function handleRecipientClick(recipient: {email: string, name?: string, type: 'to' | 'cc' | 'bcc'}) {
    // Copy email to clipboard for easy use
    try {
      navigator.clipboard.writeText(recipient.email);
      // Could dispatch a custom event here to show a snackbar if needed
      console.log(`Copied ${recipient.email} to clipboard`);
    } catch (e) {
      console.warn('Failed to copy email to clipboard:', e);
    }
  }

  function handleMoreClick() {
    // Could open a dialog showing all recipients
    console.log('Show all recipients:', allRecipients);
  }
</script>

{#if allRecipients.length > 0}
  <div class="recipient-badges" class:compact>
    {#each displayRecipients as recipient}
      <div 
        class="recipient-badge" 
        class:to={recipient.type === 'to'}
        class:cc={recipient.type === 'cc'}
        class:bcc={recipient.type === 'bcc'}
        title={getRecipientTitle(recipient)}
        role="button"
        tabindex="0"
        onclick={() => handleRecipientClick(recipient)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleRecipientClick(recipient); } }}
      >
        <Icon icon={getRecipientIcon(recipient.type)} />
        <span class="recipient-label">{getRecipientLabel(recipient)}</span>
      </div>
    {/each}
    
    {#if remainingCount > 0}
      <div 
        class="recipient-badge more" 
        title="{remainingCount} more recipient{remainingCount === 1 ? '' : 's'}"
        role="button"
        tabindex="0"
        onclick={handleMoreClick}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleMoreClick(); } }}
      >
        <Icon icon={iconMore} />
        <span class="recipient-label">+{remainingCount}</span>
      </div>
    {/if}
  </div>
{/if}

<style>
  .recipient-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    align-items: center;
    margin: 0.25rem 0;
  }

  .recipient-badges.compact {
    gap: 0.125rem;
  }

  .recipient-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.375rem;
    border-radius: var(--m3-util-rounding-extra-small);
    font-size: 0.75rem;
    line-height: 1.2;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 150ms cubic-bezier(0.4, 0, 0.2, 1);
    min-height: 1.5rem;
    box-sizing: border-box;
  }

  .recipient-badges.compact .recipient-badge {
    padding: 0.0625rem 0.25rem;
    gap: 0.125rem;
    min-height: 1.25rem;
  }

  /* Material Design 3 color variants for different recipient types */
  .recipient-badge.to {
    background: rgb(var(--m3-scheme-primary-container));
    color: rgb(var(--m3-scheme-on-primary-container));
  }

  .recipient-badge.to:hover {
    background: color-mix(in srgb, rgb(var(--m3-scheme-primary-container)) 85%, rgb(var(--m3-scheme-on-primary-container)) 15%);
  }

  .recipient-badge.cc {
    background: rgb(var(--m3-scheme-secondary-container));
    color: rgb(var(--m3-scheme-on-secondary-container));
  }

  .recipient-badge.cc:hover {
    background: color-mix(in srgb, rgb(var(--m3-scheme-secondary-container)) 85%, rgb(var(--m3-scheme-on-secondary-container)) 15%);
  }

  .recipient-badge.bcc {
    background: rgb(var(--m3-scheme-tertiary-container));
    color: rgb(var(--m3-scheme-on-tertiary-container));
  }

  .recipient-badge.bcc:hover {
    background: color-mix(in srgb, rgb(var(--m3-scheme-tertiary-container)) 85%, rgb(var(--m3-scheme-on-tertiary-container)) 15%);
  }

  .recipient-badge.more {
    background: rgb(var(--m3-scheme-surface-variant));
    color: rgb(var(--m3-scheme-on-surface-variant));
  }

  .recipient-badge.more:hover {
    background: color-mix(in srgb, rgb(var(--m3-scheme-surface-variant)) 85%, rgb(var(--m3-scheme-on-surface-variant)) 15%);
  }

  .recipient-badge :global(svg) {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
  }

  .recipient-badges.compact .recipient-badge :global(svg) {
    width: 0.75rem;
    height: 0.75rem;
  }

  .recipient-label {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 8rem;
  }

  .recipient-badges.compact .recipient-label {
    max-width: 6rem;
  }

  /* Focus styles for accessibility */
  .recipient-badge:focus {
    outline: 2px solid rgb(var(--m3-scheme-primary));
    outline-offset: 2px;
  }

  /* Responsive design - smaller badges on mobile */
  @media (max-width: 480px) {
    .recipient-badges {
      gap: 0.125rem;
    }

    .recipient-badge {
      padding: 0.0625rem 0.25rem;
      gap: 0.125rem;
      font-size: 0.6875rem;
      min-height: 1.25rem;
    }

    .recipient-badge :global(svg) {
      width: 0.75rem;
      height: 0.75rem;
    }

    .recipient-label {
      max-width: 5rem;
    }
  }
</style>
