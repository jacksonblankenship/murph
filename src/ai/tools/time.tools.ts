import { tool } from 'ai';
import { z } from 'zod';

export function createTimeTools() {
  return {
    get_current_time: tool({
      description: 'Get the current date and time in ISO format',
      inputSchema: z.object({
        timezone: z.string().optional().describe('Timezone (optional)'),
      }),
      execute: async () => {
        return new Date().toISOString();
      },
    }),
  };
}
