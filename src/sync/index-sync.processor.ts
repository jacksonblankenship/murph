import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Job, Queue } from 'bullmq';
import { MurLock } from 'murlock';
import { ObsidianService } from '../obsidian/obsidian.service';
import { ChunkingService } from '../vector/chunking.service';
import { EmbeddingService } from '../vector/embedding.service';
import { type ChunkUpsertData, QdrantService } from '../vector/qdrant.service';

interface IndexSyncJob {
  type: 'full-sync' | 'single-note';
  path?: string;
  content?: string;
}

@Processor('index-sync')
@Injectable()
export class IndexSyncProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(IndexSyncProcessor.name);
  private readonly syncIntervalMs: number;

  constructor(
    @InjectQueue('index-sync')
    private readonly syncQueue: Queue<IndexSyncJob>,
    private readonly obsidianService: ObsidianService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantService,
    private readonly chunkingService: ChunkingService,
    private readonly configService: ConfigService,
  ) {
    super();
    this.syncIntervalMs = this.configService.get<number>(
      'vector.syncIntervalMs',
    );
  }

  async onModuleInit() {
    // Run initial sync immediately
    await this.queueFullSync();
    this.logger.log(
      `Index sync scheduled every ${this.syncIntervalMs / 1000}s via @Interval`,
    );
  }

  @Interval(300000) // 5 minutes - matches default VECTOR_SYNC_INTERVAL_MS
  async scheduledFullSync(): Promise<void> {
    await this.queueFullSync();
  }

  async queueFullSync(): Promise<void> {
    await this.syncQueue.add('full-sync', { type: 'full-sync' });
    this.logger.log('Queued full index sync');
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
    this.logger.log('Starting full index sync...');

    try {
      // 1. Get all notes from Obsidian
      const vaultNotes = await this.obsidianService.getAllNotesWithContent();
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
        const currentHash = await this.hashContent(note.content);

        if (!existingDoc) {
          // CREATE: New note not in index
          const chunkCount = await this.indexNoteWithChunks(
            note.path,
            note.content,
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
            note.content,
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

      this.logger.log(
        `Index sync complete: ${created} created, ${updated} updated, ${deleted} deleted (${totalChunks} total chunks)`,
      );
    } catch (error) {
      this.logger.error('Error during full sync:', error.message);
      throw error;
    }
  }

  @MurLock(30000, 'path')
  private async indexSingleNote(path: string, content?: string): Promise<void> {
    try {
      const noteContent =
        content || (await this.obsidianService.readNote(path))?.content;

      if (!noteContent) {
        this.logger.warn(`Note ${path} not found or empty, skipping index`);
        return;
      }

      // Delete existing chunks for this document
      await this.qdrantService.deleteDocumentChunks(path);

      // Index with chunking
      const chunkCount = await this.indexNoteWithChunks(path, noteContent);
      this.logger.debug(`Indexed single note: ${path} (${chunkCount} chunks)`);
    } catch (error) {
      this.logger.error(`Error indexing note ${path}:`, error.message);
      throw error;
    }
  }

  /**
   * Index a note by chunking it and batch embedding
   */
  private async indexNoteWithChunks(
    path: string,
    content: string,
  ): Promise<number> {
    // Chunk the content
    const chunks = this.chunkingService.chunkMarkdown(content);

    if (chunks.length === 0) {
      this.logger.debug(`Skipping empty note: ${path}`);
      return 0;
    }

    // Extract metadata
    const title = this.extractTitle(path, content);
    const tags = this.extractTags(content);
    const documentHash = await this.hashContent(content);

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

    // Batch upsert to Qdrant
    await this.qdrantService.upsertChunks(chunkData);

    return chunks.length;
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
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Index sync job ${job.id} completed`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Index sync job ${job.id} failed:`, error.message);
  }
}
