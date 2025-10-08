# College Recruiting Moderation - User Interface Features

This document describes the UI features added for managing and diagnosing college recruiting email moderation.

## Features Added

### 1. Overflow Menu Option: Run College Recruiting Filter

**Location:** Top app bar → Overflow menu (⋮) → AI Features section

**Icon:** 🎓 School icon

**Function:** Manually triggers college recruiting moderation on existing inbox emails

**How it works:**
1. Checks that precompute and AI are properly configured
2. Counts inbox threads that need processing
3. Runs precompute with moderation (processes up to 50 threads)
4. Shows results with option to view diagnostics

**Requirements:**
- Precompute must be enabled in Settings
- AI API key must be configured
- Inbox must have threads

**Error Handling:**
- If precompute disabled: Shows message with link to Settings
- If no API key: Shows message with link to Settings
- If no inbox threads: Shows message with "Sync Now" button
- On completion: Shows snackbar with results and "View Results" button → Diagnostics page

### 2. Email Viewer Diagnostic Button: Test Recruiting Filter

**Location:** Email viewer → More actions menu (⋮) → "Test Recruiting Filter"

**Icon:** 🎓 School icon

**Function:** Tests the current email against the recruiting filter to see why it was/wasn't flagged

**How it works:**
1. Loads the current thread and message data
2. Extracts subject, from, and body content
3. Calls `aiDetectCollegeRecruiting()` with fresh AI analysis
4. Shows comprehensive diagnostic dialog with results

**Diagnostic Dialog Contents:**

#### AI Verdict (Color-coded)
- **MATCH** (red error container): Email is college recruiting
- **NOT_MATCH** (teal tertiary container): Email is not recruiting
- **UNKNOWN** (gray surface variant): Insufficient information

#### Information Displayed
1. **Processing Time:** How long the AI took to analyze (in milliseconds)
2. **Subject:** The email subject line
3. **From:** The sender email address
4. **Email Status:** 
   - Whether email is in INBOX
   - Whether email has body content (required for analysis)
5. **Previous Result** (if exists):
   - Previous moderation status
   - Action taken (if any)
   - Timestamp of previous check
6. **AI Response** (expandable): Raw response from AI model
7. **Body Preview** (expandable): First 500 characters of email body

**Use Cases:**

#### Troubleshooting False Negatives
*"Why wasn't this recruiting email filtered?"*

1. Open the recruiting email in viewer
2. Click ⋮ → "Test Recruiting Filter"
3. Check the verdict:
   - **NOT_MATCH**: AI didn't recognize it as recruiting
   - **UNKNOWN**: Email body may be missing
   - **MATCH**: It was detected but action may have failed

4. Review diagnostic details:
   - Check "Email Status" - body content required
   - Check "Previous Result" - was it already processed?
   - Expand "AI Response" - see AI's reasoning
   - Expand "Body Preview" - verify content is present

5. Common issues:
   - Email has no body content (just a snippet)
   - Email is not in INBOX (already archived/labeled)
   - Previous result exists with "label_enqueued" action
   - AI prompt needs tuning for this type of recruiting email

#### Troubleshooting False Positives
*"Why was this normal email marked as recruiting?"*

1. Open the incorrectly filtered email in viewer
2. Click ⋮ → "Test Recruiting Filter"
3. Check the verdict - should show **MATCH**
4. Expand "AI Response" to see why AI thought it was recruiting
5. Review subject and from address for recruiting keywords
6. Body preview may show recruiting-like language

If consistently wrong:
- AI prompt may need refinement
- Add specific sender/subject patterns to exclusion logic
- Consider adjusting prompt in `svelte-app/src/lib/ai/prompts.ts`

#### Testing New Emails
*"Will this email be caught by the filter?"*

1. Open the email in viewer
2. Click ⋮ → "Test Recruiting Filter"
3. See immediate AI verdict
4. No changes are made to the email (read-only test)

### 3. Diagnostics Page Enhancement

**Location:** Diagnostics page → College Recruiting Moderation card

**Features:**
- **Statistics Dashboard:**
  - Total threads checked
  - Match count (recruiting emails found)
  - Labeled count (actions taken)
  - Not match count (non-recruiting)
  - Unknown count (insufficient data)
  - Error count (processing failures)

- **Recent Results Table:**
  - Shows last 20 moderation results
  - Subject, from, status, timestamp
  - Action taken (if any)
  - Expandable AI response
  - Error messages (if any)

- **Actions:**
  - "Load Moderation Stats" - Refresh the data
  - "Clear All Moderation Data" - Reset all results (requires confirmation)
  - "Copy Section" - Copy diagnostics to clipboard

**Use Case:**
- View overall effectiveness of the filter
- See which emails were caught
- Identify patterns in false positives/negatives
- Monitor error rates
- Clear cache to force re-processing

