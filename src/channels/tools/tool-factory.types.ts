import type { AppClsService } from '../../common/cls.service';
import type { ExaService } from '../../exa/exa.service';
import type { ObsidianService } from '../../obsidian/obsidian.service';
import type { SchedulerService } from '../../scheduler/scheduler.service';
import type { IndexSyncProcessor } from '../../sync/index-sync.processor';
import type { EmbeddingService } from '../../vector/embedding.service';
import type { QdrantService } from '../../vector/qdrant.service';

/**
 * Typed dependencies for tool factories.
 *
 * Each tool factory may require different services. The orchestrator
 * provides these dependencies when creating tools.
 */
export interface TypedToolDependencies {
  /** Exa web search service */
  exaService?: ExaService;
  /** Scheduler service for task scheduling */
  schedulerService?: SchedulerService;
  /** CLS service for context access */
  clsService?: AppClsService;
  /** Obsidian vault service */
  obsidianService?: ObsidianService;
  /** Text embedding service */
  embeddingService?: EmbeddingService;
  /** Qdrant vector database service */
  qdrantService?: QdrantService;
  /** Index sync processor for memory indexing */
  indexSyncProcessor?: IndexSyncProcessor;
}
