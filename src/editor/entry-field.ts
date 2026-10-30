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
