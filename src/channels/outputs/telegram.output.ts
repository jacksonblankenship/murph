import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Events, type MessageBroadcastEvent } from '../../common/events';
import type { OutputContext, OutputHandler } from '../channel.types';

/**
 * Sends responses to users via Telegram.
 *
 * Emits MESSAGE_BROADCAST events which are handled by TelegramModule's
 * BroadcastHandler to actually send the message.
 */
@Injectable()
export class TelegramOutput implements OutputHandler {
  private readonly logger = new Logger(TelegramOutput.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  async send(
    userId: number,
    content: string,
    context: OutputContext,
  ): Promise<void> {
    this.logger.debug(
      `Emitting broadcast for user ${userId} from channel ${context.channelId}`,
    );

    const event: MessageBroadcastEvent = {
      userId,
      content,
    };

    this.eventEmitter.emit(Events.MESSAGE_BROADCAST, event);
  }
}
