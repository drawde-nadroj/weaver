/**
 * The only writer of entry text.
 *
 * Every surface that changes an entry goes through here, so the rules live in one
 * place: `+` is final, `N` is only appended, `C` is a branch's thread id, and a
 * write never guesses — the plan is built from the exact text the attempt is
 * about to replace, by `writer.ts`, and skipped when the entry it was aiming at
 * is gone.
 *
 * A move — append, descend, jump — pushes the place it left onto the plugin's
 * return stack before it goes, and carries `programmaticWrite`, so no move starts
 * a clock.
 */

import { MarkdownView, Notice, TFile, type App } from "obsidian";
import { EditorView } from "@codemirror/view";
import { Transaction, type StateEffect } from "@codemirror/state";

import type { DurationSigil } from "../core/duration";
import {
  entryBySeq,
  findEntryAtOffset,
  parseEntries,
  type Entry,
  type EntryIndex
} from "../core/entries";
import {
  cmChanges,
  offsetToLineCh,
  planChildEntry,
  planDeleteEntry,
  planDuration,
  planStartEntry,
  type InsertPlan
} from "../core/insert";
import { pushStop, type Stop } from "../core/navigator-stack";
import { editorPathOf } from "../editor/editor-path";
import { entryIndexField, programmaticWrite, refreshEntriesEffect } from "../editor/entry-field";
import { findEditorViewForFile, registeredEditorViews } from "../editor/view-registry";
import {
  NOTICE_NO_DAY_NOTE,
  NOTICE_REFUSAL_MS,
  noticeCloseCodeBlock,
  noticeCloseFrontmatter,
  noticeLegacyFormat
} from "../notices";
import type WeaverPlugin from "../main";
import { ensureDayNote, resolveDayNote } from "./day-note";
import { EntrySession } from "./session";
import { planRewrite, rewriteDay } from "./writer";

/** The only writer of entry text: every surface changes an entry through one of its methods. */
export class EntryEngine {
  constructor(private readonly plugin: WeaverPlugin) {}

  private get session(): EntrySession {
    return this.plugin.session;
  }

  private get app(): App {
    return this.plugin.app;
  }

  /** Appends an entry at the tip of today's note, opening it when needed. */
  async appendEntry(now: Date): Promise<void> {
    const resolved = resolveDayNote(this.app, this.plugin.settings, now);

    let file = resolved.file;
    if (file === null) {
      try {
        file = await ensureDayNote(this.app, resolved.path, now);
      } catch {
        // A read-only vault or a sync lock must fail loudly, never fall back to
        // writing the entry into whatever note happens to be open.
        new Notice(NOTICE_NO_DAY_NOTE, NOTICE_REFUSAL_MS);
        return;
      }
    }

    // Source mode first, so the write lands in an editor when one can hold the
    // file: the caret has to end up in the new entry either way.
    const open = this.openViewFor(file);
    if (open !== null) await this.ensureSourceMode(open);

    this.pushStopFrom(findEditorViewForFile(file));

    const result = await rewriteDay(
      this.app,
      file,
      planRewrite((source) => planStartEntry(source, parseEntries(source), now)),
      true
    );

    if (result === null) {
      this.notifyRefusal(parseEntries(await this.app.vault.cachedRead(file)), "appending an entry");
      return;
    }

    await this.revealDayNote(file, result.source, result.caret);
  }

  /**
   * The navigator's `⇧⏎`: settle the entry if it is open, then open a child under
   * it. Two transactions, each undoable — the same two writes `Enter` in the note
   * makes when it lands on an open entry and is pressed again.
   */
  settleAndDescend(view: EditorView, entry: Entry): void {
    // Checked once, before either half: `settle` and `descend` each refuse a
    // legacy note, and the writer should be told once, not twice.
    if (this.refuseLegacy(this.indexOf(view, view.state.doc.toString()), "settling this entry")) {
      return;
    }

    if (entry.state === "draft") this.settle(view, entry);

    // Settling rewrote the clock row, so the parent is found again by `N`.
    const settled = entryBySeq(parseEntries(view.state.doc.toString()), entry.n);
    if (settled === null) return;
    this.descend(view, settled);
  }

