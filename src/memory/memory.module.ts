import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisModule } from '../redis/redis.module';
import { VectorModule } from '../vector/vector.module';
import { ConversationService } from './conversation.service';
import { MemorySearchService } from './memory-search.service';

@Module({
  imports: [ConfigModule, RedisModule, VectorModule],
  providers: [ConversationService, MemorySearchService],
  exports: [ConversationService, MemorySearchService],
})
export class MemoryModule {}
