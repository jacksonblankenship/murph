import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChunkingService } from './chunking.service';
import { EmbeddingService } from './embedding.service';
import { QdrantService } from './qdrant.service';

@Module({
  imports: [ConfigModule],
  providers: [ChunkingService, EmbeddingService, QdrantService],
  exports: [ChunkingService, EmbeddingService, QdrantService],
})
export class VectorModule {}
