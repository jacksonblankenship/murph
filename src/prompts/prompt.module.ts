import { Global, Module } from '@nestjs/common';
import { PromptService } from './prompt.service';

/**
 * Global module that provides prompt loading and rendering.
 *
 * Prompts are loaded from markdown files in the prompts directory,
 * with support for Handlebars templating and partials.
 */
@Global()
@Module({
  providers: [PromptService],
  exports: [PromptService],
})
export class PromptModule {}
