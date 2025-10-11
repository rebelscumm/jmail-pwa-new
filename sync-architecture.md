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
   - Display shows: `localCount + delta`

5. **Server Confirmation**
   - Gmail API processes the change
   - Operation removed from queue
   - Optimistic deltas reset to 0
   - **Important**: No immediate server reconciliation after operation completes
     - Gmail's eventual consistency is unpredictable (1-10+ seconds)
     - Immediate reconciliation causes thread resurrection due to stale server state
     - Trust optimistic local state; authoritative sync handles reconciliation

---

## Counter Management

### How Counters Work

```
Display Inbox Total = Local Thread Count + Optimistic Delta
Display Unread Total = Local Thread Count + Optimistic Delta
```

- **Local thread count**: Number of threads with INBOX/UNREAD labels in IndexedDB
- **Optimistic deltas**: Sum of pending operations' impact
- **Display counters**: What the user sees (always accurate even during pending ops)
- **Server counters**: Periodically fetched from Gmail, but NOT used if there's recent user activity

### Example

1. Local DB has 50 inbox threads
2. User deletes 3 emails → Local DB updated (47 threads), `inboxDelta = -3`
3. Display shows: `47 + (-3) = 44` emails (optimistic, showing final state immediately)
4. Operations complete → Operations removed from queue, `inboxDelta` resets to 0
5. Display shows: `47 + 0 = 47` emails (now based purely on local DB)
6. User presses refresh → Authoritative sync runs (protects recently deleted threads via journal)
7. After 30+ seconds → Sync can reconcile with Gmail (fetches new emails, removes truly stale threads)

### Server Counter Refresh

Gmail's reported counts are fetched periodically but are **NOT** used to overwrite local counts when:
- There are pending operations in the queue
- There are journal entries from the last 2 minutes (indicating recent user actions)

This prevents showing stale server counts due to eventual consistency delays. Once there's been no activity for 2+ minutes, server counts are used as the authoritative source.

---

## Background Sync Mechanisms

### 1. History API Sync (Every ~30 seconds)
- Fetches incremental changes from Gmail using `historyId`
- **Protection**: Checks journal for recent user actions (last 2 minutes)
- **Action**: Skips any threads the user recently modified
- **Result**: Fast updates without undoing user actions

### 2. Remote Check (Every 60 seconds)
- Compares Gmail's reported inbox count with local count
- **Protection**: Accounts for optimistic deltas in comparison
- **Action**: If discrepancy > 2 threads, runs gentle hydrate
- **Result**: Catches drift without aggressive syncing

### 3. Authoritative Sync (On startup / manual refresh)
- Enumerates all inbox threads from Gmail
- **Protection**: Checks **BOTH** ops queue **AND** journal before modifications
  - Ops queue: Operations still pending/retrying
  - Journal: Recently completed operations (kept for undo even after sync succeeds)
  - Journal time window: 
    - **Phase 1 (adding INBOX)**: 30 seconds - very short to allow new emails to appear quickly
    - **Phase 2 (removing INBOX)**: 2 minutes - more conservative about removing INBOX
  - If EITHER indicates a user action, that thread is skipped during reconciliation
- **Before Sync**: Attempts to flush pending operations, but preserves them if they fail
- **Action**: Full reconciliation in two phases:
  1. **Phase 1**: Adds missing INBOX label to threads that should have it (30-second protection)
  2. **Phase 2**: Removes INBOX from threads that shouldn't have it (2-minute protection)
- **Result**: Nuclear option for complete accuracy
- **Important**: 
  - Optimistic counters are only reset if all pending ops successfully complete; otherwise they're recalculated to preserve visual state
  - **New threads from Gmail**: Always fetched and stored (no pending ops can exist for unseen threads)
  - **Existing threads**: Only modified if no pending/recent actions found
  - If ops/journal lookup returns `null` or empty, proceed (means no conflicts exist)
  - After 30 seconds (Phase 1) or 2 minutes (Phase 2), sync can reconcile a thread
  - **Short windows balance**: protecting immediate user actions vs showing fresh Gmail data

