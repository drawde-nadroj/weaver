/**
 * The one floating draft, and everything that may happen to it.
 *
 * A composer is not a second editor: it owns no note, holds the bytes of exactly
 * one unsaved thought, and hands that thought to `EntryEngine.capture` at the
 * moment the writer settles it. Everything here is about what happens *before*
 * and *around* that write — freezing a beginning, counting only the time spent
 * writing, guarding against a second submission, and telling the truth about
 * whether the note received the text.
 *
 * Four rules shape it:
 *
 *  - **One draft.** There is no parking, no slot list and no draft manager. A
 *    second gesture never replaces the words: it either resumes the draft that is
 *    already here, or proposes a move of that same draft and waits.
 *  - **A proposal, not an edit.** Choosing a Realm or another parent is a request.
 *    While one is displayed the draft keeps its text, its beginning and its
 *    paused clock; only confirmation revalidates and applies it, and cancelling
 *    costs nothing because nothing was changed to cancel.
 *  - **A revision guard.** Every entry point that can change what "this thread"
 *    means bumps a generation, and an asynchronous answer that belongs to an
 *    older generation is dropped. That is why a late save cannot reopen a
 *    composer the writer has already dismissed, and why a stale branch target
 *    cannot be written under a newer thread.
 *  - **No invented state.** The draft is written to nothing until `settle`, and
 *    after `settle` the note is the only authority: the receipt is compared
 *    against the file's real bytes rather than trusted from local bookkeeping.
 *
 * The host supplies the world — the clock, the destinations, the one writer, the
 * workspace visit — so this module touches no note, no vault and no DOM, and a
 * test can drive every transition with a fake host.
 */

import {
  captureBeginningAt,
  commitShown,
  elapsedOf,
  idleClock,
  pauseClock,
  resolveThought,
  resumeClock,
  rootEntryOf,
  shownOf,
  thoughtRefOf,
  wholeSeconds,
  type CaptureBeginning,
  type CaptureInvitation,
  type CapturePhase,
  type CaptureReceipt,
  type CaptureRequest,
  type CaptureResult,
  type DraftClock,
  type DraftRecord,
  type DraftTarget,
  type ThoughtRef
} from "../core/capture";
import { contextDayForPath, MAIN_CONTEXT_ID, type WeavingContext } from "../core/contexts";
import { parseEntries, type EntryIndex } from "../core/entries";

/** The whole persisted capture: the draft, and a receipt while one is pending. */
export interface CaptureRecord {
  draft: DraftRecord | null;
  receipt: CaptureReceipt | null;
  /**
   * Provenance that could not be trusted when the record was read.
   *
   * Never written: it is the explanation that travels with a recovered draft
   * whose openings were dropped, so the surface can say what was lost instead of
   * discarding the writer's words along with the doubt.
   */
  warnings?: string[];
}

/** Where the one draft lives between sessions. */
export interface CaptureStore {
  /** The stored capture, or null when nothing was ever stored. */
  load(): CaptureRecord | null;
  /** Persists the capture; throws when the record could not be written. */
  save(record: CaptureRecord): void;
  /** Forgets it once the note's answer is known. */
  clear(): void;
}

/** What the composer needs from the rest of the plugin. */
export interface CaptureHost {
  /** The instant every timing decision is made at. */
  now(): number;
  /** Every destination, `main` first. */
  contexts(): readonly WeavingContext[];
  /** The one write path: a request becomes a note's text, or a reason it did not. */
  capture(
    request: CaptureRequest,
    invitations: readonly CaptureInvitation[]
  ): Promise<CaptureResult>;
  /** The note's current bytes, or null when it cannot be read. */
  read(path: string): Promise<string | null>;
  /** Opens one saved thought at its own prose, from its note. */
  editInNote(target: ThoughtRef): Promise<boolean>;
  /** The note's clock holds the second on screen, synchronously. */
  freezeNative(): void;
  /** Stops the note's clock; `false` when that write failed. */
  pauseNative(): Promise<boolean>;
  /**
   * The openings a root begun at `at` in `contextId` would be written through.
   *
   * Asked at the instant of the first committed input, so the answer is the
   * minute the writer actually began in rather than the minute a surface noticed.
   */
  invitationsAt(contextId: string, at: number): CaptureInvitation[];
  /** One submission's invitation is spent, through its own opening. */
  acknowledge(invitation: CaptureInvitation, saved: SavedThought, beginning: CaptureBeginning): void;
  /** The persisted draft and receipt. */
  store: CaptureStore;
  /** Something a surface draws has changed; never called for elapsed seconds. */
  onChange(): void;
}

