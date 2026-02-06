import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { ConversationService } from '../bot/conversation.service';
import { LlmService } from '../bot/llm.service';
import { BroadcastService } from '../scheduler/broadcast.service';
import { ActiveRequestData, QueuedUserMessage } from './message.types';

@Processor('user-messages')
@Injectable()
export class UserMessageProcessor extends WorkerHost {
  private redis: Redis;
  private activeControllers = new Map<number, AbortController>();

  constructor(
    @InjectQueue('user-messages')
    private readonly userQueue: Queue<QueuedUserMessage>,
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

  async process(job: Job<QueuedUserMessage>): Promise<void> {
    const message = job.data;

    try {
      // 1. Check for in-flight USER request (ONLY user requests, not scheduled)
      const activeRequest = await this.getActiveUserRequest(message.userId);
      if (activeRequest) {
        // ABORT IN-FLIGHT USER REQUEST
        console.log(
          `Aborting in-flight user request ${activeRequest.jobId} for user ${message.userId}`,
        );

        // Get the AbortController and abort
        const controller = this.activeControllers.get(message.userId);
        if (controller) {
          controller.abort();
        }

        // Cancel the old job if still in queue
        const oldJob = await this.userQueue.getJob(activeRequest.jobId);
        if (oldJob) {
          await oldJob.remove();
        }

        // Clear active request marker
        await this.clearActiveUserRequest(message.userId);
      }

      // 2. Check for pending user messages (debouncing)
      const batch = await this.collectPendingUserMessages(message.userId);

      // 3. Deduplicate (if same message already processing)
      const uniqueMessages = this.deduplicateMessages(batch);

      // 4. Combine messages if multiple
      const combinedContent = this.combineMessages(uniqueMessages);

      // 5. Get conversation history
      const history = await this.conversationService.getConversation(
        message.userId,
      );

      // 6. Create AbortController for this request
      const abortController = new AbortController();
      this.activeControllers.set(message.userId, abortController);

      // 7. Mark USER request as active (separate from scheduled)
      await this.setActiveUserRequest(message.userId, job.id, abortController);

      // 8. Send typing indicator
      await this.broadcastService.sendTypingIndicator(message.userId);

      // 9. Generate LLM response with tools (with abort signal)
      const response = await this.llmService.generateResponse(
        combinedContent,
        history,
        message.userId,
        abortController.signal,
      );

      // 10. Clear active request (success)
      await this.clearActiveUserRequest(message.userId);
      this.activeControllers.delete(message.userId);

      // 11. Store in conversation history
      await this.conversationService.addMessage(
        message.userId,
        'user',
        combinedContent,
      );
      await this.conversationService.addMessage(
        message.userId,
        'assistant',
        response,
      );

      // 12. Send to user
      await this.broadcastService.sendMessageWithRetry(
        message.userId,
        response,
      );

      // 13. Clean up pending markers
      await this.clearPendingUserMessages(message.userId, uniqueMessages);
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log(
          `User request aborted for user ${message.userId}, will be retried with new context`,
        );
        this.activeControllers.delete(message.userId);
        return; // Don't rethrow
      }

      await this.clearActiveUserRequest(message.userId);
      this.activeControllers.delete(message.userId);
      throw error;
    }
  }

  /**
   * Get active user request from Redis
   */
  private async getActiveUserRequest(
    userId: number,
  ): Promise<ActiveRequestData | null> {
    const key = `active_request:${userId}:user`;
    const data = await this.redis.get(key);
    if (!data) return null;
    return JSON.parse(data);
  }

  /**
   * Set active user request in Redis
   */
  private async setActiveUserRequest(
    userId: number,
    jobId: string,
    controller: AbortController,
  ): Promise<void> {
    const key = `active_request:${userId}:user`;
    const data: ActiveRequestData = {
      jobId,
      startTime: Date.now(),
      source: 'user',
    };
    await this.redis.set(key, JSON.stringify(data), 'EX', 300); // 5 minute TTL
  }

  /**
   * Clear active user request from Redis
   */
  private async clearActiveUserRequest(userId: number): Promise<void> {
    const key = `active_request:${userId}:user`;
    await this.redis.del(key);
  }

  /**
   * Collect pending user messages within debounce window
   */
  private async collectPendingUserMessages(
    userId: number,
  ): Promise<QueuedUserMessage[]> {
    const messages: QueuedUserMessage[] = [];
    const pattern = `pending_user_message:${userId}:*`;
    const keys = await this.redis.keys(pattern);

    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        messages.push(JSON.parse(data));
      }
    }

    return messages;
  }

  /**
   * Deduplicate messages by messageId
   */
  private deduplicateMessages(
    messages: QueuedUserMessage[],
  ): QueuedUserMessage[] {
    const seen = new Set<string>();
    return messages.filter((msg) => {
      if (seen.has(msg.messageId)) {
        return false;
      }
      seen.add(msg.messageId);
      return true;
    });
  }

  /**
   * Combine multiple messages into single content
   */
  private combineMessages(messages: QueuedUserMessage[]): string {
    if (messages.length === 0) return '';
    if (messages.length === 1) return messages[0].content;

    // Sort by timestamp
    messages.sort((a, b) => a.timestamp - b.timestamp);

    // Combine with follow-up markers
    const parts = [messages[0].content];
    for (let i = 1; i < messages.length; i++) {
      parts.push(`[Follow-up]: ${messages[i].content}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Clear pending message markers from Redis
   */
  private async clearPendingUserMessages(
    userId: number,
    messages: QueuedUserMessage[],
  ): Promise<void> {
    for (const msg of messages) {
      const key = `pending_user_message:${userId}:${msg.timestamp}`;
      await this.redis.del(key);
    }
  }
}
