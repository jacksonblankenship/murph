import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { ConversationService } from '../bot/conversation.service';
import { LlmService } from '../bot/llm.service';
import { BroadcastService } from '../scheduler/broadcast.service';
import { ActiveRequestData, QueuedScheduledMessage } from './message.types';

@Processor('scheduled-messages')
@Injectable()
export class ScheduledMessageProcessor extends WorkerHost {
  private redis: Redis;

  constructor(
    private readonly llmService: LlmService,
    private readonly conversationService: ConversationService,
    private readonly broadcastService: BroadcastService,
  ) {
    super();
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
      maxRetriesPerRequest: null,
    });
  }

  async process(job: Job<QueuedScheduledMessage>): Promise<void> {
    const message = job.data;

    // Log what we're processing
    console.log(`[ScheduledMsg] Processing task ${message.taskId} for user ${message.userId}`);
    console.log(`[ScheduledMsg] Prompt: "${message.content.substring(0, 100)}..."`);

    try {
      // NO ABORT CHECKING - scheduled messages always run to completion

      // 1. Get conversation history
      const history = await this.conversationService.getConversation(message.userId);

      // 2. Mark SCHEDULED request as active (separate from user)
      await this.setActiveScheduledRequest(message.userId, job.id);

      // 3. Send typing indicator
      await this.broadcastService.sendTypingIndicator(message.userId);

      // 4. Generate LLM response with tools (NO abort signal)
      const response = await this.llmService.generateResponse(
        message.content,
        history,
        message.userId,
        // NO ABORT SIGNAL
      );

      // Log the response
      console.log(
        `[ScheduledMsg] LLM generated ${response.length} chars for task ${message.taskId}`,
      );

      // 5. Clear active request
      await this.clearActiveScheduledRequest(message.userId);

      // 6. Store in conversation history
      await this.conversationService.addMessage(
        message.userId,
        'assistant',
        `[Scheduled: ${message.content}]`,
      );
      await this.conversationService.addMessage(message.userId, 'assistant', response);

      // 7. Send to user
      await this.broadcastService.sendMessageWithRetry(message.userId, response);

      // Confirm delivery
      console.log(`[ScheduledMsg] Delivered response to user ${message.userId}`);
    } catch (error) {
      // Enhanced error logging
      console.error(`[ScheduledMsg] Failed to process scheduled message:`, {
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
  private async setActiveScheduledRequest(userId: number, jobId: string): Promise<void> {
    const key = `active_request:${userId}:scheduled`;
    const data: ActiveRequestData = {
      jobId,
      startTime: Date.now(),
      source: 'scheduled',
    };
    await this.redis.set(key, JSON.stringify(data), 'EX', 300); // 5 minute TTL
  }

  /**
   * Clear active scheduled request from Redis
   */
  private async clearActiveScheduledRequest(userId: number): Promise<void> {
    const key = `active_request:${userId}:scheduled`;
    await this.redis.del(key);
  }
}
