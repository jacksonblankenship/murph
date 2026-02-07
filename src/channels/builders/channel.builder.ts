import type {
  ChannelConfig,
  ContextEnricher,
  MessageTransformer,
  OutputHandler,
  ToolFactory,
} from '../channel.types';

/**
 * Fluent builder for composing channel configurations.
 *
 * Allows creating channels by chaining enrichers, transformers,
 * tool factories, and output handlers.
 *
 * @example
 * ```typescript
 * const channel = new ChannelBuilder('user-direct')
 *   .withSystemPrompt('You are a helpful assistant')
 *   .addEnricher(memoryEnricher)
 *   .addEnricher(historyEnricher)
 *   .addTools(timeToolFactory)
 *   .addTools(memoryToolFactory)
 *   .addOutput(telegramOutput)
 *   .build();
 * ```
 */
export class ChannelBuilder {
  private systemPrompt = '';
  private transformers: MessageTransformer[] = [];
  private enrichers: ContextEnricher[] = [];
  private toolFactories: ToolFactory[] = [];
  private outputs: OutputHandler[] = [];

  constructor(private readonly id: string) {}

  /**
   * Set the system prompt for the LLM.
   */
  withSystemPrompt(prompt: string): this {
    this.systemPrompt = prompt;
    return this;
  }

  /**
   * Add a message transformer to the chain.
   * Transformers run in the order they are added.
   */
  addTransformer(transformer: MessageTransformer): this {
    this.transformers.push(transformer);
    return this;
  }

  /**
   * Add a context enricher.
   * All enrichers run in parallel, results are merged.
   */
  addEnricher(enricher: ContextEnricher): this {
    this.enrichers.push(enricher);
    return this;
  }

  /**
   * Add a tool factory.
   * All factories are combined into one tool set.
   */
  addTools(factory: ToolFactory): this {
    this.toolFactories.push(factory);
    return this;
  }

  /**
   * Add an output handler.
   * All outputs receive the response.
   */
  addOutput(output: OutputHandler): this {
    this.outputs.push(output);
    return this;
  }

  /**
   * Build the channel configuration.
   * @throws Error if system prompt is not set
   */
  build(): ChannelConfig {
    if (!this.systemPrompt) {
      throw new Error(`Channel "${this.id}" requires a system prompt`);
    }

    return {
      id: this.id,
      systemPrompt: this.systemPrompt,
      transformers: [...this.transformers],
      enrichers: [...this.enrichers],
      toolFactories: [...this.toolFactories],
      outputs: [...this.outputs],
    };
  }
}
