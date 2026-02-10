import { createAnthropic } from '@ai-sdk/anthropic';
import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { generateText, stepCountIs, tool } from 'ai';
import { Job, Queue } from 'bullmq';
import matter from 'gray-matter';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { sanitizePath } from '../ai/tools/garden/utils';
import { formatObsidianDate } from '../common/obsidian-date';
import { ObsidianService } from '../obsidian/obsidian.service';
import { PromptService } from '../prompts';
import { EmbeddingService } from '../vector/embedding.service';
import { QdrantService } from '../vector/qdrant.service';
import { IndexSyncProcessor } from './index-sync.processor';

/** Tolerance in milliseconds for file modification detection (1 minute) */
const MODIFICATION_TOLERANCE_MS = 60_000;
/** Minimum inbound links for a note to be considered an MOC candidate */
const MOC_CANDIDATE_MIN_LINKS = 5;
/** Maximum agent steps during note tending */
const MAX_TENDING_STEPS = 20;
/** Default limit for similar notes search */
const SIMILAR_NOTES_LIMIT = 5;
/** Minimum similarity score for duplicate detection */
const SIMILARITY_THRESHOLD = 0.7;
/** Multiplier for converting decimal scores to percentages */
const PERCENT_MULTIPLIER = 100;
/** Maximum depth for link traversal */
const MAX_TRAVERSE_DEPTH = 3;

interface GardenTendingJob {
  type: 'scheduled-tending';
}

interface NoteMetadata {
  path: string;
  content: string;
  growthStage?: string;
  lastTended?: string;
  outboundLinks: string[];
  inboundLinks: string[];
  isMocCandidate: boolean;
}

/**
 * Represents a note that needs tending because it has been
 * modified since the last time it was tended.
 */
interface TendingCandidate {
  path: string;
  content: string;
  lastModified: Date;
  lastTended: Date | null;
}

/**
 * Represents a broken wikilink pointing to a non-existent note.
 */
interface BrokenLink {
  notePath: string;
  brokenLink: string;
}

/**
 * Background processor for maintaining the digital garden.
 *
 * Runs nightly to promote notes, add links, merge duplicates, split non-atomic
 * notes, and fix broken links. Can also be triggered manually via the /tend command.
 *
 * Only processes files where lastModified > lastTended to avoid infinite loops
 * and unnecessary work.
 */
@Processor('garden-tending')
@Injectable()
export class GardenTenderProcessor extends WorkerHost implements OnModuleInit {
  private readonly enabled: boolean;
  private model: ReturnType<ReturnType<typeof createAnthropic>>;
  private currentJobId: string | null = null;

  constructor(
    private readonly logger: PinoLogger,
    @InjectQueue('garden-tending')
    private readonly tendingQueue: Queue<GardenTendingJob>,
    private readonly obsidianService: ObsidianService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantService,
    private readonly indexSyncProcessor: IndexSyncProcessor,
    private readonly configService: ConfigService,
    private readonly promptService: PromptService,
  ) {
    super();
    this.logger.setContext(GardenTenderProcessor.name);
    this.enabled = this.configService.get<boolean>('gardenTending.enabled');

    const anthropicProvider = createAnthropic({
      apiKey: this.configService.get<string>('anthropic.apiKey'),
    });
    // Use Sonnet for content synthesis - requires understanding and creativity
    this.model = anthropicProvider('claude-sonnet-4-20250514');
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.info({}, 'Garden tending is disabled');
      return;
    }

