import { randomBytes } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { MurLock } from 'murlock';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from '../redis/redis.service';

/** Lock timeout in milliseconds for task operations */
const LOCK_TIMEOUT_MS = 30_000;
/** Number of random bytes for task ID generation (produces 16-char hex string) */
const TASK_ID_BYTES = 8;

import {
  normalizeTimestamp,
  ScheduledTask,
  ScheduledTaskSchema,
  TaskAction,
  TaskType,
} from './task.schemas';

@Injectable()
export class SchedulerService implements OnModuleInit {
  constructor(
    private readonly logger: PinoLogger,
    @InjectQueue('scheduled-tasks') private taskQueue: Queue,
    private redisService: RedisService,
  ) {
    this.logger.setContext(SchedulerService.name);
  }

  async onModuleInit() {
    // Recover scheduled tasks from Redis on startup
    await this.recoverScheduledTasks();
  }

  async scheduleTask(
    userId: number,
    description: string,
    message: string,
    options: {
      scheduledTime?: Date | number; // For one-time
      cronExpression?: string; // For recurring
    },
  ): Promise<{ taskId: string; scheduled: boolean; error?: string }> {
    const taskId = this.generateTaskId();

    try {
      // Determine task type
      const isOneTime = !!options.scheduledTime;
      const isRecurring = !!options.cronExpression;

      if (!isOneTime && !isRecurring) {
        return {
          taskId,
          scheduled: false,
          error: 'Must provide either scheduledTime or cronExpression',
        };
      }

      if (isOneTime && isRecurring) {
        return {
          taskId,
          scheduled: false,
          error: 'Cannot specify both scheduledTime and cronExpression',
        };
      }

      // Validate scheduledTime is in future
      if (isOneTime) {
        const timestamp = normalizeTimestamp(options.scheduledTime);

        if (timestamp <= Date.now()) {
          return {
            taskId,
            scheduled: false,
            error: 'scheduledTime must be in the future',
          };
        }
      }

      // Create task object
      const task: ScheduledTask = {
        id: taskId,
        userId,
        type: isOneTime ? TaskType.ONE_TIME : TaskType.RECURRING,
        description,
        message,
        action: TaskAction.MESSAGE,
        scheduledTime: isOneTime
          ? normalizeTimestamp(options.scheduledTime)
          : undefined,
        cronExpression: options.cronExpression,
        createdAt: Date.now(),
        enabled: true,
      };

      // Store in Redis
      await this.storeTask(task);

      // Register with scheduler
      await this.registerTask(task);

      return { taskId, scheduled: true };
    } catch (error) {
      this.logger.error({ err: error }, 'Error scheduling task');
      return {
        taskId,
        scheduled: false,
        error: error.message,
      };
    }
  }

  @MurLock(LOCK_TIMEOUT_MS, 'taskId')
  async cancelTask(
    taskId: string,
    userId: number,
  ): Promise<{ cancelled: boolean; error?: string }> {
    const redis = this.redisService.getClient();

    try {
      // Verify task exists and belongs to user
      const task = await this.getTask(taskId);

      if (!task) {
        return { cancelled: false, error: 'Task not found' };
      }

      if (task.userId !== userId) {
        return { cancelled: false, error: 'Task does not belong to this user' };
      }

      // Remove job from BullMQ queue
      const job = await this.taskQueue.getJob(taskId);
      if (job) {
        await job.remove();
      }

      // Also remove repeatable job if it's recurring
      if (task.type === TaskType.RECURRING) {
        const repeatableJobs = await this.taskQueue.getRepeatableJobs();
        const targetJob = repeatableJobs.find(
          j => j.id === taskId || j.key.includes(taskId),
        );
        if (targetJob) {
          await this.taskQueue.removeRepeatableByKey(targetJob.key);
        }
      }

      // Delete from Redis
      await redis.del(`scheduled_task:${taskId}`);
      await redis.srem(`scheduled_tasks:user:${userId}`, taskId);

      return { cancelled: true };
    } catch (error) {
      this.logger.error({ err: error }, 'Error cancelling task');
      return { cancelled: false, error: error.message };
    }
  }

  async listUserTasks(userId: number): Promise<ScheduledTask[]> {
    const redis = this.redisService.getClient();
    const taskIds = await redis.smembers(`scheduled_tasks:user:${userId}`);

    const tasks: ScheduledTask[] = [];
    for (const taskId of taskIds) {
      const task = await this.getTask(taskId);
      if (task) tasks.push(task);
    }

    return tasks;
  }

  private async storeTask(task: ScheduledTask): Promise<void> {
    const redis = this.redisService.getClient();

    // Store task data
    await redis.set(`scheduled_task:${task.id}`, JSON.stringify(task));

    // Add to user's task index
    await redis.sadd(`scheduled_tasks:user:${task.userId}`, task.id);
  }

  private async getTask(taskId: string): Promise<ScheduledTask | null> {
    const redis = this.redisService.getClient();
    const data = await redis.get(`scheduled_task:${taskId}`);

    if (!data) return null;

    const result = ScheduledTaskSchema.safeParse(JSON.parse(data));
    if (!result.success) {
      this.logger.error(
        { taskId, error: result.error.message },
        'Invalid task data',
      );
      return null;
    }
    return result.data;
  }

  private async registerTask(task: ScheduledTask): Promise<void> {
    if (task.type === TaskType.ONE_TIME) {
      await this.registerOneTimeTask(task);
    } else {
      await this.registerRecurringTask(task);
    }
  }

  private async registerOneTimeTask(task: ScheduledTask): Promise<void> {
    const delay = task.scheduledTime - Date.now();

    if (delay <= 0) {
      this.logger.warn(
        { taskId: task.id },
        'Task scheduled time is in the past, adding to queue immediately',
      );
      await this.taskQueue.add('execute-task', task, {
        jobId: task.id,
      });
      return;
    }

    // Schedule job with delay
    await this.taskQueue.add('execute-task', task, {
      jobId: task.id,
      delay,
    });
  }

  private async registerRecurringTask(task: ScheduledTask): Promise<void> {
    // Use BullMQ's repeatable jobs with cron expression
    await this.taskQueue.add('execute-task', task, {
      jobId: task.id,
      repeat: {
        pattern: task.cronExpression,
      },
    });
  }

  private async recoverScheduledTasks(): Promise<void> {
    this.logger.info({}, 'Recovering scheduled tasks from Redis...');
    const redis = this.redisService.getClient();

    try {
      // Get all task keys
      const taskKeys = await redis.keys('scheduled_task:*');

      let recovered = 0;
      for (const key of taskKeys) {
        const data = await redis.get(key);
        if (!data) continue;

        const result = ScheduledTaskSchema.safeParse(JSON.parse(data));
        if (!result.success) {
          this.logger.error(
            { key, error: result.error.message },
            'Invalid task data',
          );
          continue;
        }
        const task = result.data;

        // Skip disabled tasks
        if (!task.enabled) continue;

        // For one-time tasks, check if they're still valid
        if (task.type === TaskType.ONE_TIME) {
          if (task.scheduledTime <= Date.now()) {
            // Task is in the past, delete it
            await this.cancelTask(task.id, task.userId);
            continue;
          }
        }

        // Re-register with scheduler
        await this.registerTask(task);
        recovered++;
      }

      this.logger.info({ count: recovered }, 'Recovered scheduled tasks');
    } catch (error) {
      this.logger.error({ err: error }, 'Error recovering scheduled tasks');
    }
  }

  private generateTaskId(): string {
    return randomBytes(TASK_ID_BYTES).toString('hex');
  }
}
