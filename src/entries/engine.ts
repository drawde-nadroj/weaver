/**
 * The only writer of entry text.
 *
 * Every surface that changes an entry goes through here, so the rules live in one
 * place: `+` is final, `N` is only appended, `C` is renumbered on insert, and a
 * write never guesses — it re-reads the file inside `Vault.process` and skips the
 * write when the entry it was aiming at is gone.
 */

import { MarkdownView, Notice, TFile, type App, type Editor } from "obsidian";
import { Transaction, type StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { ensureDayNote, resolveDayNote } from "../core/day-note";
import type { DurationSigil } from "../core/duration";
import {
  entryBySeq,
  findEntryAtOffset,
  nextSeq,
  parseEntries,
  type Entry,
  type EntryIndex
} from "../core/entries";
import {
  applyPlanToSource,
  cmChanges,
  offsetToLineCh,
  planChildEntry,
  planDeleteEntry,
  planDuration,
  planStartEntry,
  type InsertPlan
} from "../core/insert";
import type { TravelRow } from "../core/travel-model";
import { editorPathOf } from "../editor/editor-path";
import { entryIndexField, programmaticWrite, refreshEntriesEffect } from "../editor/entry-field";
import { clearTravelTarget, setTravelTarget } from "../editor/travel-target";
import {
  findActiveEditorView,
  findEditorViewForFile,
  registeredEditorViews
} from "../editor/view-registry";
import {
  NOTICE_NO_DAY_NOTE,
  NOTICE_NO_ENTRY,
  NOTICE_REFUSAL_MS,
  noticeCloseCodeBlock,
  noticeCloseFrontmatter
} from "../notices";
import type WeaverPlugin from "../main";
import { EntrySession } from "./session";

export class EntryEngine {
  constructor(private readonly plugin: WeaverPlugin) {}

  private get session(): EntrySession {
    return this.plugin.session;
  }

  private get app(): App {
    return this.plugin.app;
  }

  /** Starts an entry at the tip of today's note, opening it when needed. */
  async startToday(now: Date): Promise<void> {
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

    const open = this.openViewFor(file);
    if (open !== null) {
      // Reading view on screen still ends with the caret in the new entry's
      // prose, so the writer never has to switch modes after starting.
      await this.ensureSourceMode(open);
      const view = findEditorViewForFile(file);
      if (view !== null) {
        // The note is already on screen: one undo removes the whole entry.
        this.startInView(view, now);
        return;
      }
    }

    let written = "";
    let caret: number | null = null;
    let refusal: EntryIndex | null = null;

    await this.app.vault.process(file, (data) => {
      const index = parseEntries(data);
      const plan = planStartEntry(data, index, now);
      if (plan === null) {
        refusal = index;
        return data;
      }

      const next = applyPlanToSource(data, plan);
      written = next.source;
      caret = next.selection.from;
      return next.source;
    });

    if (refusal !== null) {
      this.notifyRefusal(refusal, "starting an entry");
      return;
    }

    await this.revealDayNote(file, written, caret);
  }

  /** Inserts a child under the entry at the caret. Writes nothing if there is none. */
  startFromCursor(view: MarkdownView, now: Date): void {
    const editor = view.editor;
    const source = editor.getValue();
    const index = parseEntries(source);
    const parent = findEntryAtOffset(index, editor.posToOffset(editor.getCursor()));

    if (parent === null) {
      new Notice(NOTICE_NO_ENTRY, NOTICE_REFUSAL_MS);
      return;
    }

    const plan = planChildEntry(source, index, parent, now);
    if (plan === null) {
      this.notifyRefusal(index, "inserting an entry");
      return;
    }

    this.applyPlanToEditor(editor, source, plan);
  }

  /**
   * The palette's `Enter`: settle the entry if it is open, then open a child
   * under it. Two transactions, each undoable — the same two writes `Enter` in
   * the note makes when it lands on an open entry and is pressed again.
   */
  settleAndDescend(view: EditorView, entry: Entry): void {
    if (entry.state === "draft") this.settle(view, entry);

    // Settling rewrote the duration line, so the parent is found again by `N`.
    const settled = entryBySeq(parseEntries(view.state.doc.toString()), entry.n);
    if (settled === null) return;
    this.descend(view, settled);
  }

  /**
   * Deletes an entry and its whole subtree, one undoable transaction.
   *
   * A clock running in the entry being deleted is dropped, never written: the
   * line it would have settled no longer exists. A travel target on the deleted
   * entry is cleared, so the rectangle cannot outlive the text it pointed at.
   */
  deleteEntry(view: EditorView, entry: Entry): void {
    const path = editorPathOf(view);
    if (path === null) return;

    const source = view.state.doc.toString();
    const index = this.indexOf(view, source);
    const current = entryBySeq(index, entry.n);
    if (current === null) return;

    const plan = planDeleteEntry(source, index, current);
    if (plan === null) return;

    if (this.session.activeFor(path, current.n)) this.session.clear();

    const target = this.plugin.travelTarget;
    if (target !== null && target.path === path && target.seq === current.n) {
      this.plugin.travelTarget = null;
      view.dispatch({ effects: clearTravelTarget.of(null) });
    }

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
    const current = entryBySeq(index, entry.n);
    if (current === null || current.state === "settled") return;

    // A live session holds the elapsed time; a paused or travelled entry holds
    // its own stored time, so settling never restarts a clock it never had.
    const ms = this.session.activeFor(path, current.n)
      ? this.session.elapsed(Date.now())
      : current.durationMs;
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
   * the caret in its prose. The parent's duration line is not touched.
   */
  descend(view: EditorView, entry: Entry): void {
    const path = editorPathOf(view);
    if (path === null) return;

    const now = new Date();
    const source = view.state.doc.toString();
    const index = this.indexOf(view, source);
    const parent = entryBySeq(index, entry.n);
    if (parent === null) return;

    const child = planChildEntry(source, index, parent, now);
    if (child === null) return;

    const seq = nextSeq(index);
    this.plugin.travelTarget = { path, seq };
    this.writePlan(view, child, [setTravelTarget.of({ seq }), refreshEntriesEffect.of(undefined)]);
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
      this.session.start(path, at.n, at.durationMs, Date.now());
    }

    this.refreshSoon(view);
  }

  /** Opens an entry and puts the caret in its prose, without starting the clock. */
  async travelTo(row: TravelRow): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(row.path);
    if (!(file instanceof TFile)) return;

    const workspace = this.app.workspace;
    const leaf = workspace
      .getLeavesOfType("markdown")
      .find(
        (candidate) =>
          candidate.view instanceof MarkdownView && candidate.view.file?.path === file.path
      );

    if (leaf !== undefined) {
      workspace.setActiveLeaf(leaf, { focus: true });
      await workspace.revealLeaf(leaf);
    } else {
      await workspace.getLeaf("tab").openFile(file);
    }

    const view = this.openViewFor(file);
    if (view === null) return;

    await this.ensureSourceMode(view);

    const editor = findEditorViewForFile(file) ?? findActiveEditorView(this.app);
    if (editor === null) return;

    const entry = entryBySeq(this.indexOf(editor, editor.state.doc.toString()), row.n);
    if (entry === null) return;

    this.plugin.travelTarget = { path: file.path, seq: entry.n };
    editor.dispatch({
      selection: { anchor: entry.proseFrom },
      effects: [setTravelTarget.of({ seq: entry.n }), refreshEntriesEffect.of(undefined)],
      scrollIntoView: true
    });
    editor.focus();
  }

  /**
   * Writes a duration. Through the editor when the note is on screen, so the
   * write is undoable; through `Vault.process` otherwise, re-reading first and
   * skipping the write when the entry it aimed at is gone.
   */
  writeDuration(path: string, n: number, sigil: DurationSigil, ms: number, undoable: boolean): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const view = findEditorViewForFile(file);
    if (view !== null) {
      const source = view.state.doc.toString();
      const index = this.indexOf(view, source);
      const entry = entryBySeq(index, n);
      if (entry === null) return;

      const plan = planDuration(source, index, entry, sigil, ms);
      if (plan === null) return;

      view.dispatch({
        changes: cmChanges(plan.changes),
        annotations: [Transaction.addToHistory.of(undoable), programmaticWrite.of(true)]
      });
      return;
    }

    void this.app.vault.process(file, (data) => {
      const index = parseEntries(data);
      const entry = entryBySeq(index, n);
      if (entry === null) return data;

      const plan = planDuration(data, index, entry, sigil, ms);
      if (plan === null) return data;
      return applyPlanToSource(data, plan).source;
    });
  }

  private startInView(view: EditorView, now: Date): void {
    const source = view.state.doc.toString();
    const index = this.indexOf(view, source);
    const plan = planStartEntry(source, index, now);

    if (plan === null) {
      this.notifyRefusal(index, "starting an entry");
      return;
    }

    this.writePlan(view, plan);
    view.focus();
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
   * the palette. `null` when the note cannot be found, opened, or reached as an
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

  /** Applies a plan as one transaction, then puts the caret in the new entry. */
  private applyPlanToEditor(editor: Editor, source: string, plan: InsertPlan): void {
    const changes = plan.changes.map((change) => ({
      from: editor.offsetToPos(change.from),
      to: editor.offsetToPos(change.to),
      text: change.text
    }));

    const nextSource = applyPlanToSource(source, plan).source;
    const selection = {
      from: offsetToLineCh(nextSource, plan.selection.from),
      to: offsetToLineCh(nextSource, plan.selection.to)
    };

    editor.transaction({ changes, selection });
    editor.focus();
    editor.scrollIntoView(selection, true);
  }

  private notifyRefusal(index: EntryIndex, action: string): void {
    if (index.unclosedFrontmatter) {
      new Notice(noticeCloseFrontmatter(action), NOTICE_REFUSAL_MS);
      return;
    }
    new Notice(noticeCloseCodeBlock(action), NOTICE_REFUSAL_MS);
  }
}
