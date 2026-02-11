/**
 * A single pending message waiting to be combined and processed.
 * Stored as serialized JSON in a Redis list (`inbound:pending:{userId}`).
 */
export interface PendingMessage {
  /** Message text content */
  text: string;
  /** Transport-level message ID (for deduplication) */
  messageId: number;
  /** Unix timestamp when the message was enqueued */
  timestamp: number;
  /** Transport identifier (e.g., 'telegram', 'slack') */
  source: string;
}

/**
 * BullMQ job data for the inbound-messages queue.
 * Acts as a debounced trigger — the actual message content lives in Redis lists.
 */
export interface InboundTriggerJob {
  /** User who sent the message(s) */
  userId: number;
  /** Chat ID from the most recent message (used for response routing + typing) */
  chatId: number;
  /** Transport source from the most recent message */
  source: string;
}
