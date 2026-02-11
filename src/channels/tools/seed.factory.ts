import { Injectable } from '@nestjs/common';
import type { Tool } from 'ai';
import { z } from 'zod';
import { AgentDispatcher, createAgentTool } from '../../dispatcher';
import type { ToolDependencies, ToolFactory } from '../channel.types';

/**
 * Job data for the garden seeder queue.
 */
export interface GardenSeedJob {
  /** What was noteworthy in the conversation */
  description: string;
  /** Recent conversation context for the seeder to understand what was discussed */
  conversationContext: string;
  /** User ID who triggered the seed */
  userId: number;
  /** Timestamp when the seed was created */
  createdAt: string;
}

/**
 * Factory for the fire-and-forget garden seeding tool.
 *
 * Creates a single `note_something` tool that dispatches a BullMQ job
 * via `AgentDispatcher` for the garden seeder sub-agent. Returns immediately
 * so Murph can continue the conversation without blocking on vault writes,
 * embedding computation, or index sync.
 */
@Injectable()
export class SeedToolFactory implements ToolFactory {
  private readonly buildTool: (deps: ToolDependencies) => Tool;

  constructor(private readonly dispatcher: AgentDispatcher) {
    this.buildTool = createAgentTool<
      { description: string; conversationContext: string },
      GardenSeedJob
    >(this.dispatcher, {
      description:
        "Signal that something noteworthy came up in conversation. A background gardener will decide whether to plant a new note, update an existing one, or skip. Use this quietly — don't announce it to the user.",
      inputSchema: z.object({
        description: z
          .string()
          .describe(
            'What was noteworthy — the concept, fact, or insight to potentially capture',
          ),
        conversationContext: z
          .string()
          .describe(
            'Brief summary of the relevant conversation context surrounding this observation',
          ),
      }),
      queue: 'garden-seeder',
      jobName: 'seed',
      buildJobData: (input, deps) => ({
        ...input,
        userId: deps.userId,
        createdAt: new Date().toISOString(),
      }),
    });
  }

  create(deps: ToolDependencies): Record<string, Tool> {
    return {
      note_something: this.buildTool(deps),
    };
  }
}
