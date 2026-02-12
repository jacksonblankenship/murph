import type { Tool } from 'ai';
import type { ConversationMessage } from '../memory/conversation.schemas';

/**
 * Events emitted by the streaming execution pipeline.
 *
 * Used by voice (and future streaming transports) to consume
 * LLM output token-by-token.
 */
export type StreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string }
  | { type: 'tool-result'; toolName: string }
  | { type: 'finish' };

/**
 * Context available during message transformation.
 * Contains metadata about the incoming request.
 */
export interface TransformContext {
  /** User ID the message is for */
  userId: number;
  /** Chat ID (may differ from userId for groups) */
  chatId?: number;
  /** Original scheduled time if from scheduler */
  scheduledTime?: Date;
  /** Task ID if from scheduler */
  taskId?: string;
}

/**
 * Request data for context enrichment.
 * Enrichers receive this and add contextual information.
 */
export interface EnrichmentRequest {
  /** The message content to enrich context for */
  message: string;
  /** User ID for personalized context */
  userId: number;
  /** Chat ID for group-specific context */
  chatId?: number;
}

/**
 * Result from a context enricher.
 * Multiple enricher results are merged into the final context.
 */
export interface EnrichmentResult {
  /** Additional context to prepend/append to the message */
  contextAdditions?: string;
  /** Conversation history to include */
  conversationHistory?: ConversationMessage[];
}

/**
 * Context available when sending output.
 */
export interface OutputContext {
  /** Channel ID that generated this output */
  channelId: string;
  /** Chat ID for the destination */
  chatId?: number;
  /** Original request message for reference */
  originalMessage?: string;
}

/**
 * Dependencies available for tool creation.
 * Injected by the channel orchestrator.
 */
export interface ToolDependencies {
  /** User ID for the current request */
  userId: number;
  /** Chat ID for the current request (may differ from userId for groups) */
  chatId?: number;
}

/**
 * Result from executing a channel pipeline.
 * Contains the LLM response and metadata.
 */
export interface ChannelExecutionResult {
  /** The text response from the LLM */
  text: string;
  /** Full message history including tool calls */
  messages: ConversationMessage[];
  /** Whether outputs were sent successfully */
  outputsSent: boolean;
}

/**
 * Options for channel execution.
 */
export interface ChannelExecuteOptions {
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Override outputs for this execution only */
  outputOverrides?: OutputHandler[];
  /** Skip outputs entirely (for sub-agents returning results) */
  skipOutputs?: boolean;
}

/**
 * Transforms the raw input message before processing.
 * Transformers are chained in order - each receives the output of the previous.
 */
export interface MessageTransformer {
  /**
   * Transform a message.
   * @param message Current message content
   * @param context Contextual information about the request
   * @returns Transformed message content
   */
  transform(message: string, context: TransformContext): string;
}

/**
 * Enriches context before LLM call.
 * All enrichers run in parallel, results are merged.
 */
export interface ContextEnricher {
  /**
   * Enrich the request with additional context.
   * @param request The enrichment request with message and user info
   * @returns Enrichment result with context additions and/or history
   */
  enrich(request: EnrichmentRequest): Promise<EnrichmentResult>;
}

/**
 * Routes the LLM response somewhere.
 * Multiple outputs can be configured - all are called.
 */
export interface OutputHandler {
  /**
   * Send the response to a destination.
   * @param userId Target user ID
   * @param content The response content to send
   * @param context Additional context about the output
   */
  send(userId: number, content: string, context: OutputContext): Promise<void>;
}

/**
 * Creates tools for the LLM.
 * Multiple factories can be combined into one tool set.
 */
export interface ToolFactory {
  /**
   * Create tools with the given dependencies.
   * @param deps Dependencies available for tool creation
   * @returns Record of tool name to tool definition
   */
  create(deps: ToolDependencies): Record<string, Tool>;
}

/**
 * Configuration for a channel.
 * Defines how messages flow through the system.
 */
export interface ChannelConfig {
  /** Unique identifier for this channel */
  id: string;
  /** System prompt for the LLM */
  systemPrompt: string;
  /** Message transformers, chained in order */
  transformers: MessageTransformer[];
  /** Context enrichers, run in parallel */
  enrichers: ContextEnricher[];
  /** Tool factories, combined into one tool set */
  toolFactories: ToolFactory[];
  /** Output handlers, all called with response */
  outputs: OutputHandler[];
}
