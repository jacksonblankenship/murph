import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExaModule } from '../exa/exa.module';
import { MessagesModule } from '../messages/messages.module';
import { RedisModule } from '../redis/redis.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { BotUpdate } from './bot.update';
import { ConversationService } from './conversation.service';
import { LlmService } from './llm.service';

@Module({
  imports: [
    ConfigModule,
    RedisModule,
    ExaModule,
    SchedulerModule,
    forwardRef(() => MessagesModule),
  ],
  providers: [BotUpdate, LlmService, ConversationService],
  exports: [LlmService, ConversationService],
})
export class BotModule {}
