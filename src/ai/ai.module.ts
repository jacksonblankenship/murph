import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExaModule } from '../exa/exa.module';
import { ObsidianModule } from '../obsidian/obsidian.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { SyncModule } from '../sync/sync.module';
import { VectorModule } from '../vector/vector.module';
import { ChatOrchestratorService } from './chat-orchestrator.service';
import { LlmService } from './llm.service';

@Module({
  imports: [
    ConfigModule,
    ExaModule,
    SchedulerModule,
    ObsidianModule,
    VectorModule,
    SyncModule,
  ],
  providers: [LlmService, ChatOrchestratorService],
  exports: [LlmService, ChatOrchestratorService],
})
export class AiModule {}
