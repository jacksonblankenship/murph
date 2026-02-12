import { z } from 'zod';

export enum TaskType {
  ONE_TIME = 'one_time',
  RECURRING = 'recurring',
}

export enum TaskAction {
  MESSAGE = 'message',
  CALL = 'call',
}

export const ScheduledTaskSchema = z.object({
  id: z.string(),
  userId: z.number(),
  type: z.nativeEnum(TaskType),
  description: z.string(),
  message: z.string(),
  /** Action to perform when the task fires. Defaults to 'message' for backward compatibility. */
  action: z.nativeEnum(TaskAction).optional().default(TaskAction.MESSAGE),
  scheduledTime: z.number().optional(),
  cronExpression: z.string().optional(),
  createdAt: z.number(),
  enabled: z.boolean(),
  lastExecuted: z.number().optional(),
});

export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

/**
 * Normalize Date | number to Unix timestamp
 */
export function normalizeTimestamp(time: Date | number): number {
  return typeof time === 'number' ? time : time.getTime();
}