/** A written thought and the Thread root it belongs to. */
export type SavedThought = { thought: ThoughtRef; root: ThoughtRef };

/** Why a request to open a second thread was not taken. */
export const CAPTURE_BUSY = "A draft is already open; it was kept.";

/** A target, once it has been read against the note and the Realm list. */
interface ResolvedTarget {
  contextId: string;
  parent: ThoughtRef | null;
  root: ThoughtRef | null;
  selected: ThoughtRef | null;
}

/**
 * The draft, its timing, its destination and its one submission.
 *
 * Every method is a transition on this object alone; the host is asked only for
 * the note's text, the one write, and the workspace visit. A method that cannot
 * proceed leaves the draft exactly as it was and says why through {@link error}.
 */
export class CaptureController {
  private phase: CapturePhase = "closed";
  private collapsed = false;

  /** The destination a new root would be written into. */
  private contextId: string = MAIN_CONTEXT_ID;
  /** The saved Thread being read or continued, when there is one. */
  private root: ThoughtRef | null = null;
  /** The saved thought the composer is selected on, for a branch or a label. */
  private selected: ThoughtRef | null = null;
  /** The thought this draft branches from, or null for a new Thread. */
  private parent: ThoughtRef | null = null;

  private text = "";
  private selection = { from: 0, to: 0 };
  private beginning: CaptureBeginning | null = null;
  private clock: DraftClock = idleClock();
  /** The openings this draft's first committed input qualified for. */
  private invitations: CaptureInvitation[] = [];
  /** The move the writer is being asked to confirm, if any. */
  private pendingTarget: DraftTarget | null = null;

  /** Bumped by every entry point that can change what this thread means. */
  private generation = 0;
  /** A second Enter during Saving dismisses, and only after success. */
  private dismissAfterSuccess = false;
  /** Kept only while an answer is unknown. */
  private receipt: CaptureReceipt | null = null;
  private error: string | null = null;
  /** A recovered draft starts paused and is never focused by itself. */
  private recovered = false;

  constructor(private readonly host: CaptureHost) {}

  /** The state a surface draws. */
  get state(): {
    phase: CapturePhase;
    collapsed: boolean;
    contextId: string;
    root: ThoughtRef | null;
    selected: ThoughtRef | null;
    parent: ThoughtRef | null;
    text: string;
    selection: { from: number; to: number };
    beginning: CaptureBeginning | null;
    durationMs: number;
    invitations: CaptureInvitation[];
    pendingTarget: DraftTarget | null;
    error: string | null;
    recovered: boolean;
  } {
    return {
      phase: this.phase,
      collapsed: this.collapsed,
      contextId: this.contextId,
      root: this.root,
      selected: this.selected,
      parent: this.parent,
      text: this.text,
      selection: this.selection,
      beginning: this.beginning,
      durationMs: shownOf(this.clock, this.host.now()),
      invitations: this.invitations,
      pendingTarget: this.pendingTarget,
      error: this.error,
      recovered: this.recovered
    };
  }

  /** True while a submission is in flight, so a second one cannot be started. */
  get submitting(): boolean {
    return this.phase === "submitting";
  }

  /** True when there is prose, or a chosen branch, worth resuming. */
  get hasWork(): boolean {
    if (this.phase !== "editing") return false;
    return this.text.trim() !== "" || this.parent !== null;
  }

  /**
   * Opens the composer, or resumes the draft that is already open.
   *
   * The note's own clock is frozen first and synchronously, so opening the
   * composer cannot let a second clock start behind it; the surface focuses its
   * input within the same gesture, which is what lets a phone raise a keyboard.
   *
   * A draft with words in it is never replaced and never re-homed: the Realm this
   * call names is where a *new* root would go, and a writer who already began has
   * decided that already. Only an untouched root takes the destination, because
   * there is nothing in it to keep.
   */
  open(contextId: string): void {
    if (this.phase === "submitting" || this.phase === "uncertain") {
      this.error = `${CAPTURE_BUSY} Finish that submission first.`;
      this.host.onChange();
      return;
    }

    if (this.phase === "editing") {
      if (this.root === null && this.parent === null && this.text.trim() === "") {
        this.contextId = this.destination(contextId);
      }
      this.collapsed = false;
      this.error = null;
      this.recovered = false;
      this.persist();
      this.host.onChange();
      return;
    }

    this.generation += 1;
    this.contextId = this.destination(contextId);
    this.phase = "editing";
    this.collapsed = false;
    this.error = null;
    this.recovered = false;
    this.dismissAfterSuccess = false;
    this.pendingTarget = null;
    this.root = null;
    this.selected = null;
    this.parent = null;
    this.text = "";
    this.selection = { from: 0, to: 0 };
    this.beginning = null;
    this.clock = idleClock();
    this.invitations = [];

    this.host.freezeNative();
    void this.pauseNative();

    this.persist();
    this.host.onChange();
  }

