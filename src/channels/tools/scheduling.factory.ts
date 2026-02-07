import { Injectable } from '@nestjs/common';
import type { Tool } from 'ai';
import { createSchedulingTools } from '../../ai/tools/scheduling.tools';
import { SchedulerService } from '../../scheduler/scheduler.service';
import type { ToolDependencies, ToolFactory } from '../channel.types';

/**
 * Factory for scheduling-related tools.
 *
 * Creates tools for scheduling, listing, and cancelling tasks.
 */
@Injectable()
export class SchedulingToolFactory implements ToolFactory {
  constructor(private readonly schedulerService: SchedulerService) {}

  create(deps: ToolDependencies): Record<string, Tool> {
    return createSchedulingTools(this.schedulerService, deps.userId);
  }
}
