import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { ConversationMessage } from './conversation.schemas';
import { ConversationService } from './conversation.service';
import type { ConversationTurnPayload } from './conversation-turn.schemas';
import { ConversationVectorService } from './conversation-vector.service';
import { MemorySearchService } from './memory-search.service';

/**
 * Result from hybrid conversation retrieval.
 */
export interface ConversationContext {
  /** Merged conversation messages (recent + semantic) */
  messages: ConversationMessage[];
  /** Long-term context from Obsidian notes (if any) */
  longTermContext: string | null;
}

/**
 * Options for context retrieval.
 */
export interface RetrievalOptions {
  /** Number of recent turns to include from Redis (default: 5) */
  recentCount?: number;
  /** Number of semantic matches to include from Qdrant (default: 3) */
  semanticCount?: number;
  /** Minimum score for semantic matches (default: 0.7) */
  semanticThreshold?: number;
}

/**
 * Retrieves conversation context from multiple sources.
 *
 * Implements hybrid retrieval:
 * 1. Recent messages from Redis (recency)
 * 2. Semantically similar conversation turns from Qdrant (30-day semantic)
 * 3. Relevant Obsidian notes (long-term knowledge)
 *
 * Results are merged and deduplicated while preserving temporal order.
 */
@Injectable()
export class ConversationRetrieverService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly conversationService: ConversationService,
    private readonly vectorConversation: ConversationVectorService,
    private readonly memorySearch: MemorySearchService,
  ) {
    this.logger.setContext(ConversationRetrieverService.name);
  }

  /**
   * Retrieve conversation context from all available sources.
   *
   * @param userId User to retrieve context for
   * @param currentMessage The current user message (used for semantic search)
   * @param options Retrieval configuration
   * @returns Merged conversation context
   */
  async retrieve(
    userId: number,
    currentMessage: string,
    options: RetrievalOptions = {},
  ): Promise<ConversationContext> {
    const {
      recentCount = 5,
      semanticCount = 3,
      semanticThreshold = 0.7,
    } = options;

    // Fetch from all sources in parallel
    const [recentHistory, semanticTurns, obsidianContext] = await Promise.all([
      this.getRecentHistory(userId),
      this.getSemanticTurns(
        userId,
        currentMessage,
        semanticCount,
        semanticThreshold,
      ),
      this.getObsidianContext(currentMessage),
    ]);

    // Merge and limit messages
    const messages = this.mergeContexts(
      recentHistory,
      semanticTurns,
      recentCount,
    );

    this.logger.debug(
      {
        userId,
        recentCount: recentHistory.length,
        semanticMatches: semanticTurns.length,
        finalCount: messages.length,
        hasLongTermContext: !!obsidianContext,
      },
      'Retrieved conversation context',
    );

    return { messages, longTermContext: obsidianContext };
  }

  /**
   * Get recent conversation history from Redis.
   */
  private async getRecentHistory(
    userId: number,
  ): Promise<ConversationMessage[]> {
    try {
      return await this.conversationService.getConversation(userId);
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to get recent history');
      return [];
    }
  }

  /**
   * Get semantically similar past turns from Qdrant.
   */
  private async getSemanticTurns(
    userId: number,
    query: string,
    limit: number,
    threshold: number,
  ): Promise<ConversationTurnPayload[]> {
    try {
      const results = await this.vectorConversation.searchSimilar(
        userId,
        query,
        limit * 2, // Fetch extra to account for filtering
      );

      return results.filter(r => r.score >= threshold).slice(0, limit);
    } catch (error) {
      this.logger.warn({ err: error }, 'Conversation vector search failed');
      return [];
    }
  }

  /**
   * Get relevant long-term context from Obsidian notes.
   */
  private async getObsidianContext(query: string): Promise<string | null> {
    try {
      return await this.memorySearch.recallRelevantContext(query);
    } catch (error) {
      this.logger.warn({ err: error }, 'Obsidian context search failed');
      return null;
    }
  }

  /**
   * Merge recent history with semantic matches.
   *
   * Strategy:
   * 1. Keep all recent messages (they maintain tool_use/tool_result integrity)
   * 2. Prepend unique semantic turns that aren't already in recent history
   * 3. Sort by timestamp to maintain temporal order
   */
  private mergeContexts(
    recentHistory: ConversationMessage[],
    semanticTurns: ConversationTurnPayload[],
    maxRecent: number,
  ): ConversationMessage[] {
    // If we have semantic turns, convert them to messages and prepend
    // Only include turns that provide unique context (not in recent history)
    const semanticMessages = this.turnsToMessages(semanticTurns, recentHistory);

    // Recent history takes priority (maintains tool call integrity)
    // Semantic context provides additional relevant background
    const combined = [...semanticMessages, ...recentHistory];

    // Apply the limit to recent history only - semantic is additional context
    // Take last N messages from recent, but keep all semantic prepended
    if (recentHistory.length > maxRecent * 2) {
      // Only truncate if history is very long
      const recentSlice = this.safeTruncate(recentHistory, maxRecent * 2);
      return [...semanticMessages, ...recentSlice];
    }

    return combined;
  }

  /**
   * Convert semantic turns to conversation messages.
   * Filters out turns that are already represented in recent history.
   */
  private turnsToMessages(
    turns: ConversationTurnPayload[],
    recentHistory: ConversationMessage[],
  ): ConversationMessage[] {
    // Extract text from recent history for deduplication
    const recentTexts = new Set(
      recentHistory
        .filter(m => m.role === 'user' && typeof m.content === 'string')
        .map(m => m.content as string),
    );

    const messages: ConversationMessage[] = [];

    for (const turn of turns) {
      // Skip if user message already in recent history
      if (recentTexts.has(turn.userMessage)) {
        continue;
      }

      // Add as simple user/assistant pair
      messages.push(
        { role: 'user', content: turn.userMessage },
        { role: 'assistant', content: turn.assistantResponse },
      );
    }

    return messages;
  }

  /**
   * Safely truncate messages without orphaning tool_result blocks.
   *
   * Ensures that any tool_use block has its corresponding tool_result
   * in the next message. This prevents the API error:
   * "unexpected tool_use_id found in tool_result blocks"
   */
  private safeTruncate(
    messages: ConversationMessage[],
    limit: number,
  ): ConversationMessage[] {
    if (messages.length <= limit) {
      return messages;
    }

    // Start from the end and work backwards
    const result = messages.slice(-limit);

    // Check if first message is a tool result - if so, we need its tool_use
    const firstMsg = result[0];
    if (this.hasToolResult(firstMsg)) {
      // Find the tool_use message and include it
      const toolResultIds = this.getToolResultIds(firstMsg);
      const startIndex = messages.length - limit;

      for (let i = startIndex - 1; i >= 0; i--) {
        const msg = messages[i];
        if (this.hasMatchingToolUse(msg, toolResultIds)) {
          // Include this message and everything after
          return messages.slice(i);
        }
      }

      // If we can't find the matching tool_use, skip the orphaned tool_result
      return result.slice(1);
    }

    return result;
  }

  /**
   * Check if a message contains tool_result blocks.
   */
  private hasToolResult(message: ConversationMessage): boolean {
    if (typeof message.content === 'string') return false;
    return message.content.some(part => part.type === 'tool-result');
  }

  /**
   * Get tool_call IDs from tool_result blocks.
   */
  private getToolResultIds(message: ConversationMessage): Set<string> {
    if (typeof message.content === 'string') return new Set();
    return new Set(
      message.content
        .filter(part => part.type === 'tool-result')
        .map(part => (part as { toolCallId: string }).toolCallId),
    );
  }

  /**
   * Check if a message contains tool_use blocks matching the given IDs.
   */
  private hasMatchingToolUse(
    message: ConversationMessage,
    toolResultIds: Set<string>,
  ): boolean {
    if (typeof message.content === 'string') return false;
    return message.content.some(
      part =>
        part.type === 'tool-call' &&
        toolResultIds.has((part as { toolCallId: string }).toolCallId),
    );
  }
}
