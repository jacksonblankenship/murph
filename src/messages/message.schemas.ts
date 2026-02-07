import { z } from 'zod';

export const QueuedUserMessageSchema = z.object({
  userId: z.number(),
  content: z.string(),
  timestamp: z.number(),
  messageId: z.string(),
  context: z.any().optional(),
});

export const QueuedScheduledMessageSchema = z.object({
  userId: z.number(),
  content: z.string(),
  taskId: z.string(),
  timestamp: z.number(),
});

export const ActiveRequestDataSchema = z.object({
  jobId: z.string(),
  startTime: z.number(),
  source: z.enum(['user', 'scheduled']),
});

export type QueuedUserMessage = z.infer<typeof QueuedUserMessageSchema>;
export type QueuedScheduledMessage = z.infer<
  typeof QueuedScheduledMessageSchema
>;
export type ActiveRequestData = z.infer<typeof ActiveRequestDataSchema>;
