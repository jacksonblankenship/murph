import { Injectable } from '@nestjs/common';
import type { Tool } from 'ai';
import { createGardenTools } from '../../ai/tools/garden';
import { IndexSyncProcessor } from '../../sync/index-sync.processor';
import { VaultService } from '../../vault';
import { EmbeddingService } from '../../vector/embedding.service';
import { QdrantService } from '../../vector/qdrant.service';
import type { ToolDependencies, ToolFactory } from '../channel.types';

/**
 * Factory for the full digital garden tool set.
 *
 * Creates all 24 tools for planting, tending, and cultivating knowledge
 * stored in the vault and indexed in Qdrant. Used by the garden tender.
 */
@Injectable()
export class GardenToolFactory implements ToolFactory {
  constructor(
    private readonly vaultService: VaultService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantService,
    private readonly indexSyncProcessor: IndexSyncProcessor,
  ) {}

  create(_deps: ToolDependencies): Record<string, Tool> {
    return createGardenTools({
      vaultService: this.vaultService,
      embeddingService: this.embeddingService,
      qdrantService: this.qdrantService,
      indexSyncProcessor: this.indexSyncProcessor,
    });
  }
}
