export enum TaskType {
  ONE_TIME = 'one_time',
  RECURRING = 'recurring',
}

export interface ScheduledTask {
  id: string;
  userId: number;
  type: TaskType;
  description: string;
  message: string;

  // For one-time tasks
  scheduledTime?: number; // Unix timestamp

  // For recurring tasks
  cronExpression?: string; // e.g., '0 8 * * *' for daily at 8am

  createdAt: number;
  enabled: boolean;
  lastExecuted?: number;
}

export interface TaskExecutionLog {
  taskId: string;
  executedAt: number;
  status: 'success' | 'error';
  error?: string;
}
