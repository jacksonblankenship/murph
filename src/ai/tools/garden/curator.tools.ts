import { tool } from 'ai';
import matter from 'gray-matter';
import { z } from 'zod';
import { formatObsidianDate } from '../../../common/obsidian-date';
import { createStubsForBrokenLinks, formatStubResult } from './stub-creator';
import type { GardenToolsDependencies } from './types';
import { ensureMdExtension, GROWTH_STAGE_ICONS, sanitizePath } from './utils';

/**
 * Creates curator tools for active garden maintenance.
 *
 * Includes: merge, split, promote
 */
export function createCuratorTools(deps: GardenToolsDependencies) {
  const { vaultService, qdrantService, indexSyncProcessor } = deps;

  return {
    merge: tool({
      description:
        'Merge two notes into one. Use when you discover duplicates or notes covering the same concept. The source note is deleted and links to it are updated.',
      inputSchema: z.object({
        sourcePath: z
          .string()
          .describe('Note to merge FROM (will be deleted after merge)'),
        targetPath: z.string().describe('Note to merge INTO (will be kept)'),
        mergedContent: z
          .string()
          .describe(
            'The synthesized content combining both notes. Must read naturally as one coherent note.',
          ),
        reason: z
          .string()
          .describe('Brief explanation of why these notes should be merged'),
      }),
      execute: async ({ sourcePath, targetPath, mergedContent, reason }) => {
        try {
          const sourceNote = vaultService.getNote(sourcePath);
          const targetNote = vaultService.getNote(targetPath);

          if (!sourceNote) {
            return `Source note not found: ${sourcePath}`;
          }
          if (!targetNote) {
            return `Target note not found: ${targetPath}`;
          }

          const tendedAt = formatObsidianDate();

          // Write merged content to target
          const newContent = matter.stringify(mergedContent, {
            ...targetNote.frontmatter,
            last_tended: tendedAt,
          });

          await vaultService.writeNote(targetPath, newContent);
          await indexSyncProcessor.queueSingleNote(
            ensureMdExtension(targetPath),
            newContent,
          );

          // Delete source note
          await vaultService.deleteNote(sourcePath);
          await qdrantService.deleteNote(sourcePath);

          // Update links pointing to deleted source
          const sourceName = sourcePath.replace(/\.md$/, '').split('/').pop();
          const targetName = targetPath.replace(/\.md$/, '').split('/').pop();

          if (sourceName && targetName && sourceName !== targetName) {
            const allNotes = vaultService.getAllNotes();
            for (const note of allNotes) {
              const normalizedNotePath = note.path.replace(/\.md$/, '');
              if (
                normalizedNotePath === sourcePath.replace(/\.md$/, '') ||
                normalizedNotePath === targetPath.replace(/\.md$/, '')
              ) {
                continue;
              }

              const updatedNoteContent = note.raw.replace(
                new RegExp(`\\[\\[${sourceName}(\\|[^\\]]+)?\\]\\]`, 'g'),
                `[[${targetName}$1]]`,
              );

              if (updatedNoteContent !== note.raw) {
                await vaultService.writeNote(
                  normalizedNotePath,
                  updatedNoteContent,
                );
              }
            }
          }

          return `Merged "${sourcePath}" into "${targetPath}": ${reason}`;
        } catch (error) {
          return `Error merging notes: ${error.message}`;
        }
      },
    }),

    split: tool({
      description:
        'Split a non-atomic note into multiple focused notes. Use when a note covers multiple distinct concepts.',
      inputSchema: z.object({
        originalPath: z.string().describe('Note to split'),
        newNotes: z
          .array(
            z.object({
              title: z.string().describe('Title for the new atomic note'),
              content: z
                .string()
                .describe(
                  'Content for this note. Use [[wikilinks]] for connections.',
                ),
              folder: z
                .string()
                .optional()
                .describe('Folder (e.g., "People", "Concepts")'),
            }),
          )
          .describe('Array of new notes to create from the split'),
        deleteOriginal: z
          .boolean()
          .describe(
            'Whether to delete the original after splitting. Set false to keep as a hub note.',
          ),
        updatedOriginal: z
          .string()
          .optional()
          .describe(
            'If keeping original, provide its new focused content (should link to split notes)',
          ),
        reason: z
          .string()
          .describe('Brief explanation of why this split is needed'),
      }),
      execute: async ({
        originalPath,
        newNotes,
        deleteOriginal,
        updatedOriginal,
        reason,
      }) => {
        try {
          const original = vaultService.getNote(originalPath);
          if (!original) {
            return `Note not found: ${originalPath}`;
          }

          const tendedAt = formatObsidianDate();
          const createdPaths: string[] = [];

          // Create each new note
          for (const newNote of newNotes) {
            const sanitizedTitle = sanitizePath(newNote.title);
            const folder = newNote.folder ? sanitizePath(newNote.folder) : '';
            const notePath = folder
              ? `${folder}/${sanitizedTitle}`
              : sanitizedTitle;

            const noteContent = matter.stringify(newNote.content, {
              growth_stage: 'seedling',
              last_tended: tendedAt,
              summary: '',
              aliases: [],
              tags: [],
            });

            await vaultService.writeNote(notePath, noteContent);
            await indexSyncProcessor.queueSingleNote(
              `${notePath}.md`,
              noteContent,
            );
            createdPaths.push(notePath);
          }

          // Handle original note
          if (deleteOriginal) {
            await vaultService.deleteNote(originalPath);
            await qdrantService.deleteNote(originalPath);
          } else if (updatedOriginal) {
            const newContent = matter.stringify(updatedOriginal, {
              ...original.frontmatter,
              last_tended: tendedAt,
            });
            await vaultService.writeNote(originalPath, newContent);
            await indexSyncProcessor.queueSingleNote(
              ensureMdExtension(originalPath),
              newContent,
            );
          }

          // Auto-create stub seedlings for broken wikilinks across all new notes
          const allNewContent = newNotes.map(n => n.content).join('\n\n');
          const stubResult = await createStubsForBrokenLinks(
            allNewContent,
            deps,
          );

          const action = deleteOriginal ? 'Split and deleted' : 'Split';
          return `${action} "${originalPath}" into: ${createdPaths.join(', ')}. ${reason}${formatStubResult(stubResult)}`;
        } catch (error) {
          return `Error splitting note: ${error.message}`;
        }
      },
    }),

    promote: tool({
      description:
        'Promote a note to a higher maturity level. Use when a note has grown through connections and tending.',
      inputSchema: z.object({
        path: z.string().describe('Note path to promote'),
        newMaturity: z
          .enum(['budding', 'evergreen'])
          .describe('New maturity level (seedling → budding → evergreen)'),
        reason: z
          .string()
          .describe('Brief explanation of why this note deserves promotion'),
      }),
      execute: async ({ path, newMaturity, reason }) => {
        try {
          const note = vaultService.getNote(path);
          if (!note) {
            return `Note not found: ${path}`;
          }

          const currentStage =
            (note.frontmatter.growth_stage as string) || 'seedling';

          // Validate promotion order
          const stageOrder = ['seedling', 'budding', 'evergreen'];
          const currentIndex = stageOrder.indexOf(currentStage);
          const newIndex = stageOrder.indexOf(newMaturity);

          if (newIndex <= currentIndex) {
            return `Cannot promote: "${path}" is already ${currentStage}. Promotion must go seedling → budding → evergreen.`;
          }

          const tendedAt = formatObsidianDate();
          const newContent = matter.stringify(note.body, {
            ...note.frontmatter,
            growth_stage: newMaturity,
            last_tended: tendedAt,
          });

          await vaultService.writeNote(path, newContent);
          await indexSyncProcessor.queueSingleNote(
            ensureMdExtension(path),
            newContent,
          );

          return `Promoted "${path}" from ${GROWTH_STAGE_ICONS[currentStage]} ${currentStage} to ${GROWTH_STAGE_ICONS[newMaturity]} ${newMaturity}: ${reason}`;
        } catch (error) {
          return `Error promoting note: ${error.message}`;
        }
      },
    }),
  };
}
