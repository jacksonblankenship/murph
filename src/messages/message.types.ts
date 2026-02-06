/**
 * Message queue type definitions
 */

export interface QueuedUserMessage {
  userId: number;
  content: string;
  timestamp: number;
  messageId: string; // For deduplication
  context?: any; // Telegram context if needed
}

export interface QueuedScheduledMessage {
  userId: number;
  content: string; // From task.message - prompt for LLM to process
  taskId: string;
  timestamp: number;
}

export interface MessageBatch {
  userId: number;
  messages: QueuedUserMessage[];
  combinedContent: string; // Join with "\n\n[Follow-up]: "
}

export interface ActiveRequest {
  userId: number;
  jobId: string;
  startTime: number;
  abortController: AbortController;
  source: 'user' | 'scheduled'; // For separate tracking
}

export interface ActiveRequestData {
  jobId: string;
  startTime: number;
  source: 'user' | 'scheduled';
}