  /**
   * Opens one saved thread: its root, and the thought that was selected in it.
   *
   * The reference is validated against the note as it is now, so a thread whose
   * thought has been deleted or edited is refused instead of continued from a
   * stale address. A draft that is still being written takes precedence, and this
   * returns false rather than overwriting it.
   */
  async resumeThread(target: ThoughtRef): Promise<boolean> {
    if (this.phase === "editing" && this.text.trim() !== "") return false;
    if (this.phase === "submitting" || this.phase === "uncertain") return false;

    const generation = this.generation;
    const checked = await this.validated(target);
    if (generation !== this.generation) return false;
    if (checked === null) {
      this.error = "That thought is no longer in its note; open the note to see what changed.";
      this.host.onChange();
      return false;
    }

    const { index, target: current } = checked;
    const thought = resolveThought(index, current);
    if (thought === null) return false;
    const root = thoughtRefOf(index, rootEntryOf(index, thought), current.path);

    this.generation += 1;
    this.root = root;
    this.selected = current;
    this.parent = null;
    this.text = "";
    this.selection = { from: 0, to: 0 };
    this.beginning = null;
    this.clock = idleClock();
    this.invitations = [];
    this.pendingTarget = null;
    this.phase = "resting";
    this.collapsed = false;
    this.error = null;
    this.recovered = false;
    this.dismissAfterSuccess = false;

    this.host.freezeNative();
    void this.pauseNative();
    this.persist();
    this.host.onChange();
    return true;
  }

  /**
   * Records what the writer typed.
   *
   * The first committed non-whitespace text is what starts the draft: it freezes
   * the beginning, starts counting, and asks which openings that instant
   * qualifies for — one sample, in that order, from one instant. A branch has no
   * opening of its own, because only a root is written into a minute. Removing
   * every character resets the timing *and* the association, so text that is
   * empty and rewritten gets the minute it was actually written in.
   */
  setText(
    text: string,
    selection: { from: number; to: number } = { from: text.length, to: text.length }
  ): void {
    if (this.phase !== "editing") return;

    const wasEmpty = this.text.trim() === "";
    this.text = text;
    this.selection = selection;
    this.error = null;

    if (text.trim() === "") {
      this.beginning = null;
      this.clock = idleClock();
      this.invitations = [];
    } else if (wasEmpty || this.beginning === null) {
      const at = this.host.now();
      this.beginning = captureBeginningAt(at);
      this.clock = resumeClock(idleClock(), at);
      this.invitations = this.parent === null ? this.host.invitationsAt(this.contextId, at) : [];
    } else {
      // Real input releases a paused draft, counting on from the second it held.
      const at = this.host.now();
      if (this.clock.resumedAt === null) this.clock = resumeClock(this.clock, at);
    }

    this.persist();
    this.host.onChange();
  }

  /**
   * Records where the caret is, without touching the clock.
   *
   * Moving the caret is not writing. It is stored so a resumed draft returns to
   * the place it was left, and nothing else — no second is banked, and no
   * association is reconsidered.
   */
  setSelection(selection: { from: number; to: number }): void {
    if (this.phase !== "editing") return;
    if (this.selection.from === selection.from && this.selection.to === selection.to) return;
    this.selection = selection;
    this.persist();
  }

  /** Records what a clock painted, so a save writes the second the writer saw. */
  commitDuration(ms: number): void {
    if (this.phase !== "editing") return;
    this.clock = commitShown(this.clock, ms);
  }

  /** The raw milliseconds this draft has accrued, for a surface measuring it. */
  elapsed(): number {
    return elapsedOf(this.clock, this.host.now());
  }

  /** Counting stops: a blur, a fold, a hidden app, a workspace visit. */
  pause(): void {
    if (this.phase !== "editing" || this.clock.resumedAt === null) return;
    this.clock = pauseClock(this.clock);
    this.persist();
    this.host.onChange();
  }

