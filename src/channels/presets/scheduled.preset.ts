import { Injectable, OnModuleInit } from '@nestjs/common';
import { PromptService } from '../../prompts';
import { ChannelBuilder } from '../builders/channel.builder';
import { ChannelRegistry } from '../channel.registry';
import type { ChannelConfig } from '../channel.types';
import { HistoryEnricher } from '../enrichers/history.enricher';
import { TimeEnricher } from '../enrichers/time.enricher';
import { TelegramOutput } from '../outputs/telegram.output';
import { SeedToolFactory } from '../tools/seed.factory';
import { TimeToolFactory } from '../tools/time.factory';
import { WebSearchToolFactory } from '../tools/web-search.factory';
import { ProactiveTransformer } from '../transformers/proactive.transformer';

/**
 * Channel ID for scheduled proactive tasks.
 */
export const SCHEDULED_PROACTIVE_CHANNEL_ID = 'scheduled-proactive';

/**
 * Preset for proactive scheduled task execution.
 *
 * Features:
 * - Proactive transformer (reframes message for outreach)
 * - Hybrid context enrichment (conversation history + long-term memory)
 * - Tools: time, seed, web search (no scheduling - tasks can't schedule more tasks)
 * - Telegram output
 */
@Injectable()
export class ScheduledPreset implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly promptService: PromptService,
    private readonly proactiveTransformer: ProactiveTransformer,
    private readonly historyEnricher: HistoryEnricher,
    private readonly timeEnricher: TimeEnricher,
    private readonly timeToolFactory: TimeToolFactory,
    private readonly seedToolFactory: SeedToolFactory,
    private readonly webSearchToolFactory: WebSearchToolFactory,
    private readonly telegramOutput: TelegramOutput,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.build());
  }

  build(): ChannelConfig {
    return new ChannelBuilder(SCHEDULED_PROACTIVE_CHANNEL_ID)
      .withSystemPrompt(this.promptService.get('scheduled-proactive'))
      .addTransformer(this.proactiveTransformer)
      .addEnricher(this.historyEnricher)
      .addEnricher(this.timeEnricher)
      .addTools(this.timeToolFactory)
      .addTools(this.seedToolFactory)
      .addTools(this.webSearchToolFactory)
      .addOutput(this.telegramOutput)
      .build();
  }
}
