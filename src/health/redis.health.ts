import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Checks Redis connectivity by issuing a PING command.
   * Returns healthy when the response is 'PONG'.
   */
  async isHealthy(key: string) {
    const indicator = this.healthIndicatorService.check(key);

    try {
      const response = await this.redisService.getClient().ping();
      if (response !== 'PONG') {
        return indicator.down({ message: `Unexpected response: ${response}` });
      }
      return indicator.up();
    } catch (error) {
      return indicator.down({ message: `Redis ping failed: ${error}` });
    }
  }
}