  /**
   * Changes the destination of an unsaved root, in one step, when there is
   * nothing to discuss.
   *
   * A thread that is already saved is read-only: its destination is the note it
   * is in, and moving it is not a destination change but a different thread. A
   * draft with words goes through {@link requestTarget}, because moving it is the
   * writer's decision to confirm rather than a control's to apply.
   */
  async setDestination(contextId: string): Promise<boolean> {
    if (this.phase !== "editing") return false;
    if (this.root !== null) {
      this.error = "A saved thread stays in its own note; start a new thread to write elsewhere.";
      this.host.onChange();
      return false;
    }

    return this.requestTarget({ kind: "root", contextId });
  }

  /**
   * Proposes moving the one draft: a new root elsewhere, or under another parent.
   *
   * The target is read against the note before anything is shown, so a stale
   * reference is refused instead of displayed. With no words yet there is nothing
   * to protect, so the move is applied at once; with words the draft is paused and
   * kept exactly as it is until {@link confirmTarget}.
   */
  async requestTarget(target: DraftTarget): Promise<boolean> {
    if (this.phase === "submitting" || this.phase === "uncertain") return false;
    if (this.phase !== "editing" && this.phase !== "resting") return false;

    const generation = this.generation;
    const resolved = await this.resolveTarget(target);
    if (generation !== this.generation) return false;
    if (resolved === null) {
      this.host.onChange();
      return false;
    }

    if (this.phase === "resting" || this.text.trim() === "") {
      this.generation += 1;
      this.pendingTarget = null;
      this.applyTarget(resolved);
      this.text = "";
      this.selection = { from: 0, to: 0 };
      this.persist();
      this.host.onChange();
      return true;
    }

    // Paused, not moving: the words, the beginning and the second on screen stay.
    // The proposal kept is the *resolved* one, so the surface names the Realm the
    // move would really land in.
    this.clock = pauseClock(this.clock);
    this.pendingTarget =
      resolved.parent === null
        ? { kind: "root", contextId: resolved.contextId }
        : { kind: "branch", parent: resolved.parent };
    this.error = null;
    this.persist();
    this.host.onChange();
    return true;
  }

  /**
   * Applies the proposed move.
   *
   * The target is read again first, because a note may have changed while the
   * question was on screen. A target that is gone leaves the draft under its
   * original parent, with its words and its timing untouched.
   */
  async confirmTarget(): Promise<boolean> {
    const pending = this.pendingTarget;
    if (pending === null || this.phase !== "editing") return false;

    const generation = this.generation;
    const resolved = await this.resolveTarget(pending);
    if (generation !== this.generation) return false;

    this.pendingTarget = null;
    if (resolved === null) {
      this.persist();
      this.host.onChange();
      return false;
    }

    this.generation += 1;
    this.applyTarget(resolved);
    this.persist();
    this.host.onChange();
    return true;
  }

  /** Keeps the original parent: nothing was changed, so nothing is undone. */
  cancelTarget(): void {
    if (this.pendingTarget === null) return;
    this.pendingTarget = null;
    this.error = null;
    this.persist();
    this.host.onChange();
  }

  /**
   * Settles the draft: one Enter, one write.
   *
   * While a submission is in flight this records the deferred dismissal instead
   * of starting another write — that is what makes a distinct second Enter a
   * dismiss and never a duplicate record. In the resting state it is `Close`: the
   * composer closes and nothing is written.
   *
   * The submitted request is frozen before the write is asked for, and its clock
   * is paused at the painted second. A refusal puts the writer back in the draft
   * with their text and timing intact; an unconfirmed answer becomes the one
   * state a surface must not guess at.
   */
  async settle(): Promise<void> {
    if (this.phase === "submitting") {
      this.dismissAfterSuccess = true;
      this.host.onChange();
      return;
    }
    if (this.phase === "resting") {
      this.dismiss();
      return;
    }
    if (this.phase !== "editing") return;

    if (this.pendingTarget !== null) {
      this.error = "Confirm the parent first, or keep the original.";
      this.host.onChange();
      return;
    }

    if (this.text.trim() === "") {
      this.error = "There is nothing to save yet.";
      this.host.onChange();
      return;
    }

    const at = this.host.now();
    this.clock = pauseClock(this.clock);
    const beginning = this.beginning ?? captureBeginningAt(at);
    this.beginning = beginning;

    const request: CaptureRequest = {
      contextId: this.contextId,
      parent: this.parent,
      text: this.text,
      beginning,
      durationMs: wholeSeconds(shownOf(this.clock, at)),
      portal: this.invitations[0]?.portal ?? null
    };

    const generation = ++this.generation;
    this.phase = "submitting";
    this.error = null;
    this.host.onChange();

    let result: CaptureResult;
    try {
      result = await this.host.capture(request, this.invitations);
    } catch (error) {
      // An exception is not a refusal: the note may or may not hold the text.
      if (generation !== this.generation) return;
      this.phase = "uncertain";
      this.error = `The save could not be confirmed: ${
        error instanceof Error ? error.message : String(error)
      }. Check the note before writing again.`;
      this.host.onChange();
      return;
    }

    if (generation !== this.generation) return;

    if (!result.ok) {
      this.phase = "editing";
      this.dismissAfterSuccess = false;
      this.error = result.error;
      this.clock = resumeClock(this.clock, this.host.now());
      this.host.onChange();
      return;
    }

    this.complete(result, request.beginning);
  }

