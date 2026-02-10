import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisModule } from '../redis/redis.module';
import { VectorModule } from '../vector/vector.module';
import { ConversationService } from './conversation.service';
import { ConversationRetrieverService } from './conversation-retriever.service';
import { ConversationVectorService } from './conversation-vector.service';
import { MemorySearchService } from './memory-search.service';

@Module({
  imports: [ConfigModule, RedisModule, VectorModule],
  providers: [
    ConversationService,
    ConversationVectorService,
    ConversationRetrieverService,
    MemorySearchService,
  ],
  exports: [
    ConversationService,
    ConversationVectorService,
    ConversationRetrieverService,
    MemorySearchService,
  ],
})
export class MemoryModule {}
