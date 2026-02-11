import { type Tool, tool } from 'ai';
import type { JobsOptions } from 'bullmq';
import type { z } from 'zod';
import type { ToolDependencies } from '../channels/channel.types';
import type { AgentDispatcher } from './agent-dispatcher.service';

/**
 * Configuration for a fire-and-forget agent tool.
 */
export interface AgentToolConfig<TInput, TJobData> {
  /** Tool description shown to the LLM */
  description: string;
  /** Zod schema for tool input validation */
  inputSchema: z.ZodType<TInput>;
  /** Registered queue name to dispatch to */
  queue: string;
  /** BullMQ job name */
  jobName: string;
  /** Transform tool input + dependencies into the job payload */
  buildJobData: (input: TInput, deps: ToolDependencies) => TJobData;
  /** Optional BullMQ job options */
  jobOptions?: JobsOptions;
  /** Response returned to the LLM immediately (default: "Noted.") */
  immediateResponse?: string;
}

/**
 * Configuration for a blocking agent tool that waits for the processor result.
 */
export interface BlockingAgentToolConfig<TInput, TJobData, TResult>
  extends AgentToolConfig<TInput, TJobData> {
  /** Maximum time to wait for the job to finish */
  timeoutMs?: number;
  /** Format the processor return value into a string for the LLM */
  formatResult: (returnValue: TResult) => string;
}

/**
 * Create a fire-and-forget agent tool.
 *
 * Dispatches a job to a BullMQ queue and returns an immediate response
 * without waiting for the processor to finish.
 *
 * @param dispatcher The AgentDispatcher service
 * @param config Tool configuration
 * @returns A function that takes ToolDependencies and returns a named Tool record
 */
export function createAgentTool<TInput, TJobData>(
  dispatcher: AgentDispatcher,
  config: AgentToolConfig<TInput, TJobData>,
): (deps: ToolDependencies) => Tool {
  const immediateResponse = config.immediateResponse ?? 'Noted.';

  return (deps: ToolDependencies) =>
    tool({
      description: config.description,
      inputSchema: config.inputSchema,
      execute: async (input: TInput) => {
        await dispatcher.dispatch({
          queue: config.queue,
          jobName: config.jobName,
          data: config.buildJobData(input, deps),
          jobOptions: config.jobOptions,
        });
        return immediateResponse;
      },
    });
}

/**
 * Create a blocking agent tool that waits for the processor result.
 *
 * Dispatches a job to a BullMQ queue and blocks until the processor
 * returns a value, then formats it as the tool response.
 *
 * @param dispatcher The AgentDispatcher service
 * @param config Tool configuration including timeout and result formatter
 * @returns A function that takes ToolDependencies and returns a named Tool record
 */
export function createBlockingAgentTool<TInput, TJobData, TResult>(
  dispatcher: AgentDispatcher,
  config: BlockingAgentToolConfig<TInput, TJobData, TResult>,
): (deps: ToolDependencies) => Tool {
  return (deps: ToolDependencies) =>
    tool({
      description: config.description,
      inputSchema: config.inputSchema,
      execute: async (input: TInput) => {
        const result = await dispatcher.dispatchAndWait<TJobData, TResult>({
          queue: config.queue,
          jobName: config.jobName,
          data: config.buildJobData(input, deps),
          jobOptions: config.jobOptions,
          timeoutMs: config.timeoutMs,
        });
        return config.formatResult(result.returnValue);
      },
    });
}
