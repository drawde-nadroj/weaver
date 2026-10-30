/**
 * The one writer of a day note.
 *
 * A note has exactly one writer at a time: the live editor when the file is open
 * in one, `Vault.process` otherwise — never both. Two writers is what made
 * Obsidian report the file as modified externally: the day-stats pass landed on
 * disk behind an editor holding the same note, and the editor's next keystroke
 * wrote over it (or lost the race the other way round).
 *
 * The second rule is that a plan is built from the text being written. The
 * rewrite callback is handed the exact string that will be replaced, inside the
 * writer, so an append cannot land on a document that moved since it was read.
 */

import { Transaction } from "@codemirror/state";
import type { App, TFile } from "obsidian";

import {
  applyPlanToSource,
  cmChanges,
  type InsertPlan,
  type TextChange
} from "../core/insert";
import { programmaticWrite } from "../editor/entry-field";
import { findEditorViewForFile } from "../editor/view-registry";

/** One write: its changes, the resulting text, and where the caret belongs. */
export interface RewriteResult {
  changes: TextChange[];
  source: string;
  /** Where the caller should put the caret, as an offset in `source`. */
  caret: number | null;
}

/** Builds a rewrite against the text it is given; `null` means "nothing to do". */
export type Rewrite = (source: string) => RewriteResult | null;

/**
 * Writes one rewrite to a file: through the editor that holds it, or through the
 * vault when none does.
 *
 * `undefined` back means nothing was written — either the rewrite declined, or
 * it planned no change at all.
 */
export async function rewriteDay(
  app: App,
  file: TFile,
  rewrite: Rewrite,
  undoable: boolean
): Promise<RewriteResult | null> {
  const view = findEditorViewForFile(file);
  if (view !== null) {
    const result = rewrite(view.state.doc.toString());
    if (result === null || result.changes.length === 0) return null;

    view.dispatch({
      changes: cmChanges(result.changes),
      annotations: [Transaction.addToHistory.of(undoable), programmaticWrite.of(true)]
    });
    return result;
  }

  const box: { result: RewriteResult | null } = { result: null };
  await app.vault.process(file, (data) => {
    const result = rewrite(data);
    box.result = result;
    return result === null ? data : result.source;
  });
  return box.result;
}

/** Adapts an `InsertPlan` builder, so a plan is always built from the live text. */
export function planRewrite(build: (source: string) => InsertPlan | null): Rewrite {
  return (source) => {
    const plan = build(source);
    if (plan === null) return null;
    return {
      changes: plan.changes,
      source: applyPlanToSource(source, plan).source,
      caret: plan.selection.from
    };
  };
}

/** The single change spanning everything that differs; `[]` when nothing does. */
export function minimalChange(before: string, after: string): TextChange[] {
  if (before === after) return [];

  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before[start] === after[start]) start += 1;

  let end = 0;
  while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
    end += 1;
  }

  return [{ from: start, to: before.length - end, text: after.slice(start, after.length - end) }];
}