---

## Conflict Resolution

When background sync encounters a user action:

**Priority Order:**
1. **Recent user action** (journal entry < 30s for adding INBOX, < 2min for removing INBOX) → Always preserved
2. **Pending operation** (in ops queue) → Always preserved
3. **Server state** → Applied only if no conflict

**Example Scenario:**
- User archives an email at T+0
- Gmail receives a reply at T+10 seconds  
- Background sync runs at T+35 seconds
- **Resolution**: 
  - Archive preserved (user action within 30-second Phase 1 window)
  - Reply thread will appear in Archive folder (not resurrected to INBOX)
  - After 2+ minutes, Phase 2 can remove stale INBOX labels if needed

---

## Data Storage

### IndexedDB Tables

- **threads**: Thread metadata, labels, message IDs
- **messages**: Full message content and headers
- **ops**: Queued operations to send to Gmail
- **journal**: User action history for undo and conflict resolution
  - **Lifecycle**: Created on user actions, pruned after 10 minutes
  - **Purpose 1**: Enable undo (keep last 10 minutes)
  - **Purpose 2**: Protect recent actions during sync (check last 30s-2min depending on phase)
  - **Pruning**: Automatic cleanup on each new action to prevent unbounded growth
  - **Time windows**: Phase 1 uses 30s, Phase 2 uses 2min, counters use 2min
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

## Time Window Trade-offs

The system uses different time windows for different operations to balance protection vs freshness:

| Operation | Time Window | Rationale |
|-----------|-------------|-----------|
| **Phase 1 (adding INBOX)** | 30 seconds | Short window allows new emails to appear quickly while protecting immediate user actions |
| **Phase 2 (removing INBOX)** | 2 minutes | More conservative - better to keep a thread visible than accidentally hide it |
| **Counter refresh** | 2 minutes | Eventual consistency grace period for display values |
| **Journal retention** | 10 minutes | Enable undo while preventing unbounded growth |

**Design principle**: Err on the side of showing fresh data while protecting very recent user actions (< 30s).

---

## Performance Safeguards

- **Debouncing**: Minimum 60s between sync checks
- **Visibility**: No syncing when tab hidden
- **Online Check**: No syncing when offline
- **Mutex Flags**: Prevent overlapping sync operations
- **Pagination**: Large syncs use cursors to avoid timeouts

---

## Eventual Consistency Handling

Gmail's API exhibits **eventual consistency**: changes made via the API may not immediately appear in subsequent API reads. This is especially noticeable when:
- User performs an action (archive, delete, snooze)
- Operation succeeds on server
- Immediately fetching the same thread returns OLD state

### Our Strategy

1. **Trust optimistic local state** after operations complete
   - Do NOT fetch server state immediately after operation
   - Gmail's eventual consistency is unpredictable (1-10+ seconds)
   - Immediate fetching causes thread resurrection due to stale server data
   - Let authoritative sync handle reconciliation when user triggers refresh
   
2. **Preserve local state during refresh**
   - Check journal for recent actions (30 seconds for Phase 1, 2 minutes for Phase 2)
   - Check ops queue for pending operations
   - Skip server reconciliation if either exists

3. **Let authoritative sync reconcile everything**
   - Periodic background syncs (60s intervals)
   - Manual refresh via refresh button
   - Both respect pending/recent actions via journal checks
   - Fetches ALL threads from Gmail, not just operated ones
   - Uses short time windows to balance protection vs fresh data

4. **Counter display logic**
   - Server counters NOT used when there's recent activity
   - 2-minute grace period for counter updates
   - After grace period, server becomes authoritative again

5. **Journal lifecycle**
   - Created on every user action
   - Pruned automatically after 10 minutes
   - Phase 1 checks last 30 seconds, Phase 2 checks last 2 minutes
   - Counters check last 2 minutes
   - Prevents stale entries from blocking fresh data forever

