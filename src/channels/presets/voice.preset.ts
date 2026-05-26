import { Injectable, OnModuleInit } from '@nestjs/common';
import { PromptService } from '../../prompts';
import { ChannelBuilder } from '../builders/channel.builder';
import { ChannelRegistry } from '../channel.registry';
import type { ChannelConfig } from '../channel.types';
import { HistoryEnricher } from '../enrichers/history.enricher';
import { TimeEnricher } from '../enrichers/time.enricher';
import { NullOutput } from '../outputs/null.output';
import { ConversationalToolBundle } from '../tools/conversational-tool-bundle';
import { HangUpToolFactory } from '../tools/hang-up.factory';

/**
 * Channel ID for voice phone calls.
 */
export const VOICE_CHANNEL_ID = 'voice';

/**
 * Preset for voice phone call conversations via Twilio ConversationRelay.
 *
 * Features:
 * - History + time enrichment for conversational context
 * - Shared conversational tools (time, seed, web search, scheduling)
 * - Voice-only tool: hang_up
 * - Null output (voice gateway delivers responses via WebSocket)
 */
@Injectable()
export class VoicePreset implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly promptService: PromptService,
    private readonly historyEnricher: HistoryEnricher,
    private readonly timeEnricher: TimeEnricher,
    private readonly conversationalTools: ConversationalToolBundle,
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
      .addToolBundle(this.conversationalTools)
      .addTools(this.hangUpToolFactory)
      .addOutput(this.nullOutput)
      .build();
  }
}
