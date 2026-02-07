import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import {
  Events,
  type MessageBroadcastEvent,
  type ScheduledTaskTriggeredEvent,
} from '../common/events';
import { RedisService } from '../redis/redis.service';
import { ScheduledTask, TaskType } from './task.schemas';

@Processor('scheduled-tasks')
export class TaskProcessor extends WorkerHost {
  private readonly logger = new Logger(TaskProcessor.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<ScheduledTask>): Promise<void> {
    const task = job.data;

    this.logger.log(
      `Processing task ${task.id} (${task.type}) for user ${task.userId}`,
    );
    this.logger.debug(`Description: "${task.description}"`);
    this.logger.debug(`Prompt for LLM: "${task.message.substring(0, 100)}..."`);

    // Validate task has a message/prompt
    if (!task.message || task.message.trim().length === 0) {
      this.logger.error(`Task ${task.id} has no message, skipping`);
      await this.logExecution(task.id, 'error', 'Task message is empty');
      throw new Error(`Task ${task.id} has no message to process`);
    }

    try {
      // Emit event to trigger LLM processing
      const triggeredEvent: ScheduledTaskTriggeredEvent = {
        userId: task.userId,
        taskId: task.id,
        message: task.message,
      };
      this.eventEmitter.emit(Events.SCHEDULED_TASK_TRIGGERED, triggeredEvent);
      this.logger.log(`Emitted scheduled task trigger for task ${task.id}`);

      // Update last executed time
      const redis = this.redisService.getClient();
      task.lastExecuted = Date.now();
      await redis.set(`scheduled_task:${task.id}`, JSON.stringify(task));

      // Log execution
      await this.logExecution(task.id, 'success');
      this.logger.log(`Task ${task.id} executed successfully`);

      // If one-time task, delete it from Redis
      if (task.type === TaskType.ONE_TIME) {
        await redis.del(`scheduled_task:${task.id}`);
        await redis.srem(`scheduled_tasks:user:${task.userId}`, task.id);
      }
    } catch (error) {
      this.logger.error(`Error processing task ${task.id}:`, error);
      this.logger.error('Failed task:', {
        taskId: task.id,
        userId: task.userId,
        type: task.type,
        description: task.description,
        message: task.message.substring(0, 100),
      });
      await this.logExecution(task.id, 'error', error.message);

      // Notify user of the failure via event
      const errorEvent: MessageBroadcastEvent = {
        userId: task.userId,
        content: `⚠️ Scheduled Task Failed\n\nTask ID: ${task.id}\nError: ${error.message}\n\nPlease try rescheduling or contact support if this persists.`,
      };
      this.eventEmitter.emit(Events.MESSAGE_BROADCAST, errorEvent);
      this.logger.log(`Emitted failure notification for user ${task.userId}`);

      throw error; // Let BullMQ handle retries
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`Job ${job.id} completed successfully`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} failed:`, error);
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
