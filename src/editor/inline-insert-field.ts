import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

import {
  addRow,
  beginInsert,
  commitPlan,
  focusField,
  setLevel,
  setTitle,
  type BeginInsertInput,
  type InsertState
} from "../core/inline-insert";
import type WeaverPlugin from "../main";
import { headingIndexField } from "./index-field";
import { InlineInsertWidget, type InlineInsertHandlers } from "./inline-insert-widget";

export const openInsertEffect = StateEffect.define<BeginInsertInput>();
export const updateInsertEffect = StateEffect.define<InsertState>();
export const closeInsertEffect = StateEffect.define<null>();

/**
 * The widget's state, anchored to one document offset.
 *
 * It survives selection changes; a document change maps the anchor rather than
 * dropping the state, so a stray keystroke in the note cannot silently discard
 * what was typed into the widget.
 */
export const insertStateField = StateField.define<InsertState | null>({
  create: () => null,
  update: (value, transaction) => {
    let next = value;
    if (next !== null && transaction.docChanged) {
      next = { ...next, at: transaction.changes.mapPos(next.at, -1) };
    }

    for (const effect of transaction.effects) {
      if (effect.is(openInsertEffect)) next = beginInsert(effect.value);
      else if (effect.is(updateInsertEffect)) next = effect.value;
      else if (effect.is(closeInsertEffect)) next = null;
    }

    return next;
  }
});

/**
 * The control row's decorations.
 *
 * They must come from a **state field**, never from a plugin. CodeMirror marks
 * a decoration source that is a function (a `ViewPlugin`'s `decorations`, which
 * is how `EditorView.decorations.of(view => …)` resolves) as dynamic, and a
 * dynamic source that contains a `block: true` widget throws
 *
 *   RangeError: Block decorations may not be specified via plugins
 *
 * on the first update that would render it. That is not a rendering glitch: the
 * exception fires inside the view update, so the row never appears and nothing is
 * inserted. `draftDecorationsExtension` avoids the same trap by using a field,
 * and so does this.
 */
export function insertDecorations(state: EditorState, plugin: WeaverPlugin): DecorationSet {
  const insert = state.field(insertStateField, false) ?? null;
  if (insert === null) return Decoration.none;

  const at = Math.min(Math.max(0, insert.at), state.doc.length);
  const widget = new InlineInsertWidget(insert, plugin, (view) => insertHandlers(view, plugin));
  return Decoration.set([Decoration.widget({ widget, block: true, side: -1 }).range(at)]);
}

/** The verbs the row offers, bound to the view that renders it. */
function insertHandlers(view: EditorView, plugin: WeaverPlugin): InlineInsertHandlers {
  const maxDepth = plugin.settings.maxDepth;
  const current = (): InsertState | null => view.state.field(insertStateField, false) ?? null;
  const apply = (next: InsertState | null): void => {
    view.dispatch({
      effects: next === null ? closeInsertEffect.of(null) : updateInsertEffect.of(next)
    });
  };

  return {
    maxDepth,
    onTitle: (rowId, value) => {
      const state = current();
      if (state !== null) apply(setTitle(state, rowId, value));
    },
    onFocus: (rowId, focus) => {
      const state = current();
      // Only a real change is dispatched, so focusing an input does not rebuild
      // the widget under the caret.
      if (state === null || (state.activeRow === rowId && state.focus === focus)) return;
      apply(focusField(state, focus, rowId));
    },
    onStepLevel: (rowId, delta) => {
      const state = current();
      if (state === null) return;
      apply(setLevel(focusField(state, "level", rowId), delta, maxDepth));
    },
    onAddRow: () => {
      const state = current();
      if (state !== null) apply(addRow(state, maxDepth));
    },
    onCommit: () => commitInsert(view, plugin),
    onCancel: () => apply(null)
  };
}

/** One transaction lands the whole block, so one undo removes it. */
function commitInsert(view: EditorView, plugin: WeaverPlugin): void {
  const state = view.state.field(insertStateField, false) ?? null;
  if (state === null) return;

  const source = view.state.doc.toString();
  const index = view.state.field(headingIndexField);
  const line = view.state.doc.lineAt(Math.min(state.at, view.state.doc.length)).number - 1;
  const plan = commitPlan(state, source, index, line, new Date(), plugin.insertOptions());
  // Every row empty: nothing is inserted and the widget stays open.
  if (plan === null) return;

  view.dispatch({
    changes: plan.changes.map((change) => ({
      from: change.from,
      to: change.to,
      insert: change.text
    })),
    selection: { anchor: plan.selection.from, head: plan.selection.to },
    effects: closeInsertEffect.of(null)
  });
  view.focus();
}

/** Exported so a test can read the set straight off an `EditorState`. */
export function insertDecorationField(plugin: WeaverPlugin): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: (state) => insertDecorations(state, plugin),
    update: (value, transaction) => {
      const before = transaction.startState.field(insertStateField, false) ?? null;
      const after = transaction.state.field(insertStateField, false) ?? null;
      return before === after ? value.map(transaction.changes) : insertDecorations(transaction.state, plugin);
    }
  });
}

/** The control row above the caret, and the one transaction that commits it. */
export function inlineInsertExtension(plugin: WeaverPlugin): Extension {
  const field = insertDecorationField(plugin);
  return [insertStateField, field, EditorView.decorations.from(field)];
}
