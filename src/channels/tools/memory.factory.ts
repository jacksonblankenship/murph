import { Injectable } from '@nestjs/common';
import type { Tool } from 'ai';
import { createGardenTools } from '../../ai/tools/memory.tools';
import { ObsidianService } from '../../obsidian/obsidian.service';
import { IndexSyncProcessor } from '../../sync/index-sync.processor';
import { EmbeddingService } from '../../vector/embedding.service';
import { QdrantService } from '../../vector/qdrant.service';
import type { ToolDependencies, ToolFactory } from '../channel.types';

/**
 * Factory for digital garden tools.
 *
 * Creates tools for planting, tending, and cultivating knowledge
 * stored in Obsidian and indexed in Qdrant.
 */
@Injectable()
export class MemoryToolFactory implements ToolFactory {
  constructor(
    private readonly obsidianService: ObsidianService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantService,
    private readonly indexSyncProcessor: IndexSyncProcessor,
  ) {}

  create(_deps: ToolDependencies): Record<string, Tool> {
    return createGardenTools({
      obsidianService: this.obsidianService,
      embeddingService: this.embeddingService,
      qdrantService: this.qdrantService,
      indexSyncProcessor: this.indexSyncProcessor,
    });
  }
}
