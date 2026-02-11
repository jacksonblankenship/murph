import matter from 'gray-matter';
import { type NoteFrontmatter, NoteFrontmatterSchema } from './vault.schemas';

/** Regex for extracting wikilinks: `[[target]]` or `[[target|display]]` */
const WIKILINK_REGEX = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/** File stat metadata for a note */
export interface NoteStat {
  ctime: Date;
  mtime: Date;
  size: number;
}

/**
 * Immutable in-memory representation of a vault note.
 *
 * Constructed from raw file content, parses frontmatter via gray-matter
 * and validates it with Zod. Extracts wikilinks for link graph indexing.
 */
export class Note {
  /** Original-case relative path (e.g., `People/Luna.md`) */
  readonly path: string;

  /** Full content including frontmatter */
  readonly raw: string;

  /** Content without frontmatter */
  readonly body: string;

  /** Validated and typed frontmatter */
  readonly frontmatter: NoteFrontmatter;

  /** Extracted wikilink targets (deduplicated) */
  readonly outboundLinks: ReadonlySet<string>;

  /** File stat metadata */
  readonly stat: NoteStat;

  /** Computed title from filename (last path segment, no extension) */
  readonly title: string;

  constructor(path: string, rawContent: string, stat: NoteStat) {
    this.path = path;
    this.raw = rawContent;
    this.stat = stat;

    // Parse frontmatter
    const parsed = matter(rawContent);
    this.body = parsed.content;

    // Validate frontmatter — fall back to defaults on failure
    const result = NoteFrontmatterSchema.safeParse(parsed.data);
    this.frontmatter = result.success
      ? result.data
      : {
          summary: '',
          aliases: [],
          tags: [],
          ...parsed.data,
        };

    // Extract wikilinks
    this.outboundLinks = extractWikilinks(this.body);

    // Compute title from filename
    this.title = getTitle(path);
  }
}

/**
 * Extracts unique wikilink targets from markdown content.
 *
 * Handles both `[[target]]` and `[[target|display text]]` forms.
 */
export function extractWikilinks(content: string): ReadonlySet<string> {
  const links = new Set<string>();
  let match = WIKILINK_REGEX.exec(content);

  while (match !== null) {
    links.add(match[1]);
    match = WIKILINK_REGEX.exec(content);
  }

  // Reset the stateful regex
  WIKILINK_REGEX.lastIndex = 0;
  return links;
}

/**
 * Computes a display title from a file path.
 *
 * @example getTitle('People/Luna.md') → 'Luna'
 * @example getTitle('Morning Routine.md') → 'Morning Routine'
 */
function getTitle(path: string): string {
  const withoutExt = path.replace(/\.md$/, '');
  return withoutExt.split('/').pop() || withoutExt;
}
