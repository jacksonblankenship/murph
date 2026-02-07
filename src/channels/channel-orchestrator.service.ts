import { Injectable, Logger } from '@nestjs/common';
import type { ModelMessage, Tool } from 'ai';
import { LlmService } from '../ai/llm.service';
import type { ConversationMessage } from '../memory/conversation.schemas';
import { ConversationService } from '../memory/conversation.service';
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
  private readonly logger = new Logger(ChannelOrchestratorService.name);

  constructor(
    private readonly registry: ChannelRegistry,
    private readonly llmService: LlmService,
    private readonly conversationService: ConversationService,
  ) {}

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
      `Executing channel "${channelId}" for user ${request.userId}`,
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
          this.logger.debug(`Channel "${channelId}" tool calls:`, {
            finishReason,
            tools: toolCalls.map(tc => tc.toolName),
          });
        }
      },
    });

    // 7. Store conversation history
    await this.storeConversation(
      request.userId,
      transformedMessage,
      response.messages,
    );

    // 8. Run outputs pipeline (unless skipped)
    let outputsSent = false;
    if (!options.skipOutputs) {
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
   * Store conversation in history.
   */
  private async storeConversation(
    userId: number,
    userMessage: string,
    responseMessages: ModelMessage[],
  ): Promise<void> {
    try {
      await this.conversationService.addMessages(userId, [
        { role: 'user', content: userMessage },
        ...(responseMessages as ConversationMessage[]),
      ]);
    } catch (error) {
      this.logger.warn('Failed to store conversation:', error.message);
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
      this.logger.error('Failed to send outputs:', error.message);
      return false;
    }
  }
}
