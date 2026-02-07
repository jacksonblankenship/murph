import { tool } from 'ai';
import { z } from 'zod';
import type { SchedulerService } from '../../scheduler/scheduler.service';

/**
 * Creates scheduling tools for task management.
 *
 * @param schedulerService The scheduler service for managing tasks
 * @param userId The user ID for the current request
 */
export function createSchedulingTools(
  schedulerService: SchedulerService,
  userId: number,
) {
  return {
    schedule_task: tool({
      description:
        'Schedule a task to be executed at a specific time or on a recurring basis. Use this when the user asks to be reminded, schedule something, or set up recurring notifications.',
      inputSchema: z.object({
        description: z
          .string()
          .describe('Short description of what this task is for'),
        message: z
          .string()
          .describe(
            'The prompt/instruction for the LLM to process when the task executes. This will be processed fresh with full tool access (e.g., "Get current weather in Tokyo", "Summarize my calendar for today").',
          ),
        scheduledTime: z
          .string()
          .optional()
          .describe(
            'For one-time tasks: ISO 8601 timestamp (e.g., "2026-02-07T08:00:00Z") or human description',
          ),
        cronExpression: z
          .string()
          .optional()
          .describe(
            'For recurring tasks: cron expression (e.g., "0 8 * * *" for daily at 8am). Must provide either scheduledTime OR cronExpression, not both.',
          ),
      }),
      execute: async ({
        description,
        message,
        scheduledTime,
        cronExpression,
      }) => {
        let timestamp: number | undefined;
        if (scheduledTime) {
          try {
            timestamp = new Date(scheduledTime).getTime();
            if (Number.isNaN(timestamp)) {
              return `Error: Invalid scheduledTime format. Use ISO 8601 format like "2026-02-07T08:00:00Z"`;
            }
          } catch (error) {
            return `Error parsing scheduledTime: ${error.message}`;
          }
        }

        const result = await schedulerService.scheduleTask(
          userId,
          description,
          message,
          {
            scheduledTime: timestamp,
            cronExpression,
          },
        );

        if (!result.scheduled) {
          return `Failed to schedule task: ${result.error}`;
        }

        if (cronExpression) {
          return `✅ Recurring task scheduled!\n\nTask ID: ${result.taskId}\nSchedule: ${cronExpression}\nPrompt: "${message}"\n\nI'll process this prompt with fresh data on the specified schedule.`;
        }
        const timeStr = new Date(timestamp).toLocaleString();
        return `✅ Task scheduled!\n\nTask ID: ${result.taskId}\nScheduled for: ${timeStr}\nPrompt: "${message}"\n\nI'll process this prompt with fresh data at the scheduled time.`;
      },
    }),

    cancel_scheduled_task: tool({
      description:
        'Cancel a previously scheduled task. Use this when the user wants to stop a reminder or cancel a scheduled task.',
      inputSchema: z.object({
        taskId: z.string().describe('The task ID to cancel'),
      }),
      execute: async ({ taskId }) => {
        const result = await schedulerService.cancelTask(taskId, userId);

        if (!result.cancelled) {
          return `Failed to cancel task: ${result.error}`;
        }

        return `✅ Task ${taskId} has been cancelled and will no longer execute.`;
      },
    }),

    list_scheduled_tasks: tool({
      description: 'List all scheduled tasks for the current user',
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = await schedulerService.listUserTasks(userId);

        if (tasks.length === 0) {
          return 'You have no scheduled tasks.';
        }

        let response = `📅 Your Scheduled Tasks (${tasks.length}):\n\n`;

        tasks.forEach((task, idx) => {
          response += `${idx + 1}. ${task.description}\n`;
          response += `   ID: ${task.id}\n`;
          response += `   Type: ${task.type === 'one_time' ? 'One-time' : 'Recurring'}\n`;

          if (task.type === 'one_time') {
            const timeStr = new Date(task.scheduledTime).toLocaleString();
            response += `   Scheduled: ${timeStr}\n`;
          } else {
            response += `   Schedule: ${task.cronExpression}\n`;
          }

          response += `   Message: "${task.message}"\n`;

          if (task.lastExecuted) {
            const lastStr = new Date(task.lastExecuted).toLocaleString();
            response += `   Last executed: ${lastStr}\n`;
          }

          response += '\n';
        });

        return response.trim();
      },
    }),
  };
}
