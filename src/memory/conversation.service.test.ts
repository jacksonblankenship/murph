import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
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
    service = new ConversationService(
      createMockLogger(),
      mockRedisService as never,
    );
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

    test('enforces message limit with safe truncation', async () => {
      const userId = 1;

      // Add 105 simple messages in batches
      for (let i = 0; i < 105; i++) {
        await service.addMessages(userId, [
          { role: 'user', content: `Message ${i}` },
        ]);
      }

      const messages = await service.getConversation(userId);
      expect(messages.length).toBeLessThanOrEqual(105);
      expect(messages.length).toBeGreaterThanOrEqual(100);
    });

    test('applies 24-hour TTL', async () => {
      const userId = 1;

      await service.addMessages(userId, [{ role: 'user', content: 'Hello' }]);

      const key = `conversation:user:${userId}`;
      const ttl = mockRedis.ttls.get(key);
      expect(ttl).toBe(24 * 60 * 60);
    });
  });

  describe('safeTruncate', () => {
    test('preserves tool_use/tool_result pairs during truncation', async () => {
      const userId = 1;

      // First add many messages to fill the limit
      for (let i = 0; i < 95; i++) {
        await service.addMessages(userId, [
          { role: 'user', content: `Filler ${i}` },
        ]);
      }

      // Then add a tool call interaction
      await service.addMessages(userId, [
        { role: 'user', content: 'What time is it?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_xyz',
              toolName: 'get_time',
              input: {},
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_xyz',
              toolName: 'get_time',
              output: '10:00 AM',
            },
          ],
        },
        { role: 'assistant', content: "It's 10:00 AM" },
      ]);

      // Add more messages to trigger truncation
      for (let i = 0; i < 10; i++) {
        await service.addMessages(userId, [
          { role: 'user', content: `After ${i}` },
        ]);
      }

      const messages = await service.getConversation(userId);

      // Find any tool_result messages and verify they have matching tool_call
      const toolResultIndices: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (
          Array.isArray(msg.content) &&
          msg.content.some(p => p.type === 'tool-result')
        ) {
          toolResultIndices.push(i);
        }
      }

      // For each tool_result, there should be a matching tool_call before it
      for (const resultIdx of toolResultIndices) {
        const resultMsg = messages[resultIdx];
        const toolResultIds = new Set(
          (resultMsg.content as Array<{ type: string; toolCallId?: string }>)
            .filter(p => p.type === 'tool-result')
            .map(p => p.toolCallId),
        );

        let foundMatch = false;
        for (let i = 0; i < resultIdx; i++) {
          const msg = messages[i];
          if (Array.isArray(msg.content)) {
            const hasMatch = msg.content.some(
              p =>
                p.type === 'tool-call' &&
                toolResultIds.has(
                  (p as { type: string; toolCallId: string }).toolCallId,
                ),
            );
            if (hasMatch) {
              foundMatch = true;
              break;
            }
          }
        }

        expect(foundMatch).toBe(true);
      }
    });

    test('skips orphaned tool_result if tool_use cannot be found', async () => {
      const userId = 1;

      // Manually insert a conversation with an orphaned tool_result
      const key = `conversation:user:${userId}`;
      const orphanedConversation = [
        // tool_result without a preceding tool_call
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'orphan_123',
              toolName: 'some_tool',
              output: 'result',
            },
          ],
        },
        { role: 'assistant', content: 'Response after orphan' },
        { role: 'user', content: 'Next message' },
      ];
      mockRedis.store.set(key, JSON.stringify(orphanedConversation));

      // Add more messages to trigger processing
      await service.addMessages(userId, [
        { role: 'user', content: 'New message' },
      ]);

      const messages = await service.getConversation(userId);

      // Messages should still be valid (no API error would occur)
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('extractTurn', () => {
    test('extracts user message and assistant response', () => {
      const turn = service.extractTurn([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ]);

      expect(turn).not.toBeNull();
      expect(turn!.userMessage).toBe('Hello');
      expect(turn!.assistantResponse).toBe('Hi there!');
      expect(turn!.toolsUsed).toBeUndefined();
    });

    test('extracts tool names when tools are used', () => {
      const turn = service.extractTurn([
        { role: 'user', content: 'What time is it?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'get_time',
              input: {},
            },
            { type: 'text', text: 'Let me check the time...' },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'get_time',
              output: '10:00 AM',
            },
          ],
        },
        { role: 'assistant', content: "It's 10:00 AM" },
      ]);

      expect(turn).not.toBeNull();
      expect(turn!.userMessage).toBe('What time is it?');
      expect(turn!.assistantResponse).toContain('Let me check the time');
      expect(turn!.assistantResponse).toContain("It's 10:00 AM");
      expect(turn!.toolsUsed).toEqual(['get_time']);
    });

    test('returns null when no user message', () => {
      const turn = service.extractTurn([
        { role: 'assistant', content: 'Hello!' },
      ]);

      expect(turn).toBeNull();
    });

    test('returns null when no assistant response', () => {
      const turn = service.extractTurn([{ role: 'user', content: 'Hello' }]);

      expect(turn).toBeNull();
    });

    test('returns null when assistant only has tool calls (no text)', () => {
      const turn = service.extractTurn([
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'some_tool',
              input: {},
            },
          ],
        },
      ]);

      expect(turn).toBeNull();
    });

    test('extracts text from user message content parts', () => {
      const turn = service.extractTurn([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello from parts' }],
        },
        { role: 'assistant', content: 'Hi!' },
      ]);

      expect(turn).not.toBeNull();
      expect(turn!.userMessage).toBe('Hello from parts');
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
