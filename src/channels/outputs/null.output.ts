import { Injectable, Logger } from '@nestjs/common';
import type { OutputContext, OutputHandler } from '../channel.types';

/**
 * Silent output handler that discards responses.
 *
 * Used for background channels like garden-tender that perform
 * maintenance tasks without user-visible output.
 */
@Injectable()
export class NullOutput implements OutputHandler {
  private readonly logger = new Logger(NullOutput.name);

  async send(
    userId: number,
    content: string,
    context: OutputContext,
  ): Promise<void> {
    this.logger.debug(
      `Discarding output for user ${userId} from channel ${context.channelId} (${content.length} chars)`,
    );
    // Intentionally do nothing
  }
}
