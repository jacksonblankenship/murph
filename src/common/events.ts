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

  /** Schedule a task for later execution */
  TASK_SCHEDULE: 'task.schedule',

  /** Cancel a scheduled task */
  TASK_CANCEL: 'task.cancel',
} as const;

// Event payload schemas

export const MessageBroadcastEventSchema = z.object({
  userId: z.number(),
  content: z.string(),
});

export const TaskScheduleEventSchema = z.object({
  userId: z.number(),
  description: z.string(),
  message: z.string(),
  scheduledTime: z.number().optional(),
  cronExpression: z.string().optional(),
});

export const TaskCancelEventSchema = z.object({
  taskId: z.string(),
  userId: z.number(),
});

// Inferred types
export type MessageBroadcastEvent = z.infer<typeof MessageBroadcastEventSchema>;
export type TaskScheduleEvent = z.infer<typeof TaskScheduleEventSchema>;
export type TaskCancelEvent = z.infer<typeof TaskCancelEventSchema>;
