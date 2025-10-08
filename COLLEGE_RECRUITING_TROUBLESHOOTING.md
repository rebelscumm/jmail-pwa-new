# College Recruiting Filter Troubleshooting Guide

## Problem: Diagnostic Shows Match But Email Stays in Inbox

If you run the "Test Recruiting Filter" diagnostic and it shows a "MATCH" verdict, but the email remains in the inbox and doesn't get the `college_recruiting` label, here are the steps to troubleshoot:

### Step 1: Check Diagnostics Page
1. Go to `/diagnostics` page
2. Click "Load Moderation Stats" in the "College Recruiting Moderation" section
3. Look for your email in the "Recent Moderation Results" list
4. Check if it shows:
   - Status: `match`
   - Action: `label_enqueued` (means the label was applied)
   - Any error messages

### Step 2: Check Precompute Logs
1. Go to `/diagnostics` page
2. Look at the "Precompute Logs" section
3. Search for entries containing your thread ID or "college_recruiting"
4. Look for error messages or debug information

### Step 3: Manual Label Application
If the diagnostic shows a match but the label wasn't applied automatically:

1. **Use the "Apply Label" button**: When you run the diagnostic and it shows a match, there will be a red "Apply Label" button in the diagnostic modal
2. **Click "Apply Label"**: This will manually trigger the labeling process
3. **Check the result**: A snackbar will show success/failure message
4. **Modal closes and page refreshes**: The email should now be labeled and removed from inbox

### Step 4: Check Gmail API Permissions
The labeling process requires Gmail API permissions. Check:

1. Go to `/diagnostics` page
2. Look at "Gmail API Diagnostics" section
3. Verify that `modify` permissions are available
4. Check for any authentication errors

### Step 5: Verify Label Creation
The system automatically creates a `college_recruiting` label. To verify:

1. Go to `/diagnostics` page
2. Look for "Label Created" entries in the Gmail API diagnostics
3. Or check your Gmail labels directly to see if `college_recruiting` exists

### Step 6: Check Thread Eligibility
The automatic moderation only runs on threads that meet certain criteria:

- Thread must be in INBOX
- Thread must not be in TRASH or SPAM
- Thread must have body content (subject + body text/HTML)
- Thread must not already have the `college_recruiting` label

### Common Issues and Solutions

#### Issue: "Thread not eligible for moderation"
**Cause**: Thread doesn't meet the criteria above
**Solution**: Use manual moderation via the "Apply Label" button

#### Issue: "Failed to get college_recruiting label ID"
**Cause**: Label creation failed or API permissions issue
**Solution**: 
1. Check Gmail API permissions
2. Try running the overflow menu "Run College Recruiting Filter" to trigger label creation
3. Check diagnostics for label creation errors

#### Issue: "Failed to enqueue label"
**Cause**: Gmail API queue issue
**Solution**:
1. Check Gmail API diagnostics for queue status
2. Try the manual "Apply Label" button
3. Check for rate limiting or quota issues

#### Issue: Diagnostic shows match but no action taken
**Cause**: Thread was processed but labeling failed silently
**Solution**: Use the "Apply Label" button to manually trigger labeling

### Debugging Steps

1. **Run the diagnostic** on the specific email
2. **Check the verdict** - should show "MATCH" for recruiting emails
3. **Click "Apply Label"** if available
4. **Check diagnostics page** for moderation results
5. **Verify in Gmail** that the email has the `college_recruiting` label and is removed from inbox

### Manual Override

If all else fails, you can manually:
1. Create a `college_recruiting` label in Gmail
2. Apply it to the email
3. Remove the email from inbox
4. The system will recognize it as already processed

### Getting Help

If you continue to have issues:
1. Check the diagnostics page for detailed error logs
2. Look at the precompute logs for debugging information
3. Verify your Gmail API permissions and authentication
4. Try the manual "Apply Label" button for immediate results
