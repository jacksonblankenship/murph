import { tool } from 'ai';
import matter from 'gray-matter';
import { z } from 'zod';
import { formatObsidianDate } from '../../../common/obsidian-date';
import { BROKEN_LINKS_LIMIT, PREVIEW_LENGTH_SHORT } from './constants';
import { createStubsForBrokenLinks, formatStubResult } from './stub-creator';
import type { GardenToolsDependencies } from './types';
import { ensureMdExtension, sanitizePath } from './utils';

/**
 * Creates link hygiene tools for maintaining link quality.
 *
 * Includes: disconnect, broken_links, supersede
 */
export function createLinkHygieneTools(deps: GardenToolsDependencies) {
  const { vaultService, indexSyncProcessor } = deps;

  return {
    disconnect: tool({
      description:
        'Remove a specific wikilink from a note. Use when a link is incorrect, outdated, or no longer relevant.',
      inputSchema: z.object({
        from: z.string().describe('Note path containing the link to remove'),
        to: z
          .string()
          .describe('Target note to unlink (the [[link]] to remove)'),
      }),
      execute: async ({ from, to }) => {
        try {
          const note = vaultService.getNote(from);
          if (!note) {
            return `Note not found: ${from}`;
          }

          const toName = to.replace(/\.md$/, '').split('/').pop();

          // Remove [[to]] and [[to|alias]] patterns
          const linkPatterns = [
            new RegExp(`\\[\\[${toName}(\\|[^\\]]+)?\\]\\]`, 'g'),
            new RegExp(
              `\\[\\[${to.replace(/\.md$/, '')}(\\|[^\\]]+)?\\]\\]`,
              'g',
            ),
          ];

          let updatedContent = note.body;
          let removed = false;

          for (const pattern of linkPatterns) {
            if (pattern.test(updatedContent)) {
              updatedContent = updatedContent.replace(pattern, toName || '');
              removed = true;
            }
          }

          if (!removed) {
            return `No link to "${to}" found in "${from}".`;
          }

          const tendedAt = formatObsidianDate();
          const newContent = matter.stringify(updatedContent, {
            ...note.frontmatter,
            last_tended: tendedAt,
          });

          await vaultService.writeNote(from, newContent);
          await indexSyncProcessor.queueSingleNote(
            ensureMdExtension(from),
            newContent,
          );

          return `Removed link to [[${toName}]] from "${from}".`;
        } catch (error) {
          return `Error disconnecting: ${error.message}`;
        }
      },
    }),

    broken_links: tool({
      description:
        'Find all broken wikilinks in the garden - links pointing to notes that do not exist.',
      inputSchema: z.object({
        limit: z
          .number()
          .optional()
          .default(BROKEN_LINKS_LIMIT)
          .describe('Max broken links to return'),
      }),
      execute: async ({ limit = BROKEN_LINKS_LIMIT }) => {
        try {
          const notes = vaultService.getAllNotes();
          if (notes.length === 0) {
            return 'No notes in garden.';
          }

          // Build set of valid paths
          const validPaths = new Set<string>();
          const validNames = new Set<string>();
          for (const note of notes) {
            const normalizedPath = note.path.replace(/\.md$/, '');
            validPaths.add(normalizedPath);
            validNames.add(normalizedPath.split('/').pop() || '');
          }

          // Find broken links using pre-computed outboundLinks
          const brokenLinks: {
            notePath: string;
            brokenLink: string;
            context: string;
          }[] = [];

          for (const note of notes) {
            const normalizedPath = note.path.replace(/\.md$/, '');

            for (const linkTarget of note.outboundLinks) {
              // Check if link target exists
              const exists =
                validPaths.has(linkTarget) ||
                validNames.has(linkTarget) ||
                [...validPaths].some(p => p.endsWith(`/${linkTarget}`));

              if (!exists) {
                // Find context line containing the broken link
                const lines = note.body.split('\n');
                const contextLine =
                  lines.find(l => l.includes(`[[${linkTarget}`)) || '';

                brokenLinks.push({
                  notePath: normalizedPath,
                  brokenLink: linkTarget,
                  context: contextLine.trim().slice(0, PREVIEW_LENGTH_SHORT),
                });

                if (brokenLinks.length >= limit) break;
              }
            }
            if (brokenLinks.length >= limit) break;
          }

          if (brokenLinks.length === 0) {
            return 'No broken links found. All wikilinks point to existing notes!';
          }

          let response = `**Broken Links (${brokenLinks.length}):**\n\n`;
          for (const bl of brokenLinks) {
            response += `**${bl.notePath}** → [[${bl.brokenLink}]]\n`;
            response += `> ${bl.context}\n\n`;
          }

          response +=
            '_Fix by: creating the missing note, updating the link target, or removing the link._';
          return response.trim();
        } catch (error) {
          return `Error finding broken links: ${error.message}`;
        }
      },
    }),

    supersede: tool({
      description:
        'Mark a note as superseded when your thinking has fundamentally evolved. The old note becomes historical context with a link to the new understanding. Use this instead of deleting — it preserves the evolution of thought.',
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
          .describe(
            'Brief explanation of why thinking evolved (optional, for historical context)',
          ),
        folder: z
          .string()
          .optional()
          .describe('Folder for the new note (defaults to same as old note)'),
      }),
      execute: async ({ oldPath, newTitle, newContent, reason, folder }) => {
        try {
          const oldNote = vaultService.getNote(oldPath);
          if (!oldNote) {
            return `Note not found: ${oldPath}. Cannot supersede a non-existent note.`;
          }

          const today = formatObsidianDate();

          // Determine new note path
          const sanitizedTitle = sanitizePath(newTitle);
          const oldFolder = oldPath.includes('/')
            ? oldPath.split('/').slice(0, -1).join('/')
            : undefined;
          const targetFolder = folder ? sanitizePath(folder) : oldFolder;
          const newPath = targetFolder
            ? `${targetFolder}/${sanitizedTitle}`
            : sanitizedTitle;

          // Check if new path already exists
          const existingNew = vaultService.getNote(newPath);
          if (existingNew) {
            return `Note already exists at "${newPath}". Choose a different title or update the existing note.`;
          }

          // Create the new note with supersedes info in body
          const oldName = oldPath.replace(/\.md$/, '').split('/').pop();
          const supersedesBody = `_Supersedes [[${oldName}]]_\n\n${newContent}`;

          const newNoteContent = matter.stringify(supersedesBody, {
            growth_stage: 'seedling',
            last_tended: today,
            summary: '',
            aliases: [],
            tags: [],
          });

          await vaultService.writeNote(newPath, newNoteContent);
          await indexSyncProcessor.queueSingleNote(newPath, newNoteContent);

          // Update the old note with superseded marker in body only
          const supersessionNotice = reason
            ? `> **Superseded:** This note has been superseded by [[${sanitizedTitle}]]. ${reason}\n\n`
            : `> **Superseded:** This note has been superseded by [[${sanitizedTitle}]].\n\n`;

          const updatedOldContent = matter.stringify(
            supersessionNotice + oldNote.body.trim(),
            {
              ...oldNote.frontmatter,
              last_tended: today,
            },
          );

          await vaultService.writeNote(oldPath, updatedOldContent);
          await indexSyncProcessor.queueSingleNote(oldPath, updatedOldContent);

          // Auto-create stub seedlings for any broken wikilinks in the new content
          const stubResult = await createStubsForBrokenLinks(newContent, deps);

          return `Superseded "${oldPath}" with "${newPath}".\n\nThe old note now links to the new one and is marked as superseded. Both notes remain in the garden — the old one as historical context.${formatStubResult(stubResult)}`;
        } catch (error) {
          return `Error superseding note: ${error.message}`;
        }
      },
    }),
  };
}
