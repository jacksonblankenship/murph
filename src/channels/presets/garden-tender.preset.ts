import { Injectable, OnModuleInit } from '@nestjs/common';
import { ChannelBuilder } from '../builders/channel.builder';
import { ChannelRegistry } from '../channel.registry';
import type { ChannelConfig } from '../channel.types';
import { NullOutput } from '../outputs/null.output';
import { MemoryToolFactory } from '../tools/memory.factory';
import { TimeToolFactory } from '../tools/time.factory';
import { GARDEN_TENDER_PROMPT } from './prompts';

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
    private readonly timeToolFactory: TimeToolFactory,
    private readonly memoryToolFactory: MemoryToolFactory,
    private readonly nullOutput: NullOutput,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.build());
  }

  build(): ChannelConfig {
    return new ChannelBuilder(GARDEN_TENDER_CHANNEL_ID)
      .withSystemPrompt(GARDEN_TENDER_PROMPT)
      .addTools(this.timeToolFactory)
      .addTools(this.memoryToolFactory)
      .addOutput(this.nullOutput)
      .build();
  }
}
