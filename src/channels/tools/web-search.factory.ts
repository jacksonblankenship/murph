import { Injectable } from '@nestjs/common';
import type { Tool } from 'ai';
import { createWebSearchTools } from '../../ai/tools/web-search.tools';
import { ExaService } from '../../exa/exa.service';
import type { ToolDependencies, ToolFactory } from '../channel.types';

/**
 * Factory for web search tools.
 *
 * Creates tools for searching the web via Exa.
 */
@Injectable()
export class WebSearchToolFactory implements ToolFactory {
  constructor(private readonly exaService: ExaService) {}

  create(_deps: ToolDependencies): Record<string, Tool> {
    return createWebSearchTools(this.exaService);
  }
}