    this.logger.info({}, 'Garden tending scheduled via @Cron (daily at 3am)');
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
    this.logger.info({}, 'Queued garden tending job');
  }

  /**
   * Manually triggers garden tending.
   *
   * Discards any currently running job before starting a new one.
   */
  async triggerManualTending(): Promise<void> {
    // Discard any running job
    if (this.currentJobId) {
      const activeJobs = await this.tendingQueue.getActive();
      for (const job of activeJobs) {
        if (job.id === this.currentJobId) {
          await job.discard();
          this.logger.info(
            { jobId: job.id },
            'Discarded running garden tending job',
          );
        }
      }
    }

    // Queue new job
    const job = await this.tendingQueue.add('manual-tending', {
      type: 'scheduled-tending',
    });
    this.currentJobId = job.id;
    this.logger.info({ jobId: job.id }, 'Queued manual garden tending job');
  }

  async process(job: Job<GardenTendingJob>): Promise<void> {
    this.currentJobId = job.id;
    this.logger.info({}, 'Starting garden tending session...');

    try {
      const candidates = await this.findCandidatesForTending();

      if (candidates.length === 0) {
        this.logger.info({}, 'No files need tending');
        return;
      }

      this.logger.info(
        { count: candidates.length },
        'Found files needing attention',
      );

      // Build full garden context for linking decisions
      const garden = await this.buildGardenMetadata();
      const brokenLinks = this.findBrokenLinks(garden);

      // Process each candidate individually
      for (const candidate of candidates) {
        await this.tendSingleNote(candidate, garden, brokenLinks);
      }

      this.logger.info({}, 'Garden tending session complete');
    } catch (error) {
      this.logger.error({ err: error }, 'Error during garden tending');
      throw error;
    }
  }

  /**
   * Finds notes that need tending: files modified since last tended,
   * or files that have never been tended.
   */
  private async findCandidatesForTending(): Promise<TendingCandidate[]> {
    const notes = await this.obsidianService.getAllNotesWithContent();
    const candidates: TendingCandidate[] = [];

    for (const note of notes) {
      const parsed = matter(note.content);
      const lastTendedStr = parsed.data.last_tended as string | undefined;
      const lastTended = lastTendedStr ? new Date(lastTendedStr) : null;
      const lastModified = await this.obsidianService.getModifiedDate(
        note.path,
      );

      if (!lastModified) {
        continue;
      }

      // Add tolerance to account for the time between capturing
      // the timestamp and writing the file (which updates mtime)
      const toleranceMs = MODIFICATION_TOLERANCE_MS;
      const lastTendedWithTolerance = lastTended
        ? lastTended.getTime() + toleranceMs
        : 0;

      // Candidate if: never tended, OR modified significantly after last tending
      if (!lastTended || lastModified.getTime() > lastTendedWithTolerance) {
        candidates.push({
          path: note.path,
          content: note.content,
          lastModified,
          lastTended,
        });
      }
    }

    return candidates;
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
        growthStage: parsed.data.growth_stage as string | undefined,
        lastTended: parsed.data.last_tended as string | undefined,
        outboundLinks,
        inboundLinks: [], // Populated in second pass
        isMocCandidate: false, // Updated in third pass
      });
    }

    // Second pass: calculate inbound links
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

    // Third pass: identify MOC candidates
    for (const note of metadata) {
      note.isMocCandidate = note.inboundLinks.length >= MOC_CANDIDATE_MIN_LINKS;
    }

    return metadata;
  }

  /**
   * Finds broken wikilinks - links pointing to notes that don't exist.
   */
  private findBrokenLinks(garden: NoteMetadata[]): BrokenLink[] {
    const validPaths = new Set(garden.map(n => n.path.replace(/\.md$/, '')));
    const brokenLinks: BrokenLink[] = [];

    for (const note of garden) {
      for (const link of note.outboundLinks) {
        // Check if link target exists (handle both with/without folder)
        const linkExists =
          validPaths.has(link) ||
          [...validPaths].some(p => p.endsWith(`/${link}`) || p === link);

        if (!linkExists) {
          brokenLinks.push({ notePath: note.path, brokenLink: link });
        }
      }
    }
    return brokenLinks;
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

  /**
   * Unescapes content from LLM tool calls.
   * LLMs often output literal \n instead of actual newlines.
   */
  private unescapeContent(content: string): string {
    return content
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r');
  }

  /**
   * Normalizes frontmatter to ensure consistent keys and ordering.
   * Order: growth_stage → last_tended → summary → aliases → tags → (any custom keys)
   *
   * @param existing - Existing frontmatter data
   * @param tendedAt - Date string (YYYY-MM-DD) for last_tended
   */
  private normalizeFrontmatter(
    existing: Record<string, unknown>,
    tendedAt: string,
  ): Record<string, unknown> {
    const standardKeys = [
      'growth_stage',
      'last_tended',
      'summary',
      'aliases',
      'tags',
    ];

    // Extract custom keys (anything not in our standard set)
    const customEntries = Object.entries(existing).filter(
      ([key]) => !standardKeys.includes(key),
    );

    return {
      growth_stage: existing.growth_stage || 'seedling',
      last_tended: tendedAt, // Always update to current date
      summary: existing.summary ?? '',
      aliases: existing.aliases ?? [],
      tags: existing.tags ?? [],
      ...Object.fromEntries(customEntries),
    };
  }

  /**
   * Tends a single note with the full garden context.
   * Only updates the source note's last-tended frontmatter when done.
   */
  private async tendSingleNote(
    candidate: TendingCandidate,
    garden: NoteMetadata[],
    brokenLinks: BrokenLink[],
  ): Promise<void> {
    this.logger.info({ path: candidate.path }, 'Tending note');

    // Date-only format for last_tended
    const tendedAt = formatObsidianDate();
    const todayDate = tendedAt;

    // Find broken links in this specific note
    const noteBrokenLinks = brokenLinks.filter(
      bl => bl.notePath === candidate.path,
    );

    // Build focused context for this note (includes similar notes search)
    const noteContext = await this.buildNoteContext(
      candidate,
      garden,
      noteBrokenLinks,
    );

    await generateText({
      model: this.model,
      maxOutputTokens: 8192,
      system: this.promptService.render('garden-curator', { today: todayDate }),
      messages: [
        {
          role: 'user',
          content: noteContext,
        },
      ],
      tools: this.buildTools(tendedAt, garden),
      stopWhen: stepCountIs(MAX_TENDING_STEPS),
    });

    // After tending, update ONLY this note's last-tended with full timestamp
    await this.markAsTended(candidate.path, tendedAt);
  }

  /**
   * Checks if a note is an orphan (has no inbound or outbound links).
   */
  private isOrphan(noteMetadata: NoteMetadata | undefined): boolean {
    if (!noteMetadata) return true;
    return (
      noteMetadata.inboundLinks.length === 0 &&
      noteMetadata.outboundLinks.length === 0
    );
  }

  /**
   * Builds focused context for tending a single note.
   * Includes similar notes from vector search for deduplication.
   */
  private async buildNoteContext(
    candidate: TendingCandidate,
    garden: NoteMetadata[],
    brokenLinks: BrokenLink[],
  ): Promise<string> {
    const parsed = matter(candidate.content);
    const noteMetadata = garden.find(n => n.path === candidate.path);

    // Find similar notes for deduplication context
    let similarNotesSection = '';
    try {
      const embedding = await this.embeddingService.embed(parsed.content);
      const similarNotes = await this.qdrantService.searchSimilar(
        embedding,
        SIMILAR_NOTES_LIMIT,
      );
      const filtered = similarNotes.filter(
        s => s.path !== candidate.path && s.score > SIMILARITY_THRESHOLD,
      );
      if (filtered.length > 0) {
        similarNotesSection = `
## Similar Notes (check for duplicates)
${filtered.map(s => `- ${s.path} (${(s.score * PERCENT_MULTIPLIER).toFixed(0)}% similar)`).join('\n')}
`;
      }
    } catch {
      // If embedding fails, continue without similar notes
    }

    // Check orphan status
    const isOrphan = this.isOrphan(noteMetadata);

    // Get list of all existing notes for linking context
    const existingNotes = garden
      .map(n => `- ${n.path} [${n.growthStage || 'seedling'}]`)
      .join('\n');

    let context = `# Note to Tend: ${candidate.path}

## Current Content
\`\`\`markdown
${parsed.content}
\`\`\`

## Metadata
- Growth stage: ${noteMetadata?.growthStage || 'seedling'}
- Inbound links: ${noteMetadata?.inboundLinks.length || 0}
- Outbound links: ${noteMetadata?.outboundLinks.length || 0}
- Last tended: ${candidate.lastTended?.toISOString().split('T')[0] || 'never'}
`;

    // Check if this is an MOC candidate
    const isMocCandidate = noteMetadata?.isMocCandidate || false;

    // Add warnings for orphans, old seeds, and MOC candidates
    if (isOrphan || isMocCandidate) {
      context += '\n## Attention Required\n';
      if (isOrphan) {
        context +=
          '- **ORPHAN**: This note has no connections. Find related notes to link to/from.\n';
      }
      if (isMocCandidate) {
        context += `- **MOC CANDIDATE**: This note has ${noteMetadata?.inboundLinks.length || 0} inbound links. Consider creating a Map of Content to organize related notes.\n`;
      }
    }

    if (similarNotesSection) {
      context += similarNotesSection;
    }

    if (brokenLinks.length > 0) {
      context += `
## Broken Links in This Note
${brokenLinks.map(bl => `- [[${bl.brokenLink}]] - does not exist`).join('\n')}
`;
    }

    context += `
## Existing Notes in Garden (for linking)
${existingNotes}

## Your Task
1. Check "Similar Notes" above - merge any that cover the same concept
2. Add inline [[wikilinks]] where concepts from other notes are mentioned
3. Fix or remove broken links
4. If this note covers multiple concepts, check find_similar before splitting
5. Promote maturity if well-linked and thorough
6. If orphaned, find notes that should link here or concepts to link to
`;

    return context;
  }

  /**
   * Builds the tools object with all intelligent curator tools.
   */
  private buildTools(tendedAt: string, garden: NoteMetadata[]) {
    return {
      read_note: tool({
        description:
          'Read the full content of a note to make better decisions. ALWAYS read before modifying.',
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

      rewrite_note: tool({
        description:
          'Rewrite a note with new content. Use for adding inline links, restructuring, or fixing issues. The content you provide will replace the existing note.',
        inputSchema: z.object({
          path: z.string().describe('Note path to rewrite'),
          newContent: z
            .string()
            .describe(
              'Complete new markdown content (without frontmatter). Must be a coherent, well-structured note.',
            ),
          reason: z.string().describe('Why this rewrite is needed'),
        }),
        execute: async ({ path, newContent, reason }) => {
          try {
            const note = await this.obsidianService.readNote(path);
            if (!note) {
              return `Note not found: ${path}`;
            }

            const parsed = matter(note.content);
            const updatedContent = matter.stringify(
              this.unescapeContent(newContent),
              this.normalizeFrontmatter(parsed.data, tendedAt),
            );

            await this.obsidianService.writeNote(
              path.replace(/\.md$/, ''),
              updatedContent,
            );
            await this.indexSyncProcessor.queueSingleNote(path, updatedContent);

            this.logger.info({ path, reason }, 'Rewrote note');
            return `Rewrote ${path}`;
          } catch (error) {
            return `Error rewriting note: ${error.message}`;
          }
        },
      }),

      merge_notes: tool({
        description:
          'Merge two notes into one by synthesizing their content. You must provide the merged content - do NOT just concatenate.',
        inputSchema: z.object({
          sourcePath: z
            .string()
            .describe('Note to merge FROM (will be deleted)'),
          targetPath: z.string().describe('Note to merge INTO'),
          mergedContent: z
            .string()
            .describe(
              'The synthesized content combining both notes. Must read naturally as a single coherent note - no "merged from" markers.',
            ),
          reason: z.string().describe('Why these notes should be merged'),
        }),
        execute: async ({ sourcePath, targetPath, mergedContent, reason }) => {
          try {
            const sourceNote = await this.obsidianService.readNote(sourcePath);
            const targetNote = await this.obsidianService.readNote(targetPath);

            if (!sourceNote) {
              return `Source note not found: ${sourcePath}`;
            }
            if (!targetNote) {
              return `Target note not found: ${targetPath}`;
            }

            const targetParsed = matter(targetNote.content);

            // Write merged content
            const newContent = matter.stringify(
              this.unescapeContent(mergedContent),
              this.normalizeFrontmatter(targetParsed.data, tendedAt),
            );

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

            // Update any notes linking to source -> target
            await this.updateLinksToDeletedNote(sourcePath, targetPath, garden);

            this.logger.info(
              { sourcePath, targetPath, reason },
              'Merged notes',
            );
            return `Merged ${sourcePath} into ${targetPath}`;
          } catch (error) {
            return `Error merging notes: ${error.message}`;
          }
        },
      }),

      split_note: tool({
        description:
          'Split a non-atomic note into multiple focused notes. Provide content for each new note.',
        inputSchema: z.object({
          originalPath: z.string().describe('Note to split'),
          newNotes: z
            .array(
              z.object({
                title: z.string().describe('Title for the new atomic note'),
                content: z.string().describe('Content for this note'),
                folder: z
                  .string()
                  .optional()
                  .describe('Folder (e.g., "People", "Concepts")'),
              }),
            )
            .describe('Array of new notes to create'),
          updatedOriginal: z
            .string()
            .optional()
            .describe('If keeping original, provide its new focused content'),
          deleteOriginal: z
            .boolean()
            .describe('Whether to delete the original after splitting'),
          reason: z.string().describe('Why this split is needed'),
        }),
        execute: async ({
          originalPath,
          newNotes,
          updatedOriginal,
          deleteOriginal,
          reason,
        }) => {
          try {
            const createdPaths: string[] = [];

            // Create each new note
            for (const newNote of newNotes) {
              const folder = newNote.folder || '';
              const path = folder
                ? `${folder}/${newNote.title}`
                : newNote.title;

              const content = matter.stringify(
                this.unescapeContent(newNote.content),
                this.normalizeFrontmatter({}, tendedAt),
              );

              await this.obsidianService.writeNote(path, content);
              await this.indexSyncProcessor.queueSingleNote(
                `${path}.md`,
                content,
              );
              createdPaths.push(path);
            }

            // Handle original
            if (deleteOriginal) {
              await this.obsidianService.deleteNote(originalPath);
              await this.qdrantService.deleteNote(originalPath);
            } else if (updatedOriginal) {
              const original =
                await this.obsidianService.readNote(originalPath);
              if (original) {
                const parsed = matter(original.content);
                const newContent = matter.stringify(
                  this.unescapeContent(updatedOriginal),
                  this.normalizeFrontmatter(parsed.data, tendedAt),
                );
                await this.obsidianService.writeNote(
                  originalPath.replace(/\.md$/, ''),
                  newContent,
                );
                await this.indexSyncProcessor.queueSingleNote(
                  originalPath,
                  newContent,
                );
              }
            }

            this.logger.info(
              { originalPath, count: createdPaths.length, reason },
              'Split note',
            );
            return `Split ${originalPath} into: ${createdPaths.join(', ')}`;
          } catch (error) {
            return `Error splitting note: ${error.message}`;
          }
        },
      }),

      create_note: tool({
        description:
          'Create a new note in the garden. Use when a broken link points to a concept that should exist.',
        inputSchema: z.object({
          title: z.string().describe('Title for the note'),
          content: z.string().describe('Markdown content for the note'),
          folder: z
            .string()
            .optional()
            .describe('Folder (e.g., "People", "Concepts")'),
          reason: z.string().describe('Why this note is being created'),
        }),
        execute: async ({ title, content, folder, reason }) => {
          try {
            const path = folder ? `${folder}/${title}` : title;

            const noteContent = matter.stringify(
              this.unescapeContent(content),
              this.normalizeFrontmatter({}, tendedAt),
            );

            await this.obsidianService.writeNote(path, noteContent);
            await this.indexSyncProcessor.queueSingleNote(
              `${path}.md`,
              noteContent,
            );

            this.logger.info({ path, reason }, 'Created note');
            return `Created ${path}`;
          } catch (error) {
            return `Error creating note: ${error.message}`;
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

            this.logger.info({ path, reason }, 'Deleted note');
            return `Deleted ${path}`;
          } catch (error) {
            return `Error deleting note: ${error.message}`;
          }
        },
      }),

      promote_maturity: tool({
        description:
          'Promote a note to a higher growth stage (seedling -> budding -> evergreen)',
        inputSchema: z.object({
          path: z.string().describe('Note path'),
          newMaturity: z
            .enum(['budding', 'evergreen'])
            .describe('New growth stage'),
          reason: z.string().describe('Brief reason for promotion'),
        }),
        execute: async ({ path, newMaturity, reason }) => {
          try {
            const note = await this.obsidianService.readNote(path);
            if (!note) {
              return `Note not found: ${path}`;
            }

            const parsed = matter(note.content);
            const newContent = matter.stringify(
              parsed.content,
              this.normalizeFrontmatter(
                { ...parsed.data, growth_stage: newMaturity },
                tendedAt,
              ),
            );

            await this.obsidianService.writeNote(
              path.replace(/\.md$/, ''),
              newContent,
            );
            await this.indexSyncProcessor.queueSingleNote(path, newContent);

            this.logger.info(
              { path, newMaturity, reason },
              'Promoted note growth stage',
            );
            return `Promoted ${path} to ${newMaturity}`;
          } catch (error) {
            return `Error promoting note: ${error.message}`;
          }
        },
      }),

      find_similar: tool({
        description:
          'Find notes similar to a given topic (for identifying duplicates)',
        inputSchema: z.object({
          query: z.string().describe('Topic to search for'),
          limit: z
            .number()
            .optional()
            .default(SIMILAR_NOTES_LIMIT)
            .describe('Max results'),
        }),
        execute: async ({ query, limit = SIMILAR_NOTES_LIMIT }) => {
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
                  `- ${r.path} (similarity: ${(r.score * PERCENT_MULTIPLIER).toFixed(1)}%)`,
              )
              .join('\n');
          } catch (error) {
            return `Error searching: ${error.message}`;
          }
        },
      }),

      supersede: tool({
        description:
          'Mark a note as superseded when thinking has fundamentally evolved. Creates a new note and marks the old one as historical context. Preserves the evolution of thought.',
        inputSchema: z.object({
          oldPath: z.string().describe('Path of the note being superseded'),
          newTitle: z
            .string()
            .describe('Title for the new note with evolved thinking'),
          newContent: z
            .string()
            .describe(
              'The evolved understanding. Use [[wikilinks]] to connect to related concepts.',
            ),
          reason: z
            .string()
            .optional()
            .describe('Brief explanation of why thinking evolved'),
          folder: z
            .string()
            .optional()
            .describe('Folder for the new note (defaults to same as old)'),
        }),
        execute: async ({ oldPath, newTitle, newContent, reason, folder }) => {
          try {
            const oldNote = await this.obsidianService.readNote(oldPath);
            if (!oldNote) {
              return `Note not found: ${oldPath}`;
            }

            const today = formatObsidianDate();
            const parsed = matter(oldNote.content);

            const sanitizedTitle = sanitizePath(newTitle);
            const oldFolder = oldPath.includes('/')
              ? oldPath.split('/').slice(0, -1).join('/')
              : undefined;
            const targetFolder = folder ? sanitizePath(folder) : oldFolder;
            const newPath = targetFolder
              ? `${targetFolder}/${sanitizedTitle}`
              : sanitizedTitle;

            const existingNew = await this.obsidianService.readNote(newPath);
            if (existingNew) {
              return `Note already exists at "${newPath}". Choose a different title.`;
            }

            // Create the new note with supersedes info in body
            const oldName = oldPath.replace(/\.md$/, '').split('/').pop();
            const supersedesBody = `_Supersedes [[${oldName}]]_\n\n${this.unescapeContent(newContent)}`;
            const newNoteContent = matter.stringify(supersedesBody, {
              growth_stage: 'seedling',
              last_tended: today,
              summary: '',
              aliases: [],
              tags: [],
            });

            await this.obsidianService.writeNote(newPath, newNoteContent);
            await this.indexSyncProcessor.queueSingleNote(
              newPath,
              newNoteContent,
            );

            // Mark the old note as superseded (body only, no frontmatter pollution)
            const supersessionNotice = reason
              ? `> **Superseded:** This note has been superseded by [[${sanitizedTitle}]]. ${reason}\n\n`
              : `> **Superseded:** This note has been superseded by [[${sanitizedTitle}]].\n\n`;

            const updatedOldContent = matter.stringify(
              supersessionNotice + parsed.content.trim(),
              this.normalizeFrontmatter(parsed.data, tendedAt),
            );

            await this.obsidianService.writeNote(oldPath, updatedOldContent);
            await this.indexSyncProcessor.queueSingleNote(
              oldPath,
              updatedOldContent,
            );

            this.logger.info({ oldPath, newPath, reason }, 'Superseded note');
            return `Superseded "${oldPath}" with "${newPath}"`;
          } catch (error) {
            return `Error superseding note: ${error.message}`;
          }
        },
      }),

      traverse: tool({
        description:
          'Explore the garden by following links from a note. Discovers related concepts through the knowledge graph.',
        inputSchema: z.object({
          from: z.string().describe('Starting note path'),
          direction: z
            .enum(['outbound', 'inbound', 'both'])
            .optional()
            .default('both')
            .describe('Direction to traverse'),
          depth: z
            .number()
            .optional()
            .default(1)
            .describe('Link hops to follow (1-3)'),
        }),
        execute: async ({ from, direction = 'both', depth = 1 }) => {
          try {
            const clampedDepth = Math.min(
              Math.max(depth, 1),
              MAX_TRAVERSE_DEPTH,
            );
            const normalizedFrom = from.replace(/\.md$/, '');

            // Build link maps from garden metadata
            const outboundMap = new Map<string, string[]>();
            const inboundMap = new Map<string, string[]>();

            for (const note of garden) {
              const path = note.path.replace(/\.md$/, '');
              outboundMap.set(path, note.outboundLinks);
              for (const link of note.outboundLinks) {
                if (!inboundMap.has(link)) {
                  inboundMap.set(link, []);
                }
                inboundMap.get(link)?.push(path);
              }
            }

            // BFS traversal
            const visited = new Set<string>();
            const result: {
              path: string;
              depth: number;
              direction: string;
            }[] = [];

            interface QueueItem {
              path: string;
              currentDepth: number;
              dir: 'outbound' | 'inbound';
            }
            const queue: QueueItem[] = [];

            if (direction === 'outbound' || direction === 'both') {
              for (const target of outboundMap.get(normalizedFrom) || []) {
                queue.push({
                  path: target,
                  currentDepth: 1,
                  dir: 'outbound',
                });
              }
            }
            if (direction === 'inbound' || direction === 'both') {
              for (const source of inboundMap.get(normalizedFrom) || []) {
                queue.push({
                  path: source,
                  currentDepth: 1,
                  dir: 'inbound',
                });
              }
            }

            while (queue.length > 0) {
              const item = queue.shift();
              if (!item) break;
              if (visited.has(item.path)) continue;
              visited.add(item.path);

              result.push({
                path: item.path,
                depth: item.currentDepth,
                direction: item.dir,
              });

              if (item.currentDepth < clampedDepth) {
                if (item.dir === 'outbound') {
                  for (const target of outboundMap.get(item.path) || []) {
                    if (!visited.has(target)) {
                      queue.push({
                        path: target,
                        currentDepth: item.currentDepth + 1,
                        dir: 'outbound',
                      });
                    }
                  }
                } else {
                  for (const source of inboundMap.get(item.path) || []) {
                    if (!visited.has(source)) {
                      queue.push({
                        path: source,
                        currentDepth: item.currentDepth + 1,
                        dir: 'inbound',
                      });
                    }
                  }
                }
              }
            }

            if (result.length === 0) {
              return `No ${direction === 'both' ? '' : `${direction} `}connections found from "${normalizedFrom}".`;
            }

            let response = `**Traversal from "${normalizedFrom}"** (depth: ${clampedDepth}, direction: ${direction})\n\n`;

            for (let d = 1; d <= clampedDepth; d++) {
              const atDepth = result.filter(r => r.depth === d);
              if (atDepth.length === 0) continue;

              response += `**${d} hop${d > 1 ? 's' : ''} away:**\n`;
              for (const item of atDepth) {
                const arrow = item.direction === 'outbound' ? '->' : '<-';
                response += `  ${arrow} ${item.path}\n`;
              }
              response += '\n';
            }

            return response.trim();
          } catch (error) {
            return `Error traversing: ${error.message}`;
          }
        },
      }),

      backlinks: tool({
        description:
          "Find notes that link TO a given note, with context about why. Useful for understanding a concept's place in the garden.",
        inputSchema: z.object({
          path: z.string().describe('Note to find backlinks for'),
        }),
        execute: async ({ path }) => {
          try {
            const normalizedPath = path.replace(/\.md$/, '');
            const pathName = normalizedPath.split('/').pop();

            const notes = await this.obsidianService.getAllNotesWithContent();
            const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
            const backlinks: { path: string; context: string }[] = [];

            for (const note of notes) {
              if (note.path.replace(/\.md$/, '') === normalizedPath) {
                continue;
              }

              const parsed = matter(note.content);
              const lines = parsed.content.split('\n');

              for (const line of lines) {
                let match = wikilinkRegex.exec(line);
                while (match !== null) {
                  const linkTarget = match[1];
                  if (
                    linkTarget === normalizedPath ||
                    linkTarget === pathName ||
                    linkTarget.endsWith(`/${pathName}`)
                  ) {
                    backlinks.push({
                      path: note.path.replace(/\.md$/, ''),
                      context: line.trim(),
                    });
                    break;
                  }
                  match = wikilinkRegex.exec(line);
                }
                wikilinkRegex.lastIndex = 0;
              }
            }

            if (backlinks.length === 0) {
              return `No notes link to "${normalizedPath}".`;
            }

            let response = `**Backlinks to "${normalizedPath}" (${backlinks.length}):**\n\n`;
            for (const bl of backlinks) {
              response += `**${bl.path}**\n> ${bl.context}\n\n`;
            }

            return response.trim();
          } catch (error) {
            return `Error finding backlinks: ${error.message}`;
          }
        },
      }),
    };
  }

  /**
   * Updates any notes that link to a deleted note to point to the new location.
   */
  private async updateLinksToDeletedNote(
    deletedPath: string,
    newPath: string,
    garden: NoteMetadata[],
  ): Promise<void> {
    const deletedName = deletedPath.replace(/\.md$/, '').split('/').pop();
    const newName = newPath.replace(/\.md$/, '').split('/').pop();

    if (!deletedName || !newName || deletedName === newName) {
      return;
    }

    // Find notes that link to the deleted note
    for (const note of garden) {
      if (note.outboundLinks.includes(deletedName)) {
        try {
          const noteContent = await this.obsidianService.readNote(note.path);
          if (!noteContent) continue;

          // Replace [[deletedName]] with [[newName]]
          const updatedContent = noteContent.content.replace(
            new RegExp(`\\[\\[${deletedName}(\\|[^\\]]+)?\\]\\]`, 'g'),
            `[[${newName}$1]]`,
          );

          if (updatedContent !== noteContent.content) {
            await this.obsidianService.writeNote(
              note.path.replace(/\.md$/, ''),
              updatedContent,
            );
            this.logger.info(
              { notePath: note.path, from: deletedName, to: newName },
              'Updated links in note',
            );
          }
        } catch (error) {
          this.logger.warn(
            { err: error, notePath: note.path },
            'Failed to update links in note',
          );
        }
      }
    }
  }

  /**
   * Marks a note as tended by updating its last-tended frontmatter.
   * Only updates the source file, not any files touched as side effects.
   *
   * @param path - Note path to mark as tended
   * @param tendedAt - Full ISO timestamp when tending occurred
   */
  private async markAsTended(path: string, tendedAt: string): Promise<void> {
    try {
      const note = await this.obsidianService.readNote(path);
      if (!note) {
        return;
      }

      const parsed = matter(note.content);
      const newContent = matter.stringify(
        parsed.content,
        this.normalizeFrontmatter(parsed.data, tendedAt),
      );

      await this.obsidianService.writeNote(
        path.replace(/\.md$/, ''),
        newContent,
      );
      // Don't re-index - we only changed metadata
    } catch (error) {
      this.logger.warn({ err: error, path }, 'Failed to mark note as tended');
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug({ jobId: job.id }, 'Garden tending job completed');
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(
      { err: error, jobId: job.id },
      'Garden tending job failed',
    );
  }
}
