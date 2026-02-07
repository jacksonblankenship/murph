import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ChatOrchestratorService } from '../ai/chat-orchestrator.service';
import { AppClsService } from '../common/cls.service';
import {
  Events,
  type MessageBroadcastEvent,
  type UserMessageEvent,
} from '../common/events';
import type { ConversationMessage } from '../memory/conversation.schemas';
import { ConversationService } from '../memory/conversation.service';
import { MemorySearchService } from '../memory/memory-search.service';
import { RedisService } from '../redis/redis.service';

interface PendingMessage {
  text: string;
  messageId: number;
  timestamp: number;
}

/**
 * Orchestrates user message processing with in-memory debouncing and abort logic.
 *
 * When a user sends rapid messages:
 * 1. Collect messages in a pending buffer
 * 2. Debounce for 2 seconds before processing
 * 3. If a new message arrives during LLM processing, abort and restart
 *
 * This replaces the BullMQ-based UserMessageProcessor with simpler in-memory logic.
 */
@Injectable()
export class MessageOrchestrator implements OnModuleDestroy {
  private readonly logger = new Logger(MessageOrchestrator.name);

  private pendingMessages = new Map<number, PendingMessage[]>();
  private abortControllers = new Map<number, AbortController>();
  private debounceTimers = new Map<number, NodeJS.Timeout>();

  private readonly DEBOUNCE_MS = 2000;

  constructor(
    private readonly chatOrchestrator: ChatOrchestratorService,
    private readonly conversationService: ConversationService,
    private readonly memorySearchService: MemorySearchService,
    private readonly redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
    private readonly clsService: AppClsService,
  ) {}

  onModuleDestroy() {
    // Clean up timers on shutdown
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
  }

  @OnEvent(Events.USER_MESSAGE)
  async handleMessage(event: UserMessageEvent): Promise<void> {
    const { userId, text, messageId, chatId } = event;

    // Abort any in-flight LLM call for this user
    const existingController = this.abortControllers.get(userId);
    if (existingController) {
      this.logger.log(`Aborting in-flight request for user ${userId}`);
      existingController.abort();
      this.abortControllers.delete(userId);
    }

    // Collect message in pending buffer
    const pending = this.pendingMessages.get(userId) ?? [];
    pending.push({ text, messageId, timestamp: Date.now() });
    this.pendingMessages.set(userId, pending);

    // Clear existing debounce timer
    const existingTimer = this.debounceTimers.get(userId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounce timer - wrap in CLS context since setTimeout loses async context
    const timer = setTimeout(() => {
      this.clsService
        .runWithContext({ userId, chatId }, () =>
          this.processMessages(userId, chatId),
        )
        .catch(err => {
          this.logger.error(
            `Failed to process messages for user ${userId}:`,
            err,
          );
        });
    }, this.DEBOUNCE_MS);

    this.debounceTimers.set(userId, timer);
  }

  private async processMessages(userId: number, chatId: number): Promise<void> {
    // Get and clear pending messages
    const messages = this.pendingMessages.get(userId) ?? [];
    this.pendingMessages.delete(userId);
    this.debounceTimers.delete(userId);

    if (messages.length === 0) {
      return;
    }

    // Deduplicate by messageId
    const seen = new Set<number>();
    const uniqueMessages = messages.filter(msg => {
      if (seen.has(msg.messageId)) return false;
      seen.add(msg.messageId);
      return true;
    });

    // Combine messages
    const combinedContent = this.combineMessages(uniqueMessages);

    // Create abort controller for this request
    const abortController = new AbortController();
    this.abortControllers.set(userId, abortController);

    try {
      // Get conversation history
      const history = await this.conversationService.getConversation(userId);

      // Search for relevant long-term memory context
      const memoryContext =
        await this.memorySearchService.recallRelevantContext(combinedContent);

      // Build message with memory context if available
      const enrichedMessage = memoryContext
        ? `${combinedContent}\n\n[Relevant memory context from your notes:]\n${memoryContext}`
        : combinedContent;

      // Generate LLM response with abort signal (userId comes from CLS context)
      const response = await this.chatOrchestrator.generateResponse(
        enrichedMessage,
        history,
        abortController.signal,
      );

      // Clear abort controller on success
      this.abortControllers.delete(userId);

      // Store in conversation history
      await this.conversationService.addMessages(userId, [
        { role: 'user', content: combinedContent },
        ...(response.messages as ConversationMessage[]),
      ]);

      // Emit broadcast event to send response to user
      const broadcastEvent: MessageBroadcastEvent = {
        userId,
        content: response.text,
      };
      this.eventEmitter.emit(Events.MESSAGE_BROADCAST, broadcastEvent);
    } catch (error) {
      if (error.name === 'AbortError') {
        this.logger.log(
          `Request aborted for user ${userId}, will retry with new context`,
        );
        return; // Don't rethrow - new message will trigger fresh processing
      }

      this.abortControllers.delete(userId);

      this.logger.error(`Error processing messages for user ${userId}:`, error);

      // Emit error message to user
      const errorEvent: MessageBroadcastEvent = {
        userId,
        content: 'Sorry, I encountered an error processing your message.',
      };
      this.eventEmitter.emit(Events.MESSAGE_BROADCAST, errorEvent);
    }
  }

  private combineMessages(messages: PendingMessage[]): string {
    if (messages.length === 0) return '';
    if (messages.length === 1) return messages[0].text;

    // Sort by timestamp
    messages.sort((a, b) => a.timestamp - b.timestamp);

    // Combine with follow-up markers
    const parts = [messages[0].text];
    for (let i = 1; i < messages.length; i++) {
      parts.push(`[Follow-up]: ${messages[i].text}`);
    }

    return parts.join('\n\n');
  }
}
