import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { MessagesService } from '../messages/messages.service';
import { RedisService } from '../redis/redis.service';
import { BroadcastService } from './broadcast.service';
import { ScheduledTask, TaskType } from './task.types';

@Processor('scheduled-tasks')
export class TaskProcessor extends WorkerHost {
  constructor(
    private messagesService: MessagesService,
    private redisService: RedisService,
    private broadcastService: BroadcastService,
  ) {
    super();
  }

  async process(job: Job<ScheduledTask>): Promise<void> {
    const task = job.data;
    console.log(
      `[TaskProcessor] Processing task ${task.id} (${task.type}) for user ${task.userId}`,
    );
    console.log(`[TaskProcessor] Description: "${task.description}"`);
    console.log(`[TaskProcessor] Prompt for LLM: "${task.message.substring(0, 100)}..."`);

    // Validate task has a message/prompt
    if (!task.message || task.message.trim().length === 0) {
      console.error(`[TaskProcessor] Task ${task.id} has no message, skipping`);
      await this.logExecution(task.id, 'error', 'Task message is empty');
      throw new Error(`Task ${task.id} has no message to process`);
    }

    try {
      // Queue the task prompt for fresh LLM processing
      const queuedMessage = {
        userId: task.userId,
        content: task.message,
        taskId: task.id,
        timestamp: Date.now(),
      };

      await this.messagesService.queueScheduledMessage(queuedMessage);
      console.log(`[TaskProcessor] Queued prompt for LLM processing, task ${task.id}`);

      // Update last executed time
      const redis = this.redisService.getClient();
      task.lastExecuted = Date.now();
      await redis.set(`scheduled_task:${task.id}`, JSON.stringify(task));

      // Log execution
      await this.logExecution(task.id, 'success');
      console.log(`[TaskProcessor] Task ${task.id} executed successfully`);

      // If one-time task, delete it from Redis
      if (task.type === TaskType.ONE_TIME) {
        await redis.del(`scheduled_task:${task.id}`);
        await redis.srem(`scheduled_tasks:user:${task.userId}`, task.id);
      }
    } catch (error) {
      console.error(`[TaskProcessor] Error processing task ${task.id}:`, error);
      console.error(`[TaskProcessor] Failed task:`, {
        taskId: task.id,
        userId: task.userId,
        type: task.type,
        description: task.description,
        message: task.message.substring(0, 100),
      });
      await this.logExecution(task.id, 'error', error.message);

      // Notify user of the failure
      try {
        await this.broadcastService.notifyTaskFailure(task.userId, task.id, error.message);
        console.log(`[TaskProcessor] Notified user ${task.userId} of failure`);
      } catch (notifyError) {
        console.error(`[TaskProcessor] Failed to notify user:`, notifyError);
      }

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
