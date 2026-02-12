import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { QdrantHealthIndicator } from './qdrant.health';
import { RedisHealthIndicator } from './redis.health';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly redis: RedisHealthIndicator,
    private readonly qdrant: QdrantHealthIndicator,
  ) {}

  /**
   * Liveness probe — is the process alive and accepting HTTP requests?
   * No dependency checks; returns 200 if NestJS is running.
   */
  @Get('liveness')
  @HealthCheck()
  liveness() {
    return this.health.check([]);
  }

  /**
   * Readiness probe — can we handle traffic?
   * Checks Redis and Qdrant connectivity.
   */
  @Get('readiness')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.redis.isHealthy('redis'),
      () => this.qdrant.isHealthy('qdrant'),
    ]);
  }
}
