import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from '../ai/ai.module';
import { ExaModule } from '../exa/exa.module';
import { MemoryModule } from '../memory/memory.module';
import { ObsidianModule } from '../obsidian/obsidian.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { SyncModule } from '../sync/sync.module';
import { UserProfileModule } from '../user-profile';
import { VectorModule } from '../vector/vector.module';
import { ChannelRegistry } from './channel.registry';
import { ChannelOrchestratorService } from './channel-orchestrator.service';

// Enrichers
import { HistoryEnricher } from './enrichers/history.enricher';
import { TimeEnricher } from './enrichers/time.enricher';

// Outputs
import { NullOutput } from './outputs/null.output';
import { TelegramOutput } from './outputs/telegram.output';
// Presets
import { GardenTenderPreset } from './presets/garden-tender.preset';
import { ScheduledPreset } from './presets/scheduled.preset';
import { UserDirectPreset } from './presets/user-direct.preset';
// Tool Factories
import { CaptureToolFactory, GardenToolFactory } from './tools/garden.factory';
import { SchedulingToolFactory } from './tools/scheduling.factory';
import { TimeToolFactory } from './tools/time.factory';
import { WebSearchToolFactory } from './tools/web-search.factory';
// Transformers
import { ProactiveTransformer } from './transformers/proactive.transformer';

/**
 * Module providing the channel-based LLM orchestration system.
 *
 * Exports:
 * - ChannelOrchestratorService: Execute messages through channel pipelines
 * - ChannelRegistry: Access to registered channels
 *
 * Channels are registered automatically by presets during module initialization.
 */
@Module({
  imports: [
    ConfigModule,
    AiModule,
    MemoryModule,
    ExaModule,
    SchedulerModule,
    ObsidianModule,
    UserProfileModule,
    VectorModule,
    SyncModule,
  ],
  providers: [
    // Core
    ChannelRegistry,
    ChannelOrchestratorService,

    // Enrichers
    HistoryEnricher,
    TimeEnricher,

    // Outputs
    TelegramOutput,
    NullOutput,

    // Transformers
    ProactiveTransformer,

    // Tool Factories
    TimeToolFactory,
    GardenToolFactory,
    CaptureToolFactory,
    WebSearchToolFactory,
    SchedulingToolFactory,

    // Presets (register channels on init)
    UserDirectPreset,
    ScheduledPreset,
    GardenTenderPreset,
  ],
  exports: [ChannelOrchestratorService, ChannelRegistry],
})
export class ChannelModule {}
