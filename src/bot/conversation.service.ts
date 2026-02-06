import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

@Injectable()
export class ConversationService {
  private readonly MESSAGE_LIMIT = 50;
  private readonly TTL_SECONDS = 24 * 60 * 60; // 24 hours

  constructor(private redisService: RedisService) {}

  private getKey(userId: number): string {
    return `conversation:user:${userId}`;
  }

  async addMessage(userId: number, role: 'user' | 'assistant', content: string): Promise<void> {
    const key = this.getKey(userId);
    const redis = this.redisService.getClient();

    const message: ConversationMessage = {
      role,
      content,
      timestamp: Date.now(),
    };

    // Get existing conversation
    const existing = await redis.get(key);
    let messages: ConversationMessage[] = existing ? JSON.parse(existing) : [];

    // Add new message
    messages.push(message);

    // Prune old messages if exceeding limit
    if (messages.length > this.MESSAGE_LIMIT) {
      messages = messages.slice(-this.MESSAGE_LIMIT);
    }

    // Store with TTL
    await redis.setex(key, this.TTL_SECONDS, JSON.stringify(messages));
  }

  async getConversation(userId: number): Promise<ConversationMessage[]> {
    const key = this.getKey(userId);
    const redis = this.redisService.getClient();

    const data = await redis.get(key);
    if (!data) {
      return [];
    }

    try {
      return JSON.parse(data);
    } catch (error) {
      console.error('Error parsing conversation data:', error);
      return [];
    }
  }

  async clearConversation(userId: number): Promise<void> {
    const key = this.getKey(userId);
    const redis = this.redisService.getClient();
    await redis.del(key);
  }

  async pruneOldMessages(userId: number): Promise<void> {
    const key = this.getKey(userId);
    const redis = this.redisService.getClient();

    const data = await redis.get(key);
    if (!data) {
      return;
    }

    try {
      const messages: ConversationMessage[] = JSON.parse(data);
      if (messages.length > this.MESSAGE_LIMIT) {
        const pruned = messages.slice(-this.MESSAGE_LIMIT);
        await redis.setex(key, this.TTL_SECONDS, JSON.stringify(pruned));
      }
    } catch (error) {
      console.error('Error pruning messages:', error);
    }
  }

  async refreshTTL(userId: number): Promise<void> {
    const key = this.getKey(userId);
    const redis = this.redisService.getClient();
    await redis.expire(key, this.TTL_SECONDS);
  }
}
