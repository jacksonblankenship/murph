import { format } from 'date-fns';

/** Obsidian date-only format: YYYY-MM-DD */
const OBSIDIAN_DATE_FORMAT = 'yyyy-MM-dd';

/** Obsidian datetime format: YYYY-MM-DDTHH:mm:ss */
const OBSIDIAN_DATETIME_FORMAT = `${OBSIDIAN_DATE_FORMAT}'T'HH:mm:ss`;

/**
 * Formats a Date for Obsidian datetime properties.
 * Obsidian expects seconds precision without milliseconds or timezone.
 *
 * @param date - The date to format. Defaults to current date/time.
 * @returns Formatted datetime string (e.g., "2026-02-07T21:30:45")
 */
export function formatObsidianDatetime(date: Date = new Date()): string {
  return format(date, OBSIDIAN_DATETIME_FORMAT);
}

/**
 * Formats a Date for Obsidian date-only properties.
 *
 * @param date - The date to format. Defaults to current date.
 * @returns Formatted date string (e.g., "2026-02-07")
 */
export function formatObsidianDate(date: Date = new Date()): string {
  return format(date, OBSIDIAN_DATE_FORMAT);
}
