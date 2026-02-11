import type { IndexSyncProcessor } from '../../../sync/index-sync.processor';
import type { VaultService } from '../../../vault';
import type { EmbeddingService } from '../../../vector/embedding.service';
import type { QdrantService } from '../../../vector/qdrant.service';

/**
 * Dependencies required by garden tools.
 *
 * These services provide access to the knowledge base storage,
 * vector search, and synchronization capabilities.
 */
export interface GardenToolsDependencies {
  vaultService: VaultService;
  embeddingService: EmbeddingService;
  qdrantService: QdrantService;
  indexSyncProcessor: IndexSyncProcessor;
}
