import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Job } from 'bullmq';
import { SCHEDULED_PROACTIVE_CHANNEL_ID } from '../channels/presets/scheduled.preset';
import { createMockRedis } from '../test/mocks/redis.mock';
import type { QueuedScheduledMessage } from './message.schemas';
import { ScheduledMessageProcessor } from './scheduled-message.processor';

describe('ScheduledMessageProcessor', () => {
  let processor: ScheduledMessageProcessor;
  let mockChannelOrchestrator: {
    execute: ReturnType<typeof mock>;
  };
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockBroadcastService: {
    withTypingIndicator: ReturnType<typeof mock>;
  };

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
    mockChannelOrchestrator = {
      execute: mock(() =>
        Promise.resolve({
          text: 'The weather is sunny!',
          messages: [{ role: 'assistant', content: 'The weather is sunny!' }],
          outputsSent: true,
        }),
      ),
    };
    mockBroadcastService = {
      // Execute the function passed to withTypingIndicator immediately
      withTypingIndicator: mock((chatId: number, fn: () => Promise<unknown>) =>
        fn(),
      ),
    };
    const mockRedisService = { getClient: () => mockRedis };

    processor = new ScheduledMessageProcessor(
      mockChannelOrchestrator as never,
      mockRedisService as never,
      mockBroadcastService as never,
    );
  });

  describe('process', () => {
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

    test('calls channel orchestrator with scheduled-proactive channel', async () => {
      const job = createMockJob(testMessage);

      await processor.process(job);

      expect(mockChannelOrchestrator.execute).toHaveBeenCalledTimes(1);

      const call = mockChannelOrchestrator.execute.mock.calls[0];
      expect(call[0]).toBe(SCHEDULED_PROACTIVE_CHANNEL_ID);
      expect(call[1]).toMatchObject({
        message: testMessage.content,
        userId: testMessage.userId,
        taskId: testMessage.taskId,
      });
      expect(call[1].scheduledTime).toBeInstanceOf(Date);
    });

    test('does not pass abort signal (scheduled messages run to completion)', async () => {
      const job = createMockJob(testMessage);

      await processor.process(job);

      const call = mockChannelOrchestrator.execute.mock.calls[0];
      // Third argument (options) should be undefined or not have abortSignal
      expect(call[2]?.abortSignal).toBeUndefined();
    });

    test('clears active request on success', async () => {
      const job = createMockJob(testMessage);

      await processor.process(job);

      const key = `active_request:${testMessage.userId}:scheduled`;
      const stored = await mockRedis.get(key);
      expect(stored).toBeNull();
    });

    test('clears active request on error', async () => {
      mockChannelOrchestrator.execute = mock(() =>
        Promise.reject(new Error('Channel failed')),
      );
      const job = createMockJob(testMessage);

      // Set up active request before error
      const key = `active_request:${testMessage.userId}:scheduled`;
      await mockRedis.set(key, JSON.stringify({ jobId: 'job-123' }));

      await expect(processor.process(job)).rejects.toThrow('Channel failed');

      // Active request should be cleared
      const stored = await mockRedis.get(key);
      expect(stored).toBeNull();
    });

    test('re-throws error for BullMQ retry', async () => {
      const testError = new Error('API timeout');
      mockChannelOrchestrator.execute = mock(() => Promise.reject(testError));
      const job = createMockJob(testMessage);

      await expect(processor.process(job)).rejects.toThrow('API timeout');
    });
  });
});