  /**
   * Asks the note whether an unconfirmed submission landed.
   *
   * The receipt carries the exact bytes before and after, so the answer is one of
   * three facts rather than a guess: the note holds what this submission would
   * have written (it is saved), the note is byte-for-byte what it was (nothing
   * reached it, and the draft may be submitted again), or something else changed
   * it. Only the first two are actionable, and neither appends anything on its
   * own.
   */
  async checkSave(): Promise<void> {
    if (this.phase !== "uncertain") return;

    const receipt = this.receipt;
    if (receipt === null) {
      this.error = "There is no pending save to check.";
      this.host.onChange();
      return;
    }

    const source = await this.host.read(receipt.path);
    if (source === null) {
      this.error = "The note could not be read; the save is still unconfirmed.";
      this.host.onChange();
      return;
    }

    if (source === receipt.expected) {
      this.complete({ thought: receipt.thought, root: receipt.root }, receipt.request.beginning);
      return;
    }

    if (source === receipt.before) {
      this.phase = "editing";
      this.error = "That save did not reach the note. Your text is still here; press Enter to write it again.";
      this.receipt = null;
      this.clock = resumeClock(this.clock, this.host.now());
      this.persist();
      this.host.onChange();
      return;
    }

    this.error =
      "The note changed in a way this save cannot explain, so nothing was added. Check the note before writing again.";
    this.host.onChange();
  }

  /**
   * Selects a saved thought to branch from, or to read.
   *
   * Only a thought this note still holds under the open Thread may be selected:
   * an `N` alone is not an address, and a selection made from one would put the
   * next branch under whatever inherited the number.
   */
  async selectThought(target: ThoughtRef): Promise<boolean> {
    if (this.phase !== "resting") return false;

    const generation = this.generation;
    const checked = await this.validated(target);
    if (generation !== this.generation) return false;
    if (checked === null || resolveThought(checked.index, target) === null) {
      this.selected = null;
      this.error = "That thought changed; choose it again.";
      this.persist();
      this.host.onChange();
      return false;
    }

    this.selected = target;
    this.error = null;
    this.persist();
    this.host.onChange();
    return true;
  }

  /**
   * Starts a branch under a thought, from whatever the composer was doing.
   *
   * With an empty draft — or none at all — this is the branch; with words it is a
   * proposal to move the draft that already exists, because a writer who typed
   * something and then chose a parent meant to keep what they typed.
   */
  async branch(parent: ThoughtRef): Promise<boolean> {
    if (this.phase === "submitting" || this.phase === "uncertain") return false;
    // A closed composer is where a navigator's Branch starts: there is no draft to
    // protect, so the branch simply becomes the one draft.
    if (this.phase !== "editing" && this.phase !== "resting" && this.phase !== "closed") {
      return false;
    }

    if (this.phase === "editing" && this.text.trim() !== "") {
      return this.requestTarget({ kind: "branch", parent });
    }

    const generation = this.generation;
    const resolved = await this.resolveTarget({ kind: "branch", parent });
    if (generation !== this.generation) return false;
    if (resolved === null) {
      this.host.onChange();
      return false;
    }

    this.generation += 1;
    this.pendingTarget = null;
    this.beginning = null;
    this.clock = idleClock();
    this.applyTarget(resolved);
    this.text = "";
    this.selection = { from: 0, to: 0 };
    this.persist();
    this.host.onChange();
    return true;
  }

