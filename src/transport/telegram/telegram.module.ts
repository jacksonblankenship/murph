import { Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { InboundModule } from '../../inbound';
import { MemoryModule } from '../../memory/memory.module';
import { SyncModule } from '../../sync/sync.module';
import { TranscriptionModule } from '../../transcription';
import { UserProfileModule } from '../../user-profile';
import { TelegramUpdate } from './telegram.update';

/**
 * Handles Telegram bot interactions.
 *
 * - Enqueues inbound messages via InboundService for debounced processing
 * - Outbound broadcasting lives in BroadcastModule (no circular dependency)
 */
@Module({
  imports: [
    TelegrafModule,
    MemoryModule,
    SyncModule,
    TranscriptionModule,
    UserProfileModule,
    InboundModule,
  ],
  providers: [TelegramUpdate],
})
export class TelegramModule {}
