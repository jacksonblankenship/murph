import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';

const DEFAULT_PORT = 3000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use pino logger for all NestJS logs
  app.useLogger(app.get(PinoLogger));

  // Keep the process alive on rejections/exceptions we couldn't catch at
  // the call site. The voice gateway's WS message handler is a primary
  // source — under Bun, AbortSignal listeners can throw out of band from
  // any try/catch we wrap around `.abort()`, killing the call mid-session.
  const processLogger = new Logger('Process');
  process.on('unhandledRejection', reason => {
    processLogger.error(
      reason instanceof Error ? reason.stack : String(reason),
      'unhandledRejection',
    );
  });
  process.on('uncaughtException', err => {
    processLogger.error(err.stack ?? err.message, 'uncaughtException');
  });

  // Use raw ws adapter for WebSocket (ConversationRelay)
  app.useWebSocketAdapter(new WsAdapter(app));

  const logger = new Logger('Bootstrap');

  // Enable graceful shutdown
  app.enableShutdownHooks();

  const port = Number(process.env.PORT) || DEFAULT_PORT;
  // Bind to `::` (IPv6 dual-stack) per Railway's NestJS guide. Railway's
  // public proxy connects to upstream over IPv4 while the private network
  // and healthchecks use IPv6 — listening on `::` accepts both via
  // IPV6_V6ONLY=0. Without an explicit host, runtime defaults vary
  // (Bun in particular can leave the listener IPv6-only, which 502s the
  // public proxy with "connection refused").
  await app.listen(port, '::');

  logger.log(`Murph listening on [::]:${port}`);
}

bootstrap();