  /**
   * Deletes an entry and its whole subtree, one undoable transaction.
   *
   * A clock running in the entry being deleted is dropped, never written: the
   * line it would have settled no longer exists.
   */
  deleteEntry(view: EditorView, entry: Entry): void {
    const path = editorPathOf(view);
    if (path === null) return;

    const source = view.state.doc.toString();
    const index = this.indexOf(view, source);
    if (this.refuseLegacy(index, "deleting an entry")) return;
    const current = entryBySeq(index, entry.n);
    if (current === null) return;

    const plan = planDeleteEntry(source, index, current);
    if (plan === null) return;

    if (this.session.activeFor(path, current.n)) this.session.clear();

    this.writePlan(view, plan);
    view.focus();
  }

  /**
   * `Enter` on an open entry: the duration becomes `+` and the clock stops.
   *
   * Nothing else moves — no child, no caret — so a thought can end without also
   * opening the next one. A settled entry is final, so this is a no-op there.
   */
  settle(view: EditorView, entry: Entry): void {
    const path = editorPathOf(view);
    if (path === null) return;

    const source = view.state.doc.toString();
    const index = this.indexOf(view, source);
    if (this.refuseLegacy(index, "settling this entry")) return;
    const current = entryBySeq(index, entry.n);
    if (current === null || current.state === "settled") return;

    // A live session holds the elapsed time; a paused entry holds its own stored
    // time, so settling never restarts a clock it never had.
    const ms = this.session.activeFor(path, current.n)
      ? this.session.elapsed(Date.now())
      : (current.duration?.ms ?? 0);
    this.session.clear();

    const plan = planDuration(source, index, current, "+", ms);
    if (plan === null) return;

    view.dispatch({
      changes: cmChanges(plan.changes),
      annotations: programmaticWrite.of(true)
    });
  }

  /**
   * `Enter` on a settled entry: a child opens one dimension deeper under it, with
   * the caret in its prose. The parent's clock row is not touched.
   */
  descend(view: EditorView, entry: Entry): void {
    const now = new Date();
    const source = view.state.doc.toString();
    const index = this.indexOf(view, source);
    if (this.refuseLegacy(index, "opening a child entry")) return;
    const parent = entryBySeq(index, entry.n);
    if (parent === null) return;

    const child = planChildEntry(source, index, parent, now);
    if (child === null) return;

    this.pushStopFrom(view);
    this.writePlan(view, child);
    view.focus();
  }

  /**
   * Stops the clock and leaves the entry open at `=`, holding its elapsed time.
   *
   * `=` is the sigil for "the writer stopped here": it is a draft like `-`, so
   * the next keystroke resumes from this second, and the write is free at second
   * resolution because an unchanged clock plans nothing.
   */
  pause(now: Date): void {
    const active = this.session.active();
    if (active === null) return;

    const ms = this.session.elapsed(now.getTime());
    this.session.clear();
    this.writeDuration(active.path, active.seq, "=", ms, false);
  }

  /**
   * Keeps the live session on the entry the caret is in.
   *
   * Deleting the live entry leaves the session on a sequence number that no
   * longer exists; the next entry would reuse it and inherit a running clock.
   * So a session whose entry is gone — or whose entry is no longer the one under
   * the caret — is settled first, and only then may a draft under the caret
   * resume.
   *
   * The clock starts on the writer's own typing and nothing else: an entry the
   * vault reloaded, or one Weaver itself wrote, has no time in it yet.
   */
  afterEdit(view: EditorView, typed: boolean): void {
    const path = editorPathOf(view);
    if (path === null) return;

    const index = this.indexOf(view, view.state.doc.toString());
    const at = findEntryAtOffset(index, view.state.selection.main.head);

    const active = this.session.active();
    const moved =
      active !== null && (entryBySeq(index, active.seq) === null || active.seq !== at?.n);
    // Pausing writes `=` into the entry it aimed at, and `writeDuration` skips
    // the write when that entry is gone, so a deletion leaves the file alone.
    if (moved) this.pause(new Date());

    if (typed && at !== null && at.state === "draft" && !this.session.activeFor(path, at.n)) {
      this.session.start(path, at.n, at.duration?.ms ?? 0, Date.now());
    }

    this.refreshSoon(view);
  }

