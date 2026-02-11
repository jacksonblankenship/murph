import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { Events, type MessageBroadcastEvent } from '../common/events';
import { AgentDispatcher } from '../dispatcher';
import { RedisService } from '../redis/redis.service';
import { ScheduledTask, TaskType } from './task.schemas';

/** Preview length for logging prompts */
const LOG_PREVIEW_LENGTH = 100;
/** Maximum number of execution logs to retain per task */
const MAX_EXECUTION_LOGS = 99;

@Processor('scheduled-tasks')
export class TaskProcessor extends WorkerHost {
  constructor(
    private readonly logger: PinoLogger,
    private readonly redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
    private readonly dispatcher: AgentDispatcher,
  ) {
    super();
    this.logger.setContext(TaskProcessor.name);
  }

  async process(job: Job<ScheduledTask>): Promise<void> {
    const task = job.data;

    this.logger.info(
      { taskId: task.id, type: task.type, userId: task.userId },
      'Processing task',
    );
    this.logger.debug({ description: task.description }, 'Task description');
    this.logger.debug(
      { prompt: task.message.substring(0, LOG_PREVIEW_LENGTH) },
      'Prompt for LLM',
    );

    // Validate task has a message/prompt
    if (!task.message || task.message.trim().length === 0) {
      this.logger.error({ taskId: task.id }, 'Task has no message, skipping');
      await this.logExecution(task.id, 'error', 'Task message is empty');
      throw new Error(`Task ${task.id} has no message to process`);
    }

    try {
      // Dispatch directly to the scheduled-messages queue
      await this.dispatcher.dispatch({
        queue: 'scheduled-messages',
        jobName: 'process-scheduled-message',
        data: {
          userId: task.userId,
          content: task.message,
          taskId: task.id,
          timestamp: Date.now(),
        },
        jobOptions: {
          jobId: `scheduled-${task.id}-${Date.now()}`,
        },
      });
      this.logger.info(
        { taskId: task.id },
        'Dispatched scheduled task to queue',
      );

      // Update last executed time
      const redis = this.redisService.getClient();
      task.lastExecuted = Date.now();
      await redis.set(`scheduled_task:${task.id}`, JSON.stringify(task));

      // Log execution
      await this.logExecution(task.id, 'success');
      this.logger.info({ taskId: task.id }, 'Task executed successfully');

      // If one-time task, delete it from Redis
      if (task.type === TaskType.ONE_TIME) {
        await redis.del(`scheduled_task:${task.id}`);
        await redis.srem(`scheduled_tasks:user:${task.userId}`, task.id);
      }
    } catch (error) {
      this.logger.error(
        {
          err: error,
          taskId: task.id,
          userId: task.userId,
          type: task.type,
          description: task.description,
          message: task.message.substring(0, LOG_PREVIEW_LENGTH),
        },
        'Error processing task',
      );
      await this.logExecution(task.id, 'error', error.message);

      // Notify user of the failure via event
      const errorEvent: MessageBroadcastEvent = {
        userId: task.userId,
        content: `⚠️ Scheduled Task Failed\n\nTask ID: ${task.id}\nError: ${error.message}\n\nPlease try rescheduling or contact support if this persists.`,
      };
      this.eventEmitter.emit(Events.MESSAGE_BROADCAST, errorEvent);
      this.logger.info({ userId: task.userId }, 'Emitted failure notification');

      throw error; // Let BullMQ handle retries
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.info({ jobId: job.id }, 'Job completed successfully');
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error({ err: error, jobId: job.id }, 'Job failed');
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
    await redis.ltrim(`task_executions:${taskId}`, 0, MAX_EXECUTION_LOGS);
  }
}
