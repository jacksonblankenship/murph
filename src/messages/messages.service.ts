import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QueuedScheduledMessage, QueuedUserMessage } from './message.types';

@Injectable()
export class MessagesService {
  constructor(
    @InjectQueue('user-messages')
    private readonly userMessagesQueue: Queue<QueuedUserMessage>,
    @InjectQueue('scheduled-messages')
    private readonly scheduledMessagesQueue: Queue<QueuedScheduledMessage>,
  ) {}

  /**
   * Queue a user message with debounce delay
   */
  async queueUserMessage(message: QueuedUserMessage): Promise<string> {
    const debounceMs = Number.parseInt(process.env.USER_MESSAGE_DEBOUNCE_MS || '2000', 10);

    const job = await this.userMessagesQueue.add(
      'process-user-message',
      message,
      {
        delay: debounceMs,
        jobId: `user-${message.userId}-${message.timestamp}`,
      },
    );

    return job.id;
  }

  /**
   * Queue a scheduled message with no delay
   */
  async queueScheduledMessage(message: QueuedScheduledMessage): Promise<string> {
    const job = await this.scheduledMessagesQueue.add(
      'process-scheduled-message',
      message,
      {
        delay: 0,
        jobId: `scheduled-${message.taskId}-${message.timestamp}`,
      },
    );

    return job.id;
  }

  /**
   * Get user messages queue for monitoring
   */
  getUserMessagesQueue(): Queue<QueuedUserMessage> {
    return this.userMessagesQueue;
  }

  /**
   * Get scheduled messages queue for monitoring
   */
  getScheduledMessagesQueue(): Queue<QueuedScheduledMessage> {
    return this.scheduledMessagesQueue;
  }
}
