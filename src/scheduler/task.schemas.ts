import { z } from 'zod';

export enum TaskType {
  ONE_TIME = 'one_time',
  RECURRING = 'recurring',
}

export const ScheduledTaskSchema = z.object({
  id: z.string(),
  userId: z.number(),
  type: z.nativeEnum(TaskType),
  description: z.string(),
  message: z.string(),
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
