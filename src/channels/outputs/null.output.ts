import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { OutputContext, OutputHandler } from '../channel.types';

/**
 * Silent output handler that discards responses.
 *
 * Used for background channels like garden-tender that perform
 * maintenance tasks without user-visible output.
 */
@Injectable()
export class NullOutput implements OutputHandler {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(NullOutput.name);
  }

  async send(
    userId: number,
    content: string,
    context: OutputContext,
  ): Promise<void> {
    this.logger.debug(
      { userId, channelId: context.channelId, contentLength: content.length },
      'Discarding output',
    );
    // Intentionally do nothing
  }
}
