import { Injectable } from '@nestjs/common';
import type { ModelMessage, Tool } from 'ai';
import { PinoLogger } from 'nestjs-pino';
import { LlmService } from '../ai/llm.service';
import type { ConversationMessage } from '../memory/conversation.schemas';
import { ConversationService } from '../memory/conversation.service';
import { ConversationVectorService } from '../memory/conversation-vector.service';
import { ChannelRegistry } from './channel.registry';
import type {
  ChannelConfig,
  ChannelExecuteOptions,
  ChannelExecutionResult,
  EnrichmentRequest,
  EnrichmentResult,
  OutputContext,
  TransformContext,
} from './channel.types';

/**
 * Request for channel execution.
 */
export interface ChannelExecuteRequest {
  /** The message to process */
  message: string;
  /** User ID for context */
  userId: number;
  /** Chat ID (may differ from userId) */
  chatId?: number;
  /** Scheduled time for scheduled tasks */
  scheduledTime?: Date;
  /** Task ID for scheduled tasks */
  taskId?: string;
}

/**
 * Orchestrates message processing through channel pipelines.
 *
 * Executes the following stages:
 * 1. Transformers: Modify the message (chained in order)
 * 2. Enrichers: Add context (run in parallel, merged)
 * 3. LLM: Generate response with tools
 * 4. Outputs: Send response to destinations
 */
@Injectable()
export class ChannelOrchestratorService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly registry: ChannelRegistry,
    private readonly llmService: LlmService,
    private readonly conversationService: ConversationService,
    private readonly conversationVectorService: ConversationVectorService,
  ) {
    this.logger.setContext(ChannelOrchestratorService.name);
  }

  /**
   * Execute a message through a channel pipeline.
   *
   * @param channelId The channel to use
   * @param request The execution request
   * @param options Optional execution options
   * @returns The execution result with response and metadata
   */
  async execute(
    channelId: string,
    request: ChannelExecuteRequest,
    options: ChannelExecuteOptions = {},
  ): Promise<ChannelExecutionResult> {
    const channel = this.registry.get(channelId);

    this.logger.debug(
      { channelId, userId: request.userId },
      'Executing channel',
    );

    // 1. Run transformers pipeline
    const transformedMessage = this.runTransformers(channel, request);

    // 2. Run enrichers pipeline
    const enrichment = await this.runEnrichers(channel, {
      message: transformedMessage,
      userId: request.userId,
      chatId: request.chatId,
    });

    // 3. Build final message with context
    const finalMessage = this.buildFinalMessage(transformedMessage, enrichment);

    // 4. Compose tools from factories
    const tools = this.composeTools(channel, request);

    // 5. Build message array for LLM
    const messages: ModelMessage[] = [
      ...((enrichment.conversationHistory as ModelMessage[]) ?? []),
      { role: 'user' as const, content: finalMessage },
    ];

    // 6. Call LLM
    const response = await this.llmService.generate({
      system: channel.systemPrompt,
      messages,
      tools,
      abortSignal: options.abortSignal,
      onStepFinish: ({ toolCalls, finishReason }) => {
        if (toolCalls.length > 0) {
          this.logger.debug(
            {
              channelId,
              finishReason,
              tools: toolCalls.map(tc => tc.toolName),
            },
            'Channel tool calls',
          );
        }
      },
    });

    // 7. Store conversation history
    await this.storeConversation(
      request.userId,
      transformedMessage,
      response.messages,
    );

    // 8. Run outputs pipeline (unless skipped or empty response)
    let outputsSent = false;
    const hasTextContent = response.text.trim().length > 0;

    if (!hasTextContent) {
      this.logger.warn(
        { channelId, userId: request.userId },
        'LLM produced no text content (tool-only response), skipping outputs',
      );
    }

    if (!options.skipOutputs && hasTextContent) {
      const outputs = options.outputOverrides ?? channel.outputs;
      outputsSent = await this.runOutputs(
        outputs,
        request.userId,
        response.text,
        {
          channelId,
          chatId: request.chatId,
          originalMessage: request.message,
        },
      );
    }

    return {
      text: response.text,
      messages: response.messages as ConversationMessage[],
      outputsSent,
    };
  }

  /**
   * Run transformers in sequence.
   */
  private runTransformers(
    channel: ChannelConfig,
    request: ChannelExecuteRequest,
  ): string {
    const context: TransformContext = {
      userId: request.userId,
      chatId: request.chatId,
      scheduledTime: request.scheduledTime,
      taskId: request.taskId,
    };

    return channel.transformers.reduce(
      (message, transformer) => transformer.transform(message, context),
      request.message,
    );
  }

  /**
   * Run enrichers in parallel and merge results.
   */
  private async runEnrichers(
    channel: ChannelConfig,
    request: EnrichmentRequest,
  ): Promise<EnrichmentResult> {
    if (channel.enrichers.length === 0) {
      return {};
    }

    const results = await Promise.all(
      channel.enrichers.map(enricher => enricher.enrich(request)),
    );

    // Merge all enrichment results
    const merged: EnrichmentResult = {
      contextAdditions: undefined,
      conversationHistory: [],
    };

    for (const result of results) {
      if (result.contextAdditions) {
        merged.contextAdditions = merged.contextAdditions
          ? `${merged.contextAdditions}\n\n${result.contextAdditions}`
          : result.contextAdditions;
      }
      if (result.conversationHistory?.length) {
        // Only use the first history (avoid duplicates)
        if (merged.conversationHistory.length === 0) {
          merged.conversationHistory = result.conversationHistory;
        }
      }
    }

    return merged;
  }

  /**
   * Build the final message with context additions.
   */
  private buildFinalMessage(
    message: string,
    enrichment: EnrichmentResult,
  ): string {
    if (!enrichment.contextAdditions) {
      return message;
    }
    return `${message}\n\n${enrichment.contextAdditions}`;
  }

  /**
   * Compose tools from all factories.
   */
  private composeTools(
    channel: ChannelConfig,
    request: ChannelExecuteRequest,
  ): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    for (const factory of channel.toolFactories) {
      Object.assign(
        tools,
        factory.create({ userId: request.userId, chatId: request.chatId }),
      );
    }
    return tools;
  }

  /**
   * Store conversation in history and index for semantic retrieval.
   *
   * 1. Stores full messages in Redis (source of truth)
   * 2. Extracts and indexes turn to Qdrant (semantic retrieval)
   */
  private async storeConversation(
    userId: number,
    userMessage: string,
    responseMessages: ModelMessage[],
  ): Promise<void> {
    const messages: ConversationMessage[] = [
      { role: 'user', content: userMessage },
      ...(responseMessages as ConversationMessage[]),
    ];

    try {
      // Store full messages in Redis
      await this.conversationService.addMessages(userId, messages);

      // Extract and index turn to Qdrant for semantic retrieval
      const turn = this.conversationService.extractTurn(messages);
      if (turn) {
        await this.conversationVectorService.storeTurn({
          userId,
          userMessage: turn.userMessage,
          assistantResponse: turn.assistantResponse,
          toolsUsed: turn.toolsUsed,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to store conversation');
    }
  }

  /**
   * Run all output handlers.
   */
  private async runOutputs(
    outputs: ChannelConfig['outputs'],
    userId: number,
    content: string,
    context: OutputContext,
  ): Promise<boolean> {
    if (outputs.length === 0) {
      return false;
    }

    try {
      await Promise.all(
        outputs.map(output => output.send(userId, content, context)),
      );
      return true;
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to send outputs');
      return false;
    }
  }
}
