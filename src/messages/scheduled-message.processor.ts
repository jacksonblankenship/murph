import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { ChatOrchestratorService } from '../ai/chat-orchestrator.service';
import { AppClsService } from '../common/cls.service';
import { Events, type MessageBroadcastEvent } from '../common/events';
import type { ConversationMessage } from '../memory/conversation.schemas';
import { ConversationService } from '../memory/conversation.service';
import { RedisService } from '../redis/redis.service';
import { ActiveRequestData, QueuedScheduledMessage } from './message.schemas';

@Processor('scheduled-messages')
@Injectable()
export class ScheduledMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(ScheduledMessageProcessor.name);

  constructor(
    private readonly chatOrchestrator: ChatOrchestratorService,
    private readonly conversationService: ConversationService,
    private readonly redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
    private readonly clsService: AppClsService,
  ) {
    super();
  }

  async process(job: Job<QueuedScheduledMessage>): Promise<void> {
    const message = job.data;

    // Set user context in CLS for downstream services
    this.clsService.setUserId(message.userId);

    this.logger.log(
      `Processing task ${message.taskId} for user ${message.userId}`,
    );
    this.logger.debug(`Prompt: "${message.content.substring(0, 100)}..."`);

    try {
      // NO ABORT CHECKING - scheduled messages always run to completion

      // 1. Get conversation history
      const history = await this.conversationService.getConversation(
        message.userId,
      );

      // 2. Mark SCHEDULED request as active (separate from user)
      await this.setActiveScheduledRequest(message.userId, job.id);

      // 3. Generate LLM response with tools (userId comes from CLS context)
      const response = await this.chatOrchestrator.generateResponse(
        message.content,
        history,
        // NO ABORT SIGNAL
      );

      this.logger.log(
        `LLM generated ${response.text.length} chars for task ${message.taskId}`,
      );

      // 4. Clear active request
      await this.clearActiveScheduledRequest(message.userId);

      // 5. Store in conversation history (system note + response messages in SDK format)
      await this.conversationService.addMessages(message.userId, [
        { role: 'user', content: `[Scheduled: ${message.content}]` },
        ...(response.messages as ConversationMessage[]),
      ]);

      // 6. Emit broadcast event to send response to user
      const broadcastEvent: MessageBroadcastEvent = {
        userId: message.userId,
        content: response.text,
      };
      this.eventEmitter.emit(Events.MESSAGE_BROADCAST, broadcastEvent);

      this.logger.log(`Emitted broadcast for user ${message.userId}`);
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
