import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MurLock } from 'murlock';
import { PinoLogger } from 'nestjs-pino';
import { Note, type NoteStat } from './note';
import { VaultEvents } from './vault.events';

/** Lock timeout for write operations (30 seconds) */
const LOCK_TIMEOUT_MS = 30_000;
/** Milliseconds per second for logging conversion */
const MS_PER_SECOND = 1000;
/** Characters of context to show around search matches */
const SEARCH_CONTEXT_CHARS = 50;
/** Delay before removing a path from pendingWrites (ms) */
const PENDING_WRITE_CLEAR_DELAY_MS = 200;

/**
 * In-memory vault backed by the filesystem.
 *
 * Loads all `.md` files from a directory on boot, maintains pre-computed
 * backlink indexes, and watches the directory for external changes
 * (e.g., edits from Obsidian or git pulls).
 *
 * All read operations are synchronous from the in-memory index.
 * Write operations persist to disk first, then update the index.
 */
@Injectable()
export class VaultService implements OnModuleInit, OnModuleDestroy {
  /** In-memory note index, keyed by original-case relative path */
  private notes = new Map<string, Note>();

  /** Pre-computed backlink index: path → set of paths that link to it */
  private backlinks = new Map<string, Set<string>>();

  /** Tracks paths being written to skip self-echo from fs watcher */
  private pendingWrites = new Set<string>();

  /** Exclude patterns from config */
  private excludePatterns: string[] = [];

  /** Resolved absolute path to the vault directory */
  private vaultPath = '';

