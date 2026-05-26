import { Injectable, OnModuleInit } from '@nestjs/common';
import { PromptService } from '../../prompts';
import { ChannelBuilder } from '../builders/channel.builder';
import { ChannelRegistry } from '../channel.registry';
import type { ChannelConfig } from '../channel.types';
import { HistoryEnricher } from '../enrichers/history.enricher';
import { TimeEnricher } from '../enrichers/time.enricher';
import { TelegramOutput } from '../outputs/telegram.output';
import { ConversationalToolBundle } from '../tools/conversational-tool-bundle';
import { VoiceCallToolFactory } from '../tools/voice-call.factory';

/**
 * Channel ID for user-direct interactions.
 */
export const USER_DIRECT_CHANNEL_ID = 'user-direct';

/**
 * Preset for reactive user-initiated conversations.
 *
 * Features:
 * - Shared conversational tools (time, seed, web search, scheduling)
 * - Telegram-only tool: voice_call (initiate an outbound call)
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
    private readonly conversationalTools: ConversationalToolBundle,
    private readonly voiceCallToolFactory: VoiceCallToolFactory,
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
      .addToolBundle(this.conversationalTools)
      .addTools(this.voiceCallToolFactory)
      .addOutput(this.telegramOutput)
      .build();
  }
}
