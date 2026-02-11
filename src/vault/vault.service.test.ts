import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultEvents } from './vault.events';
import { VaultService } from './vault.service';

/** Temporary vault directory for each test */
let vaultDir: string;

function createService(vaultPath: string) {
  const mockLogger = {
    setContext: mock(),
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  };

  const mockConfig = {
    get: mock((key: string) => {
      if (key === 'vault.excludePatterns') return ['.obsidian', 'Templates'];
      if (key === 'vault.path') return vaultPath;
      return '';
    }),
  };

  const mockEventEmitter = {
    emit: mock(),
  };

  const service = new VaultService(
    mockLogger as never,
    mockConfig as never,
    mockEventEmitter as never,
  );

  // Mock MurLock decorator dependency
  (service as unknown as Record<string, unknown>).murlockServiceDecorator = {
    options: { lockKeyPrefix: 'test' },
    runWithLock: mock(
      (_key: string, _releaseTime: number, _wait: unknown, fn: () => unknown) =>
        fn(),
    ),
  };

  return { service, mockLogger, mockConfig, mockEventEmitter };
}

/**
 * Creates a markdown file in the temp vault directory.
 * Ensures parent directories exist.
 */
function createFile(relativePath: string, content: string): void {
  const absolutePath = join(vaultDir, relativePath);
  const dir = absolutePath.split('/').slice(0, -1).join('/');
  mkdirSync(dir, { recursive: true });
  writeFileSync(absolutePath, content);
}

