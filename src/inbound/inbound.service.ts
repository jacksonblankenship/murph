import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AgentDispatcher } from '../dispatcher';
import { RedisService } from '../redis/redis.service';
import type { PendingMessage } from './inbound.types';

/** Redis key prefix for pending message lists */
const PENDING_KEY_PREFIX = 'inbound:pending:';
/** Redis Pub/Sub channel for abort signals */
const ABORT_CHANNEL = 'inbound:abort';
/** Default debounce delay in milliseconds */
const DEBOUNCE_DELAY_MS = 2000;

/**
 * Enqueue parameters for an inbound message from any transport.
 */
export interface EnqueueParams {
  /** User who sent the message */
  userId: number;
  /** Chat/conversation ID for response routing */
  chatId: number;
  /** Message text */
  text: string;
  /** Transport-level message ID */
  messageId: number;
  /** Transport identifier (e.g., 'telegram', 'slack') */
  source: string;
}

/**
 * Service used by transports to enqueue inbound messages.
 *
 * On each call:
 * 1. Publishes an abort signal for any in-flight LLM processing
 * 2. Pushes the message to a per-user Redis list
 * 3. Dispatches a debounced trigger job to the inbound-messages queue
 *
 * BullMQ's deduplication mode replaces the trigger job on each call,
 * resetting the debounce timer. When the timer expires, `InboundProcessor`
 * drains the Redis list and processes all accumulated messages together.
 */
@Injectable()
export class InboundService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly dispatcher: AgentDispatcher,
    private readonly redisService: RedisService,
  ) {
    this.logger.setContext(InboundService.name);
  }

  /**
   * Enqueue a message for debounced processing.
   *
   * @param params Message details from the transport
   */
  async enqueue(params: EnqueueParams): Promise<void> {
    const { userId, chatId, text, messageId, source } = params;
    const redis = this.redisService.getClient();

    // 1. Abort any in-flight processing for this user
    await redis.publish(ABORT_CHANNEL, JSON.stringify({ userId }));

    // 2. Push message to pending list
    const pendingMessage: PendingMessage = {
      text,
      messageId,
      timestamp: Date.now(),
      source,
    };
    await redis.rpush(
      `${PENDING_KEY_PREFIX}${userId}`,
      JSON.stringify(pendingMessage),
    );

    // 3. Dispatch debounced trigger job
    await this.dispatcher.dispatch({
      queue: 'inbound-messages',
      jobName: 'process',
      data: { userId, chatId, source },
      jobOptions: {
        deduplication: {
          id: `user-${userId}`,
          ttl: DEBOUNCE_DELAY_MS,
        },
        delay: DEBOUNCE_DELAY_MS,
      },
    });

    this.logger.debug(
      { userId, messageId, source },
      'Message enqueued for processing',
    );
  }
}
