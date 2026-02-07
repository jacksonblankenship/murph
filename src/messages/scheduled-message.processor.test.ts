import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Job } from 'bullmq';
import { Events } from '../common/events';
import { createMockClsService } from '../test/mocks/cls.mock';
import { createMockRedis } from '../test/mocks/redis.mock';
import type { QueuedScheduledMessage } from './message.schemas';
import { ScheduledMessageProcessor } from './scheduled-message.processor';

describe('ScheduledMessageProcessor', () => {
  let processor: ScheduledMessageProcessor;
  let mockLlmService: { generateResponse: ReturnType<typeof mock> };
  let mockConversationService: {
    getConversation: ReturnType<typeof mock>;
    addMessages: ReturnType<typeof mock>;
  };
  let mockEventEmitter: {
    emit: ReturnType<typeof mock>;
  };
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockClsService: ReturnType<typeof createMockClsService>;

  const testMessage: QueuedScheduledMessage = {
    userId: 123,
    content: 'Check the weather',
    taskId: 'task-abc',
    timestamp: Date.now(),
  };

  const createMockJob = (
    data: QueuedScheduledMessage,
    jobId = 'job-123',
  ): Job<QueuedScheduledMessage> =>
    ({
      id: jobId,
      data,
    }) as Job<QueuedScheduledMessage>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    mockClsService = createMockClsService();
    mockLlmService = {
      generateResponse: mock(() =>
        Promise.resolve({
          text: 'The weather is sunny!',
          messages: [{ role: 'assistant', content: 'The weather is sunny!' }],
        }),
      ),
    };
    mockConversationService = {
      getConversation: mock(() => Promise.resolve([])),
      addMessages: mock(() => Promise.resolve()),
    };
    mockEventEmitter = {
      emit: mock(() => true),
    };
    const mockRedisService = { getClient: () => mockRedis };

    processor = new ScheduledMessageProcessor(
      mockLlmService as never,
      mockConversationService as never,
      mockRedisService as never,
      mockEventEmitter as never,
      mockClsService as never,
    );
  });

  describe('process', () => {
    test('retrieves conversation history before LLM call', async () => {
      const job = createMockJob(testMessage);

      await processor.process(job);

      expect(mockConversationService.getConversation).toHaveBeenCalledTimes(1);
      expect(mockConversationService.getConversation).toHaveBeenCalledWith(
        testMessage.userId,
      );
    });

    test('sets active scheduled request with 5-min TTL', async () => {
      const job = createMockJob(testMessage, 'job-xyz');

      // Capture Redis set calls to verify TTL was set
      const setCalls: Array<{ key: string; value: string; ttl?: number }> = [];
      const originalSet = mockRedis.set.bind(mockRedis);
      mockRedis.set = async (
        key: string,
        value: string,
        exMode?: string,
        ttl?: number,
      ) => {
        setCalls.push({ key, value, ttl });
        return originalSet(key, value, exMode, ttl);
      };

      await processor.process(job);

      // Find the set call for the active request
      const activeRequestCall = setCalls.find(c =>
        c.key.includes('active_request'),
      );
      expect(activeRequestCall).toBeDefined();
      expect(activeRequestCall!.key).toBe(
        `active_request:${testMessage.userId}:scheduled`,
      );
      expect(activeRequestCall!.ttl).toBe(300); // 5 minute TTL

      const data = JSON.parse(activeRequestCall!.value);
      expect(data.jobId).toBe('job-xyz');
      expect(data.source).toBe('scheduled');
      expect(data.startTime).toBeGreaterThan(0);
    });

    test('calls LLM without abort signal and sets CLS context', async () => {
      const conversationHistory = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
      ];
      mockConversationService.getConversation = mock(() =>
        Promise.resolve(conversationHistory),
      );
      const job = createMockJob(testMessage);

      await processor.process(job);

      // CLS context should be set with userId
      expect(mockClsService.setUserId).toHaveBeenCalledWith(testMessage.userId);

      expect(mockLlmService.generateResponse).toHaveBeenCalledTimes(1);
      const call = mockLlmService.generateResponse.mock.calls[0];
      expect(call[0]).toBe(testMessage.content);
      expect(call[1]).toEqual(conversationHistory);
      // NO abort signal - 3rd argument should be undefined (userId comes from CLS now)
      expect(call[2]).toBeUndefined();
    });

    test('clears active request on success', async () => {
      const job = createMockJob(testMessage);

      await processor.process(job);

      const key = `active_request:${testMessage.userId}:scheduled`;
      const stored = await mockRedis.get(key);
      expect(stored).toBeNull();
    });

    test('stores scheduled marker and response messages in conversation', async () => {
      const responseMessages = [
        { role: 'assistant', content: 'The weather is sunny!' },
      ];
      mockLlmService.generateResponse = mock(() =>
        Promise.resolve({
          text: 'The weather is sunny!',
          messages: responseMessages,
        }),
      );
      const job = createMockJob(testMessage);

      await processor.process(job);

      expect(mockConversationService.addMessages).toHaveBeenCalledTimes(1);

      // Should store system marker as user message + response messages together
      const call = mockConversationService.addMessages.mock.calls[0];
      expect(call[0]).toBe(testMessage.userId);
      expect(call[1]).toHaveLength(2);
      expect(call[1][0]).toEqual({
        role: 'user',
        content: `[Scheduled: ${testMessage.content}]`,
      });
      expect(call[1][1]).toEqual(responseMessages[0]);
    });

    test('emits MESSAGE_BROADCAST event with response', async () => {
      mockLlmService.generateResponse = mock(() =>
        Promise.resolve({
          text: 'Custom response text',
          messages: [{ role: 'assistant', content: 'Custom response text' }],
        }),
      );
      const job = createMockJob(testMessage);

      await processor.process(job);

      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        Events.MESSAGE_BROADCAST,
        {
          userId: testMessage.userId,
          content: 'Custom response text',
        },
      );
    });

    test('clears active request on error', async () => {
      mockLlmService.generateResponse = mock(() =>
        Promise.reject(new Error('LLM failed')),
      );
      const job = createMockJob(testMessage);

      // Set up active request before error
      const key = `active_request:${testMessage.userId}:scheduled`;
      await mockRedis.set(key, JSON.stringify({ jobId: 'job-123' }));

      await expect(processor.process(job)).rejects.toThrow('LLM failed');

      // Active request should be cleared
      const stored = await mockRedis.get(key);
      expect(stored).toBeNull();
    });

    test('re-throws error for BullMQ retry', async () => {
      const testError = new Error('API timeout');
      mockLlmService.generateResponse = mock(() => Promise.reject(testError));
      const job = createMockJob(testMessage);

      await expect(processor.process(job)).rejects.toThrow('API timeout');
    });

    test('does not store messages in history on error', async () => {
      mockLlmService.generateResponse = mock(() =>
        Promise.reject(new Error('Failed')),
      );
      const job = createMockJob(testMessage);

      await expect(processor.process(job)).rejects.toThrow();

      expect(mockConversationService.addMessages).not.toHaveBeenCalled();
    });

    test('does not emit broadcast event on error', async () => {
      mockLlmService.generateResponse = mock(() =>
        Promise.reject(new Error('Failed')),
      );
      const job = createMockJob(testMessage);

      await expect(processor.process(job)).rejects.toThrow();

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
