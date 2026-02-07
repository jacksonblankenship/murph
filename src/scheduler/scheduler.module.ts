import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule } from '../redis/redis.module';
import { SchedulerService } from './scheduler.service';
import { TaskProcessor } from './task.processor';

/**
 * Handles task scheduling with BullMQ.
 *
 * Communication with other modules via EventEmitter:
 * - Emits SCHEDULED_TASK_TRIGGERED when a task fires
 * - Emits MESSAGE_BROADCAST for error notifications
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('redis.host'),
          port: configService.get<number>('redis.port'),
          password: configService.get<string>('redis.password'),
        },
      }),
      inject: [ConfigService],
    }),
    BullBoardModule.forRoot({
      route: '/queues',
      adapter: ExpressAdapter,
    }),
    BullModule.registerQueue({
      name: 'scheduled-tasks',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
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
      name: 'scheduled-tasks',
      adapter: BullMQAdapter,
    }),
    RedisModule,
    ConfigModule,
  ],
  providers: [SchedulerService, TaskProcessor],
  exports: [SchedulerService],
})
export class SchedulerModule {}