  /**
   * Puts the caret in an entry of today's note, without starting the clock.
   *
   * `restore` is a stop from the return stack: its caret and scroll position are
   * exact, where a bare `N` only knows the entry's first prose line.
   */
  async jumpTo(n: number | null, restore?: Stop): Promise<void> {
    const editor = await this.revealToday(new Date());
    if (editor === null) return;

    this.pushStopFrom(editor);
    this.session.clear();

    const index = this.indexOf(editor, editor.state.doc.toString());
    const caret = restore?.caret ?? (n === null ? null : (entryBySeq(index, n)?.proseFrom ?? null));
    if (caret === null) return;

    editor.dispatch({
      selection: { anchor: caret },
      effects: [
        EditorView.scrollIntoView(caret, { y: restore === undefined ? "center" : "start" })
      ],
      annotations: programmaticWrite.of(true)
    });

    // The scroll container is laid out for the first time in the next frame, so
    // a restored offset set now would be overwritten by the scroll into view.
    if (restore !== undefined) {
      const { scroll } = restore;
      requestAnimationFrame(() => {
        editor.scrollDOM.scrollTop = scroll;
      });
    }

    editor.focus();
  }

  /** Writes a duration through the one writer. */
  writeDuration(path: string, n: number, sigil: DurationSigil, ms: number, undoable: boolean): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    void rewriteDay(
      this.app,
      file,
      planRewrite((source) => {
        const index = parseEntries(source);
        const entry = entryBySeq(index, n);
        return entry === null ? null : planDuration(source, index, entry, sigil, ms);
      }),
      undoable
    );
  }

  /**
   * Writes a plan, then puts the caret where the plan asks.
   *
   * Two dispatches, never one: Obsidian's CodeMirror maps a spec's `selection`
   * through the same update's changes, so a caret past the old document's end —
   * the caret every appending plan asks for — cannot be expressed alongside the
   * change. Writing first makes the caret an ordinary position in a document
   * that already holds it. The caret is kept out of the undo history, so one
   * undo still removes the whole write, and both carry `programmaticWrite`: this
   * is not the writer typing, so it must not start or settle a clock.
   */
  private writePlan(view: EditorView, plan: InsertPlan, effects: StateEffect<unknown>[] = []): void {
    view.dispatch({
      changes: cmChanges(plan.changes),
      annotations: programmaticWrite.of(true)
    });
    view.dispatch({
      selection: { anchor: plan.selection.from },
      effects: [...effects, EditorView.scrollIntoView(plan.selection.from, { y: "nearest" })],
      annotations: [Transaction.addToHistory.of(false), programmaticWrite.of(true)]
    });
  }

  /** Pushes the place `view` is about to leave onto the return stack. */
  private pushStopFrom(view: EditorView | null): void {
    if (view === null) return;

    const caret = view.state.selection.main.head;
    const current = findEntryAtOffset(this.indexOf(view, view.state.doc.toString()), caret);
    this.plugin.stack.stops = pushStop(this.plugin.stack.stops, {
      n: current?.n ?? null,
      caret,
      scroll: view.scrollDOM.scrollTop
    });
  }

  private indexOf(view: EditorView, source: string): EntryIndex {
    return view.state.field(entryIndexField, false) ?? parseEntries(source);
  }

  /** A refresh has to wait for the update that asked for it to finish. */
  private refreshSoon(view: EditorView): void {
    window.setTimeout(() => {
      if (!registeredEditorViews().includes(view)) return;
      // Named as a Weaver write like every other dispatch: a refresh carries no
      // caret move, and nothing downstream should mistake it for one.
      view.dispatch({
        effects: refreshEntriesEffect.of(undefined),
        annotations: programmaticWrite.of(true)
      });
    }, 0);
  }

  private openViewFor(file: TFile): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path) return view;
    }
    return null;
  }

  /**
   * Puts the note in source mode, so the caret can land in the new entry.
   * `setState` is not on every `MarkdownView` the tests build, hence the check.
   */
  private async ensureSourceMode(view: MarkdownView): Promise<void> {
    if (view.getMode() === "source") return;
    if (typeof view.setState !== "function") return;
    await view.setState({ ...view.getState(), mode: "source" }, { history: false });
  }

  /**
   * Shows a note: revealing the tab that already holds it, or opening one of its
   * own, then putting it in source mode. `getLeaf(false)` would replace the tab
   * the writer is in.
   */
  private async revealFile(file: TFile): Promise<MarkdownView | null> {
    const workspace = this.app.workspace;
    const existing = workspace
      .getLeavesOfType("markdown")
      .find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path);

    if (existing !== undefined) {
      workspace.setActiveLeaf(existing, { focus: true });
      await workspace.revealLeaf(existing);
    } else {
      await workspace.getLeaf("tab").openFile(file);
    }

    const view = this.openViewFor(file);
    if (view === null) return null;
    await this.ensureSourceMode(view);
    return view;
  }

  /** Shows the day note and puts the caret in the entry just written. */
  private async revealDayNote(file: TFile, source: string, caret: number | null): Promise<void> {
    const view = await this.revealFile(file);
    if (caret === null || view === null || view.getMode() !== "source") return;

    const position = offsetToLineCh(source, caret);
    view.editor.setCursor(position);
    view.editor.scrollIntoView({ from: position, to: position }, true);
    view.editor.focus();
  }

  /**
   * Today's day note on screen, in source mode, for a surface that edits it —
   * the navigator. `null` when the note cannot be found, opened, or reached as an
   * editor: the one refusal every caller would have to repeat.
   */
  async revealToday(now: Date): Promise<EditorView | null> {
    const resolved = resolveDayNote(this.app, this.plugin.settings, now);

    let file = resolved.file;
    if (file === null) {
      try {
        file = await ensureDayNote(this.app, resolved.path, now);
      } catch {
        new Notice(NOTICE_NO_DAY_NOTE, NOTICE_REFUSAL_MS);
        return null;
      }
    }

    const view = await this.revealFile(file);
    const editor = view === null ? null : findEditorViewForFile(file);
    if (editor === null) {
      new Notice(NOTICE_NO_DAY_NOTE, NOTICE_REFUSAL_MS);
      return null;
    }
    return editor;
  }

  /**
   * Refuses a note written before the clock row, and says why, once.
   *
   * The plans each refuse such a note on their own; this is where an explicit
   * editor action — an `⏎`, a deletion — turns that refusal into a sentence.
   * An ambient write (a pause after typing) stays silent: it writes nothing, and
   * the note is no worse for it.
   */
  private refuseLegacy(index: EntryIndex, action: string): boolean {
    if (!index.legacyFormat) return false;
    new Notice(noticeLegacyFormat(action), NOTICE_REFUSAL_MS);
    return true;
  }

  private notifyRefusal(index: EntryIndex, action: string): void {
    if (index.legacyFormat) {
      new Notice(noticeLegacyFormat(action), NOTICE_REFUSAL_MS);
      return;
    }
    if (index.unclosedFrontmatter) {
      new Notice(noticeCloseFrontmatter(action), NOTICE_REFUSAL_MS);
      return;
    }
    new Notice(noticeCloseCodeBlock(action), NOTICE_REFUSAL_MS);
  }
}
