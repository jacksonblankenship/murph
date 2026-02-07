import KeyvRedis from '@keyv/redis';
import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    NestCacheModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const host = configService.get<string>('redis.host');
        const port = configService.get<number>('redis.port');
        const password = configService.get<string>('redis.password');

        const redisUrl = password
          ? `redis://:${password}@${host}:${port}`
          : `redis://${host}:${port}`;

        const redisStore = new KeyvRedis(redisUrl);

        return {
          store: redisStore,
          ttl: 300000, // 5 minutes default
          namespace: 'murph-cache',
        };
      },
      inject: [ConfigService],
      isGlobal: true,
    }),
  ],
})
export class CacheModule {}
