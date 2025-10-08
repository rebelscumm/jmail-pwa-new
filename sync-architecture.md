# Email Sync Architecture

## Overview

The client maintains local email state and syncs with Gmail servers while preserving user actions and showing accurate counters in real-time.

## Core Principles

- **Optimistic UI**: User actions update the UI immediately before server confirmation
- **Eventual Consistency**: Server is source of truth, but client can temporarily diverge during pending operations
- **Action Preservation**: Background syncs never undo recent user actions
- **Accurate Counters**: Display counters = server counters + optimistic adjustments for pending operations

---

## User Action Flow

When a user deletes/archives/snoozes an email:

1. **Immediate UI Update**
   - Thread disappears from inbox
   - Counters decrease immediately
   - Local IndexedDB updated with new labels

2. **Journal Entry Created**
   - Records the action (threadId, action type, timestamp)
   - Used to preserve action during background syncs
   - Enables undo functionality

3. **Operation Queued**
   - API call queued to Gmail
   - Includes retry logic and exponential backoff
   - Processed asynchronously in background

4. **Optimistic Counter Adjustment**
   - `inboxDelta` tracks pending INBOX changes
   - `unreadDelta` tracks pending UNREAD changes
   - Display shows: `serverCount + delta`

5. **Server Confirmation**
   - Gmail API processes the change
   - Operation removed from queue
   - Optimistic deltas eventually reset to 0

---

## Counter Management

### How Counters Work

```
Display Inbox Total = Server Inbox Total + Inbox Delta
Display Unread Total = Server Unread Total + Unread Delta
```

- **Server counters**: Baseline from Gmail (source of truth)
- **Optimistic deltas**: Sum of pending operations' impact
- **Display counters**: What the user sees (always accurate even during pending ops)

### Example

1. Server reports 50 inbox emails
2. User deletes 3 emails → `inboxDelta = -3`
3. Display shows: `50 + (-3) = 47` emails
4. Operations complete, server now reports 47
5. Delta resets to 0, display still shows 47

---

## Background Sync Mechanisms

### 1. History API Sync (Every ~30 seconds)
- Fetches incremental changes from Gmail using `historyId`
- **Protection**: Checks journal for recent user actions (last 5 minutes)
- **Action**: Skips any threads the user recently modified
- **Result**: Fast updates without undoing user actions

### 2. Remote Check (Every 60 seconds)
- Compares Gmail's reported inbox count with local count
- **Protection**: Accounts for optimistic deltas in comparison
- **Action**: If discrepancy > 2 threads, runs gentle hydrate
- **Result**: Catches drift without aggressive syncing

### 3. Authoritative Sync (On startup / manual refresh)
- Enumerates all inbox threads from Gmail
- **Protection**: Checks both ops queue and journal before modifications
- **Before Sync**: Attempts to flush pending operations, but preserves them if they fail
- **Action**: Full reconciliation, adds missing, removes stale
- **Result**: Nuclear option for complete accuracy
- **Important**: Optimistic counters are only reset if all pending ops successfully complete; otherwise they're recalculated to preserve visual state

---

## Conflict Resolution

When background sync encounters a user action:

**Priority Order:**
1. **Recent user action** (journal entry < 5 min old) → Always preserved
2. **Pending operation** (in ops queue) → Always preserved
3. **Server state** → Applied only if no conflict

**Example Scenario:**
- User archives an email at T+0
- Gmail receives a reply at T+10 seconds
- Background sync runs at T+30 seconds
- **Resolution**: Archive preserved (user action wins), reply appears in Archive folder

---

## Data Storage

### IndexedDB Tables

- **threads**: Thread metadata, labels, message IDs
- **messages**: Full message content and headers
- **ops**: Queued operations to send to Gmail
- **journal**: User action history for undo and conflict resolution
- **settings**: Sync state (historyId), user preferences

### Svelte Stores (Memory)

- **threadsStore**: Current thread list (optimistically updated)
- **messagesStore**: Message details by ID
- **optimisticCounters**: { inboxDelta, unreadDelta }
- **labelsStore**: Label metadata including server counters

---

## Error Handling

### Failed Operations
- Automatic retry with exponential backoff
- After 5 attempts, marked as "stuck"
- User can manually retry or dismiss

### Failed Syncs
- Log error but don't block UI
- Keep optimistic state intact
- Retry on next sync cycle
- Show notification only for critical failures

---

## Performance Safeguards

- **Debouncing**: Minimum 60s between sync checks
- **Visibility**: No syncing when tab hidden
- **Online Check**: No syncing when offline
- **Mutex Flags**: Prevent overlapping sync operations
- **Pagination**: Large syncs use cursors to avoid timeouts

