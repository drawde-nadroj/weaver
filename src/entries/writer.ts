/**
 * The one writer of a day note.
 *
 * A note has exactly one writer at a time: an active editing buffer, or
 * `Vault.process` otherwise — never both. Reading view's dormant buffer is not a
 * writer. Two writers is what made
 * Obsidian report the file as modified externally: the day-stats pass landed on
 * disk behind an editor holding the same note, and the editor's next keystroke
 * wrote over it (or lost the race the other way round).
 *
 * The second rule is that a plan is built from the text being written. The
 * rewrite callback is handed the exact string that will be replaced, inside the
 * writer, so an append cannot land on a document that moved since it was read.
 */

import { Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { MarkdownView, type App, type TFile } from "obsidian";

import {
  applyPlanToSource,
  cmChanges,
  type InsertPlan,
  type TextChange
} from "../core/insert";
import { programmaticWrite } from "../editor/entry-field";
import { findEditorViewForFile } from "../editor/view-registry";

/**
 * Dispatches a change to the composer's owned, fileless editor buffer.
 *
 * This is not a note write: it accepts no file or vault, and preserves the
 * caller's input/history annotations. Publishing a draft still uses a capture
 * plan through the ordinary note writer.
 */
export function dispatchDraftChange(view: EditorView, transaction: TransactionSpec): void {
  view.dispatch(transaction);
}

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
 * A rewrite that was refused before the document was touched.
 *
 * The distinction matters to a capture: a refusal means the note is exactly as
 * it was, so the writer may submit again, while a failure after the dispatch
 * means the answer is unknown and nothing may be written twice.
 */
export class RewriteRefused extends Error {}

/** Hooks that let a caller observe — or veto — one write before it happens. */
export interface RewriteOptions {
  /**
   * Runs after the plan is built and before the document changes: the exact text
   * that will be replaced, and the write that will replace it. Throwing refuses
   * the whole write.
   */
  beforeCommit?: (before: string, planned: RewriteResult) => void;
  /**
   * Confirms the bytes reached the file. With an editor, the owning note is
   * saved and the file re-read; with the vault, the write is already the file,
   * and it is re-read all the same.
   */
  confirmPersistence?: boolean;
}

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
  undoable: boolean,
  options: RewriteOptions = {}
): Promise<RewriteResult | null> {
  const view = findEditorViewForFile(file);

  /** The refusal boundary: a throw here means nothing was written. */
  const plan = (source: string): RewriteResult | null => {
    const result = rewrite(source);
    if (result === null || result.changes.length === 0) return null;
    if (options.beforeCommit !== undefined) {
      try {
        options.beforeCommit(source, result);
      } catch (error) {
        throw new RewriteRefused(error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  };

  if (view !== null) {
    const result = plan(view.state.doc.toString());
    if (result === null) return null;

    view.dispatch({
      changes: cmChanges(result.changes),
      annotations: [Transaction.addToHistory.of(undoable), programmaticWrite.of(true)]
    });
    if (options.confirmPersistence !== true) return result;

    // The editor holds the change in memory; the note holds it once Obsidian
    // saves. Asking the owning view to save — without focusing it — and then
    // reading the file is the only way to know which of those is true.
    const owner = markdownViewFor(app, file);
    if (owner !== null && typeof owner.save === "function") await owner.save();
    await confirmBytes(app, file, result.source);
    return result;
  }

  const box: { result: RewriteResult | null } = { result: null };
  await app.vault.process(file, (data) => {
    const result = plan(data);
    box.result = result;
    return result === null ? data : result.source;
  });
  if (options.confirmPersistence === true && box.result !== null) {
    await confirmBytes(app, file, box.result.source);
  }
  return box.result;
}

/** The editing leaf that can save `file`; a Reading leaf saves different data. */
function markdownViewFor(app: App, file: TFile): MarkdownView | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === file.path && view.getMode() === "source") return view;
  }
  return null;
}

/** Re-reads the file and refuses when it does not hold what was written. */
async function confirmBytes(app: App, file: TFile, expected: string): Promise<void> {
  const actual = await app.vault.read(file);
  if (actual !== expected) {
    throw new Error("the note did not keep the bytes that were written");
  }
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

/**
 * Confirms an already-written submission without writing it again.
 *
 * When the live editor holds the expected bytes but the file does not, the
 * editor is the truth and the recovery is to let it save — then read the file.
 * It never dispatches an old plan and never replaces newer text: if no editor
 * holds exactly `expected`, it does nothing and reports false.
 */
export async function confirmExistingWrite(
  app: App,
  file: TFile,
  expected: string
): Promise<boolean> {
  const editor = findEditorViewForFile(file);
  if (editor === null) return false;
  if (editor.state.doc.toString() !== expected) return false;

  const owner = markdownViewFor(app, file);
  if (owner === null || typeof owner.save !== "function") return false;

  try {
    await owner.save();
    return (await app.vault.read(file)) === expected;
  } catch {
    return false;
  }
}

/** The in-flight write registry, shared across an ordinary plugin reload. */
const IN_FLIGHT = Symbol.for("weaver.write.inflight");

/** One registered write, as a promise a reader may await. */
interface Flight {
  promise: Promise<void>;
}

/** The process-wide registry, keyed by operation id. */
function registry(): Map<string, Flight> {
  const host = globalThis as unknown as Record<symbol, Map<string, Flight> | undefined>;
  let map = host[IN_FLIGHT];
  if (map === undefined) {
    map = new Map<string, Flight>();
    host[IN_FLIGHT] = map;
  }
  return map;
}

/**
 * Registers one in-flight Loom write so a Check or Retry can await it.
 *
 * A check that read the note while an old attempt could still commit would draw
 * the wrong conclusion; registering before the write and removing in `finally`
 * is the IO-lifetime guard, not stored product state. Returns a release function.
 */
export function registerWrite(operationId: string, promise: Promise<unknown>): () => void {
  const map = registry();
  map.set(operationId, { promise: promise.then(() => undefined, () => undefined) });
  return () => {
    map.delete(operationId);
  };
}

/** Awaits one registered write, if it is still running; a no-op once gone. */
export async function waitForWrite(_app: App, operationId: string): Promise<void> {
  const flight = registry().get(operationId);
  if (flight !== undefined) await flight.promise;
}
