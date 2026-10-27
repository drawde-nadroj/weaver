import { editorLivePreviewField } from "obsidian";
import {
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";

import { deepHashHideSpecs, lineClassSpecs } from "../core/decorations";
import type { WeaverSettings } from "../settings";
import { headingIndexField, refreshHeadingsEffect } from "./index-field";

function buildLineDecorations(state: EditorState): DecorationSet {
  const index = state.field(headingIndexField, false);
  if (index === undefined || index.headings.length === 0) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  for (const spec of lineClassSpecs(index)) {
    builder.add(spec.from, spec.from, Decoration.line({ class: spec.classes.join(" ") }));
  }
  return builder.finish();
}

/**
 * Marks every heading line with its level classes, which the generated palette
 * CSS turns into color and indentation.
 */
export const headingLineField = StateField.define<DecorationSet>({
  create: (state) => buildLineDecorations(state),
  update: (decorations, transaction) => {
    if (transaction.docChanged) return buildLineDecorations(transaction.state);
    if (transaction.effects.some((effect) => effect.is(refreshHeadingsEffect))) {
      return buildLineDecorations(transaction.state);
    }
    return decorations;
  }
});

function buildDeepHashDecorations(view: EditorView, settings: WeaverSettings): DecorationSet {
  const index = view.state.field(headingIndexField, false);
  if (index === undefined) return Decoration.none;

  const specs = deepHashHideSpecs({
    index,
    selection: { from: view.state.selection.main.from, to: view.state.selection.main.to },
    visible: view.visibleRanges,
    livePreview: view.state.field(editorLivePreviewField, false) === true,
    enabled: settings.deepHeadingLivePreview
  });

  if (specs.length === 0) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  for (const spec of specs) {
    builder.add(spec.from, spec.to, Decoration.replace({}));
  }
  return builder.finish();
}

/**
 * Hides the hash run of deep headings in Live Preview while the cursor is off
 * the heading's line. Source mode is never touched.
 */
export function deepHashHidingExtension(getSettings: () => WeaverSettings): Extension {
  class DeepHashHider {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDeepHashDecorations(view, getSettings());
    }

    update(update: ViewUpdate) {
      const livePreviewChanged =
        update.startState.field(editorLivePreviewField, false) !==
        update.state.field(editorLivePreviewField, false);

      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        livePreviewChanged
      ) {
        this.decorations = buildDeepHashDecorations(update.view, getSettings());
      }
    }
  }

  return ViewPlugin.fromClass(DeepHashHider, {
    decorations: (plugin) => plugin.decorations
  });
}

export function headingDecorationsExtension(getSettings: () => WeaverSettings): Extension {
  return [
    headingLineField,
    EditorView.decorations.from(headingLineField),
    deepHashHidingExtension(getSettings)
  ];
}
