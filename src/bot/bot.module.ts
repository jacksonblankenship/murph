import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BotUpdate } from './bot.update';
import { LlmService } from './llm.service';

@Module({
  imports: [ConfigModule],
  providers: [BotUpdate, LlmService],
})
export class BotModule {}
