import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  // Graceful shutdown handlers
  process.once('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await app.close();
    process.exit(0);
  });

  process.once('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    await app.close();
    process.exit(0);
  });

  console.log('🤖 Telegram bot is running...');
}

bootstrap();