## Material Design 3 Compliance

All UI elements follow MD3 guidelines:

### Color Usage
- **Match/Error states**: Error container colors (red)
- **Not-match/Success states**: Tertiary container colors (teal)
- **Neutral/Unknown states**: Surface variant colors (gray)
- **Information**: Primary colors for links and actions

### Typography
- Headlines: `m3-font-title-large`, `m3-font-title-small`
- Body text: `m3-font-body-medium`, `m3-font-body-small`
- Consistent font sizing and weights

### Components
- **Buttons**: Variant="text" for secondary actions, variant="filled" for primary
- **Cards**: `Card variant="outlined"` for sections
- **Dialogs**: Standard MD3 dialog with headline and action buttons
- **Menu Items**: Single-line format with icon + text [[memory:7311162]]
- **Loading Indicators**: MD3 circular progress indicators

### Interactions
- **Ripple effects**: On all clickable elements
- **State feedback**: Disabled states, loading states
- **Snackbars**: For success/error feedback with actions
- **Dialogs**: Close on backdrop click, keyboard navigation

## Testing the Features

### Test 1: Run Filter from Overflow Menu
1. Navigate to inbox
2. Click overflow menu (⋮) in top bar
3. Select "Run College Recruiting Filter"
4. Verify:
   - Snackbar shows thread count
   - Processing completes
   - Results snackbar has "View Results" action
   - Clicking "View Results" goes to diagnostics

### Test 2: Test Individual Email
1. Open an email in viewer
2. Click more menu (⋮)
3. Select "Test Recruiting Filter"
4. Verify:
   - Loading indicator appears
   - Dialog shows with verdict
   - All sections are populated
   - Expandable sections work
   - Copy button works
   - Close button works

### Test 3: View Diagnostics
1. Navigate to /diagnostics
2. Find "College Recruiting Moderation" card
3. Click "Load Moderation Stats"
4. Verify:
   - Statistics populate
   - Recent results show
   - Expandable AI responses work
   - Copy section works
   - Clear data works (with confirmation)

## Files Modified

### 1. `svelte-app/src/lib/misc/TopAppBar.svelte`
- Added `iconSchool` import
- Added `doRunRecruitingModeration()` function
- Added menu item under "AI Features" section

### 2. `svelte-app/src/routes/viewer/[threadId]/+page.svelte`
- Added `iconSchool` import
- Added `get` import from 'svelte/store'
- Added state variables: `recruitingDiagOpen`, `recruitingDiagResult`, `runningRecruitingDiag`
- Added `runRecruitingDiagnostic()` function
- Added menu item in both mobile and desktop menus
- Added `Dialog` component for diagnostic results

### 3. `svelte-app/src/routes/diagnostics/+page.svelte`
- (Already modified in previous session)
- Added recruiting diagnostic state and functions
- Added College Recruiting Moderation card with stats and results

## User Workflow Examples

### Workflow 1: Initial Setup and Batch Processing
1. User enables precompute in Settings
2. User configures AI API key
3. User clicks overflow menu → "Run College Recruiting Filter"
4. System processes all inbox emails
5. User clicks "View Results" from snackbar
6. User reviews statistics in diagnostics page
7. Recruiting emails are in `college_recruiting` label

### Workflow 2: Investigating a Missed Email
1. User notices a recruiting email still in inbox
2. User opens the email in viewer
3. User clicks ⋮ → "Test Recruiting Filter"
4. Dialog shows "NOT_MATCH" verdict
5. User expands "AI Response" to see reasoning
6. User expands "Body Preview" to verify content
7. User determines:
   - Option A: Body was too short → Full sync needed
   - Option B: AI missed it → Prompt needs tuning
   - Option C: Already processed → Check "Previous Result"

### Workflow 3: Verifying Filter Accuracy
1. User goes to Diagnostics page
2. User clicks "Load Moderation Stats"
3. User reviews statistics:
   - 50 total checked
   - 12 matches found
   - 12 labeled
   - 38 not match
   - 0 errors
4. User expands recent results to spot-check
5. User verifies AI responses are reasonable
6. User is confident filter is working correctly

## Future Enhancements

Potential improvements that could be added:

1. **Feedback Loop**: Allow users to mark false positives/negatives to improve AI
2. **Custom Filters**: Let users create additional moderation rules
3. **Batch Review**: Show pending actions before applying them
4. **Label Selection**: Let users choose destination label
5. **Whitelist/Blacklist**: Maintain sender/domain lists
6. **Scheduling**: Auto-run filter on schedule
7. **Statistics Dashboard**: More detailed analytics on filter performance
8. **Export Results**: Download moderation history
9. **Multi-Category**: Extend to other categories (newsletters, promotions, etc.)
10. **Training Mode**: Manually classify emails to improve accuracy

