import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { RedisService } from '../redis/redis.service';
import {
  type ConversationMessage,
  ConversationMessageSchema,
} from './conversation.schemas';

const ConversationMessagesSchema = z.array(ConversationMessageSchema);

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly MESSAGE_LIMIT = 50;
  private readonly TTL_SECONDS = 24 * 60 * 60; // 24 hours

  constructor(private redisService: RedisService) {}

  private getKey(userId: number): string {
    return `conversation:user:${userId}`;
  }

  /**
   * Add multiple SDK-format messages to conversation history.
   * Used for storing response.messages from generateText.
   */
  async addMessages(
    userId: number,
    messages: ConversationMessage[],
  ): Promise<void> {
    const key = this.getKey(userId);
    const redis = this.redisService.getClient();

    // Get existing conversation
    const existing = await redis.get(key);
    let history: ConversationMessage[] = [];
    if (existing) {
      const result = ConversationMessagesSchema.safeParse(JSON.parse(existing));
      if (result.success) {
        history = result.data;
      } else {
        this.logger.warn(
          `Invalid conversation data for user ${userId}, starting fresh`,
          result.error.message,
        );
      }
    }

    // Add new messages
    history.push(...messages);

    // Prune old messages if exceeding limit
    if (history.length > this.MESSAGE_LIMIT) {
      history = history.slice(-this.MESSAGE_LIMIT);
    }

    // Store with TTL
    await redis.setex(key, this.TTL_SECONDS, JSON.stringify(history));
  }

  async getConversation(userId: number): Promise<ConversationMessage[]> {
    const key = this.getKey(userId);
    const redis = this.redisService.getClient();

    const data = await redis.get(key);
    if (!data) {
      return [];
    }

    const result = ConversationMessagesSchema.safeParse(JSON.parse(data));
    if (!result.success) {
      this.logger.warn(
        `Invalid conversation data for user ${userId}, returning empty`,
        result.error.message,
      );
      return [];
    }
    return result.data;
  }

  async clearConversation(userId: number): Promise<void> {
    const key = this.getKey(userId);
    const redis = this.redisService.getClient();
    await redis.del(key);
  }
}
