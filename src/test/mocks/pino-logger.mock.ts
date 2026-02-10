import type { PinoLogger } from 'nestjs-pino';

/**
 * Creates a mock PinoLogger for testing services that use @InjectPinoLogger.
 * All log methods are no-ops to keep tests clean.
 */
export function createMockLogger(): PinoLogger {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    setContext: () => {},
    assign: () => {},
  } as unknown as PinoLogger;
}

export type MockLogger = ReturnType<typeof createMockLogger>;
