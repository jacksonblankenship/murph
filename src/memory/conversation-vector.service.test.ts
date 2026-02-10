import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { ConversationVectorService } from './conversation-vector.service';

describe('ConversationVectorService', () => {
  let service: ConversationVectorService;
  let mockQdrantService: {
    upsertConversationTurn: ReturnType<typeof mock>;
    searchConversationTurns: ReturnType<typeof mock>;
    deleteOldConversationTurns: ReturnType<typeof mock>;
  };
  let mockEmbeddingService: {
    embed: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    mockQdrantService = {
      upsertConversationTurn: mock(() => Promise.resolve()),
      searchConversationTurns: mock(() => Promise.resolve([])),
      deleteOldConversationTurns: mock(() => Promise.resolve()),
    };

    mockEmbeddingService = {
      embed: mock(() => Promise.resolve(new Array(1536).fill(0.1))),
    };

    service = new ConversationVectorService(
      createMockLogger(),
      mockQdrantService as never,
      mockEmbeddingService as never,
    );
  });

  describe('storeTurn', () => {
    test('generates embedding and stores turn', async () => {
      const turn = {
        userId: 123,
        userMessage: 'What is the weather?',
        assistantResponse: 'It looks sunny today!',
        timestamp: Date.now(),
      };

      await service.storeTurn(turn);

      // Verify embedding was generated with correct text format
      expect(mockEmbeddingService.embed).toHaveBeenCalledTimes(1);
      const embedCall = mockEmbeddingService.embed.mock.calls[0][0];
      expect(embedCall).toContain('User: What is the weather?');
      expect(embedCall).toContain('Assistant: It looks sunny today!');

      // Verify upsert was called with correct params
      expect(mockQdrantService.upsertConversationTurn).toHaveBeenCalledTimes(1);
      const upsertArgs = mockQdrantService.upsertConversationTurn.mock.calls[0];
      expect(upsertArgs[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      ); // UUIDv7
      expect(upsertArgs[1]).toHaveLength(1536); // embedding
      expect(upsertArgs[2]).toEqual(turn);
    });

    test('includes toolsUsed when provided', async () => {
      const turn = {
        userId: 123,
        userMessage: 'Search for weather',
        assistantResponse: 'Here is the weather info',
        timestamp: Date.now(),
        toolsUsed: ['web_search', 'recall'],
      };

      await service.storeTurn(turn);

      const storedPayload =
        mockQdrantService.upsertConversationTurn.mock.calls[0][2];
      expect(storedPayload.toolsUsed).toEqual(['web_search', 'recall']);
    });
  });

  describe('searchSimilar', () => {
    test('generates embedding and searches with user filter', async () => {
      const mockResults = [
        {
          userId: 123,
          userMessage: 'Previous question',
          assistantResponse: 'Previous answer',
          timestamp: 1000,
          score: 0.9,
        },
      ];
      mockQdrantService.searchConversationTurns.mockImplementation(() =>
        Promise.resolve(mockResults),
      );

      const results = await service.searchSimilar(123, 'Current question', 5);

      expect(mockEmbeddingService.embed).toHaveBeenCalledWith(
        'Current question',
      );
      expect(mockQdrantService.searchConversationTurns).toHaveBeenCalledWith(
        expect.any(Array),
        123,
        5,
      );
      expect(results).toEqual(mockResults);
    });

    test('returns empty array when no matches', async () => {
      mockQdrantService.searchConversationTurns.mockImplementation(() =>
        Promise.resolve([]),
      );

      const results = await service.searchSimilar(123, 'Query', 5);

      expect(results).toEqual([]);
    });
  });

  describe('deleteOldTurns', () => {
    test('delegates to qdrant service', async () => {
      const userId = 123;
      const beforeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;

      await service.deleteOldTurns(userId, beforeTimestamp);

      expect(mockQdrantService.deleteOldConversationTurns).toHaveBeenCalledWith(
        userId,
        beforeTimestamp,
      );
    });
  });
});
