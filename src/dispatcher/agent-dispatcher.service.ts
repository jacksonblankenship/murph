import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type {
  BlockingDispatchOptions,
  DispatchOptions,
  DispatchResult,
} from './dispatcher.types';

/** Default timeout for blocking dispatch calls */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Central dispatcher for routing jobs to registered BullMQ queues.
 *
 * Modules register their queues on init via `registerQueue()`. Tool factories
 * and processors then dispatch jobs without needing direct queue references.
 *
 * Supports fire-and-forget (`dispatch`) and blocking (`dispatchAndWait`) patterns.
 */
@Injectable()
export class AgentDispatcher implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();
  private readonly queueEvents = new Map<string, QueueEvents>();

  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
  ) {
    this.logger.setContext(AgentDispatcher.name);
  }

  /**
   * Register a BullMQ queue for dispatching.
   *
   * Idempotent — calling with the same name and queue instance is a no-op.
   *
   * @param name Logical queue name used in dispatch calls
   * @param queue The BullMQ Queue instance
   */
  registerQueue(name: string, queue: Queue): void {
    if (this.queues.has(name)) {
      this.logger.debug({ queue: name }, 'Queue already registered, skipping');
      return;
    }
    this.queues.set(name, queue);
    this.logger.info({ queue: name }, 'Queue registered');
  }

  /**
   * Fire-and-forget dispatch. Enqueues a job and returns its ID immediately.
   *
   * @param options Queue name, job name, payload, and optional BullMQ job options
   * @returns The BullMQ job ID
   */
  async dispatch<T>(options: DispatchOptions<T>): Promise<string> {
    const queue = this.getQueue(options.queue);
    const job = await queue.add(
      options.jobName,
      options.data,
      options.jobOptions,
    );
    this.logger.debug(
      { queue: options.queue, jobName: options.jobName, jobId: job.id },
      'Job dispatched',
    );
    return job.id as string;
  }

  /**
   * Dispatch a job and block until the processor returns a result.
   *
   * Creates a `QueueEvents` listener lazily (one per queue, reused).
   * The listener needs its own Redis connection, pulled from `ConfigService`.
   *
   * @param options Queue name, job name, payload, timeout, and optional BullMQ job options
   * @returns The job ID and the processor's return value
   */
  async dispatchAndWait<T, R = unknown>(
    options: BlockingDispatchOptions<T>,
  ): Promise<DispatchResult<R>> {
    const queue = this.getQueue(options.queue);
    const queueEvents = this.getOrCreateQueueEvents(options.queue);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const job = await queue.add(
      options.jobName,
      options.data,
      options.jobOptions,
    );
    const returnValue = (await job.waitUntilFinished(
      queueEvents,
      timeoutMs,
    )) as R;

    this.logger.debug(
      { queue: options.queue, jobName: options.jobName, jobId: job.id },
      'Blocking job completed',
    );

    return { jobId: job.id as string, returnValue };
  }

  /**
   * Close all QueueEvents connections on shutdown.
   */
  async onModuleDestroy(): Promise<void> {
    const closeTasks = Array.from(this.queueEvents.values()).map(qe =>
      qe.close(),
    );
    await Promise.all(closeTasks);
    this.queueEvents.clear();
    this.logger.info({}, 'All QueueEvents closed');
  }

  /**
   * Look up a registered queue by name.
   * @throws if the queue has not been registered
   */
  private getQueue(name: string): Queue {
    const queue = this.queues.get(name);
    if (!queue) {
      throw new Error(
        `Queue "${name}" is not registered. Call registerQueue() first.`,
      );
    }
    return queue;
  }

  /**
   * Get or lazily create a QueueEvents instance for blocking dispatch.
   *
   * Each QueueEvents needs its own Redis connection (BullMQ requirement).
   */
  private getOrCreateQueueEvents(name: string): QueueEvents {
    const existing = this.queueEvents.get(name);
    if (existing) return existing;

    const queueEvents = new QueueEvents(name, {
      connection: {
        host: this.configService.get<string>('redis.host'),
        port: this.configService.get<number>('redis.port'),
        password: this.configService.get<string>('redis.password'),
      },
    });

    this.queueEvents.set(name, queueEvents);
    return queueEvents;
  }
}
