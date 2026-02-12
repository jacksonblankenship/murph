import { describe, expect, test } from 'bun:test';
import { HangUpToolFactory } from './hang-up.factory';

describe('HangUpToolFactory', () => {
  const factory = new HangUpToolFactory();

  test('creates a hang_up tool', () => {
    const tools = factory.create({ userId: 123 });

    expect(tools).toHaveProperty('hang_up');
    expect(tools.hang_up).toBeDefined();
  });

  test('hang_up tool executes and returns confirmation', async () => {
    const tools = factory.create({ userId: 123 });
    const result = await tools.hang_up.execute(
      {},
      { toolCallId: 'test', messages: [], abortSignal: undefined as never },
    );

    expect(result).toBe('Call ended.');
  });
});
