import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { ToolDependencies } from '../channels/channel.types';
import { createAgentTool, createBlockingAgentTool } from './create-agent-tool';

describe('createAgentTool', () => {
  let mockDispatcher: {
    dispatch: ReturnType<typeof mock>;
    dispatchAndWait: ReturnType<typeof mock>;
  };

  const deps: ToolDependencies = { userId: 42, chatId: 100 };

  beforeEach(() => {
    mockDispatcher = {
      dispatch: mock(() => Promise.resolve('job-1')),
      dispatchAndWait: mock(() =>
        Promise.resolve({ jobId: 'job-1', returnValue: 'result-data' }),
      ),
    };
  });

  describe('fire-and-forget', () => {
    test('calls dispatcher.dispatch with built job data', async () => {
      const toolFactory = createAgentTool(mockDispatcher as never, {
        description: 'Test tool',
        inputSchema: z.object({ message: z.string() }),
        queue: 'test-queue',
        jobName: 'do-thing',
        buildJobData: (input, d) => ({
          ...input,
          userId: d.userId,
        }),
      });

      const t = toolFactory(deps);
      const result = await t.execute(
        { message: 'hello' },
        { abortSignal: undefined as never, toolCallId: 'tc-1', messages: [] },
      );

      expect(result).toBe('Noted.');
      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);

      const call = mockDispatcher.dispatch.mock.calls[0][0];
      expect(call.queue).toBe('test-queue');
      expect(call.jobName).toBe('do-thing');
      expect(call.data).toEqual({ message: 'hello', userId: 42 });
    });

    test('returns custom immediateResponse when configured', async () => {
      const toolFactory = createAgentTool(mockDispatcher as never, {
        description: 'Test tool',
        inputSchema: z.object({ x: z.number() }),
        queue: 'q',
        jobName: 'j',
        buildJobData: input => input,
        immediateResponse: 'Got it!',
      });

      const t = toolFactory(deps);
      const result = await t.execute(
        { x: 1 },
        { abortSignal: undefined as never, toolCallId: 'tc-1', messages: [] },
      );

      expect(result).toBe('Got it!');
    });

    test('passes jobOptions to dispatcher', async () => {
      const toolFactory = createAgentTool(mockDispatcher as never, {
        description: 'Test tool',
        inputSchema: z.object({ x: z.number() }),
        queue: 'q',
        jobName: 'j',
        buildJobData: input => input,
        jobOptions: { delay: 5000 },
      });

      const t = toolFactory(deps);
      await t.execute(
        { x: 1 },
        { abortSignal: undefined as never, toolCallId: 'tc-1', messages: [] },
      );

      const call = mockDispatcher.dispatch.mock.calls[0][0];
      expect(call.jobOptions).toEqual({ delay: 5000 });
    });

    test('buildJobData receives correct deps', async () => {
      const buildJobData = mock(
        (input: { val: string }, d: ToolDependencies) => ({
          ...input,
          uid: d.userId,
          cid: d.chatId,
        }),
      );

      const toolFactory = createAgentTool(mockDispatcher as never, {
        description: 'Test',
        inputSchema: z.object({ val: z.string() }),
        queue: 'q',
        jobName: 'j',
        buildJobData,
      });

      const t = toolFactory(deps);
      await t.execute(
        { val: 'test' },
        { abortSignal: undefined as never, toolCallId: 'tc-1', messages: [] },
      );

      expect(buildJobData).toHaveBeenCalledWith({ val: 'test' }, deps);
    });
  });

  describe('blocking', () => {
    test('calls dispatcher.dispatchAndWait and formats result', async () => {
      const toolFactory = createBlockingAgentTool(mockDispatcher as never, {
        description: 'Blocking test',
        inputSchema: z.object({ query: z.string() }),
        queue: 'blocking-q',
        jobName: 'compute',
        buildJobData: (input, d) => ({ ...input, userId: d.userId }),
        timeoutMs: 10_000,
        formatResult: (val: string) => `Result: ${val}`,
      });

      const t = toolFactory(deps);
      const result = await t.execute(
        { query: 'what?' },
        { abortSignal: undefined as never, toolCallId: 'tc-1', messages: [] },
      );

      expect(result).toBe('Result: result-data');
      expect(mockDispatcher.dispatchAndWait).toHaveBeenCalledTimes(1);

      const call = mockDispatcher.dispatchAndWait.mock.calls[0][0];
      expect(call.queue).toBe('blocking-q');
      expect(call.jobName).toBe('compute');
      expect(call.data).toEqual({ query: 'what?', userId: 42 });
      expect(call.timeoutMs).toBe(10_000);
    });
  });
});