  /** Filesystem watcher handle */
  private fsWatcher: FSWatcher | null = null;

  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.logger.setContext(VaultService.name);
  }

  async onModuleInit(): Promise<void> {
    this.excludePatterns =
      this.configService.get<string[]>('vault.excludePatterns') || [];

    const configPath =
      this.configService.get<string>('vault.path') || './vault';
    this.vaultPath = resolve(configPath);

    // Ensure vault directory exists
    await mkdir(this.vaultPath, { recursive: true });

    const startTime = Date.now();

    // Discover and load all markdown files
    const glob = new Bun.Glob('**/*.md');
    for await (const relativePath of glob.scan({ cwd: this.vaultPath })) {
      if (this.shouldExclude(relativePath)) continue;

      const absolutePath = resolve(this.vaultPath, relativePath);

      try {
        const [content, fileStat] = await Promise.all([
          Bun.file(absolutePath).text(),
          stat(absolutePath),
        ]);

        const noteStat: NoteStat = {
          ctime: fileStat.birthtime,
          mtime: fileStat.mtime,
          size: fileStat.size,
        };

        const note = new Note(relativePath, content, noteStat);
        this.notes.set(relativePath, note);
      } catch (error) {
        this.logger.warn(
          { path: relativePath, err: error },
          'Failed to load note',
        );
      }
    }

    // Build backlink index
    this.rebuildAllBacklinks();

    const elapsed = (Date.now() - startTime) / MS_PER_SECOND;
    this.logger.info(
      {
        noteCount: this.notes.size,
        elapsedSeconds: elapsed,
        vaultPath: this.vaultPath,
      },
      'Vault loaded from filesystem',
    );

    // Start watching for external changes
    this.fsWatcher = watch(
      this.vaultPath,
      { recursive: true },
      (_eventType, filename) => {
        if (filename) {
          this.handleFsEvent(filename);
        }
      },
    );

    // Handle watcher errors (e.g., EACCES on lost+found in mounted volumes)
    this.fsWatcher.on('error', (error: NodeJS.ErrnoException) => {
      this.logger.warn(
        { err: error, code: error.code },
        'Filesystem watcher error',
      );
    });
  }

  onModuleDestroy(): void {
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  // ─── Read Methods (synchronous, from in-memory index) ──────

  /**
   * Returns a note by path, or null if not found.
   *
   * Handles `.md` suffix normalization: both `People/Luna`
   * and `People/Luna.md` will match.
   */
  getNote(path: string): Note | null {
    const normalized = path.endsWith('.md') ? path : `${path}.md`;

    return this.notes.get(path) || this.notes.get(normalized) || null;
  }

  /** Returns all notes in the vault. */
  getAllNotes(): Note[] {
    return Array.from(this.notes.values());
  }

  /**
   * Lists note paths, optionally filtered by folder prefix.
   */
  listNotes(folder?: string): string[] {
    if (!folder) {
      return Array.from(this.notes.keys());
    }

    const prefix = folder.endsWith('/') ? folder : `${folder}/`;

    return Array.from(this.notes.keys()).filter(p => p.startsWith(prefix));
  }

  /**
   * Returns paths of notes that link TO the given path.
   *
   * Uses the pre-computed backlink index for O(1) lookups.
   */
  getBacklinks(path: string): string[] {
    const normalized = path.replace(/\.md$/, '');
    const pathName = normalized.split('/').pop() || '';

    const results = new Set<string>();

    // Check full path
    const fullPathLinks = this.backlinks.get(normalized);
    if (fullPathLinks) {
      for (const link of fullPathLinks) results.add(link);
    }

    // Check short name (filename without folder)
    const shortNameLinks = this.backlinks.get(pathName);
    if (shortNameLinks) {
      for (const link of shortNameLinks) results.add(link);
    }

    return Array.from(results);
  }

  /**
   * Simple case-insensitive substring search across note bodies.
   */
  searchText(query: string): { path: string; context: string }[] {
    const lower = query.toLowerCase();
    const results: { path: string; context: string }[] = [];

    for (const note of this.notes.values()) {
      const bodyLower = note.body.toLowerCase();
      const index = bodyLower.indexOf(lower);

      if (index === -1) continue;

      // Extract surrounding context
      const contextStart = Math.max(0, index - SEARCH_CONTEXT_CHARS);
      const contextEnd = Math.min(
        note.body.length,
        index + query.length + SEARCH_CONTEXT_CHARS,
      );
      const context = note.body.slice(contextStart, contextEnd);

      results.push({ path: note.path, context });
    }

    return results;
  }

  // ─── Write Methods (async, filesystem + index update) ──────

  /**
   * Writes or updates a note on disk and in the in-memory index.
   *
   * @param path - Note path (with or without `.md`)
   * @param content - Full markdown content including frontmatter
   */
  @MurLock(LOCK_TIMEOUT_MS, 'path')
  async writeNote(path: string, content: string): Promise<void> {
    const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;
    const absolutePath = resolve(this.vaultPath, normalizedPath);

    const existing = this.notes.get(normalizedPath);

    // Track write to suppress fs watcher echo
    this.pendingWrites.add(normalizedPath);

    try {
      // Ensure parent directory exists
      await mkdir(dirname(absolutePath), { recursive: true });

      // Write content to disk
      await Bun.write(absolutePath, content);

      // Read stat for mtime/size
      const fileStat = await stat(absolutePath);

      const noteStat: NoteStat = existing
        ? { ...existing.stat, mtime: fileStat.mtime, size: fileStat.size }
        : {
            ctime: fileStat.birthtime,
            mtime: fileStat.mtime,
            size: fileStat.size,
          };

      const note = new Note(normalizedPath, content, noteStat);
      const isCreate = !existing;

      // Get previous outbound links for incremental backlink update
      const previousOutboundLinks = existing?.outboundLinks;
      this.notes.set(normalizedPath, note);
      this.rebuildBacklinksForNote(note, previousOutboundLinks);

      // Emit event
      const event = isCreate
        ? VaultEvents.NOTE_CREATED
        : VaultEvents.NOTE_CHANGED;
      this.eventEmitter.emit(event, { path: normalizedPath, note });
    } finally {
      setTimeout(
        () => this.pendingWrites.delete(normalizedPath),
        PENDING_WRITE_CLEAR_DELAY_MS,
      );
    }
  }

  /**
   * Appends content to the end of an existing note.
   *
   * Reads the current content, concatenates, then delegates to writeNote.
   */
  async appendToNote(path: string, content: string): Promise<void> {
    const existing = this.getNote(path);
    if (!existing) {
      // If note doesn't exist, just create it
      await this.writeNote(path, content);
      return;
    }

    const newContent = `${existing.raw}\n\n${content}`;
    await this.writeNote(existing.path, newContent);
  }

  /**
   * Deletes a note from disk and the in-memory index.
   */
  @MurLock(LOCK_TIMEOUT_MS, 'path')
  async deleteNote(path: string): Promise<void> {
    const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;

    const existing = this.notes.get(normalizedPath);
    if (!existing) return;

    const absolutePath = resolve(this.vaultPath, normalizedPath);

    // Track write to suppress fs watcher echo
    this.pendingWrites.add(normalizedPath);

    try {
      await unlink(absolutePath);

      // Remove from index
      this.removeNoteFromBacklinks(existing);
      this.notes.delete(normalizedPath);

      this.eventEmitter.emit(VaultEvents.NOTE_DELETED, {
        path: normalizedPath,
      });
    } finally {
      setTimeout(
        () => this.pendingWrites.delete(normalizedPath),
        PENDING_WRITE_CLEAR_DELAY_MS,
      );
    }
  }

  // ─── Filesystem Watcher ───────────────────────────────────

  /**
   * Handles a filesystem event from `fs.watch`.
   *
   * Determines whether a file was created/updated or deleted by
   * attempting to read it. Self-writes are suppressed via `pendingWrites`.
   */
  private handleFsEvent(filename: string): void {
    // Normalize path separators (Windows compat)
    const relativePath = filename.replace(/\\/g, '/');

    // Only process markdown files
    if (!relativePath.endsWith('.md')) return;
    if (this.shouldExclude(relativePath)) return;

    // Self-write detection
    if (this.pendingWrites.has(relativePath)) return;

    const absolutePath = resolve(this.vaultPath, relativePath);

    // Try to read — success = create/update, failure = delete
    Promise.all([readFile(absolutePath, 'utf-8'), stat(absolutePath)])
      .then(([content, fileStat]) => {
        const noteStat: NoteStat = {
          ctime: fileStat.birthtime,
          mtime: fileStat.mtime,
          size: fileStat.size,
        };

        const note = new Note(relativePath, content, noteStat);
        const isCreate = !this.notes.has(relativePath);

        const previousOutboundLinks =
          this.notes.get(relativePath)?.outboundLinks;
        this.notes.set(relativePath, note);
        this.rebuildBacklinksForNote(note, previousOutboundLinks);

        const event = isCreate
          ? VaultEvents.NOTE_CREATED
          : VaultEvents.NOTE_CHANGED;

        this.eventEmitter.emit(event, { path: relativePath, note });

        this.logger.debug(
          { path: relativePath, event },
          'External note change',
        );
      })
      .catch(() => {
        // File was deleted
        const existing = this.notes.get(relativePath);
        if (!existing) return;

        this.removeNoteFromBacklinks(existing);
        this.notes.delete(relativePath);

        this.eventEmitter.emit(VaultEvents.NOTE_DELETED, {
          path: relativePath,
        });

        this.logger.debug({ path: relativePath }, 'External note deleted');
      });
  }

  // ─── Backlink Management ───────────────────────────────────

  /**
   * Fully rebuilds the backlink index from all notes.
   *
   * Called once on module init.
   */
  private rebuildAllBacklinks(): void {
    this.backlinks.clear();

    for (const note of this.notes.values()) {
      for (const target of note.outboundLinks) {
        if (!this.backlinks.has(target)) {
          this.backlinks.set(target, new Set());
        }
        this.backlinks.get(target)?.add(note.path.replace(/\.md$/, ''));
      }
    }
  }

  /**
   * Incrementally updates backlinks when a single note changes.
   *
   * Removes old outbound links, adds new ones.
   */
  private rebuildBacklinksForNote(
    note: Note,
    previousOutboundLinks?: ReadonlySet<string>,
  ): void {
    const sourcePath = note.path.replace(/\.md$/, '');

    // Remove old outbound links
    if (previousOutboundLinks) {
      for (const target of previousOutboundLinks) {
        this.backlinks.get(target)?.delete(sourcePath);
      }
    }

    // Add new outbound links
    for (const target of note.outboundLinks) {
      if (!this.backlinks.has(target)) {
        this.backlinks.set(target, new Set());
      }
      this.backlinks.get(target)?.add(sourcePath);
    }
  }

  /**
   * Removes all backlink entries for a deleted note.
   */
  private removeNoteFromBacklinks(note: Note): void {
    const sourcePath = note.path.replace(/\.md$/, '');

    for (const target of note.outboundLinks) {
      this.backlinks.get(target)?.delete(sourcePath);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────

  /**
   * Checks if a path matches any exclude pattern.
   */
  private shouldExclude(path: string): boolean {
    return this.excludePatterns.some(pattern => {
      if (pattern.includes('*')) {
        const regex = new RegExp(
          `^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
        );
        return regex.test(path);
      }
      return path.startsWith(pattern) || path.includes(`/${pattern}`);
    });
  }
}
