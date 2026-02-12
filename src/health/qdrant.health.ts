import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { QdrantService } from '../vector/qdrant.service';

@Injectable()
export class QdrantHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly qdrantService: QdrantService,
  ) {}

  /**
   * Checks Qdrant connectivity by listing collections.
   * Returns healthy when Qdrant responds without error.
   */
  async isHealthy(key: string) {
    const indicator = this.healthIndicatorService.check(key);

    try {
      await this.qdrantService.ping();
      return indicator.up();
    } catch (error) {
      return indicator.down({ message: `Qdrant ping failed: ${error}` });
    }
  }
}
