import { editorLivePreviewField } from "obsidian";
import {
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

import { parseCloseLine, parseSourceLine } from "../core/marks";
import { headingIndexField, refreshHeadingsEffect } from "./index-field";

/** True when the caret or selection touches this line, so the mark stays raw. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  const selection = state.selection.main;
  return selection.from <= to && selection.to >= from;
}

/**
 * Lines that carry text but are not marks: fenced code, frontmatter and the
 * body of a draft belong to something else until it is woven, exactly as
 * `parseMarks` treats them in Reading view.
 */
function excludedLines(state: EditorState): Set<number> {
  const excluded = new Set<number>();
  const index = state.field(headingIndexField, false);
  if (index === undefined) return excluded;

  if (index.frontmatterEnd !== null) {
    for (let line = 0; line <= index.frontmatterEnd; line += 1) excluded.add(line);
  }
  for (const fence of index.codeFences) {
    for (let line = fence.start; line <= fence.end; line += 1) excluded.add(line);
  }
  for (const draft of index.drafts) {
    for (let line = draft.openLine; line <= draft.closeLine; line += 1) excluded.add(line);
  }
  return excluded;
}

/**
 * The decoration set for one state. Exported so a test can assert it without a
 * live `EditorView`, which needs a real browser to measure.
 *
 * Only line decorations are emitted: the glyph stays in the document, so a
 * `[[link]]` inside a `✦` line stays clickable and the mark stays typable.
 */
export function markLineDecorations(state: EditorState): DecorationSet {
  // Source mode is never decorated: the raw marks are the point of it.
  if (state.field(editorLivePreviewField, false) !== true) return Decoration.none;

  const excluded = excludedLines(state);
  const builder = new RangeSetBuilder<Decoration>();

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (excluded.has(lineNumber - 1)) continue;

    const raw = line.text;
    const className =
      parseCloseLine(raw) !== null
        ? "weaver-close-mark-line"
        : parseSourceLine(raw) !== null
          ? "weaver-mark-line"
          : null;

    if (className === null) continue;
    if (selectionTouches(state, line.from, line.to)) continue;

    builder.add(line.from, line.from, Decoration.line({ class: className }));
  }

  return builder.finish();
}

/**
 * Marks `✦` and `✓` lines with a band, so a recorded spark is legible where it
 * is written instead of looking like a stray glyph.
 *
 * It must come from a **state field**: a block decoration specified through a
 * plugin throws `RangeError("Block decorations may not be specified via
 * plugins")`. These are line decorations, but a field is the same shape the draft
 * badges and the insert row use, and it keeps the source honest either way.
 */
export function markLineExtension(): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => markLineDecorations(state),
    update: (value, transaction) => {
      if (transaction.docChanged) return markLineDecorations(transaction.state);
      if (transaction.selection !== undefined) return markLineDecorations(transaction.state);
      if (transaction.effects.some((effect) => effect.is(refreshHeadingsEffect))) {
        return markLineDecorations(transaction.state);
      }
      return value;
    }
  });

  return [field, EditorView.decorations.from(field)];
}
