/**
 * The model-backed capture controller: the lower half as one tagged state, driven
 * by `reduceCapture`, persisted through the versioned store, and written through
 * the one write protocol.
 *
 * This replaces a phase string beside nine independent fields. Every transition is
 * a reducer call; the controller only installs the resulting model, persists it at
 * the durability it asks for, and carries out the one effect it names. A receipt
 * is persisted before the note is touched, an unknown outcome is reconciled by a
 * Check rather than guessed, and completion stages its durable handoffs before the
 * receipt is removed.
 *
 * Pure of DOM: the writer, store, editor and clock are injected.
 */

import {
  captureInstantAt,
  elapsedOf,
  resolveThought,
  rootEntryOf,
  shownOf,
  thoughtRefOf,
  type CaptureInstant,
  type CaptureInvitation,
  type CapturePhase,
  type CaptureReceipt,
  type CaptureRequest,
  type DraftTarget,
  type SavedThought,
  type ThoughtRef
} from "../core/capture";
import {
  captureHasWork,
  initialCaptureModel,
  reduceCapture,
  restoredOf,
  storedOf,
  type CaptureAction,
  type CaptureEffect,
  type CaptureEvent,
  type CaptureModel,
  type CapturePersistence,
  type CaptureState,
  type PendingWrite,
  type RestorableWork,
  type RevisionData,
  type WriteIntent,
  type WriteReceipt
} from "../core/capture-state";
import { contextDayForPath, MAIN_CONTEXT_ID, type WeavingContext } from "../core/contexts";
import { parseEntries, type Entry, type EntryIndex } from "../core/entries";
import type { CaptureEnvelopeV2 } from "./capture-store";
import type { LoomCaptureOwner } from "./loom";

/** The durable store the controller writes through. */
export interface CaptureStorePort {
  loadCapture(): CaptureEnvelopeV2 | null;
  saveCapture(next: CaptureEnvelopeV2, expectedRevision: number | null): CaptureEnvelopeV2;
}

/** What the controller needs from the world. */
export interface CaptureModelHost {
  now(): number;
  contexts(): readonly WeavingContext[];
  /** The one write protocol: a request becomes a note's bytes, or an outcome. */
  writeCapture(
    request: CaptureRequest,
    retry: { operationId: string; path: string; before: string } | null,
    beforeCommit: (receipt: CaptureReceipt) => void,
    invitations?: readonly CaptureInvitation[]
  ): Promise<
    | { kind: "confirmed"; receipt: CaptureReceipt }
    | { kind: "refused"; reason: string; message: string }
    | { kind: "unconfirmed"; receipt: CaptureReceipt; message: string }
  >;
  /** One correction's write, when the writer supports it. */
  writeRevision?(
    revision: RevisionData,
    beforeCommit: (receipt: WriteReceipt) => void
  ): Promise<
    | { kind: "confirmed"; receipt: WriteReceipt }
    | { kind: "refused"; reason: string; message: string }
    | { kind: "unconfirmed"; receipt: WriteReceipt; message: string }
  >;
  /** Persisted bytes of a note, or null. */
  read(path: string): Promise<string | null>;
  /** Asks an owning editor to save only if it holds `expected`, then verifies disk. */
  confirmPersisted(path: string, expected: string): Promise<boolean>;
  /** Opens one saved thought at its prose. */
  editInNote(target: ThoughtRef): Promise<boolean>;
  /** Freezes the note's clock synchronously. */
  freezeNative(): void;
  /** Stops the note's clock; false when that write failed. */
  pauseNative(): Promise<boolean>;
  /** The openings a root begun at `at` in `contextId` would be written through. */
  invitationsAt(contextId: string, at: number): readonly CaptureInvitation[];
  /** Spends one invitation through its own opening. */
  acknowledge(
    invitation: CaptureInvitation,
    saved: SavedThought,
    beginning: CaptureInstant | null
  ): "acknowledged" | "obsolete" | "retry";
  /** The durable capture store. */
  store: CaptureStorePort;
  /** Stages the durable, safe completion handoffs before the receipt is removed. */
  stageCompletion?(pending: PendingWrite): void;
  /** Something a surface draws has changed. */
  onChange?(): void;
}

