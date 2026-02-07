import { z } from 'zod';

/**
 * Event constants for cross-module communication via EventEmitter.
 *
 * Use EventEmitter for "do this now" operations between modules.
 * Use BullMQ for persistent/delayed jobs (scheduled tasks, background sync).
 */
export const Events = {
  /** Incoming message from Telegram - triggers LLM processing */
  USER_MESSAGE: 'user.message',

  /** Send message to user via Telegram */
  MESSAGE_BROADCAST: 'message.broadcast',

  /** Schedule a task for later execution */
  TASK_SCHEDULE: 'task.schedule',

  /** Cancel a scheduled task */
  TASK_CANCEL: 'task.cancel',

  /** A scheduled task has fired - needs LLM processing */
  SCHEDULED_TASK_TRIGGERED: 'scheduled.task.triggered',
} as const;

// Event payload schemas

export const UserMessageEventSchema = z.object({
  userId: z.number(),
  text: z.string(),
  messageId: z.number(),
  chatId: z.number(),
});

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

export const ScheduledTaskTriggeredEventSchema = z.object({
  userId: z.number(),
  taskId: z.string(),
  message: z.string(),
});

// Inferred types
export type UserMessageEvent = z.infer<typeof UserMessageEventSchema>;
export type MessageBroadcastEvent = z.infer<typeof MessageBroadcastEventSchema>;
export type TaskScheduleEvent = z.infer<typeof TaskScheduleEventSchema>;
export type TaskCancelEvent = z.infer<typeof TaskCancelEventSchema>;
export type ScheduledTaskTriggeredEvent = z.infer<
  typeof ScheduledTaskTriggeredEventSchema
>;
