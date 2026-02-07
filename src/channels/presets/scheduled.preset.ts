import { Injectable, OnModuleInit } from '@nestjs/common';
import { ChannelBuilder } from '../builders/channel.builder';
import { ChannelRegistry } from '../channel.registry';
import type { ChannelConfig } from '../channel.types';
import { HistoryEnricher } from '../enrichers/history.enricher';
import { MemoryEnricher } from '../enrichers/memory.enricher';
import { TelegramOutput } from '../outputs/telegram.output';
import { MemoryToolFactory } from '../tools/memory.factory';
import { TimeToolFactory } from '../tools/time.factory';
import { WebSearchToolFactory } from '../tools/web-search.factory';
import { ProactiveTransformer } from '../transformers/proactive.transformer';
import { SCHEDULED_PROACTIVE_PROMPT } from './prompts';

/**
 * Channel ID for scheduled proactive tasks.
 */
export const SCHEDULED_PROACTIVE_CHANNEL_ID = 'scheduled-proactive';

/**
 * Preset for proactive scheduled task execution.
 *
 * Features:
 * - Proactive transformer (reframes message for outreach)
 * - Memory context enrichment
 * - Conversation history
 * - Tools: time, memory, web search (no scheduling - tasks can't schedule more tasks)
 * - Telegram output
 */
@Injectable()
export class ScheduledPreset implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly proactiveTransformer: ProactiveTransformer,
    private readonly memoryEnricher: MemoryEnricher,
    private readonly historyEnricher: HistoryEnricher,
    private readonly timeToolFactory: TimeToolFactory,
    private readonly memoryToolFactory: MemoryToolFactory,
    private readonly webSearchToolFactory: WebSearchToolFactory,
    private readonly telegramOutput: TelegramOutput,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.build());
  }

  build(): ChannelConfig {
    return new ChannelBuilder(SCHEDULED_PROACTIVE_CHANNEL_ID)
      .withSystemPrompt(SCHEDULED_PROACTIVE_PROMPT)
      .addTransformer(this.proactiveTransformer)
      .addEnricher(this.memoryEnricher)
      .addEnricher(this.historyEnricher)
      .addTools(this.timeToolFactory)
      .addTools(this.memoryToolFactory)
      .addTools(this.webSearchToolFactory)
      .addOutput(this.telegramOutput)
      .build();
  }
}
