import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { Events, type ScheduledTaskTriggeredEvent } from '../common/events';
import type { QueuedScheduledMessage } from './message.schemas';

/**
 * Listens for SCHEDULED_TASK_TRIGGERED events from SchedulerModule
 * and queues them for LLM processing.
 *
 * This decouples SchedulerModule from MessagesModule.
 */
@Injectable()
export class ScheduledTaskHandler {
  private readonly logger = new Logger(ScheduledTaskHandler.name);

  constructor(
    @InjectQueue('scheduled-messages')
    private readonly scheduledMessagesQueue: Queue<QueuedScheduledMessage>,
  ) {}

  @OnEvent(Events.SCHEDULED_TASK_TRIGGERED)
  async handleScheduledTask(event: ScheduledTaskTriggeredEvent): Promise<void> {
    const { userId, taskId, message } = event;

    this.logger.log(`Queueing scheduled task ${taskId} for LLM processing`);

    const queuedMessage: QueuedScheduledMessage = {
      userId,
      content: message,
      taskId,
      timestamp: Date.now(),
    };

    await this.scheduledMessagesQueue.add(
      'process-scheduled-message',
      queuedMessage,
      {
        delay: 0,
        jobId: `scheduled-${taskId}-${queuedMessage.timestamp}`,
      },
    );
  }
}
