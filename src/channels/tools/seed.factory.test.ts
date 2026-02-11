import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { SeedToolFactory } from './seed.factory';

describe('SeedToolFactory', () => {
  let mockDispatcher: { dispatch: ReturnType<typeof mock> };
  let factory: SeedToolFactory;

  beforeEach(() => {
    mockDispatcher = {
      dispatch: mock(() => Promise.resolve('job-1')),
    };

    factory = new SeedToolFactory(mockDispatcher as never);
  });

  test('creates a note_something tool', () => {
    const tools = factory.create({ userId: 123 });
    expect(tools.note_something).toBeDefined();
  });

  test('note_something dispatches job with correct payload', async () => {
    const tools = factory.create({ userId: 42 });

    const result = await tools.note_something.execute(
      {
        description: 'Jackson prefers oat milk',
        conversationContext: 'Discussing coffee preferences',
      },
      { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
    );

    expect(result).toBe('Noted.');
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);

    const call = mockDispatcher.dispatch.mock.calls[0][0] as {
      queue: string;
      jobName: string;
      data: {
        description: string;
        conversationContext: string;
        userId: number;
        createdAt: string;
      };
    };
    expect(call.queue).toBe('garden-seeder');
    expect(call.jobName).toBe('seed');
    expect(call.data.description).toBe('Jackson prefers oat milk');
    expect(call.data.conversationContext).toBe('Discussing coffee preferences');
    expect(call.data.userId).toBe(42);
    expect(call.data.createdAt).toBeDefined();
  });

  test('returns immediately without waiting for job processing', async () => {
    /** Simulate a dispatcher that takes time (but the factory shouldn't block) */
    mockDispatcher.dispatch = mock(
      () =>
        new Promise(resolve => {
          setTimeout(() => resolve('job-1'), 10);
        }),
    );

    factory = new SeedToolFactory(mockDispatcher as never);
    const tools = factory.create({ userId: 1 });

    const result = await tools.note_something.execute(
      {
        description: 'Test signal',
        conversationContext: 'Test context',
      },
      { abortSignal: undefined as never, toolCallId: 'test', messages: [] },
    );

    expect(result).toBe('Noted.');
  });
});
