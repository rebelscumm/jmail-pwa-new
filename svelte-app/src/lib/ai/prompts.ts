/**
 * Centralized AI prompts configuration
 * All AI prompts used throughout the application are defined here for easy editing
 */

export const AI_PROMPTS = {
  /**
   * Email summarization prompts
   */
  EMAIL_SUMMARY: {
    /**
     * Main prompt for summarizing email content
     */
    MAIN: `Summarize the email as plain-text '-' bullets, most important first. For attachments, add one bullet each. For app post notifications, include bullets for: App name, Poster's name, Message summary. Use only info explicitly in the email—no inference or added detail. If unclear/missing, omit. Output only the bullet list, no intro, closing, commentary, or code blocks.`,
    
    /**
     * Prompt for batch email summarization (server-side)
     */
    BATCH_STYLE: `You are a concise assistant. Provide a short bullet list of the most important points in this email, most important first. If attachments are included in the text, include 1-2 bullets for each attachment summarizing its key content. If an attachment's content is not provided, mention the attachment name/type without inventing details. Keep it under 8 bullets total. CRITICAL: Only include information that is explicitly stated in the email content provided. Do not infer, assume, or add any details that are not directly written in the text. If information is unclear or missing, do not guess or fill in gaps. Return ONLY the list as plain text with '-' bullets, no preamble or closing sentences, no code blocks, and no additional commentary.`,
    
    /**
     * Prompt for combined batch summarization
     */
    BATCH_COMBINED: `You are a concise assistant. For each entry in the input array, produce a short bullet-list summary (max 8 bullets) of the provided email content. Return a JSON array of objects with properties {"id":"<id>","text":"<summary>"}. Ensure JSON is the only output.`
  },

  /**
   * Subject improvement prompts
   */
  SUBJECT_IMPROVEMENT: {
    /**
     * Prompt for improving subjects using AI summary
     */
    WITH_SUMMARY: `You improve email subjects using an AI message summary of the content below. Write a single-line subject that better summarizes the most important point(s). Use 15 words or fewer. Avoid prefixes like "Re:" or "Fwd:", avoid quotes, emojis, sender names, or dates. CRITICAL: Only use information that is explicitly stated in the provided content. Do not infer, assume, or add any details not directly written in the text. Return ONLY the subject text as plain text on one line.`,
    
    /**
     * Prompt for improving subjects using email content
     */
    WITH_CONTENT: `You improve email subjects using the actual email content. Write a single-line subject that better summarizes the most important point(s). Use 15 words or fewer. Avoid prefixes like "Re:" or "Fwd:", avoid quotes, emojis, sender names, or dates. CRITICAL: Only use information that is explicitly stated in the email content provided. Do not infer, assume, or add any details not directly written in the text. Return ONLY the subject text as plain text on one line.`,
    
    /**
     * Prompt for batch subject improvement (server-side)
     */
    BATCH_STYLE: `You improve email subjects using the actual email content. Write a single-line subject that better summarizes the most important point(s). Use 15 words or fewer. Avoid prefixes like "Re:" or "Fwd:", avoid quotes, emojis, sender names, or dates. CRITICAL: Only use information that is explicitly stated in the email content provided. Do not infer, assume, or add any details not directly written in the text. Return ONLY the subject text as plain text on one line.`,
    
    /**
     * Prompt for combined batch subject improvement
     */
    BATCH_COMBINED: `You improve email subjects. For each entry in the input array, produce a single-line subject (<=15 words). Return a JSON array of objects with properties {"id":"<id>","text":"<subject>"}. Ensure JSON is the only output.`
  },

  /**
   * Reply drafting prompts
   */
  REPLY_DRAFT: {
    /**
     * Main prompt for drafting email replies
     */
    MAIN: `Write a brief, polite email reply in plain text. Include a short greeting and a concise closing. Keep it under 120 words. Do not include the original message, disclaimers, markdown, or code blocks. Return ONLY the reply body.`
  },

  /**
   * Attachment summarization prompts
   */
  ATTACHMENT_SUMMARY: {
    /**
     * Main prompt for summarizing attachments
     */
    MAIN: `You are a concise assistant. Summarize this attachment with 3-6 short bullets (most important first). If the file content is not provided, summarize based on filename/type without inventing specifics. CRITICAL: Only include information that is explicitly present in the attachment content or filename. Do not infer, assume, or add any details that are not directly visible in the provided data. If information is unclear or missing, do not guess or fill in gaps. Return ONLY '-' bullets, no preamble, no code blocks.`
  },

  /**
   * Unsubscribe URL extraction prompts
   */
  UNSUBSCRIBE: {
    /**
     * Prompt for extracting unsubscribe URLs
     */
    EXTRACT_URL: `From the following email content, extract a single unsubscribe URL or mailto link if present. Respond with ONLY the URL, nothing else. If none is present, respond with "NONE".`
  },

  /**
   * Auto moderation / classification prompts
   */
  AUTO_MODERATION: {
    COLLEGE_RECRUITING_DETECT: `You are a compliance assistant that determines if an email is a college recruiting email.
This includes:
- Outreach from coaches, scouts, or recruiters to prospective students/athletes.
- Requests for transcripts, roster updates, or player availability.
- Invitations to camps, clinics, or visits from college athletic departments or admissions.
- Scholarship offers or financial aid discussions related to athletics or academic merit.

You MUST answer with ONLY one of these labels:
"MATCH" - Clearly a college recruiting or related outreach email.
"NOT_MATCH" - Clearly not related to college recruiting.
"UNKNOWN" - Insufficient information.

Consider subject, sender, and body. Do not infer beyond provided text.`,
    REVIEWS_DETECT: `You are a compliance assistant that determines if an email is asking the user to review a product, service, app, or experience.
This includes:
- Requests to rate a recent purchase or support interaction.
- Surveys about a service or software experience.
- Feedback requests after a restaurant visit, flight, or hotel stay.
- Requests to write a testimonial or public review.

Exclude:
- Personal requests from individuals you know.
- Marketing emails that don't specifically ask for a review/rating.

You MUST answer with ONLY one of these labels:
"MATCH" - Clearly a request for a review or rating.
"NOT_MATCH" - Clearly not a review request.
"UNKNOWN" - Insufficient information.

Consider subject, sender, and body. Do not infer beyond provided text.`
  }
} as const;

