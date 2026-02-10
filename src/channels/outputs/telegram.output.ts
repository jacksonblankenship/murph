import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PinoLogger } from 'nestjs-pino';
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
  constructor(
    private readonly logger: PinoLogger,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.logger.setContext(TelegramOutput.name);
  }

  async send(
    userId: number,
    content: string,
    context: OutputContext,
  ): Promise<void> {
    this.logger.debug(
      { userId, channelId: context.channelId },
      'Emitting broadcast',
    );

    const event: MessageBroadcastEvent = {
      userId,
      content,
    };

    this.eventEmitter.emit(Events.MESSAGE_BROADCAST, event);
  }
}
