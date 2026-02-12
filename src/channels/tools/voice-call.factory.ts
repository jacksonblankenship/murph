import { Injectable } from '@nestjs/common';
import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { AgentDispatcher } from '../../dispatcher';
import { SchedulerService } from '../../scheduler/scheduler.service';
import type { ToolDependencies, ToolFactory } from '../channel.types';

/**
 * Factory for the `call_me` tool that initiates voice calls.
 *
 * Supports two modes:
 * - **Immediate**: Dispatches a job to the `voice-calls` queue right away
 * - **Scheduled**: Uses the scheduler to trigger a call at a future time
 */
@Injectable()
export class VoiceCallToolFactory implements ToolFactory {
  constructor(
    private readonly dispatcher: AgentDispatcher,
    private readonly schedulerService: SchedulerService,
  ) {}

  /**
   * Creates the `call_me` tool.
   */
  create(deps: ToolDependencies): Record<string, Tool> {
    return {
      call_me: tool({
        description:
          'Initiate a phone call to the user. Can be immediate or scheduled for a specific time.',
        inputSchema: z.object({
          immediate: z
            .boolean()
            .describe('Whether to call immediately or schedule for later'),
          scheduledTime: z
            .string()
            .optional()
            .describe(
              'ISO 8601 timestamp for when to call (required if immediate is false)',
            ),
          context: z
            .string()
            .optional()
            .describe(
              'Brief context about why you are calling — will be included in your system prompt during the call',
            ),
        }),
        execute: async ({ immediate, scheduledTime, context }) => {
          if (immediate) {
            await this.dispatcher.dispatch({
              queue: 'voice-calls',
              jobName: 'outbound-call',
              data: {
                userId: deps.userId,
                context,
              },
            });
            return 'Calling now.';
          }

          if (!scheduledTime) {
            return 'Error: scheduledTime is required for scheduled calls.';
          }

          const scheduledDate = new Date(scheduledTime);
          if (scheduledDate.getTime() <= Date.now()) {
            return 'Error: scheduledTime must be in the future.';
          }

          const result = await this.schedulerService.scheduleTask(
            deps.userId,
            context || 'Scheduled phone call',
            context || 'Call the user',
            {
              scheduledTime: scheduledDate,
            },
          );

          if (!result.scheduled) {
            return `Error scheduling call: ${result.error}`;
          }

          return `Call scheduled for ${scheduledTime}.`;
        },
      }),
    };
  }
}
