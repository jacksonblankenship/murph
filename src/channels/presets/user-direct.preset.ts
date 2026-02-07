import { Injectable, OnModuleInit } from '@nestjs/common';
import { ChannelBuilder } from '../builders/channel.builder';
import { ChannelRegistry } from '../channel.registry';
import type { ChannelConfig } from '../channel.types';
import { HistoryEnricher } from '../enrichers/history.enricher';
import { MemoryEnricher } from '../enrichers/memory.enricher';
import { TelegramOutput } from '../outputs/telegram.output';
import { MemoryToolFactory } from '../tools/memory.factory';
import { SchedulingToolFactory } from '../tools/scheduling.factory';
import { TimeToolFactory } from '../tools/time.factory';
import { WebSearchToolFactory } from '../tools/web-search.factory';
import { USER_DIRECT_PROMPT } from './prompts';

/**
 * Channel ID for user-direct interactions.
 */
export const USER_DIRECT_CHANNEL_ID = 'user-direct';

/**
 * Preset for reactive user-initiated conversations.
 *
 * Features:
 * - Full tool access (time, memory, web search, scheduling)
 * - Memory context enrichment
 * - Conversation history
 * - Telegram output
 */
@Injectable()
export class UserDirectPreset implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly memoryEnricher: MemoryEnricher,
    private readonly historyEnricher: HistoryEnricher,
    private readonly timeToolFactory: TimeToolFactory,
    private readonly memoryToolFactory: MemoryToolFactory,
    private readonly webSearchToolFactory: WebSearchToolFactory,
    private readonly schedulingToolFactory: SchedulingToolFactory,
    private readonly telegramOutput: TelegramOutput,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.build());
  }

  build(): ChannelConfig {
    return new ChannelBuilder(USER_DIRECT_CHANNEL_ID)
      .withSystemPrompt(USER_DIRECT_PROMPT)
      .addEnricher(this.memoryEnricher)
      .addEnricher(this.historyEnricher)
      .addTools(this.timeToolFactory)
      .addTools(this.memoryToolFactory)
      .addTools(this.webSearchToolFactory)
      .addTools(this.schedulingToolFactory)
      .addOutput(this.telegramOutput)
      .build();
  }
}
