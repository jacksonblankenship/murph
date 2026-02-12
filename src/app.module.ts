import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { MurLockModule } from 'murlock';
import { ClsModule } from 'nestjs-cls';
import { TelegrafModule } from 'nestjs-telegraf';
import { CacheModule } from './cache/cache.module';
import { CommonModule } from './common/common.module';
import { configuration } from './config/configuration';
import { DispatcherModule } from './dispatcher';
import { HealthModule } from './health/health.module';
import { InboundModule } from './inbound';
import { LoggingModule } from './logging/logging.module';
import { MessagesModule } from './messages/messages.module';
import { PromptModule } from './prompts';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SyncModule } from './sync/sync.module';
import { TelegramModule } from './transport/telegram/telegram.module';
import { VoiceModule } from './transport/voice/voice.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ClsModule.forRoot({
      global: true,
      middleware: { mount: false },
    }),
    MurLockModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const host = configService.get<string>('redis.host');
        const port = configService.get<number>('redis.port');
        const password = configService.get<string>('redis.password');
        const passwordPart = password ? `:${password}@` : '';
        return {
          redisOptions: {
            url: `redis://${passwordPart}${host}:${port}`,
          },
          wait: 1000,
          maxAttempts: 5,
          logLevel: 'warn',
        };
      },
      inject: [ConfigService],
    }),
    CommonModule,
    DispatcherModule,
    HealthModule,
    LoggingModule,
    CacheModule,
    PromptModule,
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        token: configService.get<string>('telegram.botToken'),
      }),
      inject: [ConfigService],
    }),
    TelegramModule,
    VoiceModule,
    InboundModule,
    SchedulerModule,
    MessagesModule,
    SyncModule,
  ],
})
export class AppModule {}
