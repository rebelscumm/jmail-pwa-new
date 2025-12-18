# Precompute Moderation Debugging Guide

## Issue: Precompute Not Processing New Emails

If the college recruiting filter works on individual emails but doesn't automatically process new emails during precompute, follow these debugging steps:

### Step 1: Verify Precompute is Running

1. Go to `/diagnostics` page
2. Scroll to "Precompute Logs" section
3. Look for recent entries with `[Precompute]` prefix
4. Check for these key log messages:
   - `[Precompute] Settings:` - Shows if precompute is enabled
   - `[Precompute] Total threads in DB:` - Shows how many threads are loaded
   - `[Precompute] Inbox candidates:` - Shows how many threads are eligible for processing
   - `[Precompute] Processing batch of:` - Shows how many threads are being processed in this run
   - `[Precompute] Moderation eligibility check:` - Shows how many threads are eligible for moderation

### Step 2: Check Settings

1. Go to `/settings` page
2. Verify these settings are enabled:
   - **AI Precompute** - Must be enabled
   - **AI API Key** - Must be set
   - **AI Provider** - Should be "Gemini" (or your preferred provider)
   - **AI Summary Model** - Should be set (e.g., `gemini-1.5-flash`)

### Step 3: Check Thread Eligibility Logs

Look for these log patterns in the diagnostics:

**Thread is eligible** (should see this for new emails):
```
[Precompute] Thread eligible for moderation (no existing): <thread-id>
```

**Thread is skipped** (shouldn't see these for new recruiting emails):
```
[Precompute] Thread not in INBOX: <thread-id>
[Precompute] Thread has no body content: <thread-id>
[Precompute] Thread already has college_recruiting label: <thread-id>
[Precompute] Thread match, retry: false <thread-id> actionTaken: label_enqueued
```

### Step 4: Check Moderation Processing

Look for these log patterns:

**Moderation is running**:
```
[Precompute] Running college recruiting moderation for X threads
[Precompute] Moderation verdict for <thread-id>: match
```

**Moderation found matches**:
```
[Precompute] Enqueuing label for recruiting match <thread-id> labelId: <label-id>
```

**Moderation errors**:
```
[Precompute] Moderation failed for <thread-id>: <error>
[Precompute] Failed to enqueue label for <thread-id>: <error>
```

### Step 5: Verify Label Creation

Check if the `college_recruiting` label was created:

1. Look for this log entry:
   ```
   [Precompute] Created college_recruiting label: <label-id>
   ```
   OR
   ```
   [Precompute] Found existing college_recruiting label: <label-id>
   ```

2. Check Gmail directly to see if the label exists

### Step 6: Manual Trigger for Testing

1. Use the overflow menu "Run College Recruiting Filter"
2. Check the snackbar message - should say how many threads were processed
3. Check the diagnostics page immediately after for processing logs
4. Look at "College Recruiting Moderation" stats to see if matches were found

### Common Issues

#### Issue: "Moderation eligibility check: total prepared: X eligible: 0"
**Cause**: All threads are being filtered out as ineligible
**Check**: Look for eligibility logs for each thread to see why they're skipped

#### Issue: No moderation logs at all
**Cause**: Precompute might not be running or moderation isn't being triggered
**Solutions**:
- Verify "AI Precompute" is enabled in settings
- Check if there are any threads in the inbox
- Try running precompute manually from the overflow menu

#### Issue: "Moderation verdict: match" but no "Enqueuing label" message
**Cause**: Label creation or queueing failed
**Check**: Look for error messages about label creation or queueing

#### Issue: Precompute runs but processes 0 threads
**Causes**:
- No threads in the inbox
- All threads have been processed already
- Threads don't meet eligibility criteria
**Check**: 
- Inbox sync status
- Thread labels in IndexedDB
- Eligibility logs

### Debug Checklist

- [ ] Precompute is enabled in settings
- [ ] AI API key is set
- [ ] Precompute logs show recent activity
- [ ] "Inbox candidates" count is > 0
- [ ] "Moderation eligibility check" shows eligible threads
- [ ] Moderation verdicts are being logged
- [ ] Label enqueuing messages appear for matches
- [ ] `college_recruiting` label exists in Gmail
- [ ] Check `/diagnostics` College Recruiting Moderation stats

### Getting More Information

1. **Run a test**: Use overflow menu "Run College Recruiting Filter"
2. **Check logs immediately**: Go to `/diagnostics` and look at precompute logs
3. **Look for specific thread**: Find your recruiting email's thread ID and search logs for it
4. **Check moderation stats**: Use "Load Moderation Stats" button in diagnostics
5. **Test individual email**: Use "Test Recruiting Filter" on specific email to verify AI detection works
