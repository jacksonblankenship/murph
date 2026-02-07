import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
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
  private readonly logger = new Logger(BroadcastHandler.name);

  constructor(private readonly broadcastService: BroadcastService) {}

  @OnEvent(Events.MESSAGE_BROADCAST)
  async handleBroadcast(event: MessageBroadcastEvent): Promise<void> {
    const { userId, content } = event;

    this.logger.debug(`Broadcasting message to user ${userId}`);

    const success = await this.broadcastService.sendMessageWithRetry(
      userId,
      content,
    );

    if (!success) {
      this.logger.error(`Failed to broadcast message to user ${userId}`);
    }
  }
}
