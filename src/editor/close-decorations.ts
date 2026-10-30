/**
 * The `✓` line, banded where it is written.
 *
 * Like every other decoration Weaver draws, it must come from a **state field**:
 * a block decoration specified through a plugin throws `RangeError("Block
 * decorations may not be specified via plugins")`.
 */

import { editorLivePreviewField } from "obsidian";
import {
  StateField,
  type EditorState,
  type Extension
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

import { CLOSE_MARK } from "../core/close";
import { entryIndexField, refreshEntriesEffect } from "./entry-field";

/** True when the caret or selection touches this line, so it stays raw. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  const selection = state.selection.main;
  return selection.from <= to && selection.to >= from;
}

/** Frontmatter and fenced code are somebody else's text. */
function excludedLines(state: EditorState): Set<number> {
  const excluded = new Set<number>();
  const index = state.field(entryIndexField, false);
  if (index === undefined) return excluded;

  if (index.frontmatterEnd !== null) {
    for (let line = 0; line <= index.frontmatterEnd; line += 1) excluded.add(line);
  }
  for (const fence of index.codeFences) {
    for (let line = fence.start; line <= fence.end; line += 1) excluded.add(line);
  }
  return excluded;
}

/** The band for every `✓` line in this state, outside the caret. */
export function closeDecorations(state: EditorState): DecorationSet {
  // Source mode is never decorated: the raw marks are the point of it.
  if (state.field(editorLivePreviewField, false) !== true) return Decoration.none;

  const excluded = excludedLines(state);
  const ranges: Array<{ from: number; to: number; value: Decoration }> = [];

  for (let number = 1; number <= state.doc.lines; number += 1) {
    if (excluded.has(number - 1)) continue;

    const line = state.doc.line(number);
    if (CLOSE_MARK.exec(line.text) === null) continue;
    if (selectionTouches(state, line.from, line.to)) continue;

    ranges.push({
      from: line.from,
      to: line.from,
      value: Decoration.line({ class: "weaver-close-mark-line" })
    });
  }

  return Decoration.set(ranges, true);
}

/** Bands every `✓` line outside the caret, in Live Preview only. */
export function closeDecorationsExtension(): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => closeDecorations(state),
    update: (value, transaction) => {
      if (transaction.docChanged) return closeDecorations(transaction.state);
      if (transaction.selection !== undefined) return closeDecorations(transaction.state);
      if (transaction.effects.some((effect) => effect.is(refreshEntriesEffect))) {
        return closeDecorations(transaction.state);
      }
      return value;
    }
  });

  return [field, EditorView.decorations.from(field)];
}
