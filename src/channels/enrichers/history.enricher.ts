import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ConversationRetrieverService } from '../../memory/conversation-retriever.service';
import type {
  ContextEnricher,
  EnrichmentRequest,
  EnrichmentResult,
} from '../channel.types';

/**
 * Enriches context with conversation history and long-term memory.
 *
 * Uses hybrid retrieval:
 * - Recent messages from Redis (maintains tool_use/tool_result integrity)
 * - Semantically similar past conversations from Qdrant
 * - Relevant Obsidian notes for long-term knowledge
 */
@Injectable()
export class HistoryEnricher implements ContextEnricher {
  constructor(
    private readonly logger: PinoLogger,
    private readonly conversationRetriever: ConversationRetrieverService,
  ) {
    this.logger.setContext(HistoryEnricher.name);
  }

  async enrich(request: EnrichmentRequest): Promise<EnrichmentResult> {
    try {
      const { messages, longTermContext } =
        await this.conversationRetriever.retrieve(
          request.userId,
          request.message,
          {
            recentCount: 5,
            semanticCount: 3,
            semanticThreshold: 0.7,
          },
        );

      this.logger.debug(
        {
          messageCount: messages.length,
          userId: request.userId,
          hasLongTermContext: !!longTermContext,
        },
        'Retrieved hybrid context',
      );

      return {
        conversationHistory: messages,
        contextAdditions: longTermContext
          ? `[Long-term memory from your notes:]\n${longTermContext}`
          : undefined,
      };
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Failed to enrich with conversation context',
      );
      return {
        conversationHistory: [],
      };
    }
  }
}
