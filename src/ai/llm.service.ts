import { createAnthropic } from '@ai-sdk/anthropic';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ModelMessage, type Tool, generateText, stepCountIs } from 'ai';

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
  toolCallCount: number;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(private configService: ConfigService) {
    const anthropicProvider = createAnthropic({
      apiKey: this.configService.get<string>('anthropic.apiKey'),
    });
    this.model = anthropicProvider('claude-sonnet-4-20250514');
  }

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

      this.logger.debug('Generation complete', {
        finishReason: result.finishReason,
        stepCount: result.steps.length,
        toolCallCount: result.toolCalls.length,
      });

      return {
        text: result.text,
        messages: result.response.messages,
        finishReason: result.finishReason,
        stepCount: result.steps.length,
        toolCallCount: result.toolCalls.length,
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw error;
      }
      this.logger.error('Error calling Anthropic API:', error);
      throw error;
    }
  }
}
