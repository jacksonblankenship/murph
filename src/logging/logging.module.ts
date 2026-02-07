import { RequestMethod } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

const isProd = process.env.NODE_ENV === 'production';
const usePrettyLogs = process.env.LOG_PRETTY === 'true' || !isProd;

export const LoggingModule = LoggerModule.forRoot({
  pinoHttp: {
    level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    transport: usePrettyLogs
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: false,
            translateTime: 'SYS:standard',
          },
        }
      : undefined,
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
