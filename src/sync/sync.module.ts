import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ObsidianModule } from '../obsidian/obsidian.module';
import { VectorModule } from '../vector/vector.module';
import { GardenTenderProcessor } from './garden-tender.processor';
import { IndexSyncProcessor } from './index-sync.processor';

@Module({
  imports: [
    ConfigModule,
    ObsidianModule,
    VectorModule,
    BullModule.registerQueue(
      {
        name: 'index-sync',
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: true,
          removeOnFail: { count: 50 },
        },
      },
      {
        name: 'garden-tending',
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: true,
          removeOnFail: { count: 10 },
        },
      },
    ),
    BullBoardModule.forFeature(
      { name: 'index-sync', adapter: BullMQAdapter },
      { name: 'garden-tending', adapter: BullMQAdapter },
    ),
  ],
  providers: [IndexSyncProcessor, GardenTenderProcessor],
  exports: [IndexSyncProcessor],
})
export class SyncModule {}
