import { Injectable } from '@nestjs/common';
import { type Tool, tool } from 'ai';
import { z } from 'zod';
import type { ToolDependencies, ToolFactory } from '../channel.types';

/**
 * Factory for the hang_up tool used in voice calls.
 *
 * The tool itself is a no-op — it simply returns a confirmation string.
 * The voice gateway watches the stream for a `tool-call` event with
 * `toolName === 'hang_up'` and sends `{ type: "end" }` to Twilio
 * after the current response finishes being spoken.
 */
@Injectable()
export class HangUpToolFactory implements ToolFactory {
  /**
   * Creates the `hang_up` tool.
   */
  create(_deps: ToolDependencies): Record<string, Tool> {
    return {
      hang_up: tool({
        description:
          'End the phone call. Use this after saying goodbye to the caller.',
        inputSchema: z.object({}),
        execute: async () => 'Call ended.',
      }),
    };
  }
}
