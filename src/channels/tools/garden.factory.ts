import { Injectable } from '@nestjs/common';
import type { Tool } from 'ai';
import { createCaptureTools, createGardenTools } from '../../ai/tools/garden';
import { ObsidianService } from '../../obsidian/obsidian.service';
import { IndexSyncProcessor } from '../../sync/index-sync.processor';
import { EmbeddingService } from '../../vector/embedding.service';
import { QdrantService } from '../../vector/qdrant.service';
import type { ToolDependencies, ToolFactory } from '../channel.types';

/**
 * Factory for the full digital garden tool set.
 *
 * Creates all 24 tools for planting, tending, and cultivating knowledge
 * stored in Obsidian and indexed in Qdrant. Used by the garden tender.
 */
@Injectable()
export class GardenToolFactory implements ToolFactory {
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

/**
 * Factory for the capture-only garden tool set.
 *
 * Creates 6 tools focused on knowledge capture during conversation:
 * plant, update, recall, read, search_similar, wander.
 *
 * Organizational tools (merge, split, promote, etc.) are excluded —
 * those responsibilities belong to the garden tender.
 */
@Injectable()
export class CaptureToolFactory implements ToolFactory {
  constructor(
    private readonly obsidianService: ObsidianService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantService,
    private readonly indexSyncProcessor: IndexSyncProcessor,
  ) {}

  create(_deps: ToolDependencies): Record<string, Tool> {
    return createCaptureTools({
      obsidianService: this.obsidianService,
      embeddingService: this.embeddingService,
      qdrantService: this.qdrantService,
      indexSyncProcessor: this.indexSyncProcessor,
    });
  }
}