/** The capture request a frozen capture intent describes. */
export function captureRequestOf(intent: Extract<WriteIntent, { kind: "capture" }>): CaptureRequest {
  const target = intent.draft.target;
  return {
    contextId: target.kind === "root" ? target.contextId : MAIN_CONTEXT_ID,
    parent: target.kind === "branch" ? target.parent : null,
    text: intent.draft.text,
    beginning: intent.draft.beginning ?? captureInstantAt(intent.published.at),
    durationMs: intent.draft.durationMs,
    portal: intent.portal
  };
}

/** A write receipt from the older capture receipt shape. */
function writeReceiptOf(receipt: CaptureReceipt): WriteReceipt {
  return {
    kind: "capture",
    id: receipt.id,
    path: receipt.path,
    before: receipt.before,
    expected: receipt.expected,
    saved: { thought: receipt.thought, root: receipt.root }
  };
}

/** The lower surface's view of the model, for the still-legacy renderer. */
export interface CaptureView {
  phase: CapturePhase | "retryable";
  collapsed: boolean;
  contextId: string;
  root: ThoughtRef | null;
  selected: ThoughtRef | null;
  parent: ThoughtRef | null;
  text: string;
  selection: { from: number; to: number };
  beginning: CaptureInstant | null;
  durationMs: number;
  invitations: CaptureInvitation[];
  pendingTarget: DraftTarget | null;
  error: string | null;
  recovered: boolean;
}

/** The controller: one model, one store revision, one effect at a time. */
export class CaptureModelController implements LoomCaptureOwner {
  private modelValue: CaptureModel = initialCaptureModel();
  private revision: number | null = null;
  private readonly listeners = new Set<(model: CaptureModel) => void>();
  private disposed = false;
  private identifiers = 0;
  private proposals = 0;
  private collapsed = false;
  private recovered = false;
  private selected: ThoughtRef | null = null;
  /** The serial effect chain, so a caller can await a submission's completion. */
  private effects: Promise<void> = Promise.resolve();

  constructor(private readonly host: CaptureModelHost) {}

  /** The projected lower model. */
  get model(): CaptureModel {
    return this.modelValue;
  }

