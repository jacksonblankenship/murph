import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import type Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { ChannelOrchestratorService } from '../channels/channel-orchestrator.service';
import { USER_DIRECT_CHANNEL_ID } from '../channels/presets/user-direct.preset';
import { AppClsService } from '../common/cls.service';
import { Events, type MessageBroadcastEvent } from '../common/events';
import { RedisService } from '../redis/redis.service';
import { BroadcastService } from '../transport/telegram/broadcast.service';
import type { InboundTriggerJob, PendingMessage } from './inbound.types';

/** Redis key prefix for pending message lists */
const PENDING_KEY_PREFIX = 'inbound:pending:';
/** Redis Pub/Sub channel for abort signals */
const ABORT_CHANNEL = 'inbound:abort';

/**
 * Processes debounced inbound messages from the inbound-messages queue.
 *
 * On each job:
 * 1. Atomically drains the user's pending message list from Redis
 * 2. Deduplicates by messageId and sorts by timestamp
 * 3. Combines messages with transport-aware markers
 * 4. Runs the channel pipeline (user-direct) with abort support
 *
 * Abort handling:
 * - Subscribes to `inbound:abort` Pub/Sub channel on init
 * - Maintains a per-user AbortController map
 * - When a new message arrives (abort signal), any in-flight LLM call is cancelled
 * - On AbortError: logs and returns — the new debounced job handles re-processing
 */
@Processor('inbound-messages')
export class InboundProcessor
  extends WorkerHost
  implements OnModuleInit, OnModuleDestroy
{
  private readonly abortControllers = new Map<number, AbortController>();
  private subscriber: Redis | null = null;

  constructor(
    private readonly logger: PinoLogger,
    private readonly channelOrchestrator: ChannelOrchestratorService,
    private readonly broadcastService: BroadcastService,
    private readonly clsService: AppClsService,
    private readonly redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
    this.logger.setContext(InboundProcessor.name);
  }

  async onModuleInit(): Promise<void> {
    // Create a dedicated subscriber connection for Pub/Sub
    this.subscriber = this.redisService.getClient().duplicate();
    await this.subscriber.subscribe(ABORT_CHANNEL);

    this.subscriber.on('message', (_channel: string, message: string) => {
      try {
        const { userId } = JSON.parse(message) as { userId: number };
        const controller = this.abortControllers.get(userId);
        if (controller) {
          this.logger.debug({ userId }, 'Aborting in-flight request');
          controller.abort();
          this.abortControllers.delete(userId);
        }
      } catch {
        this.logger.warn({ message }, 'Failed to parse abort signal');
      }
    });

    this.logger.info({}, 'Subscribed to inbound abort channel');
  }

  async onModuleDestroy(): Promise<void> {
    // Abort all in-flight requests
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();

    // Clean up subscriber
    if (this.subscriber) {
      await this.subscriber.unsubscribe(ABORT_CHANNEL);
      await this.subscriber.quit();
      this.subscriber = null;
    }
  }

  async process(job: Job<InboundTriggerJob>): Promise<void> {
    const { userId, chatId } = job.data;

    // 1. Atomically drain pending messages
    const messages = await this.drainPendingMessages(userId);
    if (messages.length === 0) {
      this.logger.debug({ userId }, 'No pending messages, skipping');
      return;
    }

    // 2. Deduplicate and sort
    const uniqueMessages = this.deduplicateAndSort(messages);

    // 3. Combine with transport-aware markers
    const combinedContent = this.combineMessages(uniqueMessages);

    this.logger.info(
      { userId, messageCount: uniqueMessages.length },
      'Processing inbound messages',
    );

    // 4. Create abort controller
    const abortController = new AbortController();
    this.abortControllers.set(userId, abortController);

    try {
      await this.clsService.runWithContext({ userId, chatId }, () =>
        this.broadcastService.withTypingIndicator(chatId, () =>
          this.channelOrchestrator.execute(
            USER_DIRECT_CHANNEL_ID,
            { message: combinedContent, userId, chatId },
            { abortSignal: abortController.signal },
          ),
        ),
      );
    } catch (error) {
      if (error.name === 'AbortError') {
        this.logger.info(
          { userId },
          'Request aborted, will retry with new context',
        );
        return;
      }

      this.logger.error({ err: error, userId }, 'Error processing messages');

      const errorEvent: MessageBroadcastEvent = {
        userId,
        content: 'Sorry, I encountered an error processing your message.',
      };
      this.eventEmitter.emit(Events.MESSAGE_BROADCAST, errorEvent);

      throw error; // Let BullMQ handle retry
    } finally {
      this.abortControllers.delete(userId);
    }
  }

  /**
   * Atomically drain the pending message list from Redis.
   *
   * Uses a pipeline to LRANGE + DEL in one round-trip.
   */
  private async drainPendingMessages(
    userId: number,
  ): Promise<PendingMessage[]> {
    const key = `${PENDING_KEY_PREFIX}${userId}`;
    const redis = this.redisService.getClient();

    const pipeline = redis.pipeline();
    pipeline.lrange(key, 0, -1);
    pipeline.del(key);

    const results = await pipeline.exec();
    if (!results || !results[0]) return [];

    const [err, rawMessages] = results[0] as [Error | null, string[]];
    if (err || !rawMessages) return [];

    return rawMessages.map(raw => JSON.parse(raw) as PendingMessage);
  }

  /**
   * Deduplicate messages by messageId and sort by timestamp.
   */
  private deduplicateAndSort(messages: PendingMessage[]): PendingMessage[] {
    const seen = new Set<number>();
    const unique = messages.filter(msg => {
      if (seen.has(msg.messageId)) return false;
      seen.add(msg.messageId);
      return true;
    });

    unique.sort((a, b) => a.timestamp - b.timestamp);
    return unique;
  }

  /**
   * Combine messages with transport-aware markers.
   *
   * Rules:
   * - Single message: `[Source]: text`
   * - Multiple messages, same source: `[Source]: first\n\n[Follow-up]: second`
   * - Multiple messages, mixed sources: `[Source]: first\n\n[Follow-up, OtherSource]: second`
   */
  private combineMessages(messages: PendingMessage[]): string {
    if (messages.length === 0) return '';

    const firstSource = messages[0].source;
    const allSameSource = messages.every(m => m.source === firstSource);

    if (messages.length === 1) {
      return `[${this.capitalize(firstSource)}]: ${messages[0].text}`;
    }

    const parts = [`[${this.capitalize(firstSource)}]: ${messages[0].text}`];

    for (let i = 1; i < messages.length; i++) {
      const msg = messages[i];
      if (allSameSource || msg.source === firstSource) {
        parts.push(`[Follow-up]: ${msg.text}`);
      } else {
        parts.push(`[Follow-up, ${this.capitalize(msg.source)}]: ${msg.text}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Capitalize the first letter of a string.
   */
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
