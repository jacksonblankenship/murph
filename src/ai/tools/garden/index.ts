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

/**
 * Creates a minimal capture-focused tool set for Murph (user-direct chat).
 *
 * Only 6 tools — enough to capture knowledge during conversation
 * without any organizational responsibilities (those belong to the garden tender).
 *
 * Tools: plant, update, recall, read, search_similar, wander
 */
export function createCaptureTools(deps: GardenToolsDependencies) {
  const core = createCoreTools(deps);
  const discovery = createDiscoveryTools(deps);

  return {
    plant: core.plant,
    update: core.update,
    read: core.read,
    recall: discovery.recall,
    search_similar: discovery.search_similar,
    wander: discovery.wander,
  };
}

export type { GardenToolsDependencies } from './types';