  /** The legacy view of the model, derived so the current renderer still works. */
  get state(): CaptureView {
    const state = this.modelValue.state;
    const now = this.host.now();
    const error = this.modelValue.notice?.message ?? null;
    const base = { collapsed: this.collapsed, error, recovered: this.recovered };

    switch (state.kind) {
      case "empty":
        return {
          ...base,
          collapsed: false,
          recovered: false,
          error: null,
          phase: "closed",
          contextId: MAIN_CONTEXT_ID,
          root: null,
          selected: null,
          parent: null,
          text: "",
          selection: { from: 0, to: 0 },
          beginning: null,
          durationMs: 0,
          invitations: [],
          pendingTarget: null
        };
      case "draft":
      case "target-confirmation": {
        const draft = state.draft;
        return {
          ...base,
          phase: "editing",
          contextId: draft.target.kind === "root" ? draft.target.contextId : this.contextOf(draft.target.parent.path),
          root: null,
          selected: null,
          parent: draft.target.kind === "branch" ? draft.target.parent : null,
          text: draft.text,
          selection: draft.selection,
          beginning: draft.beginning,
          durationMs: shownOf(draft.clock, now),
          invitations: [...draft.invitations],
          pendingTarget: state.kind === "target-confirmation" ? state.proposed : null
        };
      }
      case "revision":
        return {
          ...base,
          phase: "editing",
          contextId: this.contextOf(state.revision.target.path),
          root: null,
          selected: null,
          parent: null,
          text: state.revision.text,
          selection: state.revision.selection,
          beginning: null,
          durationMs: 0,
          invitations: [],
          pendingTarget: null
        };
      case "resting":
        return {
          ...base,
          phase: "resting",
          contextId: this.contextOf(state.saved.root.path),
          root: state.saved.root,
          selected: this.selected ?? state.saved.thought,
          parent: null,
          text: "",
          selection: { from: 0, to: 0 },
          beginning: null,
          durationMs: 0,
          invitations: [],
          pendingTarget: null
        };
      case "preparing": {
        const draft = state.intent.kind === "capture" ? state.intent.draft : null;
        const revision = state.intent.kind === "revision" ? state.intent.revision : null;
        return {
          ...base,
          phase: "submitting",
          contextId: draft !== null && draft.target.kind === "root" ? draft.target.contextId : MAIN_CONTEXT_ID,
          root: null,
          selected: null,
          parent: draft !== null && draft.target.kind === "branch" ? draft.target.parent : null,
          text: draft?.text ?? revision?.text ?? "",
          selection: draft?.selection ?? revision?.selection ?? { from: 0, to: 0 },
          beginning: draft?.beginning ?? null,
          durationMs: draft?.durationMs ?? 0,
          invitations: draft !== null ? [...draft.invitations] : [],
          pendingTarget: null
        };
      }
      case "writing":
      case "unconfirmed":
      case "checking":
      case "retryable":
      case "finalizing": {
        const draft = state.pending.intent.kind === "capture" ? state.pending.intent.draft : null;
        const revision = state.pending.intent.kind === "revision" ? state.pending.intent.revision : null;
        return {
          ...base,
          phase: state.kind === "writing" || state.kind === "finalizing" ? "submitting"
            : state.kind === "retryable" ? "retryable" : "uncertain",
          contextId: draft !== null && draft.target.kind === "root" ? draft.target.contextId : MAIN_CONTEXT_ID,
          root: null,
          selected: null,
          parent: draft !== null && draft.target.kind === "branch" ? draft.target.parent : null,
          text: draft?.text ?? revision?.text ?? "",
          selection: draft?.selection ?? revision?.selection ?? { from: 0, to: 0 },
          beginning: draft?.beginning ?? null,
          durationMs: draft?.durationMs ?? 0,
          invitations: draft !== null ? [...draft.invitations] : [],
          pendingTarget: null
        };
      }
    }
  }

  /** True while a submission is in flight. */
  get submitting(): boolean {
    const kind = this.modelValue.state.kind;
    return kind === "preparing" || kind === "writing" || kind === "finalizing";
  }

  /** True when there is prose or a chosen branch worth resuming. */
  get hasWork(): boolean {
    return captureHasWork(this.modelValue);
  }

  /** The raw milliseconds a draft has accrued, or 0. */
  elapsed(): number {
    const state = this.modelValue.state;
    if (state.kind === "draft" || state.kind === "target-confirmation") {
      return elapsedOf(state.draft.clock, this.host.now());
    }
    return 0;
  }

