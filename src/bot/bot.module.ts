import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisModule } from '../redis/redis.module';
import { BotUpdate } from './bot.update';
import { ConversationService } from './conversation.service';
import { LlmService } from './llm.service';

@Module({
  imports: [ConfigModule, RedisModule],
  providers: [BotUpdate, LlmService, ConversationService],
})
export class BotModule {}
