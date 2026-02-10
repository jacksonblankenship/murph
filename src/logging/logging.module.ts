import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Global, Module, RequestMethod } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { TransportTargetOptions } from 'pino';

const isProd = process.env.NODE_ENV === 'production';
const usePrettyLogs = process.env.LOG_PRETTY === 'true' || !isProd;
const enableFileLogging = process.env.LOG_FILE === 'true';
const logDir = process.env.LOG_DIR || './logs';
const logLevel = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

// Ensure log directory exists if file logging is enabled
if (enableFileLogging && !existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

/**
 * Build transport targets based on configuration.
 * Supports console (with optional pretty printing) and file logging.
 */
function buildTransportTargets(): TransportTargetOptions[] {
  const targets: TransportTargetOptions[] = [];

  // Console transport (always enabled)
  if (usePrettyLogs) {
    targets.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: false,
        translateTime: 'SYS:standard',
      },
      level: logLevel,
    });
  } else {
    targets.push({
      target: 'pino/file',
      options: { destination: 1 }, // stdout
      level: logLevel,
    });
  }

  // File transport (optional)
  if (enableFileLogging) {
    targets.push({
      target: 'pino/file',
      options: { destination: join(logDir, 'murph.log') },
      level: logLevel,
    });
  }

  return targets;
}

const PinoLoggerModule = LoggerModule.forRoot({
  pinoHttp: {
    level: logLevel,
    transport: { targets: buildTransportTargets() },
    customAttributeKeys: {
      req: 'request',
      res: 'response',
      err: 'error',
    },
    genReqId: req =>
      (req.headers['x-request-id'] as string) || crypto.randomUUID(),
    autoLogging: {
      ignore: req => req.url === '/health/liveness',
    },
    redact: ['request.headers.authorization', 'request.headers["x-api-key"]'],
  },
  exclude: [{ method: RequestMethod.GET, path: '/health/liveness' }],
});

/**
 * Global logging module that makes PinoLogger available throughout the application.
 *
 * Configuration via environment variables:
 * - LOG_LEVEL: Log level (default: 'debug' in dev, 'info' in prod)
 * - LOG_PRETTY: Enable pretty printing (default: true in dev)
 * - LOG_FILE: Enable file logging (default: false)
 * - LOG_DIR: Directory for log files (default: './logs')
 */
@Global()
@Module({
  imports: [PinoLoggerModule],
  exports: [PinoLoggerModule],
})
export class LoggingModule {}
