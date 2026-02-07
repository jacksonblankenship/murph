import { Injectable } from '@nestjs/common';
import type { Tool } from 'ai';
import { createTimeTools } from '../../ai/tools/time.tools';
import type { ToolDependencies, ToolFactory } from '../channel.types';

/**
 * Factory for time-related tools.
 *
 * Creates tools for getting current date/time information.
 */
@Injectable()
export class TimeToolFactory implements ToolFactory {
  create(_deps: ToolDependencies): Record<string, Tool> {
    return createTimeTools();
  }
}
