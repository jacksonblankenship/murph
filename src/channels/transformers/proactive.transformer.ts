import { Injectable } from '@nestjs/common';
import type { MessageTransformer, TransformContext } from '../channel.types';

/**
 * Transforms scheduled task prompts for proactive outreach.
 *
 * Reframes the stored prompt so the LLM understands it's initiating
 * contact rather than responding to a user query.
 */
@Injectable()
export class ProactiveTransformer implements MessageTransformer {
  transform(message: string, context: TransformContext): string {
    const scheduledTimeInfo = context.scheduledTime
      ? `Scheduled for: ${context.scheduledTime.toLocaleString()}`
      : 'Triggered now';

    const taskIdInfo = context.taskId ? `Task ID: ${context.taskId}` : '';

    return `[PROACTIVE OUTREACH]
You are initiating this contact - a scheduled task has triggered.

Task: ${message}
${scheduledTimeInfo}
${taskIdInfo}

Execute the task and craft a warm, proactive message.
Don't phrase it as answering a question - you're reaching out first.
Be natural and conversational, not robotic.`.trim();
  }
}
