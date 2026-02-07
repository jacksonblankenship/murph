import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { MemoryModule } from '../memory/memory.module';
import { RedisModule } from '../redis/redis.module';
import { MessageOrchestrator } from './message.orchestrator';
import { MessagesService } from './messages.service';
import { ScheduledMessageProcessor } from './scheduled-message.processor';
import { ScheduledTaskHandler } from './scheduled-task.handler';

/**
 * Handles message processing and LLM orchestration.
 *
 * Communication with other modules via EventEmitter:
 * - Listens for USER_MESSAGE to process user messages
 * - Listens for SCHEDULED_TASK_TRIGGERED to queue scheduled messages
 * - Emits MESSAGE_BROADCAST to send responses
 *
 * Uses BullMQ for:
 * - scheduled-messages: Persistent queue for scheduled task LLM processing
 */
@Module({
  imports: [
    RedisModule,
    MemoryModule,
    AiModule,
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
  providers: [
    MessagesService,
    MessageOrchestrator,
    ScheduledMessageProcessor,
    ScheduledTaskHandler,
  ],
  exports: [MessagesService],
})
export class MessagesModule {}
