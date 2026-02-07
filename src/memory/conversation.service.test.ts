import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockRedis } from '../test/mocks/redis.mock';
import { ConversationService } from './conversation.service';

describe('ConversationService', () => {
  let service: ConversationService;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    const mockRedisService = {
      getClient: () => mockRedis,
    };
    service = new ConversationService(mockRedisService as never);
  });

  describe('getKey', () => {
    test('stores message with correct key format', async () => {
      const userId = 12345;

      await service.addMessages(userId, [{ role: 'user', content: 'Hello' }]);

      const storedKey = `conversation:user:${userId}`;
      expect(mockRedis.store.has(storedKey)).toBe(true);
    });
  });

  describe('addMessages', () => {
    test('adds messages to empty conversation', async () => {
      const userId = 1;

      await service.addMessages(userId, [{ role: 'user', content: 'Hello' }]);

      const messages = await service.getConversation(userId);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello');
    });

    test('adds multiple messages in one call', async () => {
      const userId = 1;

      await service.addMessages(userId, [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'How are you?' },
      ]);

      const messages = await service.getConversation(userId);
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('Hi');
      expect(messages[1].content).toBe('Hello!');
      expect(messages[2].content).toBe('How are you?');
    });

    test('preserves tool message format with content parts', async () => {
      const userId = 1;

      await service.addMessages(userId, [
        { role: 'user', content: 'What time is it?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_123',
              toolName: 'get_current_time',
              input: { timezone: 'UTC' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_123',
              toolName: 'get_current_time',
              output: '2024-01-15T10:30:00Z',
            },
          ],
        },
        { role: 'assistant', content: "It's 10:30 AM UTC" },
      ]);

      const messages = await service.getConversation(userId);
      expect(messages).toHaveLength(4);
      expect(messages[1].role).toBe('assistant');
      expect(Array.isArray(messages[1].content)).toBe(true);
      expect(messages[2].role).toBe('tool');
    });

    test('enforces 50-message limit by pruning oldest', async () => {
      const userId = 1;

      // Add 55 messages in batches
      for (let i = 0; i < 55; i++) {
        await service.addMessages(userId, [
          { role: 'user', content: `Message ${i}` },
        ]);
      }

      const messages = await service.getConversation(userId);
      expect(messages).toHaveLength(50);
      // First message should be Message 5 (oldest 5 pruned)
      expect(messages[0].content).toBe('Message 5');
      // Last message should be Message 54
      expect(messages[49].content).toBe('Message 54');
    });

    test('applies 24-hour TTL', async () => {
      const userId = 1;

      await service.addMessages(userId, [{ role: 'user', content: 'Hello' }]);

      const key = `conversation:user:${userId}`;
      const ttl = mockRedis.ttls.get(key);
      expect(ttl).toBe(24 * 60 * 60);
    });
  });

  describe('getConversation', () => {
    test('returns empty array for missing conversation', async () => {
      const messages = await service.getConversation(999);
      expect(messages).toEqual([]);
    });

    test('throws for invalid JSON data', async () => {
      const userId = 1;
      const key = `conversation:user:${userId}`;
      mockRedis.store.set(key, 'invalid json{{{');

      await expect(service.getConversation(userId)).rejects.toThrow();
    });

    test('returns empty array for data failing Zod validation', async () => {
      const userId = 1;
      const key = `conversation:user:${userId}`;
      // Missing required content field
      mockRedis.store.set(key, JSON.stringify([{ role: 'user' }]));

      const messages = await service.getConversation(userId);
      expect(messages).toEqual([]);
    });

    test('returns valid messages when data is correct', async () => {
      const userId = 1;
      const key = `conversation:user:${userId}`;
      const validData = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];
      mockRedis.store.set(key, JSON.stringify(validData));

      const messages = await service.getConversation(userId);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });
  });

  describe('clearConversation', () => {
    test('removes conversation from Redis', async () => {
      const userId = 1;
      await service.addMessages(userId, [{ role: 'user', content: 'Hello' }]);

      await service.clearConversation(userId);

      const messages = await service.getConversation(userId);
      expect(messages).toEqual([]);
    });

    test('handles clearing non-existent conversation', async () => {
      await expect(service.clearConversation(999)).resolves.toBeUndefined();
    });
  });
});
