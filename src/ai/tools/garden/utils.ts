/**
 * Sanitizes a path by removing invalid filename characters.
 *
 * @param name The path or filename to sanitize
 * @returns The sanitized path with invalid characters removed
 */
export function sanitizePath(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes a note path by removing the .md extension if present.
 *
 * @param path The path to normalize
 * @returns The path without .md extension
 */
export function normalizePath(path: string): string {
  return path.replace(/\.md$/, '');
}

/**
 * Extracts the filename (last segment) from a path.
 *
 * @param path The full path
 * @returns The filename without any folder prefix
 */
export function getFilename(path: string): string {
  return normalizePath(path).split('/').pop() || '';
}

/**
 * Ensures a path has the .md extension.
 *
 * @param path The path to ensure has extension
 * @returns The path with .md extension
 */
export function ensureMdExtension(path: string): string {
  return path.endsWith('.md') ? path : `${path}.md`;
}

/**
 * Growth stage icons for display in the digital garden.
 */
export const GROWTH_STAGE_ICONS: Record<string, string> = {
  seedling: '🌱',
  budding: '🌿',
  evergreen: '🌳',
};
