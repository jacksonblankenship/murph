import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { EmbeddingService } from '../vector/embedding.service';
import { QdrantService } from '../vector/qdrant.service';
import type { ConversationTurnPayload } from './conversation-turn.schemas';

/**
 * Manages conversation turns in vector storage for semantic retrieval.
 *
 * Stores conversation turns (user message + assistant response) in Qdrant,
 * enabling semantic search across past conversations. Only text content
 * is embedded - tool calls are tracked as metadata but not vectorized.
 */
@Injectable()
export class ConversationVectorService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly qdrantService: QdrantService,
    private readonly embeddingService: EmbeddingService,
  ) {
    this.logger.setContext(ConversationVectorService.name);
  }

  /**
   * Store a conversation turn for semantic retrieval.
   * Generates embedding from user query + assistant response text.
   *
   * @param turn Turn data (excluding id, which is generated)
   */
  async storeTurn(turn: ConversationTurnPayload): Promise<void> {
    const textToEmbed = this.buildEmbeddingText(
      turn.userMessage,
      turn.assistantResponse,
    );

    const embedding = await this.embeddingService.embed(textToEmbed);
    const id = Bun.randomUUIDv7();

    await this.qdrantService.upsertConversationTurn(id, embedding, turn);

    this.logger.debug(
      { userId: turn.userId, toolsUsed: turn.toolsUsed },
      'Stored conversation turn',
    );
  }

  /**
   * Search for semantically similar past conversations.
   *
   * @param userId User to search within
   * @param query Current message to find similar context for
   * @param limit Maximum results to return
   * @returns Similar conversation turns ordered by relevance
   */
  async searchSimilar(
    userId: number,
    query: string,
    limit = 5,
  ): Promise<Array<ConversationTurnPayload & { score: number }>> {
    const embedding = await this.embeddingService.embed(query);
    return this.qdrantService.searchConversationTurns(embedding, userId, limit);
  }

  /**
   * Delete conversation turns older than the specified timestamp.
   * Used for enforcing retention policies.
   *
   * @param userId User to clean up
   * @param beforeTimestamp Unix timestamp in milliseconds
   */
  async deleteOldTurns(userId: number, beforeTimestamp: number): Promise<void> {
    await this.qdrantService.deleteOldConversationTurns(
      userId,
      beforeTimestamp,
    );
  }

  /**
   * Build the text content used for embedding.
   * Combines user message and assistant response in a consistent format.
   */
  private buildEmbeddingText(
    userMessage: string,
    assistantResponse: string,
  ): string {
    return `User: ${userMessage}\n\nAssistant: ${assistantResponse}`;
  }
}
