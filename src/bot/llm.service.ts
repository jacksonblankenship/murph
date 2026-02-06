import { createAnthropic } from '@ai-sdk/anthropic';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { ExaService } from '../exa/exa.service';
import { RedisService } from '../redis/redis.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import type { ConversationMessage } from './conversation.service';

@Injectable()
export class LlmService {
  private model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
    private exaService: ExaService,
    private schedulerService: SchedulerService,
  ) {
    const anthropicProvider = createAnthropic({
      apiKey: this.configService.get<string>('ANTHROPIC_API_KEY'),
    });
    this.model = anthropicProvider('claude-sonnet-4-20250514');
  }

  async generateResponse(
    userMessage: string,
    conversationHistory: ConversationMessage[] = [],
    userId = 0,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    try {
      const result = await generateText({
        model: this.model,
        maxOutputTokens: 4096,
        abortSignal,
        messages: [
          ...conversationHistory.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          {
            role: 'user' as const,
            content: userMessage,
          },
        ],
        tools: {
          get_current_time: tool({
            description: 'Get the current date and time in ISO format',
            inputSchema: z.object({
              timezone: z.string().optional().describe('Timezone (optional)'),
            }),
            execute: async ({ timezone }) => {
              return new Date().toISOString();
            },
          }),
          web_search: tool({
            description: 'Search the web for current information using Exa',
            inputSchema: z.object({
              query: z.string().describe('The search query'),
              numResults: z.number().optional().describe('Number of results (default 5)'),
            }),
            execute: async ({ query, numResults = 5 }) => {
              return await this.exaService.search(query, numResults);
            },
          }),
          remember_fact: tool({
            description: 'Store an important fact in memory',
            inputSchema: z.object({
              key: z.string().describe('A short key to identify this fact'),
              value: z.string().describe('The fact to remember'),
            }),
            execute: async ({ key, value }) => {
              const redis = this.redisService.getClient();
              const memoryKey = `memory:user:${userId}:${key}`;
              await redis.set(memoryKey, value);
              return `Remembered: ${key} = ${value}`;
            },
          }),
          schedule_task: tool({
            description:
              'Schedule a task to be executed at a specific time or on a recurring basis. Use this when the user asks to be reminded, schedule something, or set up recurring notifications.',
            inputSchema: z.object({
              description: z.string().describe('Short description of what this task is for'),
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
            execute: async ({ description, message, scheduledTime, cronExpression }) => {
              // Parse scheduledTime if provided
              let timestamp: number | undefined;
              if (scheduledTime) {
                try {
                  timestamp = new Date(scheduledTime).getTime();
                  if (isNaN(timestamp)) {
                    return `Error: Invalid scheduledTime format. Use ISO 8601 format like "2026-02-07T08:00:00Z"`;
                  }
                } catch (error) {
                  return `Error parsing scheduledTime: ${error.message}`;
                }
              }

              const result = await this.schedulerService.scheduleTask(
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
              } else {
                const timeStr = new Date(timestamp).toLocaleString();
                return `✅ Task scheduled!\n\nTask ID: ${result.taskId}\nScheduled for: ${timeStr}\nPrompt: "${message}"\n\nI'll process this prompt with fresh data at the scheduled time.`;
              }
            },
          }),
          cancel_scheduled_task: tool({
            description:
              'Cancel a previously scheduled task. Use this when the user wants to stop a reminder or cancel a scheduled task.',
            inputSchema: z.object({
              taskId: z.string().describe('The task ID to cancel'),
            }),
            execute: async ({ taskId }) => {
              const result = await this.schedulerService.cancelTask(taskId, userId);

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
              const tasks = await this.schedulerService.listUserTasks(userId);

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
        },
        stopWhen: stepCountIs(10), // Built-in iteration limit (replaces custom loop)
      });

      return result.text;
    } catch (error) {
      // Handle abort error gracefully
      if (error.name === 'AbortError') {
        throw error; // Propagate to processor
      }
      console.error('Error calling Anthropic API:', error);
      throw error;
    }
  }
}
