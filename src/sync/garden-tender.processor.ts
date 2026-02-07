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
  private readonly logger = new Logger(GardenTenderProcessor.name);
  private readonly enabled: boolean;
  private model: ReturnType<ReturnType<typeof createAnthropic>>;
  private currentJobId: string | null = null;

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
    // Use Sonnet for content synthesis - requires understanding and creativity
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
          this.logger.log(`Discarded running garden tending job ${job.id}`);
        }
      }
    }

    // Queue new job
    const job = await this.tendingQueue.add('manual-tending', {
      type: 'scheduled-tending',
    });
    this.currentJobId = job.id;
    this.logger.log(`Queued manual garden tending job ${job.id}`);
  }

  async process(job: Job<GardenTendingJob>): Promise<void> {
    this.currentJobId = job.id;
    this.logger.log('Starting garden tending session...');

    try {
      const candidates = await this.findCandidatesForTending();

      if (candidates.length === 0) {
        this.logger.log('No files need tending');
        return;
      }

      this.logger.log(`Found ${candidates.length} files needing attention`);

      // Build full garden context for linking decisions
      const garden = await this.buildGardenMetadata();
      const brokenLinks = this.findBrokenLinks(garden);

      // Process each candidate individually
      for (const candidate of candidates) {
        await this.tendSingleNote(candidate, garden, brokenLinks);
      }

      this.logger.log('Garden tending session complete');
    } catch (error) {
      this.logger.error('Error during garden tending:', error);
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
      const lastTendedStr = parsed.data['last-tended'] as string | undefined;
      const lastTended = lastTendedStr ? new Date(lastTendedStr) : null;
      const lastModified = await this.obsidianService.getModifiedDate(
        note.path,
      );

      if (!lastModified) {
        continue;
      }

      // Candidate if: never tended, OR modified after last tending
      if (!lastTended || lastModified > lastTended) {
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
        maturity: parsed.data.maturity as string | undefined,
        planted: parsed.data.planted as string | undefined,
        lastTended: parsed.data['last-tended'] as string | undefined,
        outboundLinks,
        inboundLinks: [], // Populated in second pass
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
   * Order: planted → maturity → last-tended → (any custom keys)
   */
  private normalizeFrontmatter(
    existing: Record<string, unknown>,
    today: string,
  ): Record<string, unknown> {
    const standardKeys = ['planted', 'maturity', 'last-tended'];

    // Extract custom keys (anything not in our standard set)
    const customEntries = Object.entries(existing).filter(
      ([key]) => !standardKeys.includes(key),
    );

    return {
      planted: existing.planted || today,
      maturity: existing.maturity || 'seedling',
      'last-tended': existing['last-tended'] || today,
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
    this.logger.log(`Tending: ${candidate.path}`);

    const today = new Date().toISOString().split('T')[0];

    // Find broken links in this specific note
    const noteBrokenLinks = brokenLinks.filter(
      bl => bl.notePath === candidate.path,
    );

    // Build focused context for this note
    const noteContext = this.buildNoteContext(
      candidate,
      garden,
      noteBrokenLinks,
    );

    await generateText({
      model: this.model,
      maxOutputTokens: 8192,
      system: this.buildCuratorPrompt(today),
      messages: [
        {
          role: 'user',
          content: noteContext,
        },
      ],
      tools: this.buildTools(today, garden),
      stopWhen: stepCountIs(20),
    });

    // After tending, update ONLY this note's last-tended
    await this.markAsTended(candidate.path, today);
  }

  /**
   * Builds focused context for tending a single note.
   */
  private buildNoteContext(
    candidate: TendingCandidate,
    garden: NoteMetadata[],
    brokenLinks: BrokenLink[],
  ): string {
    const parsed = matter(candidate.content);
    const noteMetadata = garden.find(n => n.path === candidate.path);

    // Get list of all existing notes for linking context
    const existingNotes = garden
      .map(n => {
        const title = n.path.replace(/\.md$/, '').split('/').pop();
        return `- ${n.path} [${n.maturity || 'seedling'}]`;
      })
      .join('\n');

    let context = `# Note to Tend: ${candidate.path}

## Current Content
\`\`\`markdown
${parsed.content}
\`\`\`

## Metadata
- Maturity: ${noteMetadata?.maturity || 'seedling'}
- Inbound links: ${noteMetadata?.inboundLinks.length || 0}
- Outbound links: ${noteMetadata?.outboundLinks.length || 0}
- Last tended: ${candidate.lastTended?.toISOString().split('T')[0] || 'never'}
`;

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
Review this note and take appropriate actions:
1. Add inline [[wikilinks]] where concepts from other notes are mentioned
2. Fix or remove broken links
3. If this note covers multiple concepts, consider splitting it
4. If content overlaps with another note, consider merging
5. Promote maturity if well-linked
`;

    return context;
  }

  /**
   * Builds the curator prompt with new intelligent instructions.
   */
  private buildCuratorPrompt(today: string): string {
    return `You are a digital garden curator performing intelligent maintenance.

## Core Principles
- **ATOMIC**: One concept per note. Split notes covering multiple topics.
- **CONCEPT-ORIENTED**: Organize by idea, not by source/person.
- **DENSELY LINKED**: Add [[wikilinks]] INLINE where concepts are mentioned, not in separate "Related" sections.

## Your Tools

### read_note
ALWAYS read notes before modifying them. Never guess at content.

### rewrite_note
Rewrite a note to:
- Add inline [[wikilinks]] where other notes are referenced
- Restructure for clarity
- Fix broken links by removing or correcting them

### merge_notes
When notes cover the same concept, SYNTHESIZE them into one coherent note:
- Combine all unique information
- Remove redundancy
- The result must read naturally - NO "merged from" markers or separators
- You provide the merged content directly

### split_note
When a note covers multiple distinct concepts, split it:
- Create separate atomic notes for each concept
- Add links between the new notes
- Delete or update the original

### create_note
Create missing notes when a broken link points to a concept that should exist.

### delete_note
Remove truly empty or obsolete notes.

### promote_maturity
Upgrade well-linked notes: seedling → budding → evergreen

## Guidelines
1. READ before you WRITE - always use read_note first
2. Merged content must flow naturally as ONE note
3. Add links INLINE ("I love [[coffee]] in the morning"), not in "## Related" sections
4. Be bold about restructuring - that's what tending means
5. Fix broken links: remove if concept doesn't exist, correct if typo, create if it should exist

Today's date: ${today}`;
  }

  /**
   * Builds the tools object with all intelligent curator tools.
   */
  private buildTools(today: string, garden: NoteMetadata[]) {
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
              this.normalizeFrontmatter(parsed.data, today),
            );

            await this.obsidianService.writeNote(
              path.replace(/\.md$/, ''),
              updatedContent,
            );
            await this.indexSyncProcessor.queueSingleNote(path, updatedContent);

            this.logger.log(`Rewrote ${path}: ${reason}`);
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
              this.normalizeFrontmatter(targetParsed.data, today),
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

            this.logger.log(
              `Merged ${sourcePath} into ${targetPath}: ${reason}`,
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
                this.normalizeFrontmatter({}, today),
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
                  this.normalizeFrontmatter(parsed.data, today),
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

            this.logger.log(
              `Split ${originalPath} into ${createdPaths.length} notes: ${reason}`,
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
              this.normalizeFrontmatter({}, today),
            );

            await this.obsidianService.writeNote(path, noteContent);
            await this.indexSyncProcessor.queueSingleNote(
              `${path}.md`,
              noteContent,
            );

            this.logger.log(`Created ${path}: ${reason}`);
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

            this.logger.log(`Deleted ${path}: ${reason}`);
            return `Deleted ${path}`;
          } catch (error) {
            return `Error deleting note: ${error.message}`;
          }
        },
      }),

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
            const newContent = matter.stringify(
              parsed.content,
              this.normalizeFrontmatter(
                { ...parsed.data, maturity: newMaturity },
                today,
              ),
            );

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
                r => `- ${r.path} (similarity: ${(r.score * 100).toFixed(1)}%)`,
              )
              .join('\n');
          } catch (error) {
            return `Error searching: ${error.message}`;
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
            this.logger.log(
              `Updated links in ${note.path}: ${deletedName} -> ${newName}`,
            );
          }
        } catch (error) {
          this.logger.warn(
            `Failed to update links in ${note.path}: ${error.message}`,
          );
        }
      }
    }
  }

  /**
   * Marks a note as tended by updating its last-tended frontmatter.
   * Only updates the source file, not any files touched as side effects.
   */
  private async markAsTended(path: string, today: string): Promise<void> {
    try {
      const note = await this.obsidianService.readNote(path);
      if (!note) {
        return;
      }

      const parsed = matter(note.content);
      const newContent = matter.stringify(
        parsed.content,
        this.normalizeFrontmatter(parsed.data, today),
      );

      await this.obsidianService.writeNote(
        path.replace(/\.md$/, ''),
        newContent,
      );
      // Don't re-index - we only changed metadata
    } catch (error) {
      this.logger.warn(`Failed to mark ${path} as tended: ${error.message}`);
    }
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
