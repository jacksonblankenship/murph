import { z } from 'zod';

/**
 * Event constants for cross-module communication via EventEmitter.
 *
 * Use EventEmitter for immediate broadcast operations (outbound delivery).
 * Use BullMQ (via AgentDispatcher) for persistent/delayed jobs and inbound processing.
 */
export const Events = {
  /** Send message to user via Telegram */
  MESSAGE_BROADCAST: 'message.broadcast',
} as const;

// Event payload schemas

export const MessageBroadcastEventSchema = z.object({
  userId: z.number(),
  content: z.string(),
});

// Inferred types
export type MessageBroadcastEvent = z.infer<typeof MessageBroadcastEventSchema>;
