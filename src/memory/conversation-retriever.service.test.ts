import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { ConversationRetrieverService } from './conversation-retriever.service';

describe('ConversationRetrieverService', () => {
  let service: ConversationRetrieverService;
  let mockConversationService: {
    getConversation: ReturnType<typeof mock>;
  };
  let mockVectorConversation: {
    searchSimilar: ReturnType<typeof mock>;
  };
  let mockMemorySearch: {
    recallRelevantContext: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    mockConversationService = {
      getConversation: mock(() => Promise.resolve([])),
    };

    mockVectorConversation = {
      searchSimilar: mock(() => Promise.resolve([])),
    };

    mockMemorySearch = {
      recallRelevantContext: mock(() => Promise.resolve(null)),
    };

    service = new ConversationRetrieverService(
      createMockLogger(),
      mockConversationService as never,
      mockVectorConversation as never,
      mockMemorySearch as never,
    );
  });

  describe('retrieve', () => {
    test('fetches from all sources in parallel', async () => {
      const userId = 123;
      const message = 'Hello';

      await service.retrieve(userId, message);

      expect(mockConversationService.getConversation).toHaveBeenCalledWith(
        userId,
      );
      expect(mockVectorConversation.searchSimilar).toHaveBeenCalledWith(
        userId,
        message,
        expect.any(Number),
      );
      expect(mockMemorySearch.recallRelevantContext).toHaveBeenCalledWith(
        message,
      );
    });

    test('returns recent history when no semantic matches', async () => {
      const recentMessages = [
        { role: 'user' as const, content: 'Hi' },
        { role: 'assistant' as const, content: 'Hello!' },
      ];
      mockConversationService.getConversation.mockImplementation(() =>
        Promise.resolve(recentMessages),
      );

      const result = await service.retrieve(123, 'New message');

      expect(result.messages).toEqual(recentMessages);
      expect(result.longTermContext).toBeNull();
    });

    test('includes long-term context when available', async () => {
      const longTermContext = 'From "My Notes": Some relevant info';
      mockMemorySearch.recallRelevantContext.mockImplementation(() =>
        Promise.resolve(longTermContext),
      );

      const result = await service.retrieve(123, 'Query');

      expect(result.longTermContext).toBe(longTermContext);
    });

    test('merges semantic turns with recent history', async () => {
      const recentMessages = [
        { role: 'user' as const, content: 'Recent question' },
        { role: 'assistant' as const, content: 'Recent answer' },
      ];
      const semanticTurns = [
        {
          userId: 123,
          userMessage: 'Old relevant question',
          assistantResponse: 'Old relevant answer',
          timestamp: 1000,
          score: 0.85,
        },
      ];

      mockConversationService.getConversation.mockImplementation(() =>
        Promise.resolve(recentMessages),
      );
      mockVectorConversation.searchSimilar.mockImplementation(() =>
        Promise.resolve(semanticTurns),
      );

      const result = await service.retrieve(123, 'Query');

      // Should have semantic context prepended + recent history
      expect(result.messages.length).toBeGreaterThan(recentMessages.length);

      // First messages should be the semantic context
      expect(result.messages[0].content).toBe('Old relevant question');
      expect(result.messages[1].content).toBe('Old relevant answer');

      // Then recent history
      expect(result.messages[2].content).toBe('Recent question');
      expect(result.messages[3].content).toBe('Recent answer');
    });

    test('deduplicates semantic turns already in recent history', async () => {
      const recentMessages = [
        { role: 'user' as const, content: 'Same question' },
        { role: 'assistant' as const, content: 'Answer' },
      ];
      const semanticTurns = [
        {
          userId: 123,
          userMessage: 'Same question', // Duplicate
          assistantResponse: 'Same answer',
          timestamp: 1000,
          score: 0.9,
        },
      ];

      mockConversationService.getConversation.mockImplementation(() =>
        Promise.resolve(recentMessages),
      );
      mockVectorConversation.searchSimilar.mockImplementation(() =>
        Promise.resolve(semanticTurns),
      );

      const result = await service.retrieve(123, 'Query');

      // Semantic turn should be deduplicated
      expect(result.messages).toHaveLength(2);
    });

    test('filters semantic turns by threshold', async () => {
      const semanticTurns = [
        { userMessage: 'High score', assistantResponse: 'Good', score: 0.9 },
        { userMessage: 'Low score', assistantResponse: 'Bad', score: 0.5 },
      ];

      mockVectorConversation.searchSimilar.mockImplementation(() =>
        Promise.resolve(semanticTurns),
      );

      const result = await service.retrieve(123, 'Query', {
        semanticThreshold: 0.7,
      });

      // Only high-score turn should be included
      const hasLowScore = result.messages.some(
        m => m.content === 'Low score' || m.content === 'Bad',
      );
      expect(hasLowScore).toBe(false);
    });

    test('gracefully handles conversation service failure', async () => {
      mockConversationService.getConversation.mockImplementation(() =>
        Promise.reject(new Error('Redis error')),
      );

      const result = await service.retrieve(123, 'Query');

      expect(result.messages).toEqual([]);
    });

    test('gracefully handles vector search failure', async () => {
      const recentMessages = [{ role: 'user' as const, content: 'Hi' }];
      mockConversationService.getConversation.mockImplementation(() =>
        Promise.resolve(recentMessages),
      );
      mockVectorConversation.searchSimilar.mockImplementation(() =>
        Promise.reject(new Error('Qdrant error')),
      );

      const result = await service.retrieve(123, 'Query');

      // Should still return recent history
      expect(result.messages).toEqual(recentMessages);
    });

    test('gracefully handles memory search failure', async () => {
      mockMemorySearch.recallRelevantContext.mockImplementation(() =>
        Promise.reject(new Error('Memory error')),
      );

      const result = await service.retrieve(123, 'Query');

      expect(result.longTermContext).toBeNull();
    });

    test('respects custom retrieval options', async () => {
      await service.retrieve(123, 'Query', {
        recentCount: 10,
        semanticCount: 5,
        semanticThreshold: 0.8,
      });

      // Verify vector search was called with higher limit (2x for filtering)
      expect(mockVectorConversation.searchSimilar).toHaveBeenCalledWith(
        123,
        'Query',
        10, // semanticCount * 2 = 5 * 2 = 10
      );
    });
  });
});
