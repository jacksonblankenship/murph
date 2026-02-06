import { createAnthropic } from '@ai-sdk/anthropic';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { RedisService } from '../redis/redis.service';
import type { ConversationMessage } from './conversation.service';

@Injectable()
export class LlmService {
  private model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
  ) {
    const anthropicProvider = createAnthropic({
      apiKey: this.configService.get<string>('ANTHROPIC_API_KEY'),
    });
    this.model = anthropicProvider('claude-sonnet-4-20250514');
  }

  async generateResponse(
    userMessage: string,
    conversationHistory: ConversationMessage[] = [],
    userId = 0,
  ): Promise<string> {
    try {
      const result = await generateText({
        model: this.model,
        maxOutputTokens: 4096,
        messages: [
          ...conversationHistory.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          {
            role: 'user' as const,
            content: userMessage,
          },
        ],
        tools: {
          get_current_time: tool({
            description: 'Get the current date and time in ISO format',
            inputSchema: z.object({
              timezone: z.string().optional().describe('Timezone (optional)'),
            }),
            execute: async ({ timezone }) => {
              return new Date().toISOString();
            },
          }),
          web_search: tool({
            description: 'Search the web for current information',
            inputSchema: z.object({
              query: z.string().describe('The search query'),
            }),
            execute: async ({ query }) => {
              // TODO: Integrate with Exa MCP
              return `Search results for: ${query}\n\n(Integration coming soon)`;
            },
          }),
          remember_fact: tool({
            description: 'Store an important fact in memory',
            inputSchema: z.object({
              key: z.string().describe('A short key to identify this fact'),
              value: z.string().describe('The fact to remember'),
            }),
            execute: async ({ key, value }) => {
              const redis = this.redisService.getClient();
              const memoryKey = `memory:user:${userId}:${key}`;
              await redis.set(memoryKey, value);
              return `Remembered: ${key} = ${value}`;
            },
          }),
        },
        stopWhen: stepCountIs(10), // Built-in iteration limit (replaces custom loop)
      });

      return result.text;
    } catch (error) {
      console.error('Error calling Anthropic API:', error);
      throw error;
    }
  }
}
