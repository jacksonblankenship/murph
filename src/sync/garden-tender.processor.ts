import { createAnthropic } from '@ai-sdk/anthropic';
import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { generateText, stepCountIs, tool } from 'ai';
import { Job, Queue } from 'bullmq';
import matter from 'gray-matter';
import { z } from 'zod';
import { ObsidianService } from '../obsidian/obsidian.service';
import { EmbeddingService } from '../vector/embedding.service';
import { QdrantService } from '../vector/qdrant.service';
import { IndexSyncProcessor } from './index-sync.processor';

interface GardenTendingJob {
  type: 'scheduled-tending';
}

interface NoteMetadata {
  path: string;
  content: string;
  maturity?: string;
  planted?: string;
  lastTended?: string;
  outboundLinks: string[];
  inboundLinks: string[];
}

@Processor('garden-tending')
@Injectable()
export class GardenTenderProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(GardenTenderProcessor.name);
  private readonly enabled: boolean;
  private model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(
    @InjectQueue('garden-tending')
    private readonly tendingQueue: Queue<GardenTendingJob>,
    private readonly obsidianService: ObsidianService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantService,
    private readonly indexSyncProcessor: IndexSyncProcessor,
    private readonly configService: ConfigService,
  ) {
    super();
    this.enabled = this.configService.get<boolean>('gardenTending.enabled');

    const anthropicProvider = createAnthropic({
      apiKey: this.configService.get<string>('anthropic.apiKey'),
    });
    this.model = anthropicProvider('claude-sonnet-4-20250514');
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Garden tending is disabled');
      return;
    }

    this.logger.log('Garden tending scheduled via @Cron (daily at 3am)');
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async scheduledTending(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await this.queueTendingJob();
  }

  async queueTendingJob(): Promise<void> {
    await this.tendingQueue.add('scheduled-tending', {
      type: 'scheduled-tending',
    });
    this.logger.log('Queued garden tending job');
  }

  async process(job: Job<GardenTendingJob>): Promise<void> {
    this.logger.log('Starting garden tending session...');

    try {
      // Build garden metadata
      const garden = await this.buildGardenMetadata();

      if (garden.length === 0) {
        this.logger.log('Garden is empty, nothing to tend');
        return;
      }

      // Use LLM with curator prompt to analyze and tend the garden
      await this.tendGarden(garden);

      this.logger.log('Garden tending session complete');
    } catch (error) {
      this.logger.error('Error during garden tending:', error.message);
      throw error;
    }
  }

  private async buildGardenMetadata(): Promise<NoteMetadata[]> {
    const notes = await this.obsidianService.getAllNotesWithContent();
    const metadata: NoteMetadata[] = [];

    // First pass: extract all note data
    for (const note of notes) {
      const parsed = matter(note.content);
      const outboundLinks = this.extractWikilinks(parsed.content);

      metadata.push({
        path: note.path,
        content: parsed.content,
        maturity: parsed.data.maturity as string | undefined,
        planted: parsed.data.planted as string | undefined,
        lastTended: parsed.data['last-tended'] as string | undefined,
        outboundLinks,
        inboundLinks: [], // Populated in second pass
      });
    }

    // Second pass: calculate inbound links
    const pathSet = new Set(metadata.map(m => m.path.replace(/\.md$/, '')));
    for (const note of metadata) {
      for (const outbound of note.outboundLinks) {
        // Find the target note and add this as an inbound link
        const target = metadata.find(
          m => m.path.replace(/\.md$/, '') === outbound,
        );
        if (target) {
          target.inboundLinks.push(note.path.replace(/\.md$/, ''));
        }
      }
    }

    return metadata;
  }

  private extractWikilinks(content: string): string[] {
    const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    const links: string[] = [];
    let match = wikilinkRegex.exec(content);

    while (match !== null) {
      links.push(match[1]);
      match = wikilinkRegex.exec(content);
    }

    return [...new Set(links)];
  }

  private async tendGarden(garden: NoteMetadata[]): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const staleDate = thirtyDaysAgo.toISOString().split('T')[0];

    // Build garden summary for curator
    const orphans = garden.filter(
      n => n.inboundLinks.length === 0 && n.outboundLinks.length === 0,
    );
    const staleNotes = garden.filter(
      n => n.lastTended && n.lastTended < staleDate,
    );
    const seedlings = garden.filter(n => n.maturity === 'seedling');
    const wellLinked = garden.filter(
      n =>
        n.maturity === 'seedling' &&
        n.inboundLinks.length >= 2 &&
        n.outboundLinks.length >= 1,
    );

    const gardenSummary = `
# Garden Status

Total notes: ${garden.length}
Orphans (no links): ${orphans.length}
Stale notes (not tended in 30+ days): ${staleNotes.length}
Seedlings: ${seedlings.length}
Well-linked seedlings (ready for promotion): ${wellLinked.length}

## Orphan Notes
${orphans.map(n => `- ${n.path}`).join('\n') || 'None'}

## Stale Notes
${staleNotes.map(n => `- ${n.path} (last tended: ${n.lastTended})`).join('\n') || 'None'}

## Well-Linked Seedlings (Consider Promoting to Budding)
${wellLinked.map(n => `- ${n.path} (${n.inboundLinks.length} inbound, ${n.outboundLinks.length} outbound)`).join('\n') || 'None'}

## All Notes with Link Counts
${garden.map(n => `- ${n.path} [${n.maturity || 'unknown'}] (in: ${n.inboundLinks.length}, out: ${n.outboundLinks.length})`).join('\n')}
`;

    const curatorPrompt = `You are a digital garden curator. Your job is to maintain the health and quality of this knowledge garden.

Today's date: ${today}

Your available actions:
1. **promote_maturity** - Upgrade well-linked seedlings to budding or budding to evergreen
2. **add_links** - Add wikilinks to orphan notes to connect them to the garden
3. **merge_notes** - Consolidate duplicate or overlapping notes
4. **delete_note** - Remove truly orphaned, empty, or obsolete notes

Guidelines:
- Be conservative with deletions - only delete truly empty or obsolete notes
- Promote notes that have good incoming and outgoing links
- When adding links, think about what related topics exist in the garden
- Merge notes that cover the same topic
- Focus on the most impactful improvements first

Review the garden status and take appropriate tending actions.`;

    await generateText({
      model: this.model,
      maxOutputTokens: 4096,
      system: curatorPrompt,
      messages: [
        {
          role: 'user',
          content: gardenSummary,
        },
      ],
      tools: {
        promote_maturity: tool({
          description:
            'Promote a note to a higher maturity level (seedling -> budding -> evergreen)',
          inputSchema: z.object({
            path: z.string().describe('Note path'),
            newMaturity: z
              .enum(['budding', 'evergreen'])
              .describe('New maturity level'),
            reason: z.string().describe('Brief reason for promotion'),
          }),
          execute: async ({ path, newMaturity, reason }) => {
            try {
              const note = await this.obsidianService.readNote(path);
              if (!note) {
                return `Note not found: ${path}`;
              }

              const parsed = matter(note.content);
              const newContent = matter.stringify(parsed.content, {
                ...parsed.data,
                maturity: newMaturity,
                'last-tended': today,
              });

              await this.obsidianService.writeNote(
                path.replace(/\.md$/, ''),
                newContent,
              );
              await this.indexSyncProcessor.queueSingleNote(path, newContent);

              this.logger.log(`Promoted ${path} to ${newMaturity}: ${reason}`);
              return `Promoted ${path} to ${newMaturity}`;
            } catch (error) {
              return `Error promoting note: ${error.message}`;
            }
          },
        }),
        add_links: tool({
          description: 'Add wikilinks to a note to connect it to related notes',
          inputSchema: z.object({
            path: z.string().describe('Note path'),
            linksToAdd: z
              .array(z.string())
              .describe('List of note names to link to (without [[]])'),
          }),
          execute: async ({ path, linksToAdd }) => {
            try {
              const note = await this.obsidianService.readNote(path);
              if (!note) {
                return `Note not found: ${path}`;
              }

              const parsed = matter(note.content);
              const linkSection = `\n\n## Related\n${linksToAdd.map(l => `- [[${l}]]`).join('\n')}`;

              const newContent = matter.stringify(
                parsed.content.trim() + linkSection,
                {
                  ...parsed.data,
                  'last-tended': today,
                },
              );

              await this.obsidianService.writeNote(
                path.replace(/\.md$/, ''),
                newContent,
              );
              await this.indexSyncProcessor.queueSingleNote(path, newContent);

              this.logger.log(`Added ${linksToAdd.length} links to ${path}`);
              return `Added links to ${path}: ${linksToAdd.join(', ')}`;
            } catch (error) {
              return `Error adding links: ${error.message}`;
            }
          },
        }),
        merge_notes: tool({
          description:
            'Merge the content of a source note into a target note, then delete the source',
          inputSchema: z.object({
            sourcePath: z
              .string()
              .describe('Note to merge from (will be deleted)'),
            targetPath: z.string().describe('Note to merge into'),
            reason: z.string().describe('Brief reason for merge'),
          }),
          execute: async ({ sourcePath, targetPath, reason }) => {
            try {
              const sourceNote =
                await this.obsidianService.readNote(sourcePath);
              const targetNote =
                await this.obsidianService.readNote(targetPath);

              if (!sourceNote) {
                return `Source note not found: ${sourcePath}`;
              }
              if (!targetNote) {
                return `Target note not found: ${targetPath}`;
              }

              const sourceParsed = matter(sourceNote.content);
              const targetParsed = matter(targetNote.content);

              // Merge content
              const mergedContent = `${targetParsed.content.trim()}\n\n---\n*Merged from ${sourcePath}:*\n\n${sourceParsed.content.trim()}`;

              const newContent = matter.stringify(mergedContent, {
                ...targetParsed.data,
                'last-tended': today,
              });

              // Write merged content
              await this.obsidianService.writeNote(
                targetPath.replace(/\.md$/, ''),
                newContent,
              );
              await this.indexSyncProcessor.queueSingleNote(
                targetPath,
                newContent,
              );

              // Delete source
              await this.obsidianService.deleteNote(sourcePath);
              await this.qdrantService.deleteNote(sourcePath);

              this.logger.log(
                `Merged ${sourcePath} into ${targetPath}: ${reason}`,
              );
              return `Merged ${sourcePath} into ${targetPath}`;
            } catch (error) {
              return `Error merging notes: ${error.message}`;
            }
          },
        }),
        delete_note: tool({
          description:
            'Delete a note from the garden. Use sparingly - only for truly obsolete or empty notes.',
          inputSchema: z.object({
            path: z.string().describe('Note path to delete'),
            reason: z.string().describe('Brief reason for deletion'),
          }),
          execute: async ({ path, reason }) => {
            try {
              await this.obsidianService.deleteNote(path);
              await this.qdrantService.deleteNote(path);

              this.logger.log(`Deleted ${path}: ${reason}`);
              return `Deleted ${path}`;
            } catch (error) {
              return `Error deleting note: ${error.message}`;
            }
          },
        }),
        read_note: tool({
          description:
            'Read the full content of a note to make better decisions',
          inputSchema: z.object({
            path: z.string().describe('Note path'),
          }),
          execute: async ({ path }) => {
            try {
              const note = await this.obsidianService.readNote(path);
              if (!note) {
                return `Note not found: ${path}`;
              }
              return note.content;
            } catch (error) {
              return `Error reading note: ${error.message}`;
            }
          },
        }),
        find_similar: tool({
          description:
            'Find notes similar to a given topic (for identifying duplicates)',
          inputSchema: z.object({
            query: z.string().describe('Topic to search for'),
            limit: z.number().optional().default(5).describe('Max results'),
          }),
          execute: async ({ query, limit = 5 }) => {
            try {
              const embedding = await this.embeddingService.embed(query);
              const results = await this.qdrantService.searchSimilar(
                embedding,
                limit,
              );

              if (results.length === 0) {
                return 'No similar notes found.';
              }

              return results
                .map(
                  r =>
                    `- ${r.path} (similarity: ${(r.score * 100).toFixed(1)}%)`,
                )
                .join('\n');
            } catch (error) {
              return `Error searching: ${error.message}`;
            }
          },
        }),
      },
      stopWhen: stepCountIs(15), // Allow more iterations for tending
    });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Garden tending job ${job.id} completed`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Garden tending job ${job.id} failed:`, error.message);
  }
}
