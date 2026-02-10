import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { ChannelOrchestratorService } from '../channels/channel-orchestrator.service';
import { SCHEDULED_PROACTIVE_CHANNEL_ID } from '../channels/presets/scheduled.preset';
import { RedisService } from '../redis/redis.service';
import { BroadcastService } from '../transport/telegram/broadcast.service';
import { ActiveRequestData, QueuedScheduledMessage } from './message.schemas';

/** Preview length for logging scheduled task prompts */
const LOG_PREVIEW_LENGTH = 100;
/** TTL in seconds for active request tracking (5 minutes) */
const ACTIVE_REQUEST_TTL_SECONDS = 300;

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
  constructor(
    private readonly logger: PinoLogger,
    private readonly channelOrchestrator: ChannelOrchestratorService,
    private readonly redisService: RedisService,
    private readonly broadcastService: BroadcastService,
  ) {
    super();
    this.logger.setContext(ScheduledMessageProcessor.name);
  }

  async process(job: Job<QueuedScheduledMessage>): Promise<void> {
    const message = job.data;

    this.logger.info(
      { taskId: message.taskId, userId: message.userId },
      'Processing scheduled task',
    );
    this.logger.debug(
      { prompt: message.content.substring(0, LOG_PREVIEW_LENGTH) },
      'Scheduled task prompt',
    );

    try {
      // NO ABORT CHECKING - scheduled messages always run to completion

      // Mark SCHEDULED request as active (separate from user)
      await this.setActiveScheduledRequest(message.userId, job.id);

      // Execute through channel orchestrator with proactive channel and typing indicator
      // The channel handles: transformation, enrichment, LLM call, storage, output
      await this.broadcastService.withTypingIndicator(message.userId, () =>
        this.channelOrchestrator.execute(
          SCHEDULED_PROACTIVE_CHANNEL_ID,
          {
            message: message.content,
            userId: message.userId,
            scheduledTime: new Date(),
            taskId: message.taskId,
          },
          // No abort signal - scheduled messages run to completion
        ),
      );

      this.logger.info(
        { taskId: message.taskId, userId: message.userId },
        'Completed scheduled task',
      );

      // Clear active request
      await this.clearActiveScheduledRequest(message.userId);
    } catch (error) {
      this.logger.error(
        {
          err: error,
          userId: message.userId,
          taskId: message.taskId,
        },
        'Failed to process scheduled message',
      );
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
      .set(key, JSON.stringify(data), 'EX', ACTIVE_REQUEST_TTL_SECONDS);
  }

  /**
   * Clear active scheduled request from Redis
   */
  private async clearActiveScheduledRequest(userId: number): Promise<void> {
    const key = `active_request:${userId}:scheduled`;
    await this.redisService.getClient().del(key);
  }
}
