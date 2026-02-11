import { beforeEach, describe, expect, mock, test } from 'bun:test';
import matter from 'gray-matter';
import { Note } from '../../../vault';
import { createStubsForBrokenLinks, formatStubResult } from './stub-creator';
import type { GardenToolsDependencies } from './types';

/** Helper to create a mock Note instance from path and raw content. */
function createMockNote(path: string, content: string): Note {
  const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
  return new Note(normalizedPath, content, {
    ctime: new Date('2024-01-01'),
    mtime: new Date('2024-01-01'),
    size: content.length,
  });
}

describe('stub-creator', () => {
  let mockVaultService: {
    getNote: ReturnType<typeof mock>;
    writeNote: ReturnType<typeof mock>;
    getAllNotes: ReturnType<typeof mock>;
  };
  let mockIndexSyncProcessor: { queueSingleNote: ReturnType<typeof mock> };
  let deps: GardenToolsDependencies;

  beforeEach(() => {
    mockVaultService = {
      getNote: mock(() => null),
      writeNote: mock(() => Promise.resolve()),
      getAllNotes: mock(() => []),
    };

    mockIndexSyncProcessor = {
      queueSingleNote: mock(() => Promise.resolve()),
    };

    deps = {
      vaultService: mockVaultService as never,
      embeddingService: {} as never,
      qdrantService: {} as never,
      indexSyncProcessor: mockIndexSyncProcessor as never,
    };
  });

  test('creates stubs for wikilinks referencing non-existent notes', async () => {
    const content =
      'Met [[Taylor Blankenship]] at [[Aledo, Texas]] working on [[Flylance]]';

    const result = await createStubsForBrokenLinks(content, deps);

    expect(result.createdPaths).toHaveLength(3);
    expect(result.createdPaths).toContain('Taylor Blankenship');
    expect(result.createdPaths).toContain('Aledo, Texas');
    expect(result.createdPaths).toContain('Flylance');
    expect(mockVaultService.writeNote).toHaveBeenCalledTimes(3);
    expect(mockIndexSyncProcessor.queueSingleNote).toHaveBeenCalledTimes(3);
  });

  test('does not create stubs when all links resolve by full path', async () => {
    mockVaultService.getAllNotes = mock(() => [
      createMockNote('People/Luna', '---\ngrowth_stage: seedling\n---\nA dog'),
    ]);

    const content = 'Walking with [[People/Luna]]';
    const result = await createStubsForBrokenLinks(content, deps);

    expect(result.createdPaths).toHaveLength(0);
    expect(mockVaultService.writeNote).not.toHaveBeenCalled();
  });

  test('does not create stubs when links resolve by short name', async () => {
    mockVaultService.getAllNotes = mock(() => [
      createMockNote('People/Luna', '---\ngrowth_stage: seedling\n---\nA dog'),
    ]);

    const content = 'Walking with [[Luna]]';
    const result = await createStubsForBrokenLinks(content, deps);

    expect(result.createdPaths).toHaveLength(0);
    expect(mockVaultService.writeNote).not.toHaveBeenCalled();
  });

  test('does not create stubs when links resolve by path suffix', async () => {
    mockVaultService.getAllNotes = mock(() => [
      createMockNote(
        'Places/Texas/Aledo',
        '---\ngrowth_stage: seedling\n---\nA town',
      ),
    ]);

    const content = 'Living in [[Texas/Aledo]]';
    const result = await createStubsForBrokenLinks(content, deps);

    expect(result.createdPaths).toHaveLength(0);
    expect(mockVaultService.writeNote).not.toHaveBeenCalled();
  });

  test('returns empty for content with no wikilinks', async () => {
    const content = 'Just plain text without any links.';
    const result = await createStubsForBrokenLinks(content, deps);

    expect(result.createdPaths).toHaveLength(0);
    expect(mockVaultService.writeNote).not.toHaveBeenCalled();
  });

  test('deduplicates multiple references to the same target', async () => {
    const content =
      '[[Flylance]] is great. I love working at [[Flylance]]. Did I mention [[Flylance]]?';

    const result = await createStubsForBrokenLinks(content, deps);

    expect(result.createdPaths).toHaveLength(1);
    expect(result.createdPaths).toContain('Flylance');
    expect(mockVaultService.writeNote).toHaveBeenCalledTimes(1);
  });

  test('handles [[target|display text]] form by extracting target only', async () => {
    const content = 'Talked to [[Taylor Blankenship|Taylor]] about things';

    const result = await createStubsForBrokenLinks(content, deps);

    expect(result.createdPaths).toHaveLength(1);
    expect(result.createdPaths).toContain('Taylor Blankenship');
  });

  test('stub frontmatter includes summary and growth_stage seedling', async () => {
    const content = 'Reference to [[New Concept]]';
    await createStubsForBrokenLinks(content, deps);

    const [, writtenContent] = mockVaultService.writeNote.mock.calls[0];
    const parsed = matter(writtenContent as string);

    expect(parsed.data.growth_stage).toBe('seedling');
    expect(parsed.data.summary).toBe('New Concept');
    expect(parsed.data.aliases).toEqual([]);
    expect(parsed.data.tags).toEqual([]);
    expect(parsed.content.trim()).toBe(
      '_Stub: created as a placeholder from a wikilink reference._',
    );
  });

  test('sanitizes stub names by removing invalid filename characters', async () => {
    const content = 'Link to [[Some<>Thing]]';
    const result = await createStubsForBrokenLinks(content, deps);

    expect(result.createdPaths).toHaveLength(1);
    expect(result.createdPaths[0]).toBe('SomeThing');
  });

  test('skips stubs that collide with existing notes after sanitization', async () => {
    mockVaultService.getNote = mock((path: string) => {
      if (path === 'SomeThing') {
        return createMockNote(
          'SomeThing',
          '---\ngrowth_stage: seedling\n---\nExists',
        );
      }
      return null;
    });

    const content = 'Link to [[Some<>Thing]]';
    const result = await createStubsForBrokenLinks(content, deps);

    expect(result.createdPaths).toHaveLength(0);
    expect(mockVaultService.writeNote).not.toHaveBeenCalled();
  });

  describe('formatStubResult', () => {
    test('returns empty string when no stubs created', () => {
      const result = formatStubResult({ createdPaths: [] });
      expect(result).toBe('');
    });

    test('formats single stub', () => {
      const result = formatStubResult({ createdPaths: ['Taylor Blankenship'] });
      expect(result).toBe(
        '\n\nAuto-created 1 stub seedling(s): [[Taylor Blankenship]]',
      );
    });

    test('formats multiple stubs', () => {
      const result = formatStubResult({
        createdPaths: ['Taylor Blankenship', 'Aledo, Texas', 'Flylance'],
      });
      expect(result).toBe(
        '\n\nAuto-created 3 stub seedling(s): [[Taylor Blankenship]], [[Aledo, Texas]], [[Flylance]]',
      );
    });
  });
});
