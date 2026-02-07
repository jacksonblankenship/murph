import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Job } from 'bullmq';
import { Events } from '../common/events';
import { createMockRedis } from '../test/mocks/redis.mock';
import { TaskProcessor } from './task.processor';
import { type ScheduledTask, TaskType } from './task.schemas';

describe('TaskProcessor', () => {
  let processor: TaskProcessor;
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockEventEmitter: { emit: ReturnType<typeof mock> };

  function createMockJob(task: ScheduledTask): Job<ScheduledTask> {
    return {
      id: task.id,
      data: task,
    } as Job<ScheduledTask>;
  }

  beforeEach(() => {
    mockRedis = createMockRedis();
    mockEventEmitter = {
      emit: mock(() => true),
    };

    const mockRedisService = {
      getClient: () => mockRedis,
    };

    processor = new TaskProcessor(
      mockRedisService as never,
      mockEventEmitter as never,
    );
  });

  describe('process', () => {
    test('emits SCHEDULED_TASK_TRIGGERED event', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 1,
        type: TaskType.ONE_TIME,
        description: 'Test task',
        message: 'Hello world',
        scheduledTime: Date.now(),
        createdAt: Date.now(),
        enabled: true,
      };

      await processor.process(createMockJob(task));

      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        Events.SCHEDULED_TASK_TRIGGERED,
        {
          userId: task.userId,
          taskId: task.id,
          message: task.message,
        },
      );
    });

    test('throws error for empty message', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 1,
        type: TaskType.ONE_TIME,
        description: 'Test task',
        message: '',
        scheduledTime: Date.now(),
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

    test('emits MESSAGE_BROADCAST error notification on failure', async () => {
      const task: ScheduledTask = {
        id: 'task-1',
        userId: 42,
        type: TaskType.ONE_TIME,
        description: 'Test task',
        message: 'Hello',
        scheduledTime: Date.now(),
        createdAt: Date.now(),
        enabled: true,
      };

      // Make emit throw on first call (SCHEDULED_TASK_TRIGGERED) to simulate failure
      let callCount = 0;
      mockEventEmitter.emit = mock(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Something went wrong');
        }
        return true;
      });

      await expect(processor.process(createMockJob(task))).rejects.toThrow();

      // Second emit should be the error notification
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(2);
      const secondCall = mockEventEmitter.emit.mock.calls[1];
      expect(secondCall[0]).toBe(Events.MESSAGE_BROADCAST);
      expect(secondCall[1].userId).toBe(42);
      expect(secondCall[1].content).toContain('Scheduled Task Failed');
      expect(secondCall[1].content).toContain('task-1');
    });
  });
});
