import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AiModule } from '../ai/ai.module';
import { AgentDispatcher } from '../dispatcher';
import { SyncModule } from '../sync/sync.module';
import { VaultModule } from '../vault';
import { VectorModule } from '../vector/vector.module';
import { GardenSeederProcessor } from './garden-seeder.processor';

/**
 * Module for autonomous sub-agents that run in the background.
 *
 * Each sub-agent has its own BullMQ queue, processor, and LLM call.
 * Adding a new sub-agent means: 1 queue + 1 processor + 1 tool factory + 1 prompt template.
 *
 * Queues are registered with `AgentDispatcher` on init so tool factories
 * can dispatch jobs without direct queue references.
 *
 * Current agents:
 * - **Garden Seeder**: Receives signals from Murph's `note_something` tool and
 *   decides whether to plant, update, or skip.
 */
@Module({
  imports: [
    AiModule,
    VaultModule,
    VectorModule,
    SyncModule,
    BullModule.registerQueue({
      name: 'garden-seeder',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: { count: 50 },
      },
    }),
    BullBoardModule.forFeature({
      name: 'garden-seeder',
      adapter: BullMQAdapter,
    }),
  ],
  providers: [GardenSeederProcessor],
  exports: [GardenSeederProcessor],
})
export class AgentModule implements OnModuleInit {
  constructor(
    @InjectQueue('garden-seeder')
    private readonly gardenSeederQueue: Queue,
    private readonly dispatcher: AgentDispatcher,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerQueue('garden-seeder', this.gardenSeederQueue);
  }
}
