import { Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { MemoryModule } from '../../memory/memory.module';
import { SyncModule } from '../../sync/sync.module';
import { TranscriptionModule } from '../../transcription';
import { UserProfileModule } from '../../user-profile';
import { BroadcastHandler } from './broadcast.handler';
import { BroadcastService } from './broadcast.service';
import { TelegramUpdate } from './telegram.update';

/**
 * Handles Telegram bot interactions.
 *
 * Communication with other modules via EventEmitter:
 * - Emits USER_MESSAGE when a message arrives (text or transcribed voice)
 * - Listens for MESSAGE_BROADCAST to send responses
 */
@Module({
  imports: [
    TelegrafModule,
    MemoryModule,
    SyncModule,
    TranscriptionModule,
    UserProfileModule,
  ],
  providers: [TelegramUpdate, BroadcastService, BroadcastHandler],
  exports: [BroadcastService],
})
export class TelegramModule {}
