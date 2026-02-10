import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';

const DEFAULT_PORT = 3000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use pino logger for all NestJS logs
  app.useLogger(app.get(PinoLogger));

  const logger = new Logger('Bootstrap');

  // Enable graceful shutdown
  app.enableShutdownHooks();

  const port = process.env.PORT || DEFAULT_PORT;
  await app.listen(port);

  logger.log('Telegram bot is running...');
}

bootstrap();
