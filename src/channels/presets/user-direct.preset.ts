import { Injectable, OnModuleInit } from '@nestjs/common';
import { PromptService } from '../../prompts';
import { ChannelBuilder } from '../builders/channel.builder';
import { ChannelRegistry } from '../channel.registry';
import type { ChannelConfig } from '../channel.types';
import { HistoryEnricher } from '../enrichers/history.enricher';
import { TimeEnricher } from '../enrichers/time.enricher';
import { TelegramOutput } from '../outputs/telegram.output';
import { CaptureToolFactory } from '../tools/garden.factory';
import { SchedulingToolFactory } from '../tools/scheduling.factory';
import { TimeToolFactory } from '../tools/time.factory';
import { WebSearchToolFactory } from '../tools/web-search.factory';

/**
 * Channel ID for user-direct interactions.
 */
export const USER_DIRECT_CHANNEL_ID = 'user-direct';

/**
 * Preset for reactive user-initiated conversations.
 *
 * Features:
 * - Full tool access (time, memory, web search, scheduling)
 * - Hybrid context enrichment (conversation history + long-term memory)
 * - Telegram output
 */
@Injectable()
export class UserDirectPreset implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly promptService: PromptService,
    private readonly historyEnricher: HistoryEnricher,
    private readonly timeEnricher: TimeEnricher,
    private readonly timeToolFactory: TimeToolFactory,
    private readonly captureToolFactory: CaptureToolFactory,
    private readonly webSearchToolFactory: WebSearchToolFactory,
    private readonly schedulingToolFactory: SchedulingToolFactory,
    private readonly telegramOutput: TelegramOutput,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.build());
  }

  build(): ChannelConfig {
    return new ChannelBuilder(USER_DIRECT_CHANNEL_ID)
      .withSystemPrompt(this.promptService.get('user-direct'))
      .addEnricher(this.historyEnricher)
      .addEnricher(this.timeEnricher)
      .addTools(this.timeToolFactory)
      .addTools(this.captureToolFactory)
      .addTools(this.webSearchToolFactory)
      .addTools(this.schedulingToolFactory)
      .addOutput(this.telegramOutput)
      .build();
  }
}
