import { Injectable, Logger } from '@nestjs/common';
import { ConversationService } from '../../memory/conversation.service';
import type {
  ContextEnricher,
  EnrichmentRequest,
  EnrichmentResult,
} from '../channel.types';

/**
 * Enriches context with conversation history.
 *
 * Retrieves recent conversation messages from Redis
 * to maintain conversational continuity.
 */
@Injectable()
export class HistoryEnricher implements ContextEnricher {
  private readonly logger = new Logger(HistoryEnricher.name);

  constructor(private readonly conversationService: ConversationService) {}

  async enrich(request: EnrichmentRequest): Promise<EnrichmentResult> {
    try {
      const history = await this.conversationService.getConversation(
        request.userId,
      );

      this.logger.debug(
        `Retrieved ${history.length} history messages for user ${request.userId}`,
      );

      return {
        conversationHistory: history,
      };
    } catch (error) {
      this.logger.warn(
        'Failed to enrich with conversation history:',
        error.message,
      );
      return {
        conversationHistory: [],
      };
    }
  }
}
