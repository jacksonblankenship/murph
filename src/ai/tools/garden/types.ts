import type { ObsidianService } from '../../../obsidian/obsidian.service';
import type { IndexSyncProcessor } from '../../../sync/index-sync.processor';
import type { EmbeddingService } from '../../../vector/embedding.service';
import type { QdrantService } from '../../../vector/qdrant.service';

/**
 * Dependencies required by garden tools.
 *
 * These services provide access to the knowledge base storage,
 * vector search, and synchronization capabilities.
 */
export interface GardenToolsDependencies {
  obsidianService: ObsidianService;
  embeddingService: EmbeddingService;
  qdrantService: QdrantService;
  indexSyncProcessor: IndexSyncProcessor;
}
