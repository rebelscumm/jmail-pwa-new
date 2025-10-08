# College Recruiting Email Auto-Moderation

## Overview

This feature automatically detects college recruiting emails using AI and moves them from the inbox to a custom `college_recruiting` label.

## How It Works

### 1. Detection Flow
- Runs during the **precompute phase** when AI summaries and subjects are generated
- Only processes emails in the INBOX (skips TRASH, SPAM, archived)
- Uses AI (Gemini/Anthropic/OpenAI) to analyze:
  - Email subject
  - Sender (From field)
  - Email body (text or HTML)

### 2. AI Classification
The AI is given a specific prompt to classify emails as:
- **MATCH** - Clearly a college recruiting email
- **NOT_MATCH** - Clearly not a recruiting email  
- **UNKNOWN** - Insufficient information to determine

The classifier looks for:
- Communications from coaches, scouts, recruiters
- College departments reaching out to prospective students/athletes
- Scholarship recruiting
- Admissions outreach

### 3. Automatic Actions
When an email is classified as a **MATCH**:
1. A custom Gmail label `college_recruiting` is created (if it doesn't exist yet)
2. The email is labeled with `college_recruiting`
3. The email is removed from INBOX
4. The action is queued for reliable background sync with Gmail

### 4. Persistence & Tracking
- Classification results are stored in the thread's `autoModeration` field
- Includes:
  - Status (match/not_match/unknown/error)
  - AI's raw response
  - Prompt version (for future upgrades)
  - Timestamp
  - Action taken (`label_enqueued`)
  - Any errors encountered

## Files Modified

### Core Implementation
1. **`svelte-app/src/lib/types.ts`**
   - Added `autoModeration` field to `GmailThread` type to store classification results

2. **`svelte-app/src/lib/ai/prompts.ts`**
   - Added `COLLEGE_RECRUITING_DETECT` prompt
   - Added `getCollegeRecruitingModerationPrompt()` helper

3. **`svelte-app/src/lib/ai/providers.ts`**
   - Added `aiDetectCollegeRecruiting()` function
   - Handles calling AI providers and parsing responses
   - Returns structured verdict: `match`, `not_match`, or `unknown`

4. **`svelte-app/src/lib/ai/precompute.ts`**
   - Added moderation constants (`MODERATION_RULE_KEY`, `MODERATION_PROMPT_VERSION`, `COLLEGE_RECRUITING_LABEL_NAME`)
   - Added `ensureCollegeRecruitingLabel()` - creates/retrieves the custom label
   - Added `shouldRunRecruitingModeration()` - gates moderation to eligible threads
   - Integrated moderation into the precompute batch workflow
   - Runs concurrently with summaries (2 concurrent AI calls)
   - Automatically queues label changes when match is detected

5. **`svelte-app/src/lib/gmail/api.ts`**
   - Added `createLabel()` function to create custom Gmail labels

6. **`svelte-app/src/lib/queue/intents.ts`**
   - Already had `queueThreadModify()` for label operations (reused)

## Testing the Feature

### Prerequisites
1. **AI Provider Configured**: Ensure you have an AI provider set up in Settings:
   - Gemini API key (recommended for batch processing)
   - OR Anthropic API key
   - OR OpenAI API key

2. **Precompute Enabled**: In Settings, ensure:
   - "Precompute Summaries" is enabled
   - "Auto Run" is enabled (or trigger manually)

### Manual Testing Steps

1. **Trigger Precompute**:
   - Click the settings icon (⚙️) in the top app bar
   - Click "Run Precompute Now"
   - OR wait for automatic precompute (runs when inbox loads if threads need processing)

2. **Check Logs**:
   - Open browser DevTools (F12)
   - Look for console messages:
     ```
     [Precompute] Running college recruiting moderation for X threads
     [Precompute] Moderation verdict for <threadId>: match
     [Precompute] Enqueuing label for recruiting match <threadId>
     ```

3. **Verify Label Creation**:
   - Check Gmail (via web or app) for a new label: `college_recruiting`
   - It should appear in the label list on the left sidebar

4. **Verify Email Movement**:
   - Emails classified as college recruiting should:
     - Have the `college_recruiting` label
     - Be removed from INBOX
     - Still be accessible via the label

5. **Check IndexedDB** (Advanced):
   - Open DevTools → Application → IndexedDB → `gmail-app` → `threads`
   - Find a thread that was processed
   - Check for `autoModeration` → `college_recruiting_v1` entry
   - Should see: `status: "match"`, `actionTaken: "label_enqueued"`

### Troubleshooting

#### Moderation Not Running
1. **Check Settings**:
   - Settings → ensure "Precompute Summaries" is enabled
   - Settings → ensure AI provider and API key are configured

2. **Check Inbox Threads**:
   - Moderation only runs on INBOX threads
   - Threads must have body content (not just metadata)

3. **Check Console Logs**:
   ```
   [Precompute] Running college recruiting moderation for 0 threads
   ```
   This means no eligible threads were found.

4. **Force Precompute**:
   - Settings → "Run Precompute Now"
   - This bypasses automatic gating

#### AI Not Detecting Emails
1. **Check AI Response**:
   - Look in browser console for:
     ```
     [Precompute] Moderation verdict for <threadId>: not_match
     ```
   - The AI may legitimately classify the email as NOT a recruiting email

2. **Check Raw Response**:
   - In IndexedDB, check the `raw` field in `autoModeration`
   - This shows the AI's exact response

3. **Prompt Tuning**:
   - If false negatives occur, adjust the prompt in `svelte-app/src/lib/ai/prompts.ts`
   - Increment `MODERATION_PROMPT_VERSION` in `precompute.ts` to reprocess

#### Errors During Labeling
1. **Check Gmail API Permissions**:
   - The app needs `gmail.modify` scope
   - If using server-managed auth, ensure the backend has proper scopes

2. **Check Queue**:
   - IndexedDB → `ops` store
   - Look for failed operations with `lastError` field

3. **Check Console**:
   ```
   [Precompute] Failed to enqueue label for <threadId>: <error>
   ```

## Future Enhancements

1. **Settings Toggle**: Add a user-facing setting to enable/disable college recruiting moderation
2. **Custom Label Name**: Allow users to choose the label name
3. **Whitelist/Blacklist**: Let users manually mark false positives/negatives to improve detection
4. **Batch Review UI**: Show pending moderation decisions before applying
5. **Statistics**: Track accuracy metrics (user corrections vs AI classifications)
6. **Multi-Category Detection**: Extend to other categories (newsletters, promotions, etc.)

## Why It Wasn't Working Before

### Issues Fixed:
1. **Wrong Action**: Original implementation used `trashThread()` instead of labeling
2. **No Label Creation**: Didn't have logic to create the custom label
3. **Missing Import**: Needed to import `queueThreadModify` instead of `trashThread`
4. **Gating Logic**: Updated to check for existing label to avoid reprocessing
5. **Action Tracking**: Changed from `trash_enqueued` to `label_enqueued` for proper state tracking

## Performance Considerations

- **Concurrency**: Runs 2 moderation checks concurrently (configurable in `mapWithConcurrency`)
- **Batch Size**: Processes up to 25 threads per precompute run (configurable via `limit` parameter)
- **Caching**: Results are cached in `autoModeration` to avoid redundant AI calls
- **Smart Gating**: Only processes threads that:
  - Are in INBOX
  - Have body content
  - Haven't been processed before
  - Don't already have the label

## Cost Optimization

- Uses the same AI provider configured for summaries (typically Gemini Flash for cheapest rates)
- Prompt is concise to minimize tokens
- Results are cached permanently (only runs once per thread)
- Only reprocesses if:
  - Prompt version changes (manual upgrade)
  - Previous attempt had error/unknown status
  - New activity on thread (reply received)

