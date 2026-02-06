import { BullModule } from '@nestjs/bullmq';
import { Module, forwardRef } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { MessagesService } from './messages.service';
import { ScheduledMessageProcessor } from './scheduled-message.processor';
import { UserMessageProcessor } from './user-message.processor';

@Module({
  imports: [
    BullModule.registerQueue(
      {
        name: 'user-messages',
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
      },
      {
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
      },
    ),
    forwardRef(() => BotModule),
    SchedulerModule,
  ],
  providers: [MessagesService, UserMessageProcessor, ScheduledMessageProcessor],
  exports: [MessagesService],
})
export class MessagesModule {}
