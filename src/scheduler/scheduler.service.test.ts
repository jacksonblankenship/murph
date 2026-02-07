import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockQueue } from '../test/mocks/bullmq.mock';
import { injectMurlockService } from '../test/mocks/murlock.mock';
import { createMockRedis } from '../test/mocks/redis.mock';
import { SchedulerService } from './scheduler.service';
import { TaskType } from './task.schemas';

describe('SchedulerService', () => {
  let service: SchedulerService;
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockQueue: ReturnType<typeof createMockQueue>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    mockQueue = createMockQueue();

    const mockRedisService = {
      getClient: () => mockRedis,
    };

    service = new SchedulerService(
      mockQueue as never,
      mockRedisService as never,
    );

    // Inject mock murlock service for @MurLock decorator
    injectMurlockService(service);
  });

  describe('scheduleTask validation', () => {
    test('requires either scheduledTime or cronExpression', async () => {
      const result = await service.scheduleTask(
        1,
        'Test task',
        'Do something',
        {},
      );

      expect(result.scheduled).toBe(false);
      expect(result.error).toBe(
        'Must provide either scheduledTime or cronExpression',
      );
    });

    test('rejects when both scheduledTime and cronExpression provided', async () => {
      const futureTime = Date.now() + 60000;

      const result = await service.scheduleTask(
        1,
        'Test task',
        'Do something',
        {
          scheduledTime: futureTime,
          cronExpression: '0 9 * * *',
        },
      );

      expect(result.scheduled).toBe(false);
      expect(result.error).toBe(
        'Cannot specify both scheduledTime and cronExpression',
      );
    });

    test('rejects scheduledTime in the past', async () => {
      const pastTime = Date.now() - 60000;

      const result = await service.scheduleTask(
        1,
        'Test task',
        'Do something',
        {
          scheduledTime: pastTime,
        },
      );

      expect(result.scheduled).toBe(false);
      expect(result.error).toBe('scheduledTime must be in the future');
    });

    test('accepts scheduledTime in the future', async () => {
      const futureTime = Date.now() + 60000;

      const result = await service.scheduleTask(
        1,
        'Test task',
        'Do something',
        {
          scheduledTime: futureTime,
        },
      );

      expect(result.scheduled).toBe(true);
      expect(result.error).toBeUndefined();
    });

    test('accepts Date object for scheduledTime', async () => {
      const futureDate = new Date(Date.now() + 60000);

      const result = await service.scheduleTask(
        1,
        'Test task',
        'Do something',
        {
          scheduledTime: futureDate,
        },
      );

      expect(result.scheduled).toBe(true);
    });

    test('accepts cronExpression alone', async () => {
      const result = await service.scheduleTask(
        1,
        'Test task',
        'Do something',
        {
          cronExpression: '0 9 * * *',
        },
      );

      expect(result.scheduled).toBe(true);
    });
  });

  describe('scheduleTask task creation', () => {
    test('creates ONE_TIME task with scheduledTime', async () => {
      const futureTime = Date.now() + 60000;

      const result = await service.scheduleTask(1, 'One-time task', 'Message', {
        scheduledTime: futureTime,
      });

      expect(result.scheduled).toBe(true);

      // Verify task stored in Redis
      const taskData = mockRedis.store.get(`scheduled_task:${result.taskId}`);
      expect(taskData).toBeDefined();

      const task = JSON.parse(taskData!);
      expect(task.type).toBe(TaskType.ONE_TIME);
      expect(task.scheduledTime).toBe(futureTime);
      expect(task.cronExpression).toBeUndefined();
    });

    test('creates RECURRING task with cronExpression', async () => {
      const result = await service.scheduleTask(
        1,
        'Recurring task',
        'Message',
        {
          cronExpression: '0 9 * * *',
        },
      );

      expect(result.scheduled).toBe(true);

      const taskData = mockRedis.store.get(`scheduled_task:${result.taskId}`);
      const task = JSON.parse(taskData!);
      expect(task.type).toBe(TaskType.RECURRING);
      expect(task.cronExpression).toBe('0 9 * * *');
      expect(task.scheduledTime).toBeUndefined();
    });

    test('adds task to user index', async () => {
      const userId = 42;
      const futureTime = Date.now() + 60000;

      const result = await service.scheduleTask(userId, 'Task', 'Message', {
        scheduledTime: futureTime,
      });

      const userTasks = await mockRedis.smembers(
        `scheduled_tasks:user:${userId}`,
      );
      expect(userTasks).toContain(result.taskId);
    });

    test('registers task with BullMQ queue', async () => {
      const futureTime = Date.now() + 60000;

      const result = await service.scheduleTask(1, 'Task', 'Message', {
        scheduledTime: futureTime,
      });

      expect(mockQueue.jobs.has(result.taskId)).toBe(true);
    });
  });

  describe('cancelTask', () => {
    test('returns error for non-existent task', async () => {
      const result = await service.cancelTask('non-existent', 1);

      expect(result.cancelled).toBe(false);
      expect(result.error).toBe('Task not found');
    });

    test('returns error when task belongs to different user', async () => {
      const futureTime = Date.now() + 60000;
      const { taskId } = await service.scheduleTask(1, 'Task', 'Message', {
        scheduledTime: futureTime,
      });

      const result = await service.cancelTask(taskId, 999);

      expect(result.cancelled).toBe(false);
      expect(result.error).toBe('Task does not belong to this user');
    });

    test('successfully cancels task owned by user', async () => {
      const userId = 1;
      const futureTime = Date.now() + 60000;
      const { taskId } = await service.scheduleTask(userId, 'Task', 'Message', {
        scheduledTime: futureTime,
      });

      const result = await service.cancelTask(taskId, userId);

      expect(result.cancelled).toBe(true);
      expect(result.error).toBeUndefined();

      // Verify removed from Redis
      expect(mockRedis.store.has(`scheduled_task:${taskId}`)).toBe(false);
      const userTasks = await mockRedis.smembers(
        `scheduled_tasks:user:${userId}`,
      );
      expect(userTasks).not.toContain(taskId);
    });
  });

  describe('listUserTasks', () => {
    test('returns empty array for user with no tasks', async () => {
      const tasks = await service.listUserTasks(999);
      expect(tasks).toEqual([]);
    });

    test('returns all tasks for user', async () => {
      const userId = 1;
      const futureTime = Date.now() + 60000;

      await service.scheduleTask(userId, 'Task 1', 'Message 1', {
        scheduledTime: futureTime,
      });
      await service.scheduleTask(userId, 'Task 2', 'Message 2', {
        cronExpression: '0 9 * * *',
      });

      const tasks = await service.listUserTasks(userId);
      expect(tasks).toHaveLength(2);
      expect(tasks.map(t => t.description).sort()).toEqual([
        'Task 1',
        'Task 2',
      ]);
    });

    test('does not return tasks from other users', async () => {
      const futureTime = Date.now() + 60000;

      await service.scheduleTask(1, 'User 1 Task', 'Message', {
        scheduledTime: futureTime,
      });
      await service.scheduleTask(2, 'User 2 Task', 'Message', {
        scheduledTime: futureTime,
      });

      const user1Tasks = await service.listUserTasks(1);
      expect(user1Tasks).toHaveLength(1);
      expect(user1Tasks[0].description).toBe('User 1 Task');
    });
  });
});
