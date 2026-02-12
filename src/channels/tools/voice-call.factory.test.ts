import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { VoiceCallToolFactory } from './voice-call.factory';

describe('VoiceCallToolFactory', () => {
  let factory: VoiceCallToolFactory;
  let mockDispatcher: { dispatch: ReturnType<typeof mock> };
  let mockSchedulerService: { scheduleTask: ReturnType<typeof mock> };

  beforeEach(() => {
    mockDispatcher = {
      dispatch: mock(() => Promise.resolve('job-123')),
    };
    mockSchedulerService = {
      scheduleTask: mock(() =>
        Promise.resolve({ taskId: 'task-123', scheduled: true }),
      ),
    };

    factory = new VoiceCallToolFactory(
      mockDispatcher as never,
      mockSchedulerService as never,
    );
  });

  test('creates a call_me tool', () => {
    const tools = factory.create({ userId: 42 });
    expect(tools).toHaveProperty('call_me');
  });

  test('immediate call dispatches to voice-calls queue', async () => {
    const tools = factory.create({ userId: 42 });
    const result = await tools.call_me.execute(
      { immediate: true, context: 'Check in about project' },
      { toolCallId: 'test', messages: [], abortSignal: undefined as never },
    );

    expect(result).toBe('Calling now.');
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
    const call = mockDispatcher.dispatch.mock.calls[0][0] as {
      queue: string;
      data: { userId: number; context: string };
    };
    expect(call.queue).toBe('voice-calls');
    expect(call.data.userId).toBe(42);
    expect(call.data.context).toBe('Check in about project');
  });

  test('scheduled call uses scheduler service', async () => {
    const futureTime = new Date(Date.now() + 3_600_000).toISOString();
    const tools = factory.create({ userId: 42 });
    const result = await tools.call_me.execute(
      {
        immediate: false,
        scheduledTime: futureTime,
        context: 'Morning check-in',
      },
      { toolCallId: 'test', messages: [], abortSignal: undefined as never },
    );

    expect(result).toBe(`Call scheduled for ${futureTime}.`);
    expect(mockSchedulerService.scheduleTask).toHaveBeenCalledTimes(1);
  });

  test('returns error when scheduled time is missing', async () => {
    const tools = factory.create({ userId: 42 });
    const result = await tools.call_me.execute(
      { immediate: false },
      { toolCallId: 'test', messages: [], abortSignal: undefined as never },
    );

    expect(result).toContain('Error');
    expect(result).toContain('scheduledTime is required');
  });

  test('returns error when scheduled time is in the past', async () => {
    const pastTime = new Date(Date.now() - 3_600_000).toISOString();
    const tools = factory.create({ userId: 42 });
    const result = await tools.call_me.execute(
      { immediate: false, scheduledTime: pastTime },
      { toolCallId: 'test', messages: [], abortSignal: undefined as never },
    );

    expect(result).toContain('Error');
    expect(result).toContain('future');
  });
});
