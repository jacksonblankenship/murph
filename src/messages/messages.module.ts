import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AiModule } from '../ai/ai.module';
import { ChannelModule } from '../channels/channel.module';
import { AgentDispatcher } from '../dispatcher';
import { MemoryModule } from '../memory/memory.module';
import { RedisModule } from '../redis/redis.module';
import { BroadcastModule } from '../transport/telegram/broadcast.module';
import { MessagesService } from './messages.service';
import { ScheduledMessageProcessor } from './scheduled-message.processor';

/**
 * Handles message processing and LLM orchestration.
 *
 * Uses BullMQ for:
 * - scheduled-messages: Persistent queue for scheduled task LLM processing
 *
 * The scheduled-messages queue is registered with AgentDispatcher on init
 * so TaskProcessor can dispatch directly without EventEmitter bridging.
 */
@Module({
  imports: [
    RedisModule,
    MemoryModule,
    AiModule,
    ChannelModule,
    BroadcastModule,
    BullModule.registerQueue({
      name: 'scheduled-messages',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: {
          age: 86400, // 24 hours
          count: 1000,
        },
        removeOnFail: {
          age: 604800, // 7 days
        },
      },
    }),
    BullBoardModule.forFeature({
      name: 'scheduled-messages',
      adapter: BullMQAdapter,
    }),
  ],
  providers: [MessagesService, ScheduledMessageProcessor],
  exports: [MessagesService],
})
export class MessagesModule implements OnModuleInit {
  constructor(
    @InjectQueue('scheduled-messages')
    private readonly scheduledMessagesQueue: Queue,
    private readonly dispatcher: AgentDispatcher,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerQueue(
      'scheduled-messages',
      this.scheduledMessagesQueue,
    );
  }
}
