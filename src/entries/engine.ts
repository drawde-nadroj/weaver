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

import { dayKey, dayKeyFromName } from "../core/day";
import { contextDayForPath, MAIN_CONTEXT_ID } from "../core/contexts";
import {
  freshCaptureId,
  proseOf,
  resolveThought,
  rootEntryOf,
  thoughtRefOf,
  type CaptureInvitation,
  type CaptureReceipt,
  type CaptureRequest,
  type CaptureResult,
  type ThoughtRef
} from "../core/capture";
import type { DurationSigil } from "../core/duration";
import {
  entryBySeq,
  findEntryAtOffset,
  formatAddress,
  parseEntries,
  type Entry,
  type EntryIndex
} from "../core/entries";
import {
  applyPlanToSource,
  cmChanges,
  planCaptureEntry,
  planChildEntry,
  planDeleteEntry,
  planDuration,
  planSettleEntry,
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
import type { NoteStop } from "../core/navigation";
import { editorPathOf } from "../editor/editor-path";
import {
  entryIndexField,
  programmaticWrite,
  refreshEntriesEffect,
  type InputObservation
} from "../editor/entry-field";
import {
  findActiveEditorView,
  findEditorViewForFile,
  registeredEditorViews
} from "../editor/view-registry";
import {
  NOTICE_NEEDS_EDITING,
  NOTICE_NEEDS_ENTRY,
  NOTICE_NO_DAY_NOTE,
  NOTICE_PARTIAL_MS,
  NOTICE_REFUSAL_MS,
  NOTICE_STOP_FAILED,
  NOTICE_WHISPERING,
  NOTICE_WHISPER_UNREACHABLE,
  noticeCloseCodeBlock,
  noticeCloseFrontmatter,
  noticeLegacyFormat,
  noticeWhispered,
  whisperFailurePhrase
} from "../notices";
import type WeaverPlugin from "../main";
import { ensureDayNote, resolveContextDay } from "./day-note";
import { EntrySession, type NativeStopResult } from "./session";
import { planRewrite, registerWrite, rewriteDay, waitForWrite, RewriteRefused, type RewriteResult } from "./writer";

/**
 * A draft that has not recorded its beginning yet: a clock row with a duration
 * and no moment. That is the structural fact — never a zero duration, never
 * empty prose, both of which a written entry may also have. A historical draft
 * that genuinely lacks a moment is awaiting too; an entry with a moment keeps
 * it, whatever day it was written on.
 */

/**
 * A retry's guard: the operation it re-attempts, and the exact bytes its target
 * note must still hold before a replacement may be planned.
 */
export interface RetryGuard {
  /** The operation id of the attempt being retried. */
  operationId: string;
  /** The note the old attempt targeted. */
  path: string;
  /** The bytes that note held before that attempt. */
  before: string;
}

/** What one write actually did, so a caller never guesses success. */
export type WriteOutcome =
  | { readonly kind: "confirmed"; readonly receipt: CaptureReceipt }
  | {
      readonly kind: "refused";
      readonly reason: "invalid" | "retry-source-changed" | "receipt-storage" | "native-stop";
      readonly message: string;
    }
  | { readonly kind: "unconfirmed"; readonly receipt: CaptureReceipt; readonly message: string };

/** Thrown inside a plan when a retry's source bytes no longer match its guard. */
class RetrySourceChanged extends Error {}

/** The only writer of entry text: every surface changes an entry through one of its methods. */
export class EntryEngine {
  constructor(private readonly plugin: WeaverPlugin) {}

  private get session(): EntrySession {
    return this.plugin.session;
  }

  private get app(): App {
    return this.plugin.app;
  }

  /**
   * Writes one settled thought through the write protocol, and reports the truth.
   *
   * The destination is resolved here, inside the call that writes: a root belongs
   * to the day it was published in, a branch stays in its parent's file. The
   * receipt is persisted before the note is touched, so a receipt store that
   * cannot hold it refuses the whole write. A retry is guarded by the exact bytes
   * its target note must still hold: a same-file retry compares those bytes inside
   * the plan, while a retry that now routes to another day is reconciled against
   * the old path before planning against the new one — two different files' bytes
   * are never compared.
   */
  async writeCapture(
    request: CaptureRequest,
    retry: RetryGuard | null,
    beforeCommit: (receipt: CaptureReceipt) => void,
    invitations: readonly CaptureInvitation[] = []
  ): Promise<WriteOutcome> {
    const operationId = retry?.operationId ?? freshCaptureId();
    const destination =
      request.parent === null
        ? resolveContextDay(this.app, this.plugin.settings, request.contextId, request.beginning.day)
        : { ok: true as const, path: request.parent.path };

    if (!destination.ok) return { kind: "refused", reason: "invalid", message: destination.error };

    const existing = this.app.vault.getAbstractFileByPath(destination.path);
    let file: TFile | null = existing instanceof TFile ? existing : null;

    if (file === null && request.parent !== null) {
      return { kind: "refused", reason: "invalid", message: "the note that holds this branch is gone; pick a parent again" };
    }

    if (file === null) {
      try {
        file = await ensureDayNote(this.app, destination.path, request.beginning.day);
      } catch (error) {
        return {
          kind: "refused",
          reason: "invalid",
          message: `the note for ${request.beginning.day} could not be created (${
            error instanceof Error ? error.message : String(error)
          })`
        };
      }
    }

    // A retry whose destination moved to another day is reconciled against the
    // note the old attempt targeted, never by comparing the two files' bytes.
    if (retry !== null && retry.path !== destination.path) {
      await waitForWrite(this.app, retry.operationId);
      const oldBytes = await this.readPersisted(retry.path);
      if (oldBytes !== retry.before) {
        return {
          kind: "refused",
          reason: "retry-source-changed",
          message: "the original note changed; the retry was not written"
        };
      }
    }

    const box: { receipt: CaptureReceipt | null } = { receipt: null };
    let storageFailed = false;
    let flightDone: () => void = () => {};
    const flight = new Promise<void>((resolve) => {
      flightDone = resolve;
    });
    const release = registerWrite(operationId, flight);

    try {
      let result: RewriteResult | null;
      try {
        result = await rewriteDay(
          this.app,
          file,
          planRewrite((source) => {
            if (retry !== null && retry.path === destination.path && source !== retry.before) {
              throw new RetrySourceChanged();
            }
            return planCaptureEntry(source, parseEntries(source), request);
          }),
          true,
          {
            // The receipt is written before the note is touched, so a crash in the
            // middle of the write leaves evidence a later session can check. A
            // store that cannot hold it refuses the submission outright.
            beforeCommit: (before, planned) => {
              const written = parseEntries(planned.source);
              const allocated = this.allocated(written, planned.caret, destination.path);
              const receipt: CaptureReceipt = {
                id: operationId,
                request,
                path: destination.path,
                thought: allocated.thought,
                root: allocated.root,
                before,
                expected: planned.source,
                invitations: [...invitations]
              };
              box.receipt = receipt;
              try {
                beforeCommit(receipt);
              } catch (error) {
                storageFailed = true;
                throw error;
              }
            },
            confirmPersistence: true
          }
        );
      } catch (error) {
        if (error instanceof RetrySourceChanged) {
          return {
            kind: "refused",
            reason: "retry-source-changed",
            message: "the original note changed; the retry was not written"
          };
        }
        if (error instanceof RewriteRefused) {
          return {
            kind: "refused",
            reason: storageFailed ? "receipt-storage" : "invalid",
            message: error.message
          };
        }
        // A failure after the receipt was persisted may have reached the note:
        // that is unknown, never a failure the writer may answer by writing twice.
        if (box.receipt !== null) {
          return {
            kind: "unconfirmed",
            receipt: box.receipt,
            message: error instanceof Error ? error.message : String(error)
          };
        }
        return {
          kind: "refused",
          reason: "invalid",
          message: error instanceof Error ? error.message : String(error)
        };
      }

      if (result === null) {
        const index = parseEntries(await this.app.vault.cachedRead(file));
        const message = index.legacyFormat
          ? noticeLegacyFormat("writing this thought")
          : index.unclosedFrontmatter
            ? noticeCloseFrontmatter("writing this thought")
            : index.unclosedFence
              ? noticeCloseCodeBlock("writing this thought")
              : request.parent === null
                ? "this note could not take a new thought"
                : "that thought is no longer in its note; pick a parent again";
        return { kind: "refused", reason: "invalid", message };
      }

      const receipt = box.receipt;
      if (receipt === null) throw new Error("the written thought had no receipt");

      const written = parseEntries(result.source);
      const allocated = this.allocated(written, result.caret, destination.path, request.text);

      // A whisper is asked for only now: the text is a record, and the model reads
      // records. Nothing was asked while the draft was still being written.
      const input = this.whisperInput(written, allocated.entry);
      if (input !== null) this.plugin.whisper.request(destination.path, allocated.entry.n, input);

      return { kind: "confirmed", receipt };
    } finally {
      flightDone();
      release();
    }
  }

  /**
   * The pre-protocol entry point, kept for callers that do not retry or check.
   *
   * An unconfirmed write throws rather than claiming failure, because the note
   * may hold the words and a second write would duplicate them.
   */
  async capture(
    request: CaptureRequest,
    onReceipt?: (receipt: CaptureReceipt) => void,
    invitations: readonly CaptureInvitation[] = []
  ): Promise<CaptureResult> {
    const outcome = await this.writeCapture(
      request,
      null,
      (receipt) => onReceipt?.(receipt),
      invitations
    );
    if (outcome.kind === "confirmed") {
      return { ok: true, thought: outcome.receipt.thought, root: outcome.receipt.root };
    }
    if (outcome.kind === "refused") return { ok: false, error: outcome.message };
    throw new Error(outcome.message);
  }

  /** One note's persisted bytes, the only source a retry guard may be checked against. */
  private async readPersisted(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    try {
      return await this.app.vault.read(file);
    } catch {
      return null;
    }
  }

  /**
   * The thought a capture plan allocated, read back from the note it produced.
   *
   * The caret the plan leaves is inside the new entry's own prose, so it names
   * the entry without trusting a sequence number computed elsewhere. When the
   * entry cannot be read back at that place, the plan did not produce what it
   * claimed — a bug worth stopping for rather than a refusable note.
   */
  private allocated(
    index: EntryIndex,
    caret: number | null,
    path: string,
    text?: string
  ): { thought: ThoughtRef; root: ThoughtRef; entry: Entry } {
    const entry = caret === null ? null : findEntryAtOffset(index, caret);
    if (entry === null) throw new Error("the written thought could not be read back");
    if (text !== undefined && proseOf(index, entry) !== text.trim()) {
      throw new Error("the written thought could not be read back");
    }

    return {
      thought: thoughtRefOf(index, entry, path),
      root: thoughtRefOf(index, rootEntryOf(index, entry), path),
      entry
    };
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

    // A live session holds the displayed time; a paused entry holds its own
    // stored time, so settling never restarts a clock it never had. The digit on
    // screen is the truth: `⏎` never refreshes the clock, and a raw sample taken
    // here could turn a visible `00:00:07` into `00:00:09` when a tick was late.
    const live = this.session.activeFor(path, current.n);
    const ms = live ? this.session.displayed() : (current.duration?.ms ?? 0);

    const plan = planSettleEntry(source, index, current, ms, new Date());
    // Nothing can be written for this entry, so this is not a stop at all: the
    // session is kept rather than dropped, and no clock is silently discarded.
    if (plan === null) return;

    // A warm whisper goes in the same transaction as `+`, so one undo takes the
    // whole settle back. A cold one is asked for and lands later, as its own
    // undoable transaction: settle is the most-used key, and nothing waits.
    const input = this.whisperInput(index, current);
    const cached = input === null ? null : this.plugin.whisper.peek(input);
    const whisperPlan =
      input === null || cached === null ? null : planWhisper(source, index, current, cached);

    // Held before the transaction that carries the stop: if it cannot land, the
    // stopwatch stays on the second the writer saw instead of resuming past it.
    if (live) this.session.freezeDisplay();

    try {
      view.dispatch({
        changes: cmChanges([...plan.changes, ...(whisperPlan?.changes ?? [])]),
        annotations: programmaticWrite.of(true)
      });
    } catch {
      new Notice(NOTICE_STOP_FAILED, NOTICE_PARTIAL_MS);
      return;
    }

    // Released only now, after the transaction carrying the stopped duration
    // exists.
    if (live) {
      this.session.clear();
      this.repaintStoppedClocks(path);
    }

    if (input !== null && cached === null) this.plugin.whisper.request(path, current.n, input);
  }

  /**
   * `Enter` on a settled entry: a child opens one dimension deeper under it, with
   * the caret in its prose. The parent's clock row is not touched.
   */
  descend(view: EditorView, entry: Entry): void {
    const source = view.state.doc.toString();
    const index = this.indexOf(view, source);
    if (this.refuseLegacy(index, "opening a child entry")) return;
    const parent = entryBySeq(index, entry.n);
    if (parent === null) return;

    // Duration only: the child gets its own beginning when the writer first
    // types in it, not from the moment this blank block was made.
    const child = planChildEntry(source, index, parent);
    if (child === null) return;

    this.writePlan(view, child);
    view.focus();
  }

  /**
   * Stops the clock and leaves the entry open at `=`, holding its elapsed time.
   *
   * `=` is the sigil for "the writer stopped here": it is a draft like `-`, so
   * the next keystroke resumes from this second, and the write is free at second
   * resolution because an unchanged clock plans nothing.
   *
   * The written duration is the last painted second, never a fresh sample: a
   * stop preserves exactly the digits the writer was looking at. The second is
   * held before the write and the session is released only once it lands, so a
   * failed write leaves the clock stopped exactly where it stopped — a retry
   * writes the same digits, and only fresh input starts counting again.
   */
  pause(): Promise<NativeStopResult> {
    const active = this.session.active();
    if (active === null) return Promise.resolve({ kind: "idle" });

    const owner = this.session;
    const sessionId = active.id;

    // Held before the write: the stop's number is the second that was on
    // screen, and no tick may advance it while the write is in flight — nor
    // after a failed one, until the writer types again.
    this.session.freezeDisplay();
    const ms = this.session.displayed();

    return this.publish(active.path, active.seq, "=", ms, false).then((accepted) => {
      // Clearing and repainting depend on this exact session still being the one
      // that stopped: a replacement that shares the path and N keeps its clock.
      if (accepted && this.session.clearIf(sessionId)) {
        this.repaintStoppedClocks(active.path);
      } else if (!accepted) {
        // A failed write is not a stop, but it is not a resume either: the
        // stopwatch stays held at the second it stopped on, so a retry writes the
        // same digits, and only fresh input starts counting again.
        new Notice(NOTICE_STOP_FAILED, NOTICE_PARTIAL_MS);
      }

      // The answer is the captured publish result, even if the session was
      // replaced while the write was in flight.
      return {
        kind: accepted ? ("stopped" as const) : ("failed" as const),
        owner,
        sessionId,
        path: active.path,
        n: active.seq
      };
    });
  }

  /**
   * Captures an entry's beginning together with the first text written in it.
   *
   * A draft with a duration-only clock row has no moment yet: the moment is the
   * time the writer actually typed, not the time the blank block was made. The
   * text and the recorded day/moment therefore go into one transaction, so one
   * undo takes the whole beginning back and one redo restores it whole.
   *
   * Returns `false` for everything that is not the first nonempty text of an
   * awaiting entry — including an input aimed at the clock row itself, whose
   * start would be after the metadata being appended — so the caller can leave
   * ordinary input to CodeMirror.
   *
   * `beganAt` is the input's own timestamp, sampled when the input arrived;
   * `userEvent` is CodeMirror's name for that input, carried through so a paste
   * stays a paste and a committed composition stays a composition for history.
   */
  captureInput(
    _view: EditorView,
    _from: number,
    _to: number,
    _text: string,
    _beganAt: number,
    _userEvent = "input.type"
  ): boolean {
    // The beginning is recorded at settle, never at first input.
    return false;
  }

  /**
   * Records an awaiting entry's beginning after an IME composition commits.
   *
   * A composition's text reaches the document natively: CodeMirror applies the
   * preedit and keeps the committed text when `compositionend` arrives, often
   * without a further document change for the text handler to intercept. So
   * this path writes **only** the metadata — never the text, which is already
   * the writer's — in one transaction named `input.type.compose`. CodeMirror's
   * history always joins a `input.type.compose` event with the event before it,
   * so the committed composition and its recorded beginning undo together.
   *
   * `input.at` is the composition's commit instant, never a preedit update; a
   * later deferred callback cannot move the recorded moment.
   *
   * An entry that already recorded its beginning needs no metadata at all: the
   * committed text is the writer's own input, and the composition's end often
   * arrives with no further document change for the update listener to observe.
   * Such a commit is handed to the same bookkeeping ordinary typing uses, so a
   * paused or held draft resumes from the committed moment, without a write and
   * without a new undo step. A settled entry never starts a clock. Returns
   * `true` when the commit was taken as input into a draft — with or without a
   * metadata write — and `false` when there was nothing safe to do with it.
   */
  captureComposition(_view: EditorView, _input: InputObservation): boolean {
    // Timing is read from the document's input observation, not the IME commit.
    return false;
  }

  /**
   * Keeps the live session on the entry the writer is typing in.
   *
   * `input` is what the editor observed at the moment of the input: its path,
   * its entry, and its timestamp. Nothing here re-reads the caret to decide
   * where typing landed — a caret that moved before this deferred run must not
   * attach the keystroke to another entry, and the clock's baseline is the
   * moment of typing, not of bookkeeping. `null` means an edit that was not
   * input (a deletion, an undo, a reload), which never starts a clock.
   *
   * Deleting the live entry leaves the session on a sequence number that no
   * longer exists; the next entry would reuse it and inherit a running clock.
   * So a session whose entry is gone — or whose entry is no longer the one under
   * the caret — is settled first, and only then may a draft resume.
   *
   * The clock starts on the writer's own typing and nothing else: an entry the
   * vault reloaded, or one Weaver itself wrote, has no time in it yet.
   */
  afterEdit(view: EditorView, input: InputObservation | null): void {
    const path = editorPathOf(view);
    if (path === null) return;

    const index = this.indexOf(view, view.state.doc.toString());
    const at = findEntryAtOffset(index, view.state.selection.main.head);

    // A session measures an entry that has a recorded beginning. An undo can
    // take that beginning away — the entry is awaiting its first text again —
    // and a redo can settle it. In both cases there is nothing to write: the
    // row is the evidence. The clock ends here rather than clinging to an entry
    // that is no longer being written, so a later redo cannot revive it.
    const before = this.session.active();
    if (before !== null && before.path === path) {
      const measured = entryBySeq(index, before.seq);
      if (
        measured !== null &&
        (measured.state === "settled" || measured.clockLine === null)
      ) {
        this.session.clear();
      }
    }

    const active = this.session.active();
    const moved =
      active !== null &&
      (active.path !== path ||
        entryBySeq(index, active.seq) === null ||
        active.seq !== at?.n);
    // Pausing writes `=` into the entry it aimed at, and `publish` skips the
    // write when that entry is gone, so a deletion leaves the file alone.
    if (moved) void this.pause();

    if (input === null || input.path !== path) {
      this.refreshSoon(view);
      return;
    }

    const target = entryBySeq(index, input.seq);
    if (target === null || target.state !== "draft") {
      this.refreshSoon(view);
      return;
    }
    // A deferred observation can outlive the beginning it described: an undo
    // removes the text and the recorded moment, and the capture's callback may
    // still arrive afterwards. An entry without a beginning is awaiting, not
    // being written, so no clock starts on it.
    if (this.session.frozen() && this.session.activeFor(path, target.n)) {
      // Fresh input releases a held stop: counting resumes from the second the
      // clock was held on, never from the time that passed while held.
      this.session.start(path, target.n, this.session.displayed(), input.at);
      this.plugin.clock.refresh();
    } else if (!this.session.activeFor(path, target.n)) {
      this.session.start(path, target.n, target.duration?.ms ?? 0, input.at);
      // One clock samples the session, mounted or not: a tick starts now, so
      // the row this typing is in has a displayed second to stop at.
      this.plugin.clock.refresh();
    }

    // Speculation, not a write: every edit pushes the idle timer back, and an
    // answer that arrives before `⏎` makes the settle warm.
    const whisper = this.whisperInput(index, target);
    if (whisper !== null) this.plugin.whisper.arm(path, target.n, whisper);

    this.refreshSoon(view);
  }

  /**
   * Puts the caret in a thought of a named note, without starting the clock.
   *
   * This is the one jump: the navigator's rows, a return from the history, and
   * "edit in note" all arrive here, and all of them name the note as well as the
   * thought.
   *
   * `restore` is a recorded position. Its caret offset is relative to the
   * thought's own prose, so text inserted elsewhere in the note cannot move it;
   * when the thought it named is gone, or its own prose changed, the jump is
   * refused rather than landing at an unrelated offset. A position outside every
   * entry needs its own line *and* the lines around it to match exactly one
   * place, because a note full of blank lines has many lines that look alike.
   *
   * The target is checked twice: against the live editor-or-vault source before
   * anything is revealed, and again against the editor's own document afterwards,
   * because revealing may have re-read the file. `false` means the screen must be
   * put back, which is what lets the history keep its cursor where it was.
   */
  async jumpTo(
    path: string,
    n: number | null,
    restore?: NoteStop,
    focus = true
  ): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;

    const preflight = await this.sourceFor(path);
    if (preflight === null) return false;
    const before = parseEntries(preflight);
    if (n !== null) {
      if (entryBySeq(before, n) === null) return false;
      if (restore?.thought != null && resolveThought(before, restore.thought) === null) return false;
    } else if (restore !== undefined && uniqueLine(before, restore) === null) {
      return false;
    }

    const view = await this.revealFile(file);
    if (view === null) return false;
    const editor = findEditorViewForFile(file);
    if (editor === null) return false;

    this.session.clear();

    const index = this.indexOf(editor, editor.state.doc.toString());
    const entry = n === null ? null : entryBySeq(index, n);
    if (n !== null && entry === null) return false;

    let caret: number | null = null;
    if (entry !== null) {
      const offset = restore?.caretInProse ?? 0;
      caret = Math.min(Math.max(entry.proseFrom + offset, entry.proseFrom), entry.proseTo);
    } else if (restore !== undefined) {
      const line = uniqueLine(index, restore);
      caret = line === null ? null : (index.lineStarts[line] ?? null);
    }

    if (caret === null) return false;

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
      const scroll = restore.scrollTop;
      requestAnimationFrame(() => {
        editor.scrollDOM.scrollTop = scroll;
      });
    }

    if (focus) editor.focus();
    return true;
  }

  /**
   * The place the caret is in right now, as the history remembers one.
   *
   * The thought and the caret's offset inside its own prose are the durable part:
   * they survive text inserted elsewhere in the note. The line and its two
   * neighbours are what place a caret that is outside every entry, and the leaf
   * id is which pane it was in — two panes can show one note.
   */
  stopHere(): NoteStop | null {
    const editor = findActiveEditorView(this.app);
    if (editor === null) return null;
    const path = editorPathOf(editor);
    if (path === null) return null;

    const index = this.indexOf(editor, editor.state.doc.toString());
    const caret = editor.state.selection.main.head;
    const entry = findEntryAtOffset(index, caret);
    const view = markdownViewFor(this.app, editor);

    return {
      kind: "note",
      path,
      contextId: contextDayForPath(path, this.plugin.contexts())?.contextId ?? null,
      n: entry?.n ?? null,
      thought: entry === null ? null : thoughtRefOf(index, entry, path),
      leafId: view === null ? null : leafIdFor(this.app, view),
      caretInProse: entry === null ? null : Math.max(0, caret - entry.proseFrom),
      lineText: lineAt(index, caret),
      lineBefore: neighbourLine(index, caret, -1),
      lineAfter: neighbourLine(index, caret, 1),
      scrollTop: editor.scrollDOM.scrollTop,
      mode: view?.getMode() === "preview" ? "preview" : "source"
    };
  }

  /**
   * A note's text, from the live editor when one holds it and the vault otherwise.
   *
   * The editor is asked first because it may hold writing the file does not have
   * yet: a jump planned from the file alone could land in text the writer has
   * already changed on screen.
   */
  private async sourceFor(path: string): Promise<string | null> {
    for (const view of registeredEditorViews()) {
      if (editorPathOf(view) === path) return view.state.doc.toString();
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    try {
      return await this.app.vault.cachedRead(file);
    } catch {
      return null;
    }
  }

  /**
   * Publishes a session's elapsed time through the one writer: device-local
   * session time becomes the entry's clock row. `pause` publishes `=`, and
   * `settle` publishes `+` into the open editor through the same `planDuration`.
   * A settled entry plans nothing, so this is a no-op there.
   *
   * `true` means the stop was accepted — the write landed, or there was nothing
   * left to write (the file is gone, or the entry no longer exists). `false`
   * means the write itself failed, and the caller must keep what it was holding.
   */
  async publish(
    path: string,
    n: number,
    sigil: DurationSigil,
    ms: number,
    undoable: boolean
  ): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return true;

    try {
      await rewriteDay(
        this.app,
        file,
        planRewrite((source) => {
          const index = parseEntries(source);
          const entry = entryBySeq(index, n);
          return entry === null ? null : planDuration(source, index, entry, sigil, ms);
        }),
        undoable
      );
      return true;
    } catch {
      return false;
    }
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

  /** A successful stop must replace running widgets before another clock paint. */
  private repaintStoppedClocks(path: string): void {
    for (const view of registeredEditorViews()) {
      if (editorPathOf(view) !== path) continue;
      view.dispatch({
        effects: refreshEntriesEffect.of(undefined),
        annotations: programmaticWrite.of(true)
      });
    }
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

  /**
   * The model's view of one entry: its prose, its address, and the ancestors
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
      address: formatAddress(entry.b, entry.d, entry.n),
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

    const resolved = resolveContextDay(
      this.app,
      this.plugin.settings,
      MAIN_CONTEXT_ID,
      dayKey(new Date())
    );
    return resolved.ok ? resolved.file : null;
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
        (index.lines[entry.line] ?? "").slice(entry.addressEnd - entry.from).trim() === ""
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
        (each) => each.address === formatAddress(target.b, target.d, target.n)
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
        address: formatAddress(entry.b, entry.d, entry.n),
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

}

/** The zero-based line the offset sits on, or null when it is outside the note. */
function lineAt(index: EntryIndex, offset: number): string | null {
  const at = lineIndexOf(index, offset);
  return at === null ? null : (index.lines[at] ?? null);
}

/** The nearest non-empty line in one direction, trimmed, or null. */
function neighbourLine(index: EntryIndex, offset: number, direction: -1 | 1): string | null {
  const from = lineIndexOf(index, offset);
  if (from === null) return null;

  for (let at = from + direction; at >= 0 && at < index.lines.length; at += direction) {
    const text = (index.lines[at] ?? "").trim();
    if (text !== "") return text;
  }
  return null;
}

/** The last line start at or before `offset`. */
function lineIndexOf(index: EntryIndex, offset: number): number | null {
  let found: number | null = null;
  for (let at = 0; at < index.lineStarts.length; at += 1) {
    const start = index.lineStarts[at] ?? 0;
    if (start > offset) break;
    found = at;
  }
  return found;
}

/**
 * The one line a remembered position belongs to, or null when it is not one.
 *
 * A line's own text is not an address — the same sentence can appear twice — so
 * the line that precedes it and the line that follows it are matched too, and the
 * position is refused unless exactly one line satisfies all three. Refusing is the
 * point: landing at an unrelated offset is the failure this exists to prevent.
 */
function uniqueLine(index: EntryIndex, stop: NoteStop): number | null {
  const wanted = stop.lineText;
  if (wanted === null) return null;
  const text = wanted.trim();

  const candidates: number[] = [];
  for (let at = 0; at < index.lines.length; at += 1) {
    if ((index.lines[at] ?? "").trim() !== text) continue;
    if (neighbourOf(index, at, -1) !== stop.lineBefore) continue;
    if (neighbourOf(index, at, 1) !== stop.lineAfter) continue;
    candidates.push(at);
  }

  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/** The nearest non-empty line beside line `at`, trimmed. */
function neighbourOf(index: EntryIndex, at: number, direction: -1 | 1): string | null {
  for (let line = at + direction; line >= 0 && line < index.lines.length; line += direction) {
    const text = (index.lines[line] ?? "").trim();
    if (text !== "") return text;
  }
  return null;
}

/** The markdown view drawing this editor, when the host exposes the pairing. */
function markdownViewFor(app: App, editor: EditorView): MarkdownView | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) continue;
    const cm = (view.editor as unknown as { cm?: unknown } | undefined)?.cm;
    if (cm === editor) return view;
  }
  return null;
}

/** The host leaf's own id for a view, when it has one. */
function leafIdFor(app: App, view: MarkdownView): string | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    if (leaf.view !== view) continue;
    const id = Reflect.get(leaf, "id");
    return typeof id === "string" && id !== "" ? id : null;
  }
  return null;
}
