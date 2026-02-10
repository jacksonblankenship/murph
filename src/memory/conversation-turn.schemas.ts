import { z } from 'zod';

/**
 * Schema for a conversation turn stored in Qdrant.
 * A turn consists of a user message and the assistant's response.
 * Tool calls are tracked but not embedded for semantic search.
 */
export const ConversationTurnSchema = z.object({
  /** Qdrant point ID (UUIDv7 for time-sortable IDs) */
  id: z.string(),
  /** User ID for filtering */
  userId: z.number(),
  /** The user's message text */
  userMessage: z.string(),
  /** The assistant's text response (excludes tool call JSON) */
  assistantResponse: z.string(),
  /** Unix timestamp in milliseconds */
  timestamp: z.number(),
  /** Names of tools used in this turn (if any) */
  toolsUsed: z.array(z.string()).optional(),
});

export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

/**
 * Schema for conversation turn payload stored in Qdrant.
 * Excludes the id field since that's handled separately.
 */
export const ConversationTurnPayloadSchema = ConversationTurnSchema.omit({
  id: true,
});

export type ConversationTurnPayload = z.infer<
  typeof ConversationTurnPayloadSchema
>;
