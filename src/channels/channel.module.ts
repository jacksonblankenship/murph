import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentModule } from '../agents/agent.module';
import { AiModule } from '../ai/ai.module';
import { ExaModule } from '../exa/exa.module';
import { MemoryModule } from '../memory/memory.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { SyncModule } from '../sync/sync.module';
import { UserProfileModule } from '../user-profile';
import { VaultModule } from '../vault';
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
import { VoicePreset } from './presets/voice.preset';
// Tool Factories
import { GardenToolFactory } from './tools/garden.factory';
import { HangUpToolFactory } from './tools/hang-up.factory';
import { SchedulingToolFactory } from './tools/scheduling.factory';
import { SeedToolFactory } from './tools/seed.factory';
import { TimeToolFactory } from './tools/time.factory';
import { VoiceCallToolFactory } from './tools/voice-call.factory';
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
    AgentModule,
    MemoryModule,
    ExaModule,
    SchedulerModule,
    VaultModule,
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
    HangUpToolFactory,
    SeedToolFactory,
    VoiceCallToolFactory,
    WebSearchToolFactory,
    SchedulingToolFactory,

    // Presets (register channels on init)
    UserDirectPreset,
    ScheduledPreset,
    GardenTenderPreset,
    VoicePreset,
  ],
  exports: [ChannelOrchestratorService, ChannelRegistry],
})
export class ChannelModule {}
