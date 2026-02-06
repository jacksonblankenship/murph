import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { RedisModule } from '../redis/redis.module';
import { BroadcastService } from './broadcast.service';
import { SchedulerService } from './scheduler.service';
import { TaskProcessor } from './task.processor';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD'),
        },
      }),
      inject: [ConfigService],
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
    RedisModule,
    TelegrafModule, // For @InjectBot()
    ConfigModule,
  ],
  providers: [SchedulerService, BroadcastService, TaskProcessor],
  exports: [SchedulerService, BroadcastService],
})
export class SchedulerModule {}
