import type { Note } from './note';

/**
 * Event constants emitted by VaultService when notes change.
 *
 * Subscribe via `@OnEvent(VaultEvents.NOTE_CHANGED)` etc.
 */
export const VaultEvents = {
  NOTE_CREATED: 'vault.note.created',
  NOTE_CHANGED: 'vault.note.changed',
  NOTE_DELETED: 'vault.note.deleted',
} as const;

/** Payload for NOTE_CREATED and NOTE_CHANGED events */
export interface VaultNoteEvent {
  path: string;
  note: Note;
}

/** Payload for NOTE_DELETED events */
export interface VaultNoteDeletedEvent {
  path: string;
}
