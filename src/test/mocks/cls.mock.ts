import { mock } from 'bun:test';

/**
 * Creates a mock AppClsService for testing.
 */
export function createMockClsService() {
  const store = new Map<string, unknown>();

  return {
    setUserId: mock((userId: number) => store.set('userId', userId)),
    getUserId: mock(() => store.get('userId') as number | undefined),
    requireUserId: mock(() => {
      const userId = store.get('userId') as number | undefined;
      if (userId === undefined) {
        throw new Error('userId not available in CLS context');
      }
      return userId;
    }),
    setChatId: mock((chatId: number) => store.set('chatId', chatId)),
    getChatId: mock(() => store.get('chatId') as number | undefined),
    runWithContext: mock(
      async <T>(
        context: { userId: number; chatId?: number },
        callback: () => Promise<T>,
      ): Promise<T> => {
        store.set('userId', context.userId);
        if (context.chatId !== undefined) {
          store.set('chatId', context.chatId);
        }
        return callback();
      },
    ),
    // Helper for tests to reset state
    _reset: () => store.clear(),
  };
}
