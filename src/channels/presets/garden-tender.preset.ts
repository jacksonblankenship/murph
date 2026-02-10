import { Injectable, OnModuleInit } from '@nestjs/common';
import { PromptService } from '../../prompts';
import { ChannelBuilder } from '../builders/channel.builder';
import { ChannelRegistry } from '../channel.registry';
import type { ChannelConfig } from '../channel.types';
import { TimeEnricher } from '../enrichers/time.enricher';
import { NullOutput } from '../outputs/null.output';
import { GardenToolFactory } from '../tools/garden.factory';
import { TimeToolFactory } from '../tools/time.factory';

/**
 * Channel ID for garden tender background tasks.
 */
export const GARDEN_TENDER_CHANNEL_ID = 'garden-tender';

/**
 * Preset for silent background garden maintenance.
 *
 * Features:
 * - No enrichers (works with specific instructions)
 * - Tools: time, memory (for maintenance operations)
 * - Null output (silent operation)
 */
@Injectable()
export class GardenTenderPreset implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly promptService: PromptService,
    private readonly timeEnricher: TimeEnricher,
    private readonly timeToolFactory: TimeToolFactory,
    private readonly gardenToolFactory: GardenToolFactory,
    private readonly nullOutput: NullOutput,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.build());
  }

  build(): ChannelConfig {
    return new ChannelBuilder(GARDEN_TENDER_CHANNEL_ID)
      .withSystemPrompt(this.promptService.get('garden-curator'))
      .addEnricher(this.timeEnricher)
      .addTools(this.timeToolFactory)
      .addTools(this.gardenToolFactory)
      .addOutput(this.nullOutput)
      .build();
  }
}
