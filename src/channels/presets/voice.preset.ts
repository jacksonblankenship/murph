import { Injectable, OnModuleInit } from '@nestjs/common';
import { PromptService } from '../../prompts';
import { ChannelBuilder } from '../builders/channel.builder';
import { ChannelRegistry } from '../channel.registry';
import type { ChannelConfig } from '../channel.types';
import { HistoryEnricher } from '../enrichers/history.enricher';
import { TimeEnricher } from '../enrichers/time.enricher';
import { NullOutput } from '../outputs/null.output';
import { HangUpToolFactory } from '../tools/hang-up.factory';
import { SeedToolFactory } from '../tools/seed.factory';
import { TimeToolFactory } from '../tools/time.factory';
import { WebSearchToolFactory } from '../tools/web-search.factory';

/**
 * Channel ID for voice phone calls.
 */
export const VOICE_CHANNEL_ID = 'voice';

/**
 * Preset for voice phone call conversations via Twilio ConversationRelay.
 *
 * Features:
 * - History + time enrichment for conversational context
 * - Tools: time, seed, web search, hang_up
 * - Null output (voice gateway delivers responses via WebSocket)
 */
@Injectable()
export class VoicePreset implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly promptService: PromptService,
    private readonly historyEnricher: HistoryEnricher,
    private readonly timeEnricher: TimeEnricher,
    private readonly timeToolFactory: TimeToolFactory,
    private readonly seedToolFactory: SeedToolFactory,
    private readonly webSearchToolFactory: WebSearchToolFactory,
    private readonly hangUpToolFactory: HangUpToolFactory,
    private readonly nullOutput: NullOutput,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.build());
  }

  /**
   * Builds the voice channel configuration.
   */
  build(): ChannelConfig {
    return new ChannelBuilder(VOICE_CHANNEL_ID)
      .withSystemPrompt(this.promptService.get('voice'))
      .addEnricher(this.historyEnricher)
      .addEnricher(this.timeEnricher)
      .addTools(this.timeToolFactory)
      .addTools(this.seedToolFactory)
      .addTools(this.webSearchToolFactory)
      .addTools(this.hangUpToolFactory)
      .addOutput(this.nullOutput)
      .build();
  }
}
