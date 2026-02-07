import { z } from 'zod';

// SDK ModelMessage content parts
const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const ToolCallPartSchema = z.object({
  type: z.literal('tool-call'),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
});

const ToolResultPartSchema = z.object({
  type: z.literal('tool-result'),
  toolCallId: z.string(),
  toolName: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
});

const ReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
});

// Content can be string or array of parts
const ContentPartSchema = z.union([
  TextPartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
  ReasoningPartSchema,
]);

export const ConversationMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(ContentPartSchema)]),
});

export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
