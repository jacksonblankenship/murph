// ===========================================
// Similarity thresholds for note matching
// ===========================================

/** Very high similarity - likely duplicate */
export const SIMILARITY_VERY_HIGH = 0.9;

/** High similarity - consider merging */
export const SIMILARITY_HIGH = 0.85;

/** Moderate similarity - worth linking */
export const SIMILARITY_MODERATE = 0.7;

/** Low similarity for loose relationships */
export const SIMILARITY_LOW = 0.6;

/** Threshold for "high but not very high" similarity (orange category) */
export const SIMILARITY_HIGH_LOWER = 0.8;

// ===========================================
// Search and display limits
// ===========================================

/** Default number of search results */
export const DEFAULT_SEARCH_LIMIT = 5;

/** Smaller search limit for duplicate checking */
export const DUPLICATE_CHECK_LIMIT = 3;

/** Default limit for wander results */
export const WANDER_LIMIT = 3;

/** Default limit for orphan search */
export const ORPHAN_LIMIT = 10;

/** Default max age for excluding new notes from orphan search */
export const ORPHAN_MAX_AGE_DAYS = 7;

/** Minimum links to qualify as MOC candidate */
export const MOC_MIN_INBOUND_LINKS = 5;

/** Default limit for broken links search */
export const BROKEN_LINKS_LIMIT = 20;

/** Maximum depth for link traversal */
export const MAX_TRAVERSE_DEPTH = 3;

/** Number of top linkers to show in MOC candidates */
export const TOP_LINKERS_PREVIEW = 5;

/** Random shuffle midpoint for sorting */
export const SHUFFLE_MIDPOINT = 0.5;

/** Preview slice length for content */
export const PREVIEW_LENGTH_SHORT = 100;

/** Preview slice length for longer content */
export const PREVIEW_LENGTH_LONG = 200;

// ===========================================
// Time calculations
// ===========================================

/** Milliseconds per day */
// biome-ignore lint/style/noMagicNumbers: time unit calculation is self-documenting
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ===========================================
// Display formatting
// ===========================================

/** Multiplier for converting decimal scores to percentages */
export const PERCENT_MULTIPLIER = 100;

/** Decimal places for percentage display */
export const PERCENT_DECIMALS_PRECISE = 1;

/** Decimal places for rounded percentage */
export const PERCENT_DECIMALS_ROUNDED = 0;

// ===========================================
// Controlled vocabulary
// ===========================================

/** Valid tag values for the digital garden frontmatter schema */
export const VALID_TAGS = [
  'preference',
  'decision',
  'observation',
  'belief',
  'pattern',
  'process',
] as const;