  /**
   * Starts a fresh root in the current destination, ending the open Thread view.
   *
   * With words in the draft this is a proposal, not a clear: `T` never silently
   * discards what was typed.
   */
  async newThread(): Promise<boolean> {
    if (this.phase === "submitting" || this.phase === "uncertain") return false;

    const contextId = this.root === null ? this.contextId : this.contextOf(this.root.path);
    if (this.phase === "editing" && this.text.trim() !== "") {
      return this.requestTarget({ kind: "root", contextId });
    }

    this.generation += 1;
    this.pendingTarget = null;
    this.beginning = null;
    this.clock = idleClock();
    this.applyTarget({
      contextId: this.destination(contextId),
      parent: null,
      root: null,
      selected: null
    });
    this.text = "";
    this.selection = { from: 0, to: 0 };
    this.persist();
    this.host.onChange();
    return true;
  }

  /**
   * Leaves an empty branch without writing anything.
   *
   * This is the way out of a branch that was opened and not used: the saved
   * thread is still there, so the composer returns to it rather than closing and
   * making the writer find it again.
   */
  backToSavedThought(): void {
    if (this.phase !== "editing" || this.parent === null) return;
    if (this.text.trim() !== "") return;

    this.generation += 1;
    this.parent = null;
    this.text = "";
    this.beginning = null;
    this.clock = idleClock();
    this.invitations = [];
    this.pendingTarget = null;
    this.phase = this.root === null ? "closed" : "resting";
    this.error = null;
    this.recovered = false;
    this.persist();
    this.host.onChange();
  }

  /**
   * Hides the surface, keeping the draft.
   *
   * Hide is not a dismissal: the words stay, the caret is remembered, and the
   * clock stops on the second that was on screen. A root that was never typed in
   * closes instead of leaving a Resume strip, because there is nothing to resume;
   * a chosen branch is kept even while empty, because opening one was an intent.
   * A resting Thread closes, because it is a reading, not work in progress.
   */
  collapse(): void {
    if (this.phase === "closed") return;
    if (this.phase === "resting") {
      this.reset();
      return;
    }

    if (
      this.phase === "editing" &&
      this.root === null &&
      this.parent === null &&
      this.text.trim() === ""
    ) {
      this.reset();
      return;
    }

    if (this.phase === "editing") this.clock = pauseClock(this.clock);
    // A question that was never answered does not survive being hidden: the
    // draft keeps its original parent, and the surface has no way to ask.
    this.pendingTarget = null;
    this.collapsed = true;
    this.persist();
    this.host.onChange();
  }

  /** Shows the composer again, on whatever it was holding. */
  expand(): void {
    if (this.phase === "closed") return;
    this.collapsed = false;
    this.recovered = false;
    this.error = null;
    this.persist();
    this.host.onChange();
  }

  /**
   * Closes the composer.
   *
   * A resting composer closes outright. An editing one only hides: prose that was
   * never saved must not disappear because a key was pressed, and the explicit
   * {@link discardDraft} is the one way to give it up.
   */
  dismiss(): void {
    if (this.phase === "submitting" || this.phase === "uncertain") return;

    if (this.phase === "editing" && this.hasWork) {
      this.collapse();
      return;
    }

    this.reset();
  }

  /** Gives up the unsaved prose, after the surface has confirmed it. */
  discardDraft(): void {
    if (this.phase === "submitting" || this.phase === "uncertain") return;
    this.reset();
  }

  /**
   * Opens a saved thought in its own note, at its own prose.
   *
   * The bounded correction route: a settled thought is read and repaired where it
   * lives, not re-typed here. The composer keeps its selection so the writer can
   * come back to it.
   */
  async editInNote(target: ThoughtRef): Promise<boolean> {
    const checked = await this.validated(target);
    if (checked === null) {
      this.error = "That thought is no longer in its note; nothing was opened.";
      this.host.onChange();
      return false;
    }
    return this.host.editInNote(checked.target);
  }

