import matter from 'gray-matter';
import { formatObsidianDate } from '../../../common/obsidian-date';
import { extractWikilinks } from '../../../vault';
import type { GardenToolsDependencies } from './types';
import { ensureMdExtension, sanitizePath } from './utils';

/** Result of stub creation for a single call */
export interface StubCreationResult {
  /** Paths of the newly created stub notes (without .md) */
  createdPaths: string[];
}

/**
 * Extracts wikilinks from content, identifies targets that don't exist
 * in the vault, and creates minimal stub seedling notes for each missing target.
 *
 * Uses the same triple-match logic as the `broken_links` tool:
 * full path, short name, or path suffix.
 *
 * @param content - Markdown content to scan for wikilinks
 * @param deps - Garden tool dependencies (vaultService, indexSyncProcessor)
 * @returns Paths of all created stubs
 */
export async function createStubsForBrokenLinks(
  content: string,
  deps: GardenToolsDependencies,
): Promise<StubCreationResult> {
  const { vaultService, indexSyncProcessor } = deps;

  const links = extractWikilinks(content);
  if (links.size === 0) {
    return { createdPaths: [] };
  }

  // Build lookup sets from all existing notes (same approach as broken_links)
  const allNotes = vaultService.getAllNotes();
  const validPaths = new Set<string>();
  const validNames = new Set<string>();
  for (const note of allNotes) {
    const normalizedPath = note.path.replace(/\.md$/, '');
    validPaths.add(normalizedPath);
    validNames.add(normalizedPath.split('/').pop() || '');
  }

  const createdPaths: string[] = [];
  const seen = new Set<string>();

  for (const linkTarget of links) {
    // Skip if link already resolves
    const exists =
      validPaths.has(linkTarget) ||
      validNames.has(linkTarget) ||
      [...validPaths].some(p => p.endsWith(`/${linkTarget}`));

    if (exists) {
      continue;
    }

    const sanitized = sanitizePath(linkTarget);
    if (!sanitized || seen.has(sanitized)) {
      continue;
    }
    seen.add(sanitized);

    // Double-check after sanitization to avoid edge-case collisions
    if (vaultService.getNote(sanitized)) {
      continue;
    }

    const stubContent = matter.stringify(
      '_Stub: created as a placeholder from a wikilink reference._',
      {
        growth_stage: 'seedling',
        last_tended: formatObsidianDate(),
        summary: sanitized,
        aliases: [],
        tags: [],
      },
    );

    await vaultService.writeNote(sanitized, stubContent);
    await indexSyncProcessor.queueSingleNote(
      ensureMdExtension(sanitized),
      stubContent,
    );

    // Update lookup sets so subsequent links in the same call don't re-create
    validPaths.add(sanitized);
    validNames.add(sanitized.split('/').pop() || '');

    createdPaths.push(sanitized);
  }

  return { createdPaths };
}

/**
 * Formats a stub creation result as a human-readable suffix string.
 *
 * Returns an empty string if no stubs were created, so tools can
 * unconditionally append this to their response.
 */
export function formatStubResult(result: StubCreationResult): string {
  if (result.createdPaths.length === 0) {
    return '';
  }

  const links = result.createdPaths.map(p => `[[${p}]]`).join(', ');
  return `\n\nAuto-created ${result.createdPaths.length} stub seedling(s): ${links}`;
}
