import { Injectable } from '@nestjs/common';
import type { ModelMessage } from 'ai';
import { PinoLogger } from 'nestjs-pino';
import { ExaService } from '../exa/exa.service';
import type { ConversationMessage } from '../memory/conversation.schemas';
import { ObsidianService } from '../obsidian/obsidian.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { IndexSyncProcessor } from '../sync/index-sync.processor';
import { EmbeddingService } from '../vector/embedding.service';
import { QdrantService } from '../vector/qdrant.service';
import { LlmService } from './llm.service';
import { createGardenTools } from './tools/garden';
import { createSchedulingTools } from './tools/scheduling.tools';
import { createTimeTools } from './tools/time.tools';
import { createWebSearchTools } from './tools/web-search.tools';

export interface ChatResponse {
  text: string;
  messages: ModelMessage[];
}

@Injectable()
export class ChatOrchestratorService {
  private readonly systemPrompt =
    `You are Murph, a friendly personal assistant and second brain.

## Your Role
- You're Jackson's sidekick - helpful, proactive, and personable
- You have long-term memory and will remember important things
- You can search the web, schedule reminders, and access various services

## Memory Guidelines
- When the user shares noteworthy information, save it quietly (don't announce "I'll remember that")
- Use the save_memory tool for facts about people, pets, work, preferences, health, interests
- Be selective - don't save every passing detail
- Use [[wikilinks]] to connect related memories when it makes sense
- When asked what you know or remember about the user, use recall_memory or list_memories tools BEFORE responding
- Never claim you don't know something without checking your memory first

## Tone
- Conversational and warm, but not overly effusive
- Direct and helpful
- Match the user's energy`;

  constructor(
    private readonly logger: PinoLogger,
    private readonly llmService: LlmService,
    private readonly exaService: ExaService,
    private readonly schedulerService: SchedulerService,
    private readonly obsidianService: ObsidianService,
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantService,
    private readonly indexSyncProcessor: IndexSyncProcessor,
  ) {
    this.logger.setContext(ChatOrchestratorService.name);
  }

  /**
   * Generate a response to a user message.
   *
   * @param userMessage The user's message
   * @param userId The user ID for the current request
   * @param conversationHistory Previous conversation messages
   * @param abortSignal Optional signal to abort the request
   */
  async generateResponse(
    userMessage: string,
    userId: number,
    conversationHistory: ConversationMessage[] = [],
    abortSignal?: AbortSignal,
  ): Promise<ChatResponse> {
    const tools = this.buildTools(userId);

    const response = await this.llmService.generate({
      system: this.systemPrompt,
      messages: [
        ...(conversationHistory as ModelMessage[]),
        {
          role: 'user' as const,
          content: userMessage,
        },
      ],
      tools,
      abortSignal,
      onStepFinish: ({ toolCalls, finishReason }) => {
        if (toolCalls.length > 0) {
          this.logger.debug(
            {
              finishReason,
              tools: toolCalls.map(tc => tc.toolName),
            },
            'Tool calls executed',
          );
        }
      },
    });

    return {
      text: response.text,
      messages: response.messages,
    };
  }

  private buildTools(userId: number) {
    return {
      ...createTimeTools(),
      ...createWebSearchTools(this.exaService),
      ...createGardenTools({
        obsidianService: this.obsidianService,
        embeddingService: this.embeddingService,
        qdrantService: this.qdrantService,
        indexSyncProcessor: this.indexSyncProcessor,
      }),
      ...createSchedulingTools(this.schedulerService, userId),
    };
  }
}
