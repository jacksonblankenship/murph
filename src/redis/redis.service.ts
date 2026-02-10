import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

/** Base delay multiplier (ms) for Redis reconnection attempts */
const RETRY_BASE_DELAY_MS = 50;
/** Maximum delay (ms) between Redis reconnection attempts */
const RETRY_MAX_DELAY_MS = 2000;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis;

  constructor(
    private readonly logger: PinoLogger,
    private configService: ConfigService,
  ) {
    this.logger.setContext(RedisService.name);
    this.client = new Redis({
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
      password: this.configService.get<string>('redis.password'),
      retryStrategy: times => {
        const delay = Math.min(times * RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS);
        return delay;
      },
      lazyConnect: false,
    });

    this.client.on('error', error => {
      this.logger.error({ err: error }, 'Redis connection error');
    });

    this.client.on('connect', () => {
      this.logger.info({}, 'Redis connected successfully');
    });
  }

  getClient(): Redis {
    return this.client;
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
