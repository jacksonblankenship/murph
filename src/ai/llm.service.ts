import { createAnthropic } from '@ai-sdk/anthropic';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateText,
  type ModelMessage,
  stepCountIs,
  streamText,
  type Tool,
} from 'ai';
import { PinoLogger } from 'nestjs-pino';

export interface LlmGenerateOptions {
  system: string;
  messages: ModelMessage[];
  tools?: Record<string, Tool>;
  maxSteps?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
  onStepFinish?: (step: {
    toolCalls: { toolName: string }[];
    finishReason: string;
  }) => void;
}

export interface LlmResponse {
  text: string;
  messages: ModelMessage[];
  finishReason: string;
  stepCount: number;
  totalToolCallCount: number;
}

/**
 * Return type from {@link LlmService.stream}.
 *
 * Wraps the `streamText` result, exposing the `fullStream` async iterable
 * for token-by-token consumption and a `response` promise that resolves
 * once the stream is complete (provides `messages` for conversation storage).
 */
export interface LlmStreamResult {
  /** Async iterable of all stream events (text deltas, tool calls, etc.) */
  fullStream: ReturnType<typeof streamText>['fullStream'];
  /** Async iterable of text-only tokens */
  textStream: ReturnType<typeof streamText>['textStream'];
  /** Resolves after stream completes — use `.messages` for conversation storage */
  response: ReturnType<typeof streamText>['response'];
  /** Resolves to the full concatenated text after streaming completes */
  text: ReturnType<typeof streamText>['text'];
}

@Injectable()
export class LlmService {
  private readonly model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(
    private readonly logger: PinoLogger,
    private configService: ConfigService,
  ) {
    this.logger.setContext(LlmService.name);
    const anthropicProvider = createAnthropic({
      apiKey: this.configService.get<string>('anthropic.apiKey'),
    });
    this.model = anthropicProvider('claude-sonnet-4-20250514');
  }

  /**
   * Generate a complete response (non-streaming).
   *
   * Waits for the full LLM response before returning.
   */
  async generate(options: LlmGenerateOptions): Promise<LlmResponse> {
    const {
      system,
      messages,
      tools,
      maxSteps = 10,
      maxTokens = 4096,
      abortSignal,
      onStepFinish,
    } = options;

    try {
      const result = await generateText({
        model: this.model,
        maxOutputTokens: maxTokens,
        abortSignal,
        system,
        messages,
        tools,
        onStepFinish,
        stopWhen: stepCountIs(maxSteps),
      });

      const totalToolCallCount = result.steps.flatMap(s => s.toolCalls).length;

      this.logger.debug(
        {
          finishReason: result.finishReason,
          stepCount: result.steps.length,
          totalToolCallCount,
        },
        'Generation complete',
      );

      return {
        text: result.text,
        messages: result.response.messages,
        finishReason: result.finishReason,
        stepCount: result.steps.length,
        totalToolCallCount,
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw error;
      }
      this.logger.error({ err: error }, 'Error calling Anthropic API');
      throw error;
    }
  }

  /**
   * Stream a response token-by-token.
   *
   * Returns immediately with stream handles. Iterate `fullStream` for
   * all events (text-delta, tool-call, tool-result, finish) or
   * `textStream` for text tokens only.
   *
   * After the stream completes, `await result.response` provides
   * `messages` for conversation storage.
   */
  stream(options: LlmGenerateOptions): LlmStreamResult {
    const {
      system,
      messages,
      tools,
      maxSteps = 10,
      maxTokens = 4096,
      abortSignal,
      onStepFinish,
    } = options;

    const result = streamText({
      model: this.model,
      maxOutputTokens: maxTokens,
      abortSignal,
      system,
      messages,
      tools,
      onStepFinish,
      stopWhen: stepCountIs(maxSteps),
    });

    return {
      fullStream: result.fullStream,
      textStream: result.textStream,
      response: result.response,
      text: result.text,
    };
  }
}
