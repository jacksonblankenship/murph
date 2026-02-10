import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PinoLogger } from 'nestjs-pino';
import { ChannelOrchestratorService } from '../channels/channel-orchestrator.service';
import { USER_DIRECT_CHANNEL_ID } from '../channels/presets/user-direct.preset';
import { AppClsService } from '../common/cls.service';
import {
  Events,
  type MessageBroadcastEvent,
  type UserMessageEvent,
} from '../common/events';
import { BroadcastService } from '../transport/telegram/broadcast.service';

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
 * Delegates actual LLM processing to the channel orchestrator using the
 * 'user-direct' channel.
 */
@Injectable()
export class MessageOrchestrator implements OnModuleDestroy {
  private pendingMessages = new Map<number, PendingMessage[]>();
  private abortControllers = new Map<number, AbortController>();
  private debounceTimers = new Map<number, NodeJS.Timeout>();

  private readonly DEBOUNCE_MS = 2000;

  constructor(
    private readonly logger: PinoLogger,
    private readonly channelOrchestrator: ChannelOrchestratorService,
    private readonly eventEmitter: EventEmitter2,
    private readonly clsService: AppClsService,
    private readonly broadcastService: BroadcastService,
  ) {
    this.logger.setContext(MessageOrchestrator.name);
  }

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
      this.logger.info({ userId }, 'Aborting in-flight request');
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
          this.logger.error({ err, userId }, 'Failed to process messages');
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
      // Execute through channel orchestrator with typing indicator
      // The channel handles: enrichment, history, LLM call, conversation storage, output
      await this.broadcastService.withTypingIndicator(chatId, () =>
        this.channelOrchestrator.execute(
          USER_DIRECT_CHANNEL_ID,
          {
            message: combinedContent,
            userId,
            chatId,
          },
          {
            abortSignal: abortController.signal,
          },
        ),
      );

      // Clear abort controller on success
      this.abortControllers.delete(userId);
    } catch (error) {
      if (error.name === 'AbortError') {
        this.logger.info(
          { userId },
          'Request aborted, will retry with new context',
        );
        return; // Don't rethrow - new message will trigger fresh processing
      }

      this.abortControllers.delete(userId);

      this.logger.error({ err: error, userId }, 'Error processing messages');

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
