import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Job, Queue } from 'bullmq';
import { MurLock } from 'murlock';
import { PinoLogger } from 'nestjs-pino';
import {
  VaultEvents,
  type VaultNoteDeletedEvent,
  type VaultNoteEvent,
  VaultService,
} from '../vault';
import { ChunkingService } from '../vector/chunking.service';
import { EmbeddingService } from '../vector/embedding.service';
import {
  type ChunkUpsertData,
  QdrantService,
  type SummaryUpsertData,
} from '../vector/qdrant.service';

/** Milliseconds per second for logging conversion */
const MS_PER_SECOND = 1000;
/** Lock timeout in milliseconds for single note indexing */
const LOCK_TIMEOUT_MS = 30_000;
/** Hexadecimal radix for hash conversion */
const HEX_RADIX = 16;
/** Padding for hash byte conversion */
const BYTE_PAD_LENGTH = 2;

interface IndexSyncJob {
  type: 'full-sync' | 'single-note';
  path?: string;
  content?: string;
}

@Processor('index-sync')
@Injectable()
export class IndexSyncProcessor extends WorkerHost implements OnModuleInit {
  private readonly syncIntervalMs: number;

  constructor(
    private readonly logger: PinoLogger,
    @InjectQueue('index-sync')
    private readonly syncQueue: Queue<IndexSyncJob>,
    private readonly vaultService: VaultService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantService,
    private readonly chunkingService: ChunkingService,
    private readonly configService: ConfigService,
  ) {
    super();
    this.logger.setContext(IndexSyncProcessor.name);
    this.syncIntervalMs = this.configService.get<number>(
      'vector.syncIntervalMs',
    );
  }

  async onModuleInit() {
    // Run initial sync immediately
    await this.queueFullSync();
    this.logger.info(
      { intervalSeconds: this.syncIntervalMs / MS_PER_SECOND },
      'Index sync initialized — event-driven updates active',
    );
  }

  /**
   * Handles external note changes detected via filesystem watcher.
   * Automatically re-indexes the note in Qdrant.
   */
  @OnEvent(VaultEvents.NOTE_CHANGED)
  async onNoteChanged(event: VaultNoteEvent): Promise<void> {
    await this.queueSingleNote(event.path, event.note.raw);
  }

  /**
   * Handles new notes detected via filesystem watcher.
   * Automatically indexes the note in Qdrant.
   */
  @OnEvent(VaultEvents.NOTE_CREATED)
  async onNoteCreated(event: VaultNoteEvent): Promise<void> {
    await this.queueSingleNote(event.path, event.note.raw);
  }

  /**
   * Handles note deletions detected via filesystem watcher.
   * Automatically removes the note from Qdrant.
   */
  @OnEvent(VaultEvents.NOTE_DELETED)
  async onNoteDeleted(event: VaultNoteDeletedEvent): Promise<void> {
    await this.qdrantService.deleteDocumentChunks(event.path);
    this.logger.debug({ path: event.path }, 'Deleted note from index');
  }

  async queueFullSync(): Promise<void> {
    await this.syncQueue.add('full-sync', { type: 'full-sync' });
    this.logger.info({}, 'Queued full index sync');
  }

  async queueSingleNote(path: string, content: string): Promise<void> {
    await this.syncQueue.add('single-note', {
      type: 'single-note',
      path,
      content,
    });
  }

  async process(job: Job<IndexSyncJob>): Promise<void> {
    const { type } = job.data;

    if (type === 'full-sync') {
      await this.performFullSync();
    } else if (type === 'single-note' && job.data.path) {
      await this.indexSingleNote(job.data.path, job.data.content);
    }
  }