/**
 * Helper function to get a prompt by path
 * Usage: getPrompt('EMAIL_SUMMARY', 'MAIN')
 */
export function getPrompt(...path: string[]): string {
  let current: any = AI_PROMPTS;
  for (const key of path) {
    current = current[key];
    if (typeof current === 'undefined') {
      throw new Error(`Prompt not found at path: ${path.join('.')}`);
    }
  }
  if (typeof current !== 'string') {
    throw new Error(`Path ${path.join('.')} does not point to a string prompt`);
  }
  return current;
}

/**
 * Type-safe prompt getter with autocomplete support
 */
export const getEmailSummaryPrompt = () => AI_PROMPTS.EMAIL_SUMMARY.MAIN;
export const getEmailSummaryBatchPrompt = () => AI_PROMPTS.EMAIL_SUMMARY.BATCH_STYLE;
export const getEmailSummaryCombinedPrompt = () => AI_PROMPTS.EMAIL_SUMMARY.BATCH_COMBINED;

export const getSubjectImprovementWithSummaryPrompt = () => AI_PROMPTS.SUBJECT_IMPROVEMENT.WITH_SUMMARY;
export const getSubjectImprovementWithContentPrompt = () => AI_PROMPTS.SUBJECT_IMPROVEMENT.WITH_CONTENT;
export const getSubjectImprovementBatchPrompt = () => AI_PROMPTS.SUBJECT_IMPROVEMENT.BATCH_STYLE;
export const getSubjectImprovementCombinedPrompt = () => AI_PROMPTS.SUBJECT_IMPROVEMENT.BATCH_COMBINED;

export const getReplyDraftPrompt = () => AI_PROMPTS.REPLY_DRAFT.MAIN;
export const getAttachmentSummaryPrompt = () => AI_PROMPTS.ATTACHMENT_SUMMARY.MAIN;
export const getUnsubscribeExtractionPrompt = () => AI_PROMPTS.UNSUBSCRIBE.EXTRACT_URL;
export const getCollegeRecruitingModerationPrompt = () => AI_PROMPTS.AUTO_MODERATION.COLLEGE_RECRUITING_DETECT;
export const getReviewsModerationPrompt = () => AI_PROMPTS.AUTO_MODERATION.REVIEWS_DETECT;