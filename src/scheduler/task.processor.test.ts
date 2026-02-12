import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Job } from 'bullmq';
import { createMockLogger } from '../test/mocks/pino-logger.mock';
import { createMockRedis } from '../test/mocks/redis.mock';
import { TaskProcessor } from './task.processor';
import { type ScheduledTask, TaskAction, TaskType } from './task.schemas';

describe('TaskProcessor', () => {
  let processor: TaskProcessor;
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockDispatcher: { dispatch: ReturnType<typeof mock> };

  function createMockJob(task: ScheduledTask): Job<ScheduledTask> {
    return {
      id: task.id,
      data: task,
    } as Job<ScheduledTask>;
  }

  beforeEach(() => {
    mockRedis = createMockRedis();
    mockDispatcher = {
      dispatch: mock(() => Promise.resolve('dispatched-job-id')),
    };

    const mockRedisService = {
      getClient: () => mockRedis,
    };

    processor = new TaskProcessor(
      createMockLogger(),
      mockRedisService as never,
      mockDispatcher as never,
    );
  });

  describe('process', () => {
    test('dispatches to scheduled-messages queue', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 1,
        type: TaskType.ONE_TIME,
        description: 'Test task',
        message: 'Hello world',
        scheduledTime: Date.now(),
        action: TaskAction.MESSAGE,
        createdAt: Date.now(),
        enabled: true,
      };

      await processor.process(createMockJob(task));

      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);

      const call = mockDispatcher.dispatch.mock.calls[0][0] as {
        queue: string;
        jobName: string;
        data: {
          userId: number;
          content: string;
          taskId: string;
          timestamp: number;
        };
        jobOptions: { jobId: string };
      };
      expect(call.queue).toBe('scheduled-messages');
      expect(call.jobName).toBe('process-scheduled-message');
      expect(call.data.userId).toBe(task.userId);
      expect(call.data.content).toBe(task.message);
      expect(call.data.taskId).toBe(task.id);
      expect(call.jobOptions.jobId).toStartWith(`scheduled-${task.id}-`);
    });

    test('throws error for empty message', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 1,
        type: TaskType.ONE_TIME,
        description: 'Test task',
        message: '',
        scheduledTime: Date.now(),
        action: TaskAction.MESSAGE,
        createdAt: Date.now(),
        enabled: true,
      };

      await expect(processor.process(createMockJob(task))).rejects.toThrow(
        'Task task-1 has no message to process',
      );
    });

    test('throws error for whitespace-only message', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 1,
        type: TaskType.ONE_TIME,
        description: 'Test task',
        message: '   ',
        scheduledTime: Date.now(),
        action: TaskAction.MESSAGE,
        createdAt: Date.now(),
        enabled: true,
      };

      await expect(processor.process(createMockJob(task))).rejects.toThrow(
        'Task task-1 has no message to process',
      );
    });

    test('updates lastExecuted timestamp', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 1,
        type: TaskType.RECURRING,
        description: 'Test task',
        message: 'Hello',
        cronExpression: '0 9 * * *',
        action: TaskAction.MESSAGE,
        createdAt: Date.now(),
        enabled: true,
      };

      await processor.process(createMockJob(task));

      const stored = mockRedis.store.get(`scheduled_task:${task.id}`);
      expect(stored).toBeDefined();
      const parsed = JSON.parse(stored!);
      expect(parsed.lastExecuted).toBeGreaterThan(0);
    });

    test('deletes ONE_TIME task after execution', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 1,
        type: TaskType.ONE_TIME,
        description: 'One-time task',
        message: 'Hello',
        scheduledTime: Date.now(),
        action: TaskAction.MESSAGE,
        createdAt: Date.now(),
        enabled: true,
      };

      // Store task in Redis first
      await mockRedis.set(`scheduled_task:${task.id}`, JSON.stringify(task));
      await mockRedis.sadd(`scheduled_tasks:user:${task.userId}`, task.id);

      await processor.process(createMockJob(task));

      // Verify task removed from Redis
      expect(mockRedis.store.has(`scheduled_task:${task.id}`)).toBe(false);
      const userTasks = await mockRedis.smembers(
        `scheduled_tasks:user:${task.userId}`,
      );
      expect(userTasks).not.toContain(task.id);
    });

    test('keeps RECURRING task after execution', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 1,
        type: TaskType.RECURRING,
        description: 'Recurring task',
        message: 'Hello',
        cronExpression: '0 9 * * *',
        action: TaskAction.MESSAGE,
        createdAt: Date.now(),
        enabled: true,
      };

      await processor.process(createMockJob(task));

      // Verify task still in Redis
      expect(mockRedis.store.has(`scheduled_task:${task.id}`)).toBe(true);
    });

    test('logs execution on success', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 1,
        type: TaskType.ONE_TIME,
        description: 'Test task',
        message: 'Hello',
        scheduledTime: Date.now(),
        action: TaskAction.MESSAGE,
        createdAt: Date.now(),
        enabled: true,
      };

      await processor.process(createMockJob(task));

      const logs = await mockRedis.lrange(`task_executions:${task.id}`, 0, -1);
      expect(logs).toHaveLength(1);

      const log = JSON.parse(logs[0]);
      expect(log.taskId).toBe(task.id);
      expect(log.status).toBe('success');
      expect(log.executedAt).toBeGreaterThan(0);
    });

    test('caps execution log at 100 entries', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 1,
        type: TaskType.RECURRING,
        description: 'Test task',
        message: 'Hello',
        cronExpression: '0 9 * * *',
        action: TaskAction.MESSAGE,
        createdAt: Date.now(),
        enabled: true,
      };

      // Execute 105 times
      for (let i = 0; i < 105; i++) {
        await processor.process(createMockJob(task));
      }

      const logs = await mockRedis.lrange(`task_executions:${task.id}`, 0, -1);
      expect(logs.length).toBeLessThanOrEqual(100);
    });

    test('dispatches error notification to scheduled-messages on failure', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 42,
        type: TaskType.ONE_TIME,
        description: 'Test task',
        message: 'Hello',
        scheduledTime: Date.now(),
        action: TaskAction.MESSAGE,
        createdAt: Date.now(),
        enabled: true,
      };

      // First call throws (the actual task dispatch), second call succeeds (error notification)
      let callCount = 0;
      mockDispatcher.dispatch = mock(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Something went wrong');
        }
        return Promise.resolve('dispatched-job-id');
      });

      processor = new TaskProcessor(
        createMockLogger(),
        { getClient: () => mockRedis } as never,
        mockDispatcher as never,
      );

      await expect(processor.process(createMockJob(task))).rejects.toThrow();

      // Should dispatch error notification (second call)
      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);

      const errorCall = mockDispatcher.dispatch.mock.calls[1][0] as {
        queue: string;
        jobName: string;
        data: {
          userId: number;
          content: string;
          taskId: string;
          timestamp: number;
        };
        jobOptions: { jobId: string };
      };
      expect(errorCall.queue).toBe('scheduled-messages');
      expect(errorCall.jobName).toBe('process-scheduled-message');
      expect(errorCall.data.userId).toBe(42);
      expect(errorCall.data.content).toContain('task-1');
      expect(errorCall.data.content).toContain('Something went wrong');
      expect(errorCall.jobOptions.jobId).toStartWith('scheduled-error-task-1-');
    });
  });
});
