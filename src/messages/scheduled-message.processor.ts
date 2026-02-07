import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ChannelOrchestratorService } from '../channels/channel-orchestrator.service';
import { SCHEDULED_PROACTIVE_CHANNEL_ID } from '../channels/presets/scheduled.preset';
import { RedisService } from '../redis/redis.service';
import { ActiveRequestData, QueuedScheduledMessage } from './message.schemas';

/**
 * Processes scheduled messages through the proactive channel.
 *
 * Uses the 'scheduled-proactive' channel which:
 * - Transforms messages with proactive framing
 * - Enriches with memory and history context
 * - Uses time, memory, and web search tools (no scheduling tools)
 * - Outputs via Telegram
 */
@Processor('scheduled-messages')
@Injectable()
export class ScheduledMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(ScheduledMessageProcessor.name);

  constructor(
    private readonly channelOrchestrator: ChannelOrchestratorService,
    private readonly redisService: RedisService,
  ) {
    super();
  }

  async process(job: Job<QueuedScheduledMessage>): Promise<void> {
    const message = job.data;

    this.logger.log(
      `Processing task ${message.taskId} for user ${message.userId}`,
    );
    this.logger.debug(`Prompt: "${message.content.substring(0, 100)}..."`);

    try {
      // NO ABORT CHECKING - scheduled messages always run to completion

      // Mark SCHEDULED request as active (separate from user)
      await this.setActiveScheduledRequest(message.userId, job.id);

      // Execute through channel orchestrator with proactive channel
      // The channel handles: transformation, enrichment, LLM call, storage, output
      await this.channelOrchestrator.execute(
        SCHEDULED_PROACTIVE_CHANNEL_ID,
        {
          message: message.content,
          userId: message.userId,
          scheduledTime: new Date(),
          taskId: message.taskId,
        },
        // No abort signal - scheduled messages run to completion
      );

      this.logger.log(
        `Completed task ${message.taskId} for user ${message.userId}`,
      );

      // Clear active request
      await this.clearActiveScheduledRequest(message.userId);
    } catch (error) {
      this.logger.error('Failed to process scheduled message:', {
        userId: message.userId,
        taskId: message.taskId,
        error: error.message,
      });
      await this.clearActiveScheduledRequest(message.userId);
      throw error; // Let BullMQ handle retry
    }
  }

  /**
   * Set active scheduled request in Redis
   */
  private async setActiveScheduledRequest(
    userId: number,
    jobId: string,
  ): Promise<void> {
    const key = `active_request:${userId}:scheduled`;
    const data: ActiveRequestData = {
      jobId,
      startTime: Date.now(),
      source: 'scheduled',
    };
    await this.redisService
      .getClient()
      .set(key, JSON.stringify(data), 'EX', 300); // 5 minute TTL
  }

  /**
   * Clear active scheduled request from Redis
   */
  private async clearActiveScheduledRequest(userId: number): Promise<void> {
    const key = `active_request:${userId}:scheduled`;
    await this.redisService.getClient().del(key);
  }
}