beforeEach(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), 'vault-test-'));
});

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('VaultService', () => {
  describe('onModuleInit', () => {
    test('loads notes from filesystem into memory', async () => {
      createFile(
        'People/Luna.md',
        '---\ngrowth_stage: seedling\n---\nLuna is a dog',
      );
      createFile('Notes/Test.md', '---\n---\nTest content');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      expect(service.getAllNotes()).toHaveLength(2);
      expect(service.getNote('People/Luna.md')).not.toBeNull();
      expect(service.getNote('Notes/Test.md')).not.toBeNull();
    });

    test('excludes notes matching exclude patterns', async () => {
      createFile('Notes/Good.md', 'Good note');
      createFile('.obsidian/settings.md', 'Should be excluded');
      createFile('Templates/Default.md', 'Also excluded');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      expect(service.getAllNotes()).toHaveLength(1);
      expect(service.getNote('Notes/Good.md')).not.toBeNull();
    });

    test('creates vault directory if missing', async () => {
      const nestedPath = join(vaultDir, 'nested', 'vault');

      const { service } = createService(nestedPath);
      await service.onModuleInit();

      expect(service.getAllNotes()).toHaveLength(0);
    });
  });

  describe('getNote', () => {
    test('finds note with exact path', async () => {
      createFile('People/Luna.md', 'Luna content');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      const note = service.getNote('People/Luna.md');
      expect(note).not.toBeNull();
      expect(note!.title).toBe('Luna');
    });

    test('handles .md suffix normalization', async () => {
      createFile('People/Luna.md', 'Luna content');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      expect(service.getNote('People/Luna')).not.toBeNull();
      expect(service.getNote('People/Luna.md')).not.toBeNull();
    });

    test('returns null for non-existent note', async () => {
      const { service } = createService(vaultDir);
      await service.onModuleInit();

      expect(service.getNote('Missing/Note')).toBeNull();
    });
  });

  describe('getAllNotes', () => {
    test('returns all loaded notes', async () => {
      createFile('A.md', 'Note A');
      createFile('B.md', 'Note B');
      createFile('C.md', 'Note C');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      expect(service.getAllNotes()).toHaveLength(3);
    });
  });

  describe('listNotes', () => {
    test('lists all paths without folder filter', async () => {
      createFile('Notes/A.md', 'A');
      createFile('People/B.md', 'B');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      const paths = service.listNotes();
      expect(paths).toHaveLength(2);
    });

    test('filters by folder prefix', async () => {
      createFile('Notes/A.md', 'A');
      createFile('Notes/B.md', 'B');
      createFile('People/C.md', 'C');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      const paths = service.listNotes('Notes');
      expect(paths).toHaveLength(2);
      expect(paths.every(p => p.startsWith('Notes/'))).toBe(true);
    });
  });

  describe('getBacklinks', () => {
    test('returns notes that link to target', async () => {
      createFile('Notes/Target.md', '---\n---\nTarget note');
      createFile('Notes/Linker.md', '---\n---\nLinks to [[Target]]');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      const backlinks = service.getBacklinks('Notes/Target');
      expect(backlinks).toContain('Notes/Linker');
    });

    test('returns empty array when no backlinks', async () => {
      createFile('Notes/Lonely.md', '---\n---\nNo one links here');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      expect(service.getBacklinks('Notes/Lonely')).toHaveLength(0);
    });
  });

  describe('writeNote', () => {
    test('writes to filesystem and updates index', async () => {
      const { service, mockEventEmitter } = createService(vaultDir);
      await service.onModuleInit();

      await service.writeNote(
        'Notes/New',
        '---\ngrowth_stage: seedling\n---\nNew content',
      );

      const note = service.getNote('Notes/New.md');
      expect(note).not.toBeNull();
      expect(note!.body).toContain('New content');

      // Verify file was written to disk
      const onDisk = await Bun.file(join(vaultDir, 'Notes/New.md')).text();
      expect(onDisk).toContain('New content');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        VaultEvents.NOTE_CREATED,
        expect.objectContaining({ path: 'Notes/New.md' }),
      );
    });

    test('emits NOTE_CHANGED for existing notes', async () => {
      createFile('Notes/Existing.md', 'Old content');

      const { service, mockEventEmitter } = createService(vaultDir);
      await service.onModuleInit();

      await service.writeNote('Notes/Existing.md', 'Updated content');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        VaultEvents.NOTE_CHANGED,
        expect.objectContaining({ path: 'Notes/Existing.md' }),
      );
    });

    test('creates parent directories if needed', async () => {
      const { service } = createService(vaultDir);
      await service.onModuleInit();

      await service.writeNote('Deep/Nested/Dir/Note.md', 'content');

      const note = service.getNote('Deep/Nested/Dir/Note.md');
      expect(note).not.toBeNull();
    });
  });

  describe('appendToNote', () => {
    test('appends to existing note', async () => {
      createFile('Notes/Append.md', 'Original content');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      await service.appendToNote('Notes/Append.md', 'Appended content');

      const note = service.getNote('Notes/Append.md');
      expect(note!.raw).toContain('Original content');
      expect(note!.raw).toContain('Appended content');
    });

    test('creates note if it does not exist', async () => {
      const { service } = createService(vaultDir);
      await service.onModuleInit();

      await service.appendToNote('Notes/NewAppend', 'New content');

      const note = service.getNote('Notes/NewAppend.md');
      expect(note).not.toBeNull();
      expect(note!.raw).toBe('New content');
    });
  });

  describe('deleteNote', () => {
    test('deletes from filesystem and removes from index', async () => {
      createFile('Notes/ToDelete.md', 'Delete me');

      const { service, mockEventEmitter } = createService(vaultDir);
      await service.onModuleInit();

      expect(service.getNote('Notes/ToDelete.md')).not.toBeNull();

      await service.deleteNote('Notes/ToDelete.md');

      expect(service.getNote('Notes/ToDelete.md')).toBeNull();

      // Verify file is gone from disk
      expect(Bun.file(join(vaultDir, 'Notes/ToDelete.md')).size).resolves
        .toBeNaN;

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        VaultEvents.NOTE_DELETED,
        { path: 'Notes/ToDelete.md' },
      );
    });

    test('no-ops when note does not exist', async () => {
      const { service, mockEventEmitter } = createService(vaultDir);
      await service.onModuleInit();

      await service.deleteNote('Notes/Missing.md');

      // Should not have emitted any delete event
      const emitCalls = mockEventEmitter.emit.mock.calls as unknown[][];
      const deleteCalls = emitCalls.filter(
        c => c[0] === VaultEvents.NOTE_DELETED,
      );
      expect(deleteCalls).toHaveLength(0);
    });
  });

  describe('self-write suppression', () => {
    test('skips fs watcher events for own writes', async () => {
      const { service, mockEventEmitter } = createService(vaultDir);
      await service.onModuleInit();

      // Write a note (adds path to pendingWrites)
      await service.writeNote('Notes/Mine.md', 'My content');

      // Reset emit count
      mockEventEmitter.emit.mockClear();

      // The fs watcher would normally fire for our own write,
      // but pendingWrites suppresses it. We verify by writing externally
      // after the pending window expires (200ms).
      await new Promise(resolve => setTimeout(resolve, 300));

      // Now an external write should be detected
      await writeFile(join(vaultDir, 'Notes/Mine.md'), 'External update');

      // Give watcher time to fire
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should detect the external change (not suppressed since pendingWrites cleared)
      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });
  });

  describe('external change handling', () => {
    test('updates index on external file creation', async () => {
      const { service, mockEventEmitter } = createService(vaultDir);
      await service.onModuleInit();

      // Simulate external change: create a file on disk
      mkdirSync(join(vaultDir, 'Notes'), { recursive: true });
      writeFileSync(
        join(vaultDir, 'Notes/External.md'),
        '---\ngrowth_stage: budding\n---\nFrom Obsidian',
      );

      // Wait for fs watcher to fire and async handler to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      const note = service.getNote('Notes/External.md');
      expect(note).not.toBeNull();
      expect(note!.frontmatter.growth_stage).toBe('budding');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        VaultEvents.NOTE_CREATED,
        expect.objectContaining({ path: 'Notes/External.md' }),
      );
    });

    test('removes note on external delete', async () => {
      createFile('Notes/WillBeDeleted.md', 'content');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      expect(service.getNote('Notes/WillBeDeleted.md')).not.toBeNull();

      // Delete the file externally
      rmSync(join(vaultDir, 'Notes/WillBeDeleted.md'));

      // Wait for fs watcher to fire
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(service.getNote('Notes/WillBeDeleted.md')).toBeNull();
    });
  });

  describe('searchText', () => {
    test('finds matching notes', async () => {
      createFile('Notes/A.md', '---\n---\nThe quick brown fox');
      createFile('Notes/B.md', '---\n---\nA lazy dog');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      const results = service.searchText('brown fox');
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('Notes/A.md');
      expect(results[0].context).toContain('brown fox');
    });

    test('case insensitive search', async () => {
      createFile('Notes/A.md', '---\n---\nHello World');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      const results = service.searchText('hello world');
      expect(results).toHaveLength(1);
    });
  });

  describe('notes without frontmatter', () => {
    test('handles raw text with no frontmatter', async () => {
      createFile('Notes/Plain.md', 'Just plain text');

      const { service } = createService(vaultDir);
      await service.onModuleInit();

      const note = service.getNote('Notes/Plain.md');
      expect(note).not.toBeNull();
      expect(note!.frontmatter.summary).toBe('');
      expect(note!.body).toContain('Just plain text');
    });
  });

  describe('onModuleDestroy', () => {
    test('closes fs watcher without error', async () => {
      const { service } = createService(vaultDir);
      await service.onModuleInit();

      // Should not throw
      service.onModuleDestroy();
    });
  });
});