  /** Subscribes to changes of the lower model. */
  subscribe(listener: (model: CaptureModel) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Loads the durable capture, restoring paused work and one pending check. */
  start(): void {
    if (this.disposed) return;
    let loaded: CaptureEnvelopeV2 | null;
    try {
      loaded = this.host.store.loadCapture();
    } catch {
      this.modelValue = {
        ...this.modelValue,
        durability: "blocked",
        notice: { code: "storage-failed", message: "The stored draft could not be read, so it was left alone." }
      };
      this.notify();
      return;
    }
    if (loaded === null) return;

    this.revision = loaded.revision;
    this.modelValue = {
      ...this.modelValue,
      state: restoredOf(loaded.state),
      durability: "ready",
      acknowledgements: loaded.acknowledgements
    };
    // Unfinished work comes back folded and paused; a pending write shows itself
    // so the writer can reconcile it.
    this.collapsed = loaded.state.kind === "draft";
    this.recovered = loaded.state.kind === "draft";
    if (loaded.state.kind === "pending") this.apply({ kind: "check" });
    this.notify();
  }

  /** One command from a surface. Result events are never accepted here. */
  dispatch(action: CaptureAction): void {
    this.apply(action);
  }

  /** One reducer event, from a surface command or from the host's own result. */
  private apply(event: CaptureEvent): void {
    if (this.disposed) return;
    const transition = reduceCapture(this.modelValue, event);
    if (!this.install(transition.model, transition.persistence)) return;
    const effect = transition.effect;
    if (effect !== null) {
      this.effects = this.effects.then(
        () => this.runEffect(effect),
        () => this.runEffect(effect)
      );
    }
  }

  /** The proposal identity a new confirmation would carry. */
  nextProposalId(): number {
    this.proposals += 1;
    return this.proposals;
  }

  /** A fresh identity for one capture or correction. */
  nextId(): string {
    this.identifiers += 1;
    return `capture-${this.host.now().toString(36)}-${this.identifiers}`;
  }

  /** Stops the controller; late effects may persist only while their revision holds. */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  /** Installs a model, persisting it first when the transition requires it. */
  private install(model: CaptureModel, persistence: CapturePersistence): boolean {
    if (persistence !== "none") {
      try {
        this.persist(model);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (persistence === "required") {
          this.modelValue = {
            ...model,
            durability: "blocked",
            notice: { code: "storage-failed", message }
          };
          this.notify();
          return false;
        }
        this.modelValue = {
          ...model,
          durability: "blocked",
          notice: { code: "storage-failed", message }
        };
        this.notify();
        return true;
      }
    }
    this.modelValue = model;
    this.notify();
    return true;
  }

  /** Writes the model's durable state at the next revision. */
  private persist(model: CaptureModel): void {
    this.persistState(model.state, model.acknowledgements);
  }

  /** Writes one state and its queued acknowledgements at the next revision. */
  private persistState(state: CaptureState, acknowledgements: readonly CaptureInvitation[]): void {
    const envelope: CaptureEnvelopeV2 = {
      version: 2,
      revision: this.revision ?? 0,
      state: storedOf(state),
      acknowledgements
    };
    const saved = this.host.store.saveCapture(envelope, this.revision);
    this.revision = saved.revision;
  }

  /** Runs the one command a transition named. */
  private async runEffect(effect: CaptureEffect): Promise<void> {
    if (effect.kind === "write") await this.runWrite(effect.intent);
    else if (effect.kind === "check") await this.runCheck(effect.pending);
    else await this.runFinalize(effect.pending, effect.next);
  }

  /** The retry guard the model's preparing state carries, if any. */
  private retryGuard(): { operationId: string; path: string; before: string } | null {
    const state = this.modelValue.state;
    if (state.kind !== "preparing" || state.retryOf === null) return null;
    return {
      operationId: state.retryOf.intent.id,
      path: state.retryOf.receipt.path,
      before: state.retryOf.receipt.before
    };
  }

  /** Runs one write through the protocol and reports its outcome as reducer events. */
  private async runWrite(intent: WriteIntent): Promise<void> {
    const retry = this.retryGuard();
    try {
      if (intent.kind === "capture") {
        const outcome = await this.host.writeCapture(
          captureRequestOf(intent),
          retry,
          (receipt) =>
            this.apply({ kind: "receipt-prepared", intentId: intent.id, receipt: writeReceiptOf(receipt) }),
          intent.draft.invitations
        );
        if (this.disposed) return;
        if (outcome.kind === "confirmed") this.apply({ kind: "write-confirmed", intentId: intent.id });
        else if (outcome.kind === "refused")
          this.apply({
            kind: "write-refused",
            intentId: intent.id,
            reason: intentReason(outcome.reason),
            message: outcome.message
          });
        else this.apply({ kind: "write-unconfirmed", intentId: intent.id, message: outcome.message });
        return;
      }

      if (this.host.writeRevision === undefined) {
        this.apply({
          kind: "write-refused",
          intentId: intent.id,
          reason: "invalid",
          message: "Editing an original is not available on this build."
        });
        return;
      }
      const outcome = await this.host.writeRevision(intent.revision, (receipt) =>
        this.apply({ kind: "receipt-prepared", intentId: intent.id, receipt })
      );
      if (this.disposed) return;
      if (outcome.kind === "confirmed") this.apply({ kind: "write-confirmed", intentId: intent.id });
      else if (outcome.kind === "refused")
        this.apply({
          kind: "write-refused",
          intentId: intent.id,
          reason: intentReason(outcome.reason),
          message: outcome.message
        });
      else this.apply({ kind: "write-unconfirmed", intentId: intent.id, message: outcome.message });
    } catch (error) {
      this.apply({
        kind: "write-unconfirmed",
        intentId: intent.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** Reconciles an uncertain write: disk, the live editor, then a definite answer. */
  private async runCheck(pending: PendingWrite): Promise<void> {
    const receipt = pending.receipt;
    let source: string | null;
    try {
      source = await this.host.read(receipt.path);
    } catch {
      source = null;
    }
    if (source === null) {
      this.apply({ kind: "check-failed", intentId: pending.intent.id, message: "The note could not be read; the save is still unconfirmed." });
      return;
    }
    if (source === receipt.expected) {
      this.apply({ kind: "check-confirmed", intentId: pending.intent.id });
      return;
    }
    let confirmed = false;
    try {
      confirmed = await this.host.confirmPersisted(receipt.path, receipt.expected);
    } catch {
      confirmed = false;
    }
    if (confirmed) {
      const again = await this.host.read(receipt.path);
      if (again === receipt.expected) {
        this.apply({ kind: "check-confirmed", intentId: pending.intent.id });
        return;
      }
    }
    if (source === receipt.before) {
      this.apply({ kind: "check-absent", intentId: pending.intent.id, message: "That save did not reach the note." });
      return;
    }
    this.apply({ kind: "check-diverged", intentId: pending.intent.id, message: "The note changed in a way this save cannot explain." });
  }

  /** Stores the next state, stages its handoffs, then removes the receipt. */
  private async runFinalize(pending: PendingWrite, next: RestorableWork): Promise<void> {
    try {
      this.host.stageCompletion?.(pending);
    } catch {
      // A staging failure does not block the note write; it is retried locally.
    }
    const nextState: CaptureState =
      next.kind === "resting"
        ? { kind: "resting", saved: next.saved }
        : next.kind === "draft"
          ? { kind: "draft", draft: { ...next.draft, clock: { baselineMs: next.draft.durationMs, resumedAt: null, shownMs: next.draft.durationMs } } }
          : { kind: "empty" };
    try {
      // Store the next state (receipt removed) while the model is still
      // finalizing, so the completion event transitions it rather than being
      // ignored because the state already moved.
      this.persistState(nextState, this.modelValue.acknowledgements);
    } catch (error) {
      this.apply({ kind: "storage-failed", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.apply({ kind: "completion-stored", intentId: pending.intent.id });
    this.drainAcknowledgements(pending);
  }

  /** Spends acknowledged invitations once completion is durable. */
  private drainAcknowledgements(pending: PendingWrite): void {
    const saved =
      pending.kind === "capture"
        ? pending.receipt.saved
        : { thought: pending.receipt.thought, root: pending.receipt.thought };
    const beginning = pending.intent.kind === "capture" ? pending.intent.draft.beginning : null;
    for (const invitation of [...this.modelValue.acknowledgements]) {
      let status: "acknowledged" | "obsolete" | "retry";
      try {
        status = this.host.acknowledge(invitation, saved, beginning);
      } catch {
        status = "retry";
      }
      if (status === "acknowledged" || status === "obsolete") {
        this.apply({
          kind: "acknowledged",
          occurrenceId: invitation.occurrenceId,
          generation: invitation.generation
        });
      }
    }
  }

  /**
   * Opens the composer, or resumes the draft that is already open.
   *
   * `move` is the caller naming a Realm rather than merely opening the surface:
   * an invitation, for instance, is a request to write *there*. A draft with
   * words keeps its destination until the writer agrees, so the request becomes a
   * proposal instead of a silent move; an unnamed open never retargets anything.
   */
  open(contextId: string, options: { move?: boolean } = {}): void {
    const state = this.modelValue.state;
    if (isPending(state) || state.kind === "preparing") {
      this.setNotice("A draft is already open; finish that submission first.");
      return;
    }
    if (state.kind === "draft" || state.kind === "target-confirmation") {
      this.collapsed = false;
      this.recovered = false;
      this.setNotice(null);
      const requested = this.destination(contextId);
      const target = state.draft.target;
      const current = target.kind === "root" ? target.contextId : this.contextOf(target.parent.path);
      if (options.move === true && requested !== current) {
        void this.requestTarget({ kind: "root", contextId: requested });
      }
      return;
    }
    this.dispatch({ kind: "new-root", contextId: this.destination(contextId) });
    this.collapsed = false;
    this.recovered = false;
    this.host.freezeNative();
    void this.host.pauseNative();
  }

  /** Restores the durable capture, as a reload would. */
  recover(): void {
    this.start();
  }

  /** Records what the writer typed. */
  setText(text: string, selection: { from: number; to: number } = { from: text.length, to: text.length }): void {
    const state = this.modelValue.state;
    if (state.kind !== "draft" && state.kind !== "target-confirmation") return;
    const at = this.host.now();
    const invitations =
      state.draft.target.kind === "root" ? this.host.invitationsAt(state.draft.target.contextId, at) : [];
    this.dispatch({ kind: "input", text, selection, at, invitations: [...invitations] });
  }

  /** Records where the caret is without touching the clock. */
  setSelection(selection: { from: number; to: number }): void {
    const state = this.modelValue.state;
    if (state.kind === "draft" || state.kind === "target-confirmation") {
      this.dispatch({ kind: "select-text", selection });
    }
  }

  /** Records what a clock painted. */
  commitDuration(ms: number): void {
    const state = this.modelValue.state;
    if (state.kind === "draft" || state.kind === "target-confirmation") this.dispatch({ kind: "painted", ms });
  }

  /** Pauses the draft's clock. */
  pause(): void {
    const state = this.modelValue.state;
    if ((state.kind === "draft" || state.kind === "target-confirmation") && state.draft.clock.resumedAt !== null) {
      this.dispatch({ kind: "pause" });
    }
  }

  /** Saves once, or retries only after a check proved the previous write absent. */
  async settle(): Promise<void> {
    const state = this.modelValue.state;
    if (state.kind === "retryable") {
      this.dispatch({ kind: "retry", id: this.nextId(), published: captureInstantAt(this.host.now()) });
      await this.settled();
      return;
    }
    if (state.kind === "draft" || state.kind === "revision") {
      const text = state.kind === "draft" ? state.draft.text : state.revision.text;
      if (text.trim() === "") {
        this.setNotice("There is nothing to save yet.");
        return;
      }
      this.dispatch({ kind: "submit", id: this.nextId(), published: captureInstantAt(this.host.now()) });
      await this.settled();
    }
  }

  /** Checks an unconfirmed write, resolving once the check's effect settles. */
  async checkSave(): Promise<void> {
    this.dispatch({ kind: "check" });
    await this.settled();
  }

  /** Waits until no further effect is queued or running. */
  private async settled(): Promise<void> {
    let current = this.effects;
    await current;
    while (current !== this.effects) {
      current = this.effects;
      await current;
    }
  }

  /** Hides the surface, keeping the draft. */
  collapse(): void {
    this.pause();
    this.collapsed = true;
    this.setNotice(null);
    this.notify();
  }

  /** Shows the surface again. */
  expand(): void {
    this.collapsed = false;
    this.recovered = false;
    this.setNotice(null);
    this.notify();
  }

  /** Closes the surface; editable work is hidden rather than discarded. */
  dismiss(): void {
    const state = this.modelValue.state;
    if (isPending(state)) return;
    if (
      (state.kind === "draft" && (state.draft.text.trim() !== "" || state.draft.target.kind === "branch")) ||
      state.kind === "target-confirmation"
    ) {
      this.collapse();
      return;
    }
    this.reset();
  }

  /** Gives up the unsaved prose, after the surface has confirmed it. */
  discardDraft(): void {
    const state = this.modelValue.state;
    if (state.kind === "draft" || state.kind === "revision") this.dispatch({ kind: "discard" });
  }

  /** Starts a fresh root in the current destination. */
  async newThread(): Promise<boolean> {
    const state = this.modelValue.state;
    const contextId =
      state.kind === "draft" && state.draft.target.kind === "root" ? state.draft.target.contextId : MAIN_CONTEXT_ID;
    this.dispatch({ kind: "new-root", contextId });
    return true;
  }

  /** Applies the proposed move. */
  confirmTarget(): void {
    const state = this.modelValue.state;
    if (state.kind === "target-confirmation") this.dispatch({ kind: "confirm-target", proposalId: state.proposalId });
  }

  /** Keeps the original target. */
  cancelTarget(): void {
    this.dispatch({ kind: "cancel-target" });
  }

  /** The one submission's receipt, while an answer about it is unknown. */
  pendingReceipt(): CaptureReceipt | null {
    const state = this.modelValue.state;
    if (!isPending(state)) return null;
    const pending = state.pending;
    if (pending.kind !== "capture") return null;
    return {
      id: pending.receipt.id,
      request: captureRequestOf(pending.intent),
      invitations: [...pending.intent.draft.invitations],
      path: pending.receipt.path,
      thought: pending.receipt.saved.thought,
      root: pending.receipt.saved.root,
      before: pending.receipt.before,
      expected: pending.receipt.expected
    };
  }

  /** Starts a branch under a thought, protecting any draft with words. */
  async branch(parent: ThoughtRef): Promise<boolean> {
    const state = this.modelValue.state;
    if (isPending(state) || state.kind === "preparing") return false;
    if (!(await this.validate(parent))) {
      this.setNotice("That thought is no longer in its note; your draft kept its parent.");
      return false;
    }
    if (state.kind === "draft" && state.draft.text.trim() !== "") {
      this.dispatch({ kind: "pause" });
      this.dispatch({
        kind: "retarget",
        target: { kind: "branch", parent },
        confirm: true,
        proposalId: this.nextProposalId()
      });
      return true;
    }
    this.dispatch({ kind: "retarget", target: { kind: "branch", parent }, confirm: false, proposalId: 0 });
    return true;
  }

  /** Selects one saved thought to branch from or read. */
  async selectThought(target: ThoughtRef): Promise<boolean> {
    if (!(await this.validate(target))) {
      this.selected = null;
      this.setNotice("That thought changed; choose it again.");
      return false;
    }
    this.selected = target;
    this.notify();
    return true;
  }

  /** Opens one saved thought in its own note. */
  async editInNote(target: ThoughtRef): Promise<boolean> {
    if (!(await this.validate(target))) {
      this.setNotice("That thought is no longer in its note; nothing was opened.");
      return false;
    }
    return this.host.editInNote(target);
  }

  /** Opens a saved Thread as the resting result. */
  async resumeThread(target: ThoughtRef): Promise<boolean> {
    const state = this.modelValue.state;
    if (isPending(state) || state.kind === "preparing") return false;
    if (state.kind === "draft" && state.draft.text.trim() !== "") return false;

    const loaded = await this.loadEntry(target);
    if (loaded === null) {
      this.setNotice("That thought is no longer in its note; open the note to see what changed.");
      return false;
    }
    const root = thoughtRefOf(loaded.index, rootEntryOf(loaded.index, loaded.entry), target.path);
    this.modelValue = {
      ...this.modelValue,
      state: { kind: "resting", saved: { thought: target, root } },
      notice: null
    };
    this.selected = null;
    this.collapsed = false;
    this.recovered = false;
    try {
      this.persist(this.modelValue);
    } catch {
      // The reading is still shown; the next write reports the store.
    }
    this.notify();
    return true;
  }

  /** Proposes moving the draft: a new root elsewhere, or under another parent. */
  async requestTarget(target: DraftTarget): Promise<boolean> {
    const state = this.modelValue.state;
    if (isPending(state) || state.kind === "preparing" || state.kind === "revision" || state.kind === "empty") {
      return false;
    }
    if (target.kind === "branch" && !(await this.validate(target.parent))) {
      this.setNotice("That thought is no longer in its note; your draft kept its parent.");
      return false;
    }
    const hasWords =
      (state.kind === "draft" || state.kind === "target-confirmation") &&
      state.draft.text.trim() !== "";
    if (state.kind === "resting" || !hasWords) {
      this.dispatch({ kind: "retarget", target, confirm: false, proposalId: 0 });
      return true;
    }
    this.dispatch({ kind: "pause" });
    this.dispatch({ kind: "retarget", target, confirm: true, proposalId: this.nextProposalId() });
    return true;
  }

  /** Changes the destination of an unsaved root. */
  async setDestination(contextId: string): Promise<boolean> {
    return this.requestTarget({ kind: "root", contextId: this.destination(contextId) });
  }

  /** Leaves an empty branch without writing anything. */
  backToSavedThought(): void {
    const state = this.modelValue.state;
    if (state.kind !== "draft" || state.draft.target.kind !== "branch" || state.draft.text.trim() !== "") return;
    this.dispatch({ kind: "discard" });
  }

  /** One note's parsed entry for a reference, or null when it no longer resolves. */
  private async loadEntry(target: ThoughtRef): Promise<{ index: EntryIndex; entry: Entry } | null> {
    const source = await this.host.read(target.path);
    if (source === null) return null;
    const index = parseEntries(source);
    const entry = resolveThought(index, target);
    return entry === null ? null : { index, entry };
  }

  /** True when the reference still truthfully names an entry. */
  private async validate(target: ThoughtRef): Promise<boolean> {
    return (await this.loadEntry(target)) !== null;
  }

  private reset(): void {
    try {
      this.persistState({ kind: "empty" }, this.modelValue.acknowledgements);
    } catch {
      // A draft that cannot be cleared stays; it is safer than claiming it is gone.
    }
    this.modelValue = { ...this.modelValue, state: { kind: "empty" }, notice: null };
    this.collapsed = false;
    this.recovered = false;
    this.notify();
  }

  private setNotice(message: string | null): void {
    this.modelValue = {
      ...this.modelValue,
      notice: message === null ? null : { code: "notice", message }
    };
    this.notify();
  }

  private contextOf(path: string): string {
    return contextDayForPath(path, this.host.contexts())?.contextId ?? MAIN_CONTEXT_ID;
  }

  private destination(contextId: string): string {
    return this.host.contexts().some((context) => context.id === contextId) ? contextId : MAIN_CONTEXT_ID;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener(this.modelValue);
    this.host.onChange?.();
  }
}

/** Maps a writer's refusal reason onto the reducer's reason union. */
function intentReason(reason: string): "invalid" | "retry-source-changed" | "receipt-storage" | "native-stop" {
  if (reason === "retry-source-changed") return "retry-source-changed";
  if (reason === "receipt-storage") return "receipt-storage";
  if (reason === "native-stop") return "native-stop";
  return "invalid";
}

/** True for a capture state that holds an unresolved write receipt. */
function isPending(
  state: CaptureState
): state is Extract<CaptureState, { kind: "writing" | "unconfirmed" | "checking" | "retryable" | "finalizing" }> {
  return (
    state.kind === "writing" ||
    state.kind === "unconfirmed" ||
    state.kind === "checking" ||
    state.kind === "retryable" ||
    state.kind === "finalizing"
  );
}
