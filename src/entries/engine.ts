/**
 * The editor path that changes an entry.
 *
 * Every surface that changes an entry goes through here or through
 * `writer.ts`, so the rules live in one place: `+` is final, `N` is only
 * appended, `B` is the branch id, and a write never guesses — the plan is built
 * from the exact text the attempt is about to replace, by `writer.ts`, and
 * skipped when the entry it was aiming at is gone.
 *
 * A move — start, descend, jump — pushes the place it left onto the plugin's
 * return stack before it goes, and carries `programmaticWrite`, so no move starts
 * a clock.
 */

import { MarkdownView, Notice, TFile, type App } from "obsidian";
import { EditorView } from "@codemirror/view";
import { Transaction, type StateEffect } from "@codemirror/state";

import { dayKeyFromName } from "../core/day";
import type { DurationSigil } from "../core/duration";
import {
  entryBySeq,
  findEntryAtOffset,
  formatMarker,
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
  planThread,
  planWhisper,
  type InsertPlan,
  type TextChange
} from "../core/insert";
import {
  parseWhisperResponse,
  validateThread,
  validateWhisper,
  whisperKey,
  whisperPrompt,
  whisperThreadPrompt,
  type WhisperDayEntry,
  type WhisperInput,
  type WhisperItem
} from "../core/whisper";
import { NoModel, type WhisperFailure } from "../model/whisper-model";
import { WHISPER_FAILURE_LIMIT } from "../model/whisper-runner";
import { pushStop, type Stop } from "../core/navigator-stack";
import { editorPathOf } from "../editor/editor-path";
import { entryIndexField, programmaticWrite, refreshEntriesEffect } from "../editor/entry-field";
import {
  findActiveEditorView,
  findEditorViewForFile,
  registeredEditorViews
} from "../editor/view-registry";
import {
  NOTICE_NEEDS_EDITING,
  NOTICE_NEEDS_ENTRY,
  NOTICE_NO_DAY_NOTE,
  NOTICE_REFUSAL_MS,
  NOTICE_WHISPERING,
  NOTICE_WHISPER_UNREACHABLE,
  noticeCloseCodeBlock,
  noticeCloseFrontmatter,
  noticeLegacyFormat,
  noticeWhispered,
  whisperFailurePhrase
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

  /** Starts an entry at the tip of today's note, opening it when needed. */
  async startEntry(now: Date): Promise<void> {
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
      this.notifyRefusal(parseEntries(await this.app.vault.cachedRead(file)), "starting an entry");
      return;
    }

    await this.revealDayNote(file, result.source, result.caret);
  }

  /**
   * Settle the entry if it is open, then open a child under it: the navigator's
   * `⇧⏎` and the palette/toolbar descent. Two transactions, each undoable — the
   * same two writes `Enter` in the note makes when it lands on an open entry and
   * is pressed again.
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
   * The palette/toolbar descent: settle the caret's entry if it is open, then
   * open a child under it. The same two writes as `⇧⏎` in the navigator, and the
   * same state rule as `⏎`: the entry decides whether it settles first.
   */
  descendAtCaret(): void {
    const view = findActiveEditorView(this.app);
    if (view === null) {
      new Notice(NOTICE_NEEDS_EDITING, NOTICE_REFUSAL_MS);
      return;
    }

    const index = this.indexOf(view, view.state.doc.toString());
    const entry = findEntryAtOffset(index, view.state.selection.main.head);
    if (entry === null) {
      new Notice(NOTICE_NEEDS_ENTRY, NOTICE_REFUSAL_MS);
      return;
    }

    this.settleAndDescend(view, entry);
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

    // A warm whisper goes in the same transaction as `+`, so one undo takes the
    // whole settle back. A cold one is asked for and lands later, as its own
    // undoable transaction: settle is the most-used key, and nothing waits.
    const input = this.whisperInput(index, current);
    const cached = input === null ? null : this.plugin.whisper.peek(input);
    const whisperPlan =
      input === null || cached === null ? null : planWhisper(source, index, current, cached);

    view.dispatch({
      changes: cmChanges([...plan.changes, ...(whisperPlan?.changes ?? [])]),
      annotations: programmaticWrite.of(true)
    });

    if (input !== null && cached === null) this.plugin.whisper.request(path, current.n, input);
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
    this.publish(active.path, active.seq, "=", ms, false);
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
    // Pausing writes `=` into the entry it aimed at, and `publish` skips the
    // write when that entry is gone, so a deletion leaves the file alone.
    if (moved) this.pause(new Date());

    if (typed && at !== null && at.state === "draft" && !this.session.activeFor(path, at.n)) {
      this.session.start(path, at.n, at.duration?.ms ?? 0, Date.now());
    }

    // Speculation, not a write: every edit pushes the idle timer back, and an
    // answer that arrives before `⏎` makes the settle warm.
    if (typed && at !== null && at.state === "draft") {
      const input = this.whisperInput(index, at);
      if (input !== null) this.plugin.whisper.arm(path, at.n, input);
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

  /**
   * Publishes a session's elapsed time through the one writer: device-local
   * session time becomes the entry's clock row. `pause` publishes `=`, and
   * `settle` publishes `+` into the open editor through the same `planDuration`.
   * A settled entry plans nothing, so this is a no-op there.
   */
  publish(path: string, n: number, sigil: DurationSigil, ms: number, undoable: boolean): void {
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
   * The model's view of one entry: its prose, its marker, and the ancestors
   * above it, root first.
   *
   * `null` when there is nothing to read. An ancestor contributes its own first
   * prose line, and its name when a whisper already gave it one — so a child's
   * reading can see the branch it is written into without the prompt having to
   * describe the note's shape.
   *
   * `names` is the whole-day pass's own bookkeeping: a name it has just collected
   * but not yet written, so a child reads after its parent's new name.
   */
  private whisperInput(
    index: EntryIndex,
    entry: Entry,
    names: ReadonlyMap<number, string> = new Map()
  ): WhisperInput | null {
    if (entry.proseLines.length === 0) return null;

    const ancestors: WhisperInput["ancestors"] = [];
    let at = entry.parent;
    while (at !== null) {
      const ancestor = index.entries[at];
      if (ancestor === undefined) break;
      ancestors.unshift({
        title: ancestor.title,
        whisper: names.get(at) ?? ancestor.whisper[0]?.text ?? null
      });
      at = ancestor.parent;
    }

    return {
      marker: formatMarker(entry.d, entry.b, entry.n),
      prose: entry.proseLines.map((line) => index.lines[line] ?? "").join("\n"),
      ancestors
    };
  }

  /**
   * The day note this command reads: the one on screen when its filename carries
   * a day, and today's otherwise.
   *
   * A past day is a day. Its note is the same shape and its settled entries are
   * the same entries, so nothing about a whisper needs the day to be today —
   * which is why the command follows the reader rather than the clock. The
   * filename is what says a note is a day note: `dayKeyFromName` is the same test
   * the day plane itself uses.
   */
  private dayToWhisper(): TFile | null {
    const active = this.app.workspace.getActiveFile();
    if (active !== null && dayKeyFromName(active.basename) !== null) return active;

    return resolveDayNote(this.app, this.plugin.settings, new Date()).file;
  }

  /**
   * Whispers every settled entry of the day note on screen (today's when no day
   * note is open) that has none: one pass, one undo.
   *
   * Each answer is asked for in document order and read after the names already
   * collected, so a child sees the branch as this pass is naming it. The writes
   * are merged into one `rewriteDay`, and every one of them re-checks the key it
   * was answered under — the same compare-and-swap a single landing uses — so a
   * hand edit during the pass cannot be overwritten by an answer about the text
   * it replaced.
   */
  async whisperDay(): Promise<void> {
    const model = this.plugin.whisperModel();
    if (model.id === NoModel.id) {
      new Notice(NOTICE_WHISPER_UNREACHABLE, NOTICE_REFUSAL_MS);
      return;
    }

    const file = this.dayToWhisper();
    if (file === null) {
      new Notice(NOTICE_NO_DAY_NOTE, NOTICE_REFUSAL_MS);
      return;
    }

    const index = parseEntries(await this.app.vault.cachedRead(file));
    if (this.refuseLegacy(index, "whispering the day")) return;

    const targets = index.entries.filter(
      (entry) =>
        entry.state === "settled" &&
        entry.whisper.length === 0 &&
        entry.proseLines.length > 0 &&
        (index.lines[entry.line] ?? "").slice(entry.markerEnd - entry.from).trim() === ""
    );

    new Notice(NOTICE_WHISPERING);

    const names = new Map<number, string>();
    const collected: { n: number; key: string; whisper: WhisperItem[] }[] = [];
    let rejected = 0;
    let failure: WhisperFailure | null = null;
    let consecutive = 0;
    let stopped = false;

    for (const target of targets) {
      const input = this.whisperInput(index, target, names);
      if (input === null) continue;

      const reply = await model.complete(whisperPrompt(input));
      if (!reply.ok) {
        failure = reply.failure;
        consecutive += 1;
        this.plugin.log("whisper", whisperFailurePhrase(reply.failure));
        // A pass over a broken address must not spend one request per entry.
        if (consecutive >= WHISPER_FAILURE_LIMIT) {
          stopped = true;
          break;
        }
        continue;
      }

      consecutive = 0;

      const answer = validateWhisper(parseWhisperResponse(reply.text), input);
      if (!answer.ok) {
        rejected += 1;
        this.plugin.log("whisper rejected", answer.reason);
        continue;
      }

      collected.push({ n: target.n, key: whisperKey(input), whisper: answer.whisper });
      const name = answer.whisper[0];
      if (name?.type === "name") names.set(index.entries.indexOf(target), name.text);
    }

    // The day-level question, asked once per entry that will carry a reading and has
    // an earlier entry to point at. One job, one call: a model asked to both read the
    // entry and place it names the day instead of the entry.
    const skeleton = this.daySkeleton(index, names);
    const placements = new Map<number, WhisperItem>();

    for (const target of this.plugin.settings.whisperThreads ? index.entries : []) {
      if (target.state !== "settled" || target.proseLines.length === 0) continue;

      const willCarry = collected.some((item) => item.n === target.n) || target.whisper.length > 0;
      if (!willCarry) continue;
      if (target.whisper.some((row) => row.type === "thread")) continue;

      const own = skeleton.find(
        (each) => each.marker === formatMarker(target.d, target.b, target.n)
      );
      // The first entry of the day has no earlier entry to cite.
      if (own === undefined || skeleton.indexOf(own) === 0) continue;

      if (stopped) break;
      const reply = await model.complete(whisperThreadPrompt(skeleton, own));
      if (!reply.ok) {
        failure = reply.failure;
        this.plugin.log("whisper", whisperFailurePhrase(reply.failure));
        consecutive += 1;
        if (consecutive >= WHISPER_FAILURE_LIMIT) {
          stopped = true;
          break;
        }
        continue;
      }

      consecutive = 0;
      const answer = validateThread(parseWhisperResponse(reply.text), skeleton, own);
      if (!answer.ok) {
        rejected += 1;
        this.plugin.log("whisper thread rejected", answer.reason);
        continue;
      }
      if (answer.thread !== null) placements.set(target.n, answer.thread);
    }

    let written = 0;
    let threads = 0;
    await rewriteDay(
      this.app,
      file,
      (source) => {
        const liveIndex = parseEntries(source);
        const changes: TextChange[] = [];

        for (const item of collected) {
          const entry = entryBySeq(liveIndex, item.n);
          if (entry === null || entry.state !== "settled" || entry.whisperLines.length > 0) continue;

          const input = this.whisperInput(liveIndex, entry, names);
          if (input === null || whisperKey(input) !== item.key) continue;

          // A reading written in this pass carries its placement in the same
          // insertion, so the whole day is still one undo.
          const thread = placements.get(item.n);
          const plan = planWhisper(
            source,
            liveIndex,
            entry,
            thread === undefined ? item.whisper : [...item.whisper, thread]
          );
          if (plan === null) continue;
          changes.push(...plan.changes);
          written += 1;
          if (thread !== undefined) threads += 1;
        }

        // Readings written earlier get their placement appended, and only that.
        for (const [n, thread] of placements) {
          if (collected.some((item) => item.n === n)) continue;
          const entry = entryBySeq(liveIndex, n);
          if (entry === null) continue;
          const plan = planThread(source, liveIndex, entry, thread);
          if (plan === null) continue;
          changes.push(...plan.changes);
          threads += 1;
        }

        if (changes.length === 0) return null;
        const plan = { changes, selection: { from: 0, to: 0 } };
        return { changes, source: applyPlanToSource(source, plan).source, caret: null };
      },
      true
    );

    new Notice(
      noticeWhispered({ targets: targets.length, written, rejected, failure, threads })
    );
  }

  /**
   * The day as the thread question sees it: one line per settled entry, an address
   * and the name it carries — a whisper name when it has one, and otherwise the
   * opening of its own prose cut to six words.
   *
   * `names` carries the readings this pass has collected but not yet written, so an
   * entry placed after one read in the same pass can cite it.
   */
  private daySkeleton(index: EntryIndex, names: ReadonlyMap<number, string>): WhisperDayEntry[] {
    return index.entries
      .filter((entry) => entry.state === "settled" && entry.proseLines.length > 0)
      .map((entry) => ({
        marker: formatMarker(entry.d, entry.b, entry.n),
        name:
          names.get(index.entries.indexOf(entry)) ??
          entry.whisper[0]?.text ??
          entry.title.split(/\s+/).slice(0, 6).join(" ")
      }));
  }

  /**
   * Lands a whisper that arrived after its entry settled: its own transaction, so
   * its own undo.
   *
   * The key is compared inside the rewrite, against the text being written — the
   * same compare-and-swap every plan uses — so a landing can never describe prose
   * that has changed since the model read it, and no invalidation logic exists.
   *
   * Rows are about to appear above the prose. Never under the writer's own caret:
   * a line arriving between two keystrokes moves the text they are reading. The
   * entry stays unwhispered, and `Whisper the day` is the repair.
   */
  landWhisper(path: string, n: number, key: string, whisper: WhisperItem[]): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const view = findEditorViewForFile(file);

    void rewriteDay(
      this.app,
      file,
      planRewrite((source) => {
        const index = parseEntries(source);
        const entry = entryBySeq(index, n);
        if (entry === null || entry.state !== "settled") return null;

        const input = this.whisperInput(index, entry);
        if (input === null || whisperKey(input) !== key) return null;

        if (view !== null) {
          const caretLine = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
          const last = entry.clockLine ?? entry.line;
          if (caretLine >= entry.line && caretLine <= last) return null;
        }

        return planWhisper(source, index, entry, whisper);
      }),
      true
    );
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