  /**
   * Restores the one stored draft, if there is one.
   *
   * A recovered draft arrives paused and hidden, so a reload never takes focus or
   * starts a keyboard. A stored receipt means the last submission's answer is
   * unknown, so the composer opens in that state rather than pretending either
   * way. An unreadable record is reported and left untouched, and capture stays
   * available in memory with the recovery warning showing.
   */
  recover(): void {
    let record: CaptureRecord | null;
    try {
      record = this.host.store.load();
    } catch {
      this.error =
        "The stored draft could not be read, so it was left alone. Anything written now is memory-only until this is fixed.";
      this.host.onChange();
      return;
    }
    if (record === null) return;

    const warnings = record.warnings ?? [];

    if (record.receipt !== null) {
      this.receipt = record.receipt;
      this.phase = "uncertain";
      this.collapsed = false;
      this.contextId = record.receipt.request.contextId;
      this.text = record.receipt.request.text;
      this.beginning = record.receipt.request.beginning;
      this.invitations = record.receipt.invitations;
      this.error = [
        "A save was interrupted; check the note before writing again.",
        ...warnings
      ].join(" ");
      this.host.onChange();
      return;
    }

    const draft = record.draft;
    if (draft === null) return;

    this.phase = "editing";
    this.collapsed = true;
    this.recovered = true;
    this.contextId = this.destination(draft.contextId);
    this.root = draft.root;
    this.parent = draft.parent;
    this.selected = draft.root;
    this.text = draft.text;
    this.selection = draft.selection;
    this.beginning = draft.beginning;
    // Recovered time is paused: counting resumes only on real input.
    this.clock = {
      baselineMs: wholeSeconds(draft.durationMs),
      resumedAt: null,
      shownMs: wholeSeconds(draft.durationMs)
    };
    this.invitations = draft.invitations;
    this.error = warnings.length === 0 ? null : warnings.join(" ");
    this.host.onChange();
  }

  /** The one submission's receipt, while an answer about it is unknown. */
  pendingReceipt(): CaptureReceipt | null {
    return this.receipt;
  }

  /**
   * Installs the receipt for the submission now in flight.
   *
   * The writer records it before the note is touched, so a crash between planning
   * and saving leaves evidence a later session can check instead of appending a
   * second copy. A store that cannot write it refuses the submission: an
   * unrecorded write is the one outcome recovery could not describe.
   */
  attachReceipt(receipt: CaptureReceipt): void {
    this.receipt = receipt;
    this.persist(true);
  }

  /** The receipt was confirmed written; the note is the authority now. */
  clearReceipt(): void {
    this.receipt = null;
    this.persist();
  }

  /** A successful submission, from the write or from a confirmed receipt. */
  private complete(saved: SavedThought, beginning: CaptureBeginning): void {
    const invitations = this.invitations;
    const done = this.dismissAfterSuccess;

    this.generation += 1;
    this.receipt = null;
    this.recovered = false;
    this.error = null;
    this.dismissAfterSuccess = false;

    // Every opening the beginning qualified for is spent, each through its own
    // identity and generation: two schedules may share one epoch minute.
    for (const invitation of invitations) this.host.acknowledge(invitation, saved, beginning);
    this.invitations = [];

    this.root = saved.root;
    this.selected = saved.thought;
    this.parent = null;
    this.text = "";
    this.selection = { from: 0, to: 0 };
    this.beginning = null;
    this.clock = idleClock();
    this.phase = "resting";

    if (done) {
      // The writer asked to be done while the write was in flight: now that it
      // is confirmed, that intent is honoured, and nothing was written twice.
      const stored = this.performClose(saved);
      if (!stored.ok) this.error = stored.error;
      this.host.onChange();
      return;
    }

    try {
      this.host.store.clear();
    } catch {
      // The note holds the record and the answer is known; a stale local draft
      // is a warning, never a failed save.
      this.error = "Saved to the note, but the local draft could not be cleared; it may reappear after a reload.";
    }

    this.host.onChange();
  }

  /**
   * Closes on a confirmed save, keeping the saved thread as the resting selection.
   *
   * A local cleanup that fails is reported, never turned into a failed save: the
   * note is the record, and it already holds the words.
   */
  private performClose(saved: SavedThought): { ok: true } | { ok: false; error: string } {
    this.phase = "closed";
    this.collapsed = false;
    this.root = null;
    this.selected = null;
    this.parent = null;
    this.text = "";
    this.selection = { from: 0, to: 0 };
    this.beginning = null;
    this.clock = idleClock();
    this.invitations = [];
    this.pendingTarget = null;
    this.receipt = null;
    this.recovered = false;
    this.dismissAfterSuccess = false;
    void saved;

    try {
      this.host.store.clear();
      return { ok: true };
    } catch {
      return {
        ok: false,
        error: "Saved to the note, but the local draft could not be cleared; it may reappear after a reload."
      };
    }
  }

