import type { JobsOptions } from 'bullmq';

/**
 * Options for dispatching a fire-and-forget job to a registered queue.
 */
export interface DispatchOptions<T = unknown> {
  /** Registered queue name */
  queue: string;
  /** BullMQ job name */
  jobName: string;
  /** Job payload */
  data: T;
  /** Optional BullMQ job options (deduplication, delay, etc.) */
  jobOptions?: JobsOptions;
}

/**
 * Options for dispatching a job and waiting for its result.
 */
export interface BlockingDispatchOptions<T = unknown>
  extends DispatchOptions<T> {
  /** Maximum time to wait for the job to finish (default 30_000ms) */
  timeoutMs?: number;
}

/**
 * Result from a blocking dispatch call.
 */
export interface DispatchResult<R = unknown> {
  /** BullMQ job ID */
  jobId: string;
  /** Return value from the processor */
  returnValue: R;
}
