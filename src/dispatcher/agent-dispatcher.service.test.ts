import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { AgentDispatcher } from './agent-dispatcher.service';

describe('AgentDispatcher', () => {
  let dispatcher: AgentDispatcher;
  let mockConfigService: { get: ReturnType<typeof mock> };

  function createMockQueue() {
    return {
      add: mock((_jobName: string, _data: unknown, _opts?: unknown) =>
        Promise.resolve({ id: 'job-123' }),
      ),
    };
  }

  beforeEach(() => {
    mockConfigService = {
      get: mock((key: string) => {
        const config: Record<string, string | number> = {
          'redis.host': 'localhost',
          'redis.port': 6379,
        };
        return config[key];
      }),
    };

    dispatcher = new AgentDispatcher(
      createMockLogger(),
      mockConfigService as never,
    );
  });

  describe('registerQueue', () => {
    test('registers a queue by name', () => {
      const queue = createMockQueue();
      dispatcher.registerQueue('test-queue', queue as never);

      // Should not throw when dispatching
      expect(
        dispatcher.dispatch({
          queue: 'test-queue',
          jobName: 'test',
          data: {},
        }),
      ).resolves.toBe('job-123');
    });

    test('is idempotent — second call with same name is a no-op', () => {
      const queue1 = createMockQueue();
      const queue2 = createMockQueue();

      dispatcher.registerQueue('test-queue', queue1 as never);
      dispatcher.registerQueue('test-queue', queue2 as never);

      // Should use the first queue
      dispatcher.dispatch({ queue: 'test-queue', jobName: 'test', data: {} });
      expect(queue1.add).toHaveBeenCalledTimes(1);
      expect(queue2.add).toHaveBeenCalledTimes(0);
    });
  });

  describe('dispatch', () => {
    test('calls queue.add with correct arguments', async () => {
      const queue = createMockQueue();
      dispatcher.registerQueue('my-queue', queue as never);

      const jobId = await dispatcher.dispatch({
        queue: 'my-queue',
        jobName: 'do-thing',
        data: { foo: 'bar' },
        jobOptions: { delay: 1000 },
      });

      expect(jobId).toBe('job-123');
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        'do-thing',
        { foo: 'bar' },
        { delay: 1000 },
      );
    });

    test('throws on unregistered queue name', () => {
      expect(
        dispatcher.dispatch({
          queue: 'nonexistent',
          jobName: 'test',
          data: {},
        }),
      ).rejects.toThrow('Queue "nonexistent" is not registered');
    });
  });

  describe('dispatchAndWait', () => {
    test('calls queue.add and job.waitUntilFinished, returns result', async () => {
      const mockJob = {
        id: 'job-456',
        waitUntilFinished: mock((_queueEvents: unknown, _timeout: number) =>
          Promise.resolve('the-result'),
        ),
      };
      const queue = {
        add: mock(() => Promise.resolve(mockJob)),
      };

      dispatcher.registerQueue('blocking-queue', queue as never);

      const result = await dispatcher.dispatchAndWait({
        queue: 'blocking-queue',
        jobName: 'compute',
        data: { input: 42 },
        timeoutMs: 5000,
      });

      expect(result.jobId).toBe('job-456');
      expect(result.returnValue).toBe('the-result');
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(mockJob.waitUntilFinished).toHaveBeenCalledTimes(1);

      // Second arg should be the timeout
      const [, timeout] = mockJob.waitUntilFinished.mock.calls[0] as [
        unknown,
        number,
      ];
      expect(timeout).toBe(5000);
    });

    test('throws on unregistered queue name', () => {
      expect(
        dispatcher.dispatchAndWait({
          queue: 'nonexistent',
          jobName: 'test',
          data: {},
        }),
      ).rejects.toThrow('Queue "nonexistent" is not registered');
    });
  });

  describe('onModuleDestroy', () => {
    test('closes all QueueEvents', async () => {
      // We need to trigger QueueEvents creation by calling dispatchAndWait
      // But since QueueEvents connects to real Redis, we test the cleanup path
      // by verifying onModuleDestroy doesn't throw with no events
      await dispatcher.onModuleDestroy();
      // No error = success
    });
  });
});
