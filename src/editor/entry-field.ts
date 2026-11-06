/**
 * The entry index as editor state: one parse per document change, shared by the
 * decorations, the keys and the engine, so every surface agrees on structure.
 */

import { Annotation, StateEffect, StateField, type Extension } from "@codemirror/state";

import { parseEntries, type EntryIndex } from "../core/entries";

/** Forces a reparse, used when a setting or the live session changes. */
export const refreshEntriesEffect = StateEffect.define<void>();

/**
 * Marks a transaction Weaver wrote itself — a started entry, a submitted one, the
 * child an advance opens.
 *
 * The edit listener settles the session on every change the *writer* makes. A
 * programmatic write must not count as typing: starting an entry would otherwise
 * start its clock before the first keystroke, and the caret has not even been
 * moved into the new entry yet when the change lands.
 */
export const programmaticWrite = Annotation.define<boolean>();

/**
 * The writer's input, as observed at the moment it happened: which entry it
 * landed in, and when.
 *
 * The clock starts on the identity and the time of the input itself, never on
 * where the caret happens to be when the deferred listener runs — a caret that
 * moved on in the meantime must not attach the keystroke to another entry, and
 * the moment recorded must be the moment of typing, not of bookkeeping.
 */
export interface InputObservation {
  path: string;
  seq: number;
  at: number;
}

/**
 * Marks the one transaction that carries an entry's first text together with
 * its recorded beginning. Its value is the observation, so the listener starts
 * the clock from the same facts the plan was built from.
 */
export const capturedInput = Annotation.define<InputObservation>();

/** The shared parse: one per document change, read by every surface. */
export const entryIndexField = StateField.define<EntryIndex>({
  create: (state) => parseEntries(state.doc.toString()),
  update: (value, transaction) => {
    if (transaction.docChanged) return parseEntries(transaction.state.doc.toString());
    if (transaction.effects.some((effect) => effect.is(refreshEntriesEffect))) {
      return parseEntries(transaction.state.doc.toString());
    }
    return value;
  }
});

/** Registers the field every other editor extension reads. */
export function entryIndexExtension(): Extension {
  return entryIndexField;
}
