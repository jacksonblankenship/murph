import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { RedisService } from '../redis/redis.service';
import { BroadcastService } from './broadcast.service';
import { ScheduledTask, TaskType } from './task.types';

@Processor('scheduled-tasks')
export class TaskProcessor extends WorkerHost {
  constructor(
    private broadcastService: BroadcastService,
    private redisService: RedisService,
  ) {
    super();
  }

  async process(job: Job<ScheduledTask>): Promise<void> {
    const task = job.data;
    console.log(`Processing task ${task.id} for user ${task.userId}`);

    try {
      // Send message
      const success = await this.broadcastService.sendMessageWithRetry(task.userId, task.message);

      // Update last executed time
      const redis = this.redisService.getClient();
      task.lastExecuted = Date.now();
      await redis.set(`scheduled_task:${task.id}`, JSON.stringify(task));

      // Log execution
      await this.logExecution(
        task.id,
        success ? 'success' : 'error',
        success ? undefined : 'Failed to send message',
      );

      // If one-time task, delete it from Redis
      if (task.type === TaskType.ONE_TIME) {
        await redis.del(`scheduled_task:${task.id}`);
        await redis.srem(`scheduled_tasks:user:${task.userId}`, task.id);
      }

      if (!success) {
        throw new Error('Failed to send message');
      }
    } catch (error) {
      console.error(`Error processing task ${task.id}:`, error);
      await this.logExecution(task.id, 'error', error.message);
      throw error; // Let BullMQ handle retries
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    console.log(`Job ${job.id} completed successfully`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    console.error(`Job ${job.id} failed:`, error);
  }

  private async logExecution(
    taskId: string,
    status: 'success' | 'error',
    error?: string,
  ): Promise<void> {
    const redis = this.redisService.getClient();
    const log = {
      taskId,
      executedAt: Date.now(),
      status,
      error,
    };

    await redis.lpush(`task_executions:${taskId}`, JSON.stringify(log));
    await redis.ltrim(`task_executions:${taskId}`, 0, 99); // Keep last 100 executions
  }
}
