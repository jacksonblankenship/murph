import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { createMockRedis } from '../test/mocks/redis.mock';
import { InboundService } from './inbound.service';

describe('InboundService', () => {
  let service: InboundService;
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockDispatcher: { dispatch: ReturnType<typeof mock> };

  beforeEach(() => {
    mockRedis = createMockRedis();
    mockDispatcher = {
      dispatch: mock(() => Promise.resolve('trigger-job-id')),
    };

    const mockRedisService = {
      getClient: () => mockRedis,
    };

    service = new InboundService(
      createMockLogger(),
      mockDispatcher as never,
      mockRedisService as never,
    );
  });

  test('publishes abort signal for in-flight processing', async () => {
    const publishSpy = mock((_channel: string, _message: string) =>
      Promise.resolve(0),
    );
    mockRedis.publish = publishSpy;

    await service.enqueue({
      userId: 42,
      chatId: 100,
      text: 'Hello',
      messageId: 1,
      source: 'telegram',
    });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [channel, message] = publishSpy.mock.calls[0] as [string, string];
    expect(channel).toBe('inbound:abort');
    expect(JSON.parse(message)).toEqual({ userId: 42 });
  });

  test('pushes pending message to Redis list', async () => {
    await service.enqueue({
      userId: 42,
      chatId: 100,
      text: 'Hello Murph',
      messageId: 5,
      source: 'telegram',
    });

    const pendingList = mockRedis.lists.get('inbound:pending:42');
    expect(pendingList).toBeDefined();
    expect(pendingList).toHaveLength(1);

    const parsed = JSON.parse(pendingList![0]);
    expect(parsed.text).toBe('Hello Murph');
    expect(parsed.messageId).toBe(5);
    expect(parsed.source).toBe('telegram');
    expect(parsed.timestamp).toBeGreaterThan(0);
  });

  test('dispatches debounced trigger job with deduplication options', async () => {
    await service.enqueue({
      userId: 42,
      chatId: 100,
      text: 'Hello',
      messageId: 1,
      source: 'telegram',
    });

    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);

    const call = mockDispatcher.dispatch.mock.calls[0][0] as {
      queue: string;
      jobName: string;
      data: { userId: number; chatId: number; source: string };
      jobOptions: { deduplication: { id: string; ttl: number }; delay: number };
    };

    expect(call.queue).toBe('inbound-messages');
    expect(call.jobName).toBe('process');
    expect(call.data.userId).toBe(42);
    expect(call.data.chatId).toBe(100);
    expect(call.data.source).toBe('telegram');
    expect(call.jobOptions.deduplication.id).toBe('user-42');
    expect(call.jobOptions.deduplication.ttl).toBe(2000);
    expect(call.jobOptions.delay).toBe(2000);
  });

  test('accumulates multiple messages in the same Redis list', async () => {
    await service.enqueue({
      userId: 42,
      chatId: 100,
      text: 'First message',
      messageId: 1,
      source: 'telegram',
    });

    await service.enqueue({
      userId: 42,
      chatId: 100,
      text: 'Second message',
      messageId: 2,
      source: 'telegram',
    });

    const pendingList = mockRedis.lists.get('inbound:pending:42');
    expect(pendingList).toHaveLength(2);
  });
});
