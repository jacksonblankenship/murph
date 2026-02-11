import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ChannelModule } from '../channels/channel.module';
import { AgentDispatcher } from '../dispatcher';
import { RedisModule } from '../redis/redis.module';
import { BroadcastModule } from '../transport/telegram/broadcast.module';
import { InboundProcessor } from './inbound.processor';
import { InboundService } from './inbound.service';

/**
 * Handles inbound message processing via BullMQ.
 *
 * Transports push messages to a per-user Redis list and dispatch a debounced
 * trigger job. The processor drains the list, combines messages, and runs
 * the channel pipeline.
 *
 * Supports:
 * - Debounced batching (2s window, reset on each new message)
 * - Cross-transport accumulation (multiple sources batched together)
 * - Abort-on-new-message (cancels in-flight LLM calls)
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: 'inbound-messages',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    }),
    BullBoardModule.forFeature({
      name: 'inbound-messages',
      adapter: BullMQAdapter,
    }),
    RedisModule,
    ChannelModule,
    BroadcastModule,
  ],
  providers: [InboundService, InboundProcessor],
  exports: [InboundService],
})
export class InboundModule implements OnModuleInit {
  constructor(
    @InjectQueue('inbound-messages')
    private readonly inboundQueue: Queue,
    private readonly dispatcher: AgentDispatcher,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerQueue('inbound-messages', this.inboundQueue);
  }
}
