import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PinoLogger } from 'nestjs-pino';
import { Events, type MessageBroadcastEvent } from '../../common/events';
import { BroadcastService } from './broadcast.service';

/**
 * Listens for MESSAGE_BROADCAST events and sends messages via Telegram.
 *
 * This decouples message sending from the modules that trigger broadcasts,
 * eliminating circular dependencies.
 */
@Injectable()
export class BroadcastHandler {
  constructor(
    private readonly logger: PinoLogger,
    private readonly broadcastService: BroadcastService,
  ) {
    this.logger.setContext(BroadcastHandler.name);
  }

  @OnEvent(Events.MESSAGE_BROADCAST)
  async handleBroadcast(event: MessageBroadcastEvent): Promise<void> {
    const { userId, content } = event;

    this.logger.debug({ userId }, 'Broadcasting message');

    const success = await this.broadcastService.sendMessageWithRetry(
      userId,
      content,
    );

    if (!success) {
      this.logger.error({ userId }, 'Failed to broadcast message');
    }
  }
}
