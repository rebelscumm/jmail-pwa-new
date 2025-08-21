// Core shared types for the Gmail PWA client

export type GmailLabel = { id: string; name: string; type: "system" | "user" };

export type GmailMessage = {
  id: string;
  threadId: string;
  snippet?: string;
  headers?: Record<string, string>;
  labelIds: string[];
  internalDate?: number; // ms epoch
  bodyText?: string;
  bodyHtml?: string;
};

export type GmailThread = {
  threadId: string;
  messageIds: string[];
  lastMsgMeta: { from?: string; subject?: string; date?: number };
  labelIds: string[];
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
  tokenExpiry?: number; // ms epoch
};