  private async performFullSync(): Promise<void> {
    this.logger.info({}, 'Starting full index sync...');

    try {
      // 1. Get all notes from in-memory vault
      const vaultNotes = this.vaultService.getAllNotes();
      const vaultPaths = new Set(vaultNotes.map(n => n.path));

      // 2. Get all indexed documents from Qdrant (using document hash)
      const indexed = await this.qdrantService.getAllIndexedDocuments();

      let created = 0;
      let updated = 0;
      let deleted = 0;
      let totalChunks = 0;

      // 3. Process vault notes (CREATE or UPDATE)
      for (const note of vaultNotes) {
        const existingDoc = indexed.get(note.path);
        const currentHash = await this.hashContent(note.raw);

        if (!existingDoc) {
          // CREATE: New note not in index
          const chunkCount = await this.indexNoteWithChunks(
            note.path,
            note.raw,
          );
          if (chunkCount > 0) {
            created++;
            totalChunks += chunkCount;
          }
        } else if (existingDoc.documentHash !== currentHash) {
          // UPDATE: Content changed - delete old chunks and re-index
          await this.qdrantService.deleteDocumentChunks(note.path);
          const chunkCount = await this.indexNoteWithChunks(
            note.path,
            note.raw,
          );
          if (chunkCount > 0) {
            updated++;
            totalChunks += chunkCount;
          }
        }
        // else: unchanged, skip
      }

      // 4. Delete notes no longer in vault
      for (const [path] of indexed) {
        if (!vaultPaths.has(path)) {
          await this.qdrantService.deleteDocumentChunks(path);
          deleted++;
        }
      }

      this.logger.info(
        { created, updated, deleted, totalChunks },
        'Index sync complete',
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Error during full sync');
      throw error;
    }
  }

  @MurLock(LOCK_TIMEOUT_MS, 'path')
  private async indexSingleNote(path: string, content?: string): Promise<void> {
    try {
      const noteContent = content || this.vaultService.getNote(path)?.raw;

      if (!noteContent) {
        this.logger.warn({ path }, 'Note not found or empty, skipping index');
        return;
      }

      // Delete existing chunks for this document
      await this.qdrantService.deleteDocumentChunks(path);

      // Index with chunking
      const chunkCount = await this.indexNoteWithChunks(path, noteContent);
      this.logger.debug({ path, chunkCount }, 'Indexed single note');
    } catch (error) {
      this.logger.error({ err: error, path }, 'Error indexing note');
      throw error;
    }
  }

  /**
   * Index a note by chunking it and batch embedding.
   * Uses a two-tier strategy: summary embedding for search/dedup (document-level)
   * and chunk embeddings for context retrieval.
   */
  private async indexNoteWithChunks(
    path: string,
    content: string,
  ): Promise<number> {
    // Chunk the content
    const chunks = this.chunkingService.chunkMarkdown(content);

    if (chunks.length === 0) {
      this.logger.debug({ path }, 'Skipping empty note');
      return 0;
    }

    // Extract metadata
    const title = this.extractTitle(path, content);
    const tags = this.extractTags(content);
    const documentHash = await this.hashContent(content);
    const summary = this.extractSummary(path);

    // Batch embed all chunks
    const chunkContents = chunks.map(c => c.content);
    const embeddings = await this.embeddingService.embedBatch(chunkContents);

    // Prepare chunk upsert data
    const chunkData: ChunkUpsertData[] = chunks.map((chunk, i) => ({
      chunk,
      embedding: embeddings[i],
      path,
      totalChunks: chunks.length,
      documentHash,
      title,
      tags,
    }));

    // Batch upsert chunks to Qdrant
    await this.qdrantService.upsertChunks(chunkData);

    // If summary is non-empty, create a summary-level embedding for search/dedup
    if (summary) {
      const summaryEmbedding = await this.embeddingService.embed(summary);
      const summaryData: SummaryUpsertData = {
        embedding: summaryEmbedding,
        path,
        documentHash,
        title,
        tags,
        summary,
      };
      await this.qdrantService.upsertSummary(summaryData);
    }

    return chunks.length;
  }

  /**
   * Extracts the summary from the in-memory Note's frontmatter.
   *
   * @param path - Note path to look up
   * @returns Summary string, or empty string if not present
   */
  private extractSummary(path: string): string {
    const note = this.vaultService.getNote(path);
    return (note?.frontmatter.summary as string) || '';
  }

  private extractTitle(path: string, content: string): string {
    // Try to get title from frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const titleMatch = frontmatterMatch[1].match(/^title:\s*(.+)$/m);
      if (titleMatch) return titleMatch[1].trim().replace(/^["']|["']$/g, '');
    }

    // Try to get title from first H1
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) return h1Match[1].trim();

    // Fall back to filename
    const filename = path.split('/').pop() || path;
    return filename.replace(/\.md$/, '');
  }

  private extractTags(content: string): string[] {
    const tags: string[] = [];

    // Extract from frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const tagsMatch = frontmatterMatch[1].match(/^tags:\s*\[([^\]]+)\]/m);
      if (tagsMatch) {
        const tagList = tagsMatch[1]
          .split(',')
          .map(t => t.trim().replace(/^["']|["']$/g, ''));
        tags.push(...tagList);
      }
    }

    // Extract inline #tags
    const inlineTags = content.match(/#[\w-]+/g);
    if (inlineTags) {
      tags.push(...inlineTags.map(t => t.slice(1)));
    }

    return [...new Set(tags)];
  }

  private async hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray
      .map(b => b.toString(HEX_RADIX).padStart(BYTE_PAD_LENGTH, '0'))
      .join('');
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug({ jobId: job.id }, 'Index sync job completed');
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error({ err: error, jobId: job.id }, 'Index sync job failed');
  }
}
