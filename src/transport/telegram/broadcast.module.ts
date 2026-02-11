import { Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { BroadcastHandler } from './broadcast.handler';
import { BroadcastService } from './broadcast.service';

/**
 * Outbound message broadcasting via Telegram.
 *
 * Provides `BroadcastService` for sending messages and `BroadcastHandler`
 * for reacting to MESSAGE_BROADCAST events. Extracted from TelegramModule
 * to break the circular dependency between TelegramModule and InboundModule.
 */
@Module({
  imports: [TelegrafModule],
  providers: [BroadcastService, BroadcastHandler],
  exports: [BroadcastService],
})
export class BroadcastModule {}
