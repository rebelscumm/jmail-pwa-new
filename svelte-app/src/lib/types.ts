// Core shared types for the Gmail PWA client

export type GmailLabel = { id: string; name: string; type: "system" | "user" } & {
  // Optional stats provided by Gmail labels.get when requested
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
};

export type GmailMessage = {
  id: string;
  threadId: string;
  snippet?: string;
  headers?: Record<string, string>;
  labelIds: string[];
  internalDate?: number; // ms epoch
  bodyText?: string;
  bodyHtml?: string;
  attachments?: GmailAttachment[];
};

export type GmailThread = {
  threadId: string;
  messageIds: string[];
  lastMsgMeta: { from?: string; subject?: string; date?: number };
  labelIds: string[];
  /** Precomputed AI summary for the thread's latest content */
  summary?: string;
  /** Precompute status for the summary */
  summaryStatus?: 'none' | 'pending' | 'ready' | 'error';
  /** Deprecated: summaryVersion removed. Presence of `summary` indicates a cached AI summary. */
  summaryVersion?: never;
  /** Last update timestamp for the summary (ms epoch) */
  summaryUpdatedAt?: number;
  /** When precompute marked the thread as pending for summary generation (ms epoch) */
  summaryPendingAt?: number;
  /** Timestamp user explicitly requested a regeneration (ms epoch) */
  summaryUserRequestedAt?: number;
  /** Hash of the content used for the current summary (subject+body) */
  bodyHash?: string;
  /** AI-improved subject line for the thread */
  aiSubject?: string;
  /** Precompute status for the AI subject */
  aiSubjectStatus?: 'none' | 'pending' | 'ready' | 'error';
  /** App-controlled version for subject prompt/schema */
  subjectVersion?: number;
  /** Last update timestamp for the AI subject (ms epoch) */
  aiSubjectUpdatedAt?: number;
  /** AI-based auto moderation/classification results keyed by identifier */
  autoModeration?: Record<string, {
    status: 'pending' | 'match' | 'not_match' | 'unknown' | 'error';
    updatedAt: number;
    promptVersion?: number;
    raw?: string;
    lastError?: string;
    actionTaken?: string;
  }>;
};

export type GmailAttachment = {
  id?: string; // Gmail attachmentId when available
  filename?: string;
  mimeType?: string;
  size?: number;
  /** Best-effort extracted plain text content for summarization */
  textContent?: string;
  /** Optional standard Base64 (not URL-safe) bytes for AI providers that support inline files */
  dataBase64?: string;
};

export type SnoozeRule = {
  labelName: string;
  resolver: (
    nowLocal: Date,
    defaults: { anchorHour: number; roundMinutes: number }
  ) => Date | null;
  addLabels?: string[];
  removeLabels?: string[];
  persistent?: boolean;
};

export type SnoozeQueueItem = {
  id: string; // `${threadId}:${snoozeLabelId}`
  accountSub: string;
  threadId: string;
  messageIds: string[];
  snoozeLabelId: string;
  dueAtUtc: number;
  sourceTimeZone: string; // IANA TZ
  addUnreadOnUnsnooze: boolean;
};

export type QueuedOp = {
  id: string; // uuid
  accountSub: string;
  op:
    | {
        type: "batchModify";
        ids: string[];
        addLabelIds: string[];
        removeLabelIds: string[];
      }
    | {
        type: "sendMessage";
        raw: string; // base64url-encoded RFC 2822
        threadId?: string;
      };
  scopeKey: string; // `${threadId}` or synthetic key for compose
  opHash: string; // deterministic hash of intent for idempotency
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
};

export type AccountAuthMeta = {
  sub: string;
  email?: string;
  accessToken?: string; // persisted OAuth access token (expires quickly; refreshed as needed)
  tokenExpiry?: number; // ms epoch
  /** First environment where the user successfully connected */
  firstConnectedOrigin?: string;
  firstConnectedUrl?: string;
  firstConnectedAt?: number; // ms epoch
  /** Most recent environment where a token was acquired */
  lastConnectedOrigin?: string;
  lastConnectedUrl?: string;
  lastConnectedAt?: number; // ms epoch
};

