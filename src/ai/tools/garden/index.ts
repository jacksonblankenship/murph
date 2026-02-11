import { createConnectionTools } from './connection.tools';
import { createCoreTools } from './core.tools';
import { createCuratorTools } from './curator.tools';
import { createDiscoveryTools } from './discovery.tools';
import { createLinkHygieneTools } from './link-hygiene.tools';
import { createMocTools } from './moc.tools';
import type { GardenToolsDependencies } from './types';

/**
 * Creates the full digital garden tool set for the garden tender.
 *
 * These tools follow digital garden principles:
 * - Atomic notes (one concept per note)
 * - Concept-oriented organization
 * - Dense linking with [[wikilinks]]
 * - Maturity stages (seedling -> budding -> evergreen)
 *
 * Tool categories:
 * - Core: plant, update, read, browse, uproot
 * - Discovery: search_similar, recall, wander, get_surrounding_chunks, traverse
 * - Connection: connect, backlinks, orphans
 * - Curator: merge, split, promote
 * - MOC: moc_candidates, create_moc
 * - Link Hygiene: disconnect, broken_links, supersede
 */
export function createGardenTools(deps: GardenToolsDependencies) {
  return {
    ...createCoreTools(deps),
    ...createDiscoveryTools(deps),
    ...createConnectionTools(deps),
    ...createCuratorTools(deps),
    ...createMocTools(deps),
    ...createLinkHygieneTools(deps),
  };
}

export type { GardenToolsDependencies } from './types';
