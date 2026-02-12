import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { RedisModule } from '../redis/redis.module';
import { VectorModule } from '../vector/vector.module';
import { HealthController } from './health.controller';
import { QdrantHealthIndicator } from './qdrant.health';
import { RedisHealthIndicator } from './redis.health';

@Module({
  imports: [TerminusModule, RedisModule, VectorModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator, QdrantHealthIndicator],
})
export class HealthModule {}
