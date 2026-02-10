import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { RedisService } from '../redis/redis.service';
import {
  type ConversationMessage,
  ConversationMessageSchema,
} from './conversation.schemas';

const ConversationMessagesSchema = z.array(ConversationMessageSchema);

/**
 * Extracted turn data from a set of conversation messages.
 */
export interface ExtractedTurn {
  userMessage: string;
  assistantResponse: string;
  toolsUsed?: string[];
}

@Injectable()
export class ConversationService {
  /**
   * Maximum messages to keep in Redis.
   * This is a soft limit - safeTruncate may keep slightly more
   * to preserve tool_use/tool_result integrity.
   */
  private readonly MESSAGE_LIMIT = 100;
  private readonly TTL_SECONDS = 24 * 60 * 60; // 24 hours

  constructor(
    private readonly logger: PinoLogger,
    private redisService: RedisService,
  ) {
    this.logger.setContext(ConversationService.name);
  }

  private getKey(userId: number): string {
    return `conversation:user:${userId}`;
  }

  /**
   * Add multiple SDK-format messages to conversation history.
   * Uses safe truncation to preserve tool_use/tool_result pairs.
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
          { userId, error: result.error.message },
          'Invalid conversation data, starting fresh',
        );
      }
    }

    // Add new messages
    history.push(...messages);

    // Safe truncation that preserves tool_use/tool_result pairs
    if (history.length > this.MESSAGE_LIMIT) {
      history = this.safeTruncate(history, this.MESSAGE_LIMIT);
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
        { userId, error: result.error.message },
        'Invalid conversation data, returning empty',
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

  /**
   * Extract a conversation turn from a set of messages.
   *
   * A turn is the user's message + the assistant's text response.
   * Tool calls are tracked as metadata but the JSON content is not included
   * in the response text (it would hurt semantic search quality).
   *
   * @param messages Messages from this interaction
   * @returns Extracted turn or null if no valid turn found
   */
  extractTurn(messages: ConversationMessage[]): ExtractedTurn | null {
    const userMsg = messages.find(m => m.role === 'user');
    const assistantMsgs = messages.filter(m => m.role === 'assistant');

    if (!userMsg || assistantMsgs.length === 0) {
      return null;
    }

    // Extract user message text
    const userMessage =
      typeof userMsg.content === 'string'
        ? userMsg.content
        : userMsg.content
            .filter(p => p.type === 'text')
            .map(p => (p as { text: string }).text)
            .join('\n');

    if (!userMessage.trim()) {
      return null;
    }

    // Extract assistant text (skip tool calls - those are tracked separately)
    const assistantParts = assistantMsgs.flatMap(m =>
      typeof m.content === 'string'
        ? [{ type: 'text' as const, text: m.content }]
        : m.content,
    );

    const assistantResponse = assistantParts
      .filter(p => p.type === 'text')
      .map(p => (p as { text: string }).text)
      .join('\n');

    // Skip turns where assistant only made tool calls (no text response)
    if (!assistantResponse.trim()) {
      return null;
    }

    // Extract tool names used
    const toolsUsed = assistantParts
      .filter(p => p.type === 'tool-call')
      .map(p => (p as { toolName: string }).toolName);

    return {
      userMessage,
      assistantResponse,
      toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
    };
  }

  /**
   * Safely truncate messages without orphaning tool_result blocks.
   *
   * The Anthropic API requires that every tool_result has a corresponding
   * tool_use in the immediately preceding assistant message. Naive slicing
   * can break this invariant, causing API errors.
   *
   * Strategy:
   * 1. Try to slice from the target position
   * 2. If first message has tool_result, find and include its tool_use
   * 3. If tool_use can't be found, skip the orphaned tool_result
   */
  private safeTruncate(
    messages: ConversationMessage[],
    limit: number,
  ): ConversationMessage[] {
    if (messages.length <= limit) {
      return messages;
    }

    // Start from the end
    let result = messages.slice(-limit);

    // Check if first message contains orphaned tool_result
    while (result.length > 0 && this.hasToolResult(result[0])) {
      const firstMsg = result[0];
      const toolResultIds = this.getToolResultIds(firstMsg);
      const startIndex = messages.length - result.length;

      // Look for the matching tool_use in preceding messages
      let foundMatch = false;
      for (let i = startIndex - 1; i >= 0; i--) {
        const msg = messages[i];
        if (this.hasMatchingToolUse(msg, toolResultIds)) {
          // Include from this message onwards
          result = messages.slice(i);
          foundMatch = true;
          break;
        }
      }

      if (!foundMatch) {
        // Can't find matching tool_use - skip the orphaned message
        result = result.slice(1);
      } else {
        break;
      }
    }

    return result;
  }

  /**
   * Check if a message contains tool_result blocks.
   */
  private hasToolResult(message: ConversationMessage): boolean {
    if (typeof message.content === 'string') return false;
    return message.content.some(part => part.type === 'tool-result');
  }

  /**
   * Get tool_call IDs from tool_result blocks in a message.
   */
  private getToolResultIds(message: ConversationMessage): Set<string> {
    if (typeof message.content === 'string') return new Set();
    return new Set(
      message.content
        .filter(part => part.type === 'tool-result')
        .map(part => (part as { toolCallId: string }).toolCallId),
    );
  }

  /**
   * Check if a message contains tool_use blocks matching the given IDs.
   */
  private hasMatchingToolUse(
    message: ConversationMessage,
    toolResultIds: Set<string>,
  ): boolean {
    if (typeof message.content === 'string') return false;
    return message.content.some(
      part =>
        part.type === 'tool-call' &&
        toolResultIds.has((part as { toolCallId: string }).toolCallId),
    );
  }
}
