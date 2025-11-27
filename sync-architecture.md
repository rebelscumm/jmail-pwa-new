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
- There are journal entries from the last 30 seconds (indicating recent user actions)

This prevents showing stale server counts due to eventual consistency delays. Once there's been no activity for 30+ seconds, server counts are used as the authoritative source.

---

## Background Sync Mechanisms

### 1. History API Sync (Every ~30 seconds)
- Fetches incremental changes from Gmail using `historyId`
- **Protection**: Checks journal for recent user actions (last 30 seconds)
- **Action**: Skips any threads the user recently modified
- **Result**: Fast updates without undoing user actions
- **Fallback**: If no historyId or error, triggers authoritative sync

### 2. Remote Check (Every 60 seconds)
- Compares Gmail's reported inbox count with local count
- **Protection**: Accounts for optimistic deltas in comparison
- **Action**: If discrepancy > 2 threads, runs gentle hydrate
- **Result**: Catches drift without aggressive syncing

### Sync Decision Matrix

When refresh is triggered, choose sync method based on state:

| Condition | Sync Method | Reason |
|-----------|-------------|--------|
| **Have historyId + drift < 5 threads** | History API Sync | Fast incremental update |
| **No historyId** | Authoritative Sync | Can't use history without baseline |
| **Drift > 5 threads** | Authoritative Sync | Safer to enumerate all than trust incremental |
| **History API fails** | Authoritative Sync | Fallback for reliability |
| **Manual refresh button** | Authoritative Sync | User expects full reconciliation |

**Priority**: Always prefer History API when possible (faster, less bandwidth), but use Authoritative Sync when accuracy is critical.

### 3. Authoritative Sync (On startup / manual refresh)

Uses `threads.list` API as the **primary source of truth** for reliable enumeration.

**How It Works:**

1. **Step 1: Enumerate all Gmail INBOX thread IDs**
   - Uses `threads.list` API with `labelIds=INBOX`
   - Paginates through ALL pages (500 threads/page) until no more pages
   - No arbitrary page limits - fetches everything Gmail reports
   - Dynamic page limits based on Gmail's reported thread count

2. **Step 2: Identify missing threads**
   - Compares Gmail's thread IDs with local IndexedDB
   - Threads in Gmail but not local → fetch and store
   - Threads in local missing INBOX label → add label (with protection checks)

3. **Step 3: Fetch missing threads**
   - Fetches thread summaries for all missing threads
   - Processes in batches of 20 with concurrency of 4
   - Stores threads and messages to IndexedDB
   - Ensures INBOX label is present

4. **Step 4: Add INBOX label to existing threads**
   - For threads that exist locally but are missing INBOX label
   - Checks for pending operations and terminal labels first

5. **Step 5: Remove INBOX from stale threads**
   - Local threads with INBOX that aren't in Gmail's list
   - Protected by pending ops check (2-minute window)
   - Terminal labels (TRASH/SPAM) are never modified

6. **Step 6: Refresh labels for existing threads**
   - Updates labels for a subset of existing INBOX threads
   - Catches read/unread state changes
   - Limited to 50 threads per sync for performance

