import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Job } from 'bullmq';
import { Events } from '../common/events';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { createMockRedis } from '../test/mocks/redis.mock';
import { InboundProcessor } from './inbound.processor';
import type { InboundTriggerJob, PendingMessage } from './inbound.types';

describe('InboundProcessor', () => {
  let processor: InboundProcessor;
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockChannelOrchestrator: { execute: ReturnType<typeof mock> };
  let mockBroadcastService: {
    withTypingIndicator: ReturnType<typeof mock>;
  };
  let mockClsService: { runWithContext: ReturnType<typeof mock> };
  let mockEventEmitter: { emit: ReturnType<typeof mock> };

  function createJob(data: InboundTriggerJob): Job<InboundTriggerJob> {
    return { id: 'job-1', data } as Job<InboundTriggerJob>;
  }

  function pushPendingMessage(userId: number, msg: PendingMessage): void {
    const key = `inbound:pending:${userId}`;
    if (!mockRedis.lists.has(key)) {
      mockRedis.lists.set(key, []);
    }
    mockRedis.lists.get(key)!.push(JSON.stringify(msg));
  }

  beforeEach(() => {
    mockRedis = createMockRedis();
    mockChannelOrchestrator = {
      execute: mock(() =>
        Promise.resolve({ text: 'response', messages: [], outputsSent: true }),
      ),
    };
    mockBroadcastService = {
      withTypingIndicator: mock((_chatId: number, fn: () => Promise<unknown>) =>
        fn(),
      ),
    };
    mockClsService = {
      runWithContext: mock((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    };
    mockEventEmitter = {
      emit: mock(() => true),
    };

    processor = new InboundProcessor(
      createMockLogger(),
      mockChannelOrchestrator as never,
      mockBroadcastService as never,
      mockClsService as never,
      { getClient: () => mockRedis } as never,
      mockEventEmitter as never,
    );
  });

  describe('process', () => {
    test('returns early if no pending messages', async () => {
      await processor.process(
        createJob({ userId: 42, chatId: 100, source: 'telegram' }),
      );

      expect(mockChannelOrchestrator.execute).not.toHaveBeenCalled();
    });

    test('processes single message', async () => {
      pushPendingMessage(42, {
        text: 'Hello',
        messageId: 1,
        timestamp: 1000,
        source: 'telegram',
      });

      await processor.process(
        createJob({ userId: 42, chatId: 100, source: 'telegram' }),
      );

      expect(mockChannelOrchestrator.execute).toHaveBeenCalledTimes(1);
      const [channelId, request] = mockChannelOrchestrator.execute.mock
        .calls[0] as [
        string,
        { message: string; userId: number; chatId: number },
      ];
      expect(channelId).toBe('user-direct');
      expect(request.message).toBe('[Telegram]: Hello');
      expect(request.userId).toBe(42);
      expect(request.chatId).toBe(100);
    });

    test('combines multiple messages from same source', async () => {
      pushPendingMessage(42, {
        text: 'First',
        messageId: 1,
        timestamp: 1000,
        source: 'telegram',
      });
      pushPendingMessage(42, {
        text: 'Second',
        messageId: 2,
        timestamp: 2000,
        source: 'telegram',
      });

      await processor.process(
        createJob({ userId: 42, chatId: 100, source: 'telegram' }),
      );

      const [, request] = mockChannelOrchestrator.execute.mock.calls[0] as [
        string,
        { message: string },
      ];
      expect(request.message).toBe('[Telegram]: First\n\n[Follow-up]: Second');
    });

    test('combines messages from different sources with labels', async () => {
      pushPendingMessage(42, {
        text: 'Hey from Telegram',
        messageId: 1,
        timestamp: 1000,
        source: 'telegram',
      });
      pushPendingMessage(42, {
        text: 'Hey from Slack',
        messageId: 2,
        timestamp: 2000,
        source: 'slack',
      });

      await processor.process(
        createJob({ userId: 42, chatId: 100, source: 'slack' }),
      );

      const [, request] = mockChannelOrchestrator.execute.mock.calls[0] as [
        string,
        { message: string },
      ];
      expect(request.message).toBe(
        '[Telegram]: Hey from Telegram\n\n[Follow-up, Slack]: Hey from Slack',
      );
    });

    test('deduplicates by messageId', async () => {
      pushPendingMessage(42, {
        text: 'Hello',
        messageId: 1,
        timestamp: 1000,
        source: 'telegram',
      });
      pushPendingMessage(42, {
        text: 'Hello duplicate',
        messageId: 1,
        timestamp: 1001,
        source: 'telegram',
      });
      pushPendingMessage(42, {
        text: 'Another',
        messageId: 2,
        timestamp: 2000,
        source: 'telegram',
      });

      await processor.process(
        createJob({ userId: 42, chatId: 100, source: 'telegram' }),
      );

      const [, request] = mockChannelOrchestrator.execute.mock.calls[0] as [
        string,
        { message: string },
      ];
      // Should only have 2 unique messages
      expect(request.message).toBe('[Telegram]: Hello\n\n[Follow-up]: Another');
    });

    test('sorts messages by timestamp', async () => {
      pushPendingMessage(42, {
        text: 'Later message',
        messageId: 2,
        timestamp: 2000,
        source: 'telegram',
      });
      pushPendingMessage(42, {
        text: 'Earlier message',
        messageId: 1,
        timestamp: 1000,
        source: 'telegram',
      });

      await processor.process(
        createJob({ userId: 42, chatId: 100, source: 'telegram' }),
      );

      const [, request] = mockChannelOrchestrator.execute.mock.calls[0] as [
        string,
        { message: string },
      ];
      expect(request.message).toBe(
        '[Telegram]: Earlier message\n\n[Follow-up]: Later message',
      );
    });

    test('drains Redis list atomically (list empty after processing)', async () => {
      pushPendingMessage(42, {
        text: 'Hello',
        messageId: 1,
        timestamp: 1000,
        source: 'telegram',
      });

      await processor.process(
        createJob({ userId: 42, chatId: 100, source: 'telegram' }),
      );

      // List should be drained
      const remaining = mockRedis.lists.get('inbound:pending:42');
      expect(remaining).toBeUndefined();
    });

    test('runs with CLS context for userId and chatId', async () => {
      pushPendingMessage(42, {
        text: 'Hello',
        messageId: 1,
        timestamp: 1000,
        source: 'telegram',
      });

      await processor.process(
        createJob({ userId: 42, chatId: 100, source: 'telegram' }),
      );

      expect(mockClsService.runWithContext).toHaveBeenCalledTimes(1);
      const [context] = mockClsService.runWithContext.mock.calls[0] as [
        { userId: number; chatId: number },
      ];
      expect(context.userId).toBe(42);
      expect(context.chatId).toBe(100);
    });

    test('shows typing indicator during processing', async () => {
      pushPendingMessage(42, {
        text: 'Hello',
        messageId: 1,
        timestamp: 1000,
        source: 'telegram',
      });

      await processor.process(
        createJob({ userId: 42, chatId: 100, source: 'telegram' }),
      );

      expect(mockBroadcastService.withTypingIndicator).toHaveBeenCalledTimes(1);
      const [chatId] = mockBroadcastService.withTypingIndicator.mock
        .calls[0] as [number];
      expect(chatId).toBe(100);
    });

    test('emits MESSAGE_BROADCAST on non-abort error', async () => {
      pushPendingMessage(42, {
        text: 'Hello',
        messageId: 1,
        timestamp: 1000,
        source: 'telegram',
      });

      mockChannelOrchestrator.execute = mock(() => {
        throw new Error('LLM failure');
      });

      await expect(
        processor.process(
          createJob({ userId: 42, chatId: 100, source: 'telegram' }),
        ),
      ).rejects.toThrow('LLM failure');

      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
      const [eventName, eventData] = mockEventEmitter.emit.mock.calls[0] as [
        string,
        { userId: number; content: string },
      ];
      expect(eventName).toBe(Events.MESSAGE_BROADCAST);
      expect(eventData.userId).toBe(42);
      expect(eventData.content).toContain('error processing your message');
    });

    test('handles AbortError gracefully without emitting error', async () => {
      pushPendingMessage(42, {
        text: 'Hello',
        messageId: 1,
        timestamp: 1000,
        source: 'telegram',
      });

      mockChannelOrchestrator.execute = mock(() => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      });

      // Should not throw
      await processor.process(
        createJob({ userId: 42, chatId: 100, source: 'telegram' }),
      );

      // Should not emit error broadcast
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
