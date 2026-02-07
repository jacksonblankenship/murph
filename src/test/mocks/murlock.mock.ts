import { mock } from 'bun:test';

/**
 * Creates a mock MurlockService for testing.
 *
 * The MurLock decorator requires a `murlockServiceDecorator` property
 * to be injected into the service. This mock provides a no-op implementation
 * that allows the decorated methods to execute without actual locking.
 */
export function createMockMurlockService() {
  return {
    options: {
      lockKeyPrefix: 'test-lock',
      wait: 1000,
      maxAttempts: 3,
    },
    lock: mock(async () => ({
      unlock: mock(async () => {}),
    })),
    runWithLock: mock(
      async <T>(
        _lockKey: string,
        _releaseTime: number,
        _wait: number,
        callback: () => Promise<T>,
      ): Promise<T> => {
        // Execute the callback directly without actual locking
        return callback();
      },
    ),
  };
}

/**
 * Injects the mock murlock service into a class instance.
 *
 * Usage:
 * ```ts
 * const service = new SchedulerService(...);
 * injectMurlockService(service);
 * ```
 */
export function injectMurlockService<T>(
  instance: T,
  murlockService = createMockMurlockService(),
): T {
  (
    instance as unknown as { murlockServiceDecorator: unknown }
  ).murlockServiceDecorator = murlockService;
  return instance;
}