**Protection Logic:**
- **Terminal labels**: TRASH/SPAM threads are never modified
- **Pending operations**: Threads with queued ops are skipped
- **Recent journal entries**: Actions within 2 minutes are protected
- **New threads**: Always fetched (no protection needed - they're new)

**Why threads.list is Primary:**
- More reliable than message-based enumeration
- Consistent pagination behavior
- Directly returns thread IDs without extra API calls
- Matches Gmail's reported thread counts

---

## Conflict Resolution

When background sync encounters a user action:

**Priority Order:**
1. **Terminal label rule** → HIGHEST priority (never violated)
2. **Recent user action** (journal entry < 30s for Phase 1, < 2min for Phase 2) → Always preserved
3. **Pending operation** (in ops queue) → Always preserved
4. **Server state** → Applied only if no conflict

**Example Scenario:**
- User archives an email at T+0
- Gmail receives a reply at T+10 seconds  
- Background sync runs at T+35 seconds (after 30s window)
- **Resolution**: 
  - Archive is NO LONGER protected by Phase 1 (> 30 seconds old)
  - BUT Phase 2 protects it from being added back (< 2 minutes)
  - New threads FROM Gmail are fetched normally
  - Reply thread will appear based on its actual Gmail state
  
**Key Point**: Short 30-second window means refresh fetches new emails quickly while only protecting very recent deletions.

---

## Terminal Label Rules

**Terminal labels** (`TRASH`, `SPAM`) represent final user decisions and have special handling:

### Critical Invariants (NEVER Violated)

1. **Never add INBOX if TRASH present**
   - User deleted thread → stays deleted forever
   - Even if Gmail shows INBOX, local state wins
   - Applies to: Phase 1, Phase 1a, `applyRemoteLabels`, new thread storage

2. **Never add INBOX if SPAM present**
   - User marked as spam → stays spam forever
   - Even if Gmail shows INBOX, local state wins
   - Applies to: Phase 1, Phase 1a, `applyRemoteLabels`, new thread storage

3. **Never remove TRASH/SPAM during Phase 2**
   - Phase 2 only removes INBOX from non-terminal threads
   - Terminal labels are permanent until user explicitly undoes
   - Protects against accidental resurrection

### Implementation Locations

- **Phase 1 (adding INBOX)**: Check before adding INBOX to existing threads
- **Phase 1a (quick updates)**: Check before batching INBOX additions
- **Phase 1b (new threads)**: Skip storing if thread has terminal label
- **Phase 2 (removing INBOX)**: Skip if thread has terminal label
- **applyRemoteLabels**: Always remove INBOX if TRASH/SPAM present
- **Paging loop storage**: Check before storing from enumeration

### Why This Matters

Without terminal label protection:
- ❌ Deleted emails could reappear in inbox during sync
- ❌ Spam could resurface if Gmail's eventual consistency lags
- ❌ User's explicit "delete" or "spam" actions could be undone

With terminal label protection:
- ✅ Deleted emails stay deleted (only undo can restore)
- ✅ Spam stays marked as spam
- ✅ User actions are respected permanently

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
| **Terminal labels** | Forever | TRASH/SPAM are permanent decisions (only undo can reverse) |
| **Phase 1 (adding INBOX)** | 30 seconds | Short window allows new emails to appear quickly while protecting immediate user actions |
| **Phase 2 (removing INBOX)** | 2 minutes | More conservative - better to keep a thread visible than accidentally hide it |
| **Counter refresh** | 30 seconds | Match Phase 1 to show fresh counts quickly after user actions settle |
| **Journal retention** | 10 minutes | Enable undo while preventing unbounded growth |
| **History API drift threshold** | 5 threads | Beyond this, use authoritative sync instead of incremental |

**Design principle**: Err on the side of showing fresh data while protecting very recent user actions (< 30s).

**Protection hierarchy**: Terminal labels (permanent) → Recent journal entries (30s-2min) → Pending ops (until complete) → Server state (default).

---

## System Invariants

These rules are **NEVER** violated, regardless of server state or timing:

### Label Invariants

1. **INBOX + TRASH = Impossible**
   - If thread has TRASH label, INBOX is NEVER added
   - Enforced at: Phase 1, Phase 1a, Phase 1b, `applyRemoteLabels`, paging storage
   - Violation would: Resurrect deleted emails in inbox

2. **INBOX + SPAM = Impossible**
   - If thread has SPAM label, INBOX is NEVER added
   - Enforced at: Phase 1, Phase 1a, Phase 1b, `applyRemoteLabels`, paging storage
   - Violation would: Show spam in inbox

3. **Terminal labels are permanent**
   - TRASH and SPAM labels are never removed by sync
   - Only user undo can remove terminal labels
   - Phase 2 explicitly skips threads with terminal labels

### Protection Invariants

4. **Pending operations always complete**
   - Threads with pending ops in queue are never modified by sync
   - Ensures user actions reach Gmail before reconciliation
   - Violation would: Lose queued user actions

5. **Recent actions preserved**
   - Journal entries within time window (30s-2min) protect threads
   - Time window depends on operation phase
   - Violation would: Undo user actions immediately after they occur

6. **New threads always fetched**
   - If Gmail reports a thread ID we don't have, we always fetch it
   - Even if ops/journal lookup fails, new threads are stored
   - Only exception: Thread has terminal label (TRASH/SPAM)
   - Violation would: Miss new emails from Gmail

### Counter Invariants

7. **Counters = local + optimistic**
   - Display always shows: `local thread count + pending op delta`
   - Never show server count if recent activity detected
   - Violation would: Display incorrect counts during pending operations

8. **Optimistic deltas never lost**
   - If operations remain after sync, deltas are recalculated (not reset)
   - Only reset when ops queue is truly empty
   - Violation would: Threads "pop back" visually during slow operations

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
   - Rely on authoritative sync (triggered by user or periodic background) for reconciliation
   
2. **Preserve local state during refresh** (applies to authoritative sync)
   - Check terminal labels FIRST (TRASH/SPAM always win over server state)
   - Check journal for recent actions (30 seconds for Phase 1, 2 minutes for Phase 2)
   - Check ops queue for pending operations
   - Skip server reconciliation if any protection rule applies
   - If error checking ops/journal: NEW threads always fetched, existing threads protected

3. **Authoritative sync reconciles everything**
   - Periodic background syncs (60s intervals)
   - Manual refresh via refresh button
   - Fetches ALL threads from Gmail
   - Applies protections: terminal labels → journal (time-windowed) → ops queue
   - Uses short time windows (30s/2min) to balance protection vs fresh data

4. **Counter display logic**
   - Server counters NOT used when there's recent activity
   - 30-second grace period for counter updates (matches Phase 1)
   - After grace period, server becomes authoritative again

5. **Journal lifecycle**
   - Created on every user action
   - Pruned automatically after 10 minutes
   - Phase 1 checks last 30 seconds, Phase 2 checks last 2 minutes
   - Counters check last 30 seconds
   - Prevents stale entries from blocking fresh data forever

