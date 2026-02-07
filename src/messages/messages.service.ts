import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QueuedScheduledMessage } from './message.schemas';

/**
 * Service for accessing message queues.
 *
 * User messages are now processed via in-memory MessageOrchestrator.
 * Scheduled messages still use BullMQ for persistence.
 */
@Injectable()
export class MessagesService {
  constructor(
    @InjectQueue('scheduled-messages')
    private readonly scheduledMessagesQueue: Queue<QueuedScheduledMessage>,
  ) {}

  /**
   * Get scheduled messages queue for monitoring
   */
  getScheduledMessagesQueue(): Queue<QueuedScheduledMessage> {
    return this.scheduledMessagesQueue;
  }
}
