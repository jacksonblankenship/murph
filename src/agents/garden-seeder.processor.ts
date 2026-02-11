import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { LlmService } from '../ai/llm.service';
import { createCoreTools } from '../ai/tools/garden/core.tools';
import { createDiscoveryTools } from '../ai/tools/garden/discovery.tools';
import type { GardenToolsDependencies } from '../ai/tools/garden/types';
import type { GardenSeedJob } from '../channels/tools/seed.factory';
import { formatObsidianDate } from '../common/obsidian-date';
import { PromptService } from '../prompts';
import { IndexSyncProcessor } from '../sync/index-sync.processor';
import { VaultService } from '../vault';
import { EmbeddingService } from '../vector/embedding.service';
import { QdrantService } from '../vector/qdrant.service';

/** Maximum agent steps during seeding */
const MAX_SEEDING_STEPS = 10;

/**
 * BullMQ processor for the garden seeder sub-agent.
 *
 * Receives seed jobs from Murph's `note_something` tool and uses an LLM
 * with core + discovery garden tools to decide what to do: plant a new note,
 * update an existing one, or skip entirely.
 *
 * Operates silently — no output to the user.
 */
@Processor('garden-seeder')
@Injectable()
export class GardenSeederProcessor extends WorkerHost {
  constructor(
    private readonly logger: PinoLogger,
    private readonly llmService: LlmService,
    private readonly promptService: PromptService,
    private readonly vaultService: VaultService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantService,
    private readonly indexSyncProcessor: IndexSyncProcessor,
  ) {
    super();
    this.logger.setContext(GardenSeederProcessor.name);
  }

  async process(job: Job<GardenSeedJob>): Promise<void> {
    const { description, conversationContext } = job.data;

    this.logger.info({ jobId: job.id, description }, 'Processing garden seed');

    const today = formatObsidianDate();
    const tools = this.buildTools();

    await this.llmService.generate({
      system: this.promptService.render('garden-seeder', { today }),
      messages: [
        {
          role: 'user' as const,
          content: this.buildUserMessage(description, conversationContext),
        },
      ],
      tools,
      maxSteps: MAX_SEEDING_STEPS,
    });

    this.logger.info({ jobId: job.id }, 'Garden seed processed');
  }

  /**
   * Builds the user message from the seed job data.
   */
  private buildUserMessage(
    description: string,
    conversationContext: string,
  ): string {
    return `## Signal

${description}

## Conversation Context

${conversationContext}`;
  }

  /**
   * Builds core + discovery garden tools for the seeder.
   */
  private buildTools() {
    const deps: GardenToolsDependencies = {
      vaultService: this.vaultService,
      embeddingService: this.embeddingService,
      qdrantService: this.qdrantService,
      indexSyncProcessor: this.indexSyncProcessor,
    };

    return {
      ...createCoreTools(deps),
      ...createDiscoveryTools(deps),
    };
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug({ jobId: job.id }, 'Garden seed job completed');
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error({ err: error, jobId: job.id }, 'Garden seed job failed');
  }
}