  /** Closes and forgets everything the composer was holding. */
  private reset(): void {
    this.generation += 1;
    this.phase = "closed";
    this.collapsed = false;
    this.root = null;
    this.selected = null;
    this.parent = null;
    this.text = "";
    this.selection = { from: 0, to: 0 };
    this.beginning = null;
    this.clock = idleClock();
    this.invitations = [];
    this.pendingTarget = null;
    this.receipt = null;
    this.error = null;
    this.recovered = false;
    this.dismissAfterSuccess = false;

    try {
      this.host.store.clear();
    } catch {
      this.error = "The local draft could not be cleared; it may reappear after a reload.";
    }

    this.host.onChange();
  }

  /**
   * Makes a resolved target the draft's own.
   *
   * Only the destination and the tree position move: the prose, the beginning and
   * the second on screen belong to the writer, not to the place. The openings the
   * draft had qualified for do not travel with it — they were frozen for the root
   * this draft was, and a move is not a reason to claim one retrospectively.
   */
  private applyTarget(target: ResolvedTarget): void {
    this.phase = "editing";
    this.collapsed = false;
    this.error = null;
    this.recovered = false;
    this.dismissAfterSuccess = false;
    this.contextId = target.contextId;
    this.root = target.root;
    this.parent = target.parent;
    this.selected = target.selected;
    this.invitations = [];

    this.host.freezeNative();
    void this.pauseNative();
  }

  /**
   * Reads a proposed target against the note and the Realm list.
   *
   * A branch target is resolved to its *true* root, so the draft's Thread is the
   * depth-1 entry a deep parent actually descends from, and the Realm is the one
   * that parent's recognized path belongs to.
   */
  private async resolveTarget(target: DraftTarget): Promise<ResolvedTarget | null> {
    if (target.kind === "root") {
      return {
        contextId: this.destination(target.contextId),
        parent: null,
        root: null,
        selected: null
      };
    }

    const source = await this.host.read(target.parent.path);
    if (source === null) {
      this.error = "That note could not be read; your draft kept its parent.";
      return null;
    }

    const index = parseEntries(source);
    const entry = resolveThought(index, target.parent);
    if (entry === null) {
      this.error = "That thought is no longer in its note; your draft kept its parent.";
      return null;
    }

    return {
      contextId: this.contextOf(target.parent.path),
      parent: target.parent,
      root: thoughtRefOf(index, rootEntryOf(index, entry), target.parent.path),
      selected: target.parent
    };
  }

  /**
   * Stores the draft, or reports that it could not be stored.
   *
   * `required` is the receipt's case: a submission whose record cannot be written
   * is refused before the note is touched, because an unexplained write is worse
   * than a refused one.
   */
  private persist(required = false): void {
    const record: CaptureRecord = {
      draft:
        this.phase === "editing"
          ? {
              contextId: this.contextId,
              parent: this.parent,
              root: this.root,
              text: this.text,
              selection: this.selection,
              beginning: this.beginning,
              durationMs: shownOf(this.clock, this.host.now()),
              collapsed: this.collapsed,
              invitations: this.invitations
            }
          : null,
      receipt: this.receipt
    };

    try {
      this.host.store.save(record);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (required) throw error;
      this.error = `The draft could not be stored (${reason}); it is kept in memory only.`;
    }
  }

  /** The pause of the note's clock, reported rather than repeated. */
  private async pauseNative(): Promise<void> {
    const stopped = await this.host.pauseNative();
    if (stopped) return;
    this.error = "The note's clock could not be stopped, so it was held where it was.";
    this.host.onChange();
  }

  /** A destination id that this vault actually has, `main` when it does not. */
  private destination(contextId: string): string {
    const contexts = this.host.contexts();
    return contexts.some((context) => context.id === contextId) ? contextId : MAIN_CONTEXT_ID;
  }

  /** The Realm a recognized day-note path belongs to, `main` when none does. */
  private contextOf(path: string): string {
    return contextDayForPath(path, this.host.contexts())?.contextId ?? MAIN_CONTEXT_ID;
  }

  /**
   * The reference itself, once the note still holds exactly what it described.
   *
   * The check is against the reference the caller holds, not against a reference
   * rebuilt from whatever now carries its `N`: rebuilding would resolve anything
   * and make every stale address look valid.
   */
  private async validated(
    target: ThoughtRef
  ): Promise<{ target: ThoughtRef; index: EntryIndex } | null> {
    const source = await this.host.read(target.path);
    if (source === null) return null;
    const index = parseEntries(source);
    return resolveThought(index, target) === null ? null : { target, index };
  }
}
