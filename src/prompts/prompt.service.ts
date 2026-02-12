import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import matter from 'gray-matter';
import Handlebars from 'handlebars';

/**
 * Valid prompt names that can be loaded by the service.
 */
export type PromptName =
  | 'user-direct'
  | 'scheduled-proactive'
  | 'garden-curator'
  | 'garden-seeder'
  | 'voice';

const PROMPT_NAMES: PromptName[] = [
  'user-direct',
  'scheduled-proactive',
  'garden-curator',
  'garden-seeder',
  'voice',
];

interface PromptMetadata {
  name: string;
  description?: string;
}

interface ParsedPrompt {
  metadata: PromptMetadata;
  template: Handlebars.TemplateDelegate;
}

/**
 * Service for loading and rendering markdown prompt templates.
 *
 * Uses gray-matter for frontmatter parsing and Handlebars for templating.
 * Supports partials via `{{> partial-name}}` syntax and variables via `{{var}}`.
 * Prompts are loaded synchronously in the constructor to ensure availability
 * before any dependent services initialize.
 *
 * @example
 * ```typescript
 * // Static prompt (no variables)
 * const prompt = promptService.get('user-direct');
 *
 * // Dynamic prompt with variables
 * const prompt = promptService.render('garden-curator', { today: '2025-02-07' });
 * ```
 */
@Injectable()
export class PromptService {
  private readonly prompts = new Map<PromptName, ParsedPrompt>();
  private readonly templateDir = path.join(__dirname, 'templates');

  constructor() {
    this.registerPartials();
    this.loadPrompts();
  }

  /**
   * Get a rendered prompt by name.
   *
   * Use for static prompts with no runtime variables.
   *
   * @param name - The prompt identifier
   * @returns The rendered prompt string
   * @throws Error if prompt not found
   */
  get(name: PromptName): string {
    return this.render(name, {});
  }

  /**
   * Render a prompt with variable substitution.
   *
   * Use for prompts with `{{variable}}` placeholders.
   *
   * @param name - The prompt identifier
   * @param vars - Key-value pairs for template variables
   * @returns The rendered prompt string with variables substituted
   * @throws Error if prompt not found
   */
  render(name: PromptName, vars: Record<string, unknown>): string {
    const prompt = this.prompts.get(name);
    if (!prompt) {
      throw new Error(`Prompt not found: ${name}`);
    }
    return prompt.template(vars).trim();
  }

  /**
   * Registers all partial templates from the partials directory.
   * Partials can be included in prompts using `{{> partial-name}}`.
   * Supports nested directories: `{{> philosophy/core-principles}}`.
   */
  private registerPartials(): void {
    const partialsDir = path.join(this.templateDir, 'partials');
    if (!fs.existsSync(partialsDir)) return;
    this.registerPartialsRecursive(partialsDir, '');
  }

  /**
   * Recursively registers partials from a directory.
   *
   * @param dir - The directory to scan for partial files
   * @param prefix - The path prefix for nested partials (e.g., "philosophy/")
   */
  private registerPartialsRecursive(dir: string, prefix: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.registerPartialsRecursive(fullPath, `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.md')) {
        const name = `${prefix}${entry.name.replace('.md', '')}`;
        const content = fs.readFileSync(fullPath, 'utf-8');
        Handlebars.registerPartial(name, content.trim());
      }
    }
  }

  /**
   * Loads and parses all prompt templates from markdown files.
   * Each prompt file should have YAML frontmatter with at least a `name` field.
   */
  private loadPrompts(): void {
    for (const name of PROMPT_NAMES) {
      const filePath = path.join(this.templateDir, `${name}.md`);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { data, content } = matter(raw);

      this.prompts.set(name, {
        metadata: data as PromptMetadata,
        template: Handlebars.compile(content.trim()),
      });
    }
  }
}
