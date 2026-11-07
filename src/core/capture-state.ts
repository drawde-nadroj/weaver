/**
 * The lower half of the Loom as one tagged state: the draft, the correction, and
 * the one write each of them may be making.
 *
 * `src/entries/capture.ts` used to hold a phase string beside nine independent
 * fields — `phase`, `collapsed`, nullable `root`/`selected`/`parent`, text,
 * `pendingTarget`, `receipt`, `recovered`, `dismissAfterSuccess`. A phase string
 * does not constrain those fields, so recovery, completion and hiding could each
 * build a different subset of them. This module replaces that bag with a tagged
 * union: there is no state in which "editable work" and "an unresolved write"
 * are both true, no revision inside a revision, and no second place a draft's
 * target can live.
 *
 * Everything here is pure. It samples nothing, generates nothing and touches no
 * store or surface: time, identities and IO results arrive as payloads, one
 * write/check/finalize command leaves through {@link CaptureTransition.effect},
 * and the model is projected by a renderer that must not reason about it.
 */

import {
  captureInstantAt,
  commitShown,
  idleClock,
  pauseClock,
  resumeClock,
  wholeSeconds,
  type CaptureInstant,
  type CaptureInvitation,
  type DraftClock,
  type DraftTarget,
  type SavedThought,
  type ThoughtRef
} from "./capture";
import type { PortalInstant } from "./portals";
import type { ThoughtSnapshot } from "./reference";

/** A text range, in UTF-16 units, as a textarea or a DOM selection reports it. */
export interface TextSelection {
  readonly from: number;
  readonly to: number;
}

/**
 * What a draft holds once it is frozen for writing: its target, its authored
 * text, where the caret was, the beginning its first input froze, the whole
 * milliseconds already counted and the openings that input qualified for.
 */
export interface DraftData {
  readonly id: string;
  readonly target: DraftTarget;
  readonly text: string;
  readonly selection: TextSelection;
  readonly beginning: CaptureInstant | null;
  readonly durationMs: number;
  readonly invitations: readonly CaptureInvitation[];
}

/**
 * A draft while it is still being written: the same data, but with its running
 * clock instead of a frozen duration. The duration a save records is projected
 * from `clock.shownMs`, the last second a surface painted, never a fresh sample.
 */
export type DraftWork = Omit<DraftData, "durationMs"> & {
  readonly clock: DraftClock;
};

/**
 * Work a correction can return to: nothing, a protected draft, or a saved
 * result. A revision is never a member, which is what makes "no revision inside a
 * revision" true by construction rather than by a check.
 */
export type RestorableWork =
  | { readonly kind: "empty" }
  | { readonly kind: "draft"; readonly draft: DraftData }
  | { readonly kind: "resting"; readonly saved: SavedThought };

/** One correction of an original thought, and the work it borrowed the composer from. */
export interface RevisionData {
  readonly id: string;
  readonly target: ThoughtRef;
  readonly originalBlock: string;
  readonly originalText: string;
  readonly text: string;
  readonly selection: TextSelection;
  readonly returnTo: RestorableWork;
}

/** One frozen write: what it will become, before the note is touched. */
export type WriteIntent =
  | {
      readonly kind: "capture";
      readonly id: string;
      readonly draft: DraftData;
      readonly published: CaptureInstant;
      readonly portal: PortalInstant | null;
    }
  | {
      readonly kind: "revision";
      readonly id: string;
      readonly revision: RevisionData;
    };

/** The exact before/after identities every receipt carries. */
export interface ReceiptBase {
  readonly id: string;
  readonly path: string;
  readonly before: string;
  readonly expected: string;
}

/** The receipt of one write, held until its persistence is confirmed and cleared. */
export type WriteReceipt =
  | (ReceiptBase & { readonly kind: "capture"; readonly saved: SavedThought })
  | (ReceiptBase & { readonly kind: "revision"; readonly thought: ThoughtRef });

/**
 * One write whose outcome is not yet durably settled: its frozen intent and the
 * matching receipt. The receipt is evidence a later session can reconcile; it is
 * not authority to write again.
 */
export type PendingWrite =
  | {
      readonly kind: "capture";
      readonly intent: Extract<WriteIntent, { kind: "capture" }>;
      readonly receipt: Extract<WriteReceipt, { kind: "capture" }>;
    }
  | {
      readonly kind: "revision";
      readonly intent: Extract<WriteIntent, { kind: "revision" }>;
      readonly receipt: Extract<WriteReceipt, { kind: "revision" }>;
    };

/**
 * Every legal shape of the lower half.
 *
 * The pending family (`writing`, `unconfirmed`, `checking`, `retryable`) all hold
 * a {@link PendingWrite} and no editable copy of the same text; `finalizing` holds
 * the receipt and the work that becomes current once storage agrees.
 */
export type CaptureState =
  | { readonly kind: "empty" }
  | { readonly kind: "draft"; readonly draft: DraftWork }
  | {
      readonly kind: "target-confirmation";
      readonly draft: DraftWork;
      readonly proposalId: number;
      readonly proposed: DraftTarget;
    }
  | { readonly kind: "revision"; readonly revision: RevisionData }
  | { readonly kind: "resting"; readonly saved: SavedThought }
  | {
      readonly kind: "preparing";
      readonly intent: WriteIntent;
      readonly retryOf: PendingWrite | null;
    }
  | {
      readonly kind: "writing" | "unconfirmed" | "checking" | "retryable";
      readonly pending: PendingWrite;
    }
  | {
      readonly kind: "finalizing";
      readonly pending: PendingWrite;
      readonly next: RestorableWork;
    };

/** One diagnostic a surface may show, with a code it can branch on. */
export interface CaptureNotice {
  readonly code: string;
  readonly message: string;
}

/** The whole projected lower model: its state, and the orthogonal facts beside it. */
export interface CaptureModel {
  readonly state: CaptureState;
  /**
   * Whether the durable store is usable. A blocked store keeps in-memory input
   * readable and copyable but forbids a new note write and any destructive
   * handoff, because neither could be recorded.
   */
  readonly durability: "ready" | "blocked";
  readonly notice: CaptureNotice | null;
  /** Qualified invitations still owed an acknowledgement, drained after completion. */
  readonly acknowledgements: readonly CaptureInvitation[];
}

/** One command the runner must carry out after a transition is installed. */
export type CaptureEffect =
  | { readonly kind: "write"; readonly intent: WriteIntent }
  | { readonly kind: "check"; readonly pending: PendingWrite }
  | {
      readonly kind: "finalize";
      readonly pending: PendingWrite;
      readonly next: RestorableWork;
    };

/** How a transition's model must be persisted: not at all, opportunistically, or or not at all. */
export type CapturePersistence = "none" | "best-effort" | "required";

/** What a reducer call produced: the model, how to store it, and the effect to run. */
export interface CaptureTransition {
  readonly model: CaptureModel;
  readonly persistence: CapturePersistence;
  readonly effect: CaptureEffect | null;
}

/**
 * A command a surface may dispatch. None of these may claim a write succeeded:
 * results arrive only through {@link CaptureResultEvent}, which the host raises.
 */
export type CaptureAction =
  | { readonly kind: "ensure-draft"; readonly id: string; readonly target: DraftTarget }
  | {
      readonly kind: "input";
      readonly text: string;
      readonly selection: TextSelection;
      readonly at: number;
      readonly invitations?: readonly CaptureInvitation[];
    }
  | { readonly kind: "select-text"; readonly selection: TextSelection }
  | { readonly kind: "pause" }
  | { readonly kind: "painted"; readonly ms: number }
  | { readonly kind: "new-root"; readonly contextId: string }
  | { readonly kind: "retarget"; readonly target: DraftTarget; readonly confirm: boolean; readonly proposalId: number }
  | { readonly kind: "confirm-target"; readonly proposalId: number }
  | { readonly kind: "cancel-target" }
  | { readonly kind: "begin-revision"; readonly snapshot: ThoughtSnapshot; readonly id: string }
  | { readonly kind: "cancel-revision" }
  | { readonly kind: "submit"; readonly id: string; readonly published: CaptureInstant }
  | { readonly kind: "check" }
  | { readonly kind: "retry"; readonly id: string; readonly published: CaptureInstant }
  | { readonly kind: "discard" }
  | { readonly kind: "retry-local-save" };

/**
 * A result the host observed. These are not accepted from a renderer: they carry
 * the owning intent's identity so a late or foreign answer is ignored rather than
 * retargeted onto whatever work happens to be visible now.
 */
export type CaptureResultEvent =
  | { readonly kind: "receipt-prepared"; readonly intentId: string; readonly receipt: WriteReceipt }
  | {
      readonly kind: "write-refused";
      readonly intentId: string;
      readonly reason: "invalid" | "retry-source-changed" | "receipt-storage" | "native-stop";
      readonly message: string;
    }
  | {
      readonly kind: "write-unconfirmed";
      readonly intentId: string;
      readonly message: string;
    }
  | { readonly kind: "write-confirmed"; readonly intentId: string }
  | { readonly kind: "check-confirmed"; readonly intentId: string }
  | { readonly kind: "check-absent"; readonly intentId: string; readonly message: string }
  | { readonly kind: "check-diverged"; readonly intentId: string; readonly message: string }
  | { readonly kind: "check-failed"; readonly intentId: string; readonly message: string }
  | { readonly kind: "completion-stored"; readonly intentId: string }
  | { readonly kind: "storage-failed"; readonly message: string }
  | {
      readonly kind: "acknowledged";
      readonly occurrenceId: string;
      readonly generation: number;
    }
  | {
      readonly kind: "recovered";
      readonly state: CaptureState;
      readonly durability: "ready" | "blocked";
      readonly notice: CaptureNotice | null;
      readonly acknowledgements: readonly CaptureInvitation[];
    };

/** Everything the reducer accepts, from a surface or from the host. */
export type CaptureEvent = CaptureAction | CaptureResultEvent;

/** The projected lower model before anything has happened. */
export function initialCaptureModel(): CaptureModel {
  return { state: { kind: "empty" }, durability: "ready", notice: null, acknowledgements: [] };
}

/** Freeze running work into the duration a save records: its last painted second. */
export function draftProjection(work: DraftWork): DraftData {
  return {
    id: work.id,
    target: work.target,
    text: work.text,
    selection: work.selection,
    beginning: work.beginning,
    durationMs: wholeSeconds(work.clock.shownMs),
    invitations: work.invitations
  };
}

/** True when the model holds editable work whose text is worth resuming. */
export function captureHasWork(model: CaptureModel): boolean {
  const state = model.state;
  if (state.kind === "draft") return state.draft.text.trim() !== "";
  if (state.kind === "target-confirmation") return state.draft.text.trim() !== "";
  if (state.kind === "revision") return true;
  return false;
}

/** The model with one field changed, so transitions read as single edits. */
function withModel(model: CaptureModel, patch: Partial<CaptureModel>): CaptureModel {
  return { ...model, ...patch };
}

/** A transition that only changes the model. */
function settle(
  model: CaptureModel,
  persistence: CapturePersistence = "none",
  effect: CaptureEffect | null = null
): CaptureTransition {
  return { model, persistence, effect };
}

/** The draft work a restorable draft describes, paused at its stored duration. */
function workOf(data: DraftData): DraftWork {
  return {
    id: data.id,
    target: data.target,
    text: data.text,
    selection: data.selection,
    beginning: data.beginning,
    invitations: data.invitations,
    clock: { baselineMs: wholeSeconds(data.durationMs), resumedAt: null, shownMs: wholeSeconds(data.durationMs) }
  };
}

/** The restorable value a state holds, for beginning or cancelling a correction. */
function restorableOf(state: CaptureState): RestorableWork | null {
  switch (state.kind) {
    case "empty":
      return { kind: "empty" };
    case "draft":
      return { kind: "draft", draft: draftProjection(state.draft) };
    case "resting":
      return { kind: "resting", saved: state.saved };
    case "revision":
      return state.revision.returnTo;
    default:
      return null;
  }
}

/** The editable state a written intent would return to on a refusal. */
function editableOf(intent: WriteIntent): CaptureState {
  if (intent.kind === "capture") return { kind: "draft", draft: workOf(intent.draft) };
  return { kind: "revision", revision: intent.revision };
}

/** The outcome state a confirmed write finalizes into. */
function restingOf(pending: PendingWrite): RestorableWork {
  if (pending.kind === "capture") return { kind: "resting", saved: pending.receipt.saved };
  return pending.intent.revision.returnTo;
}

/** Whether the intent an event names is the one this model is currently writing. */
function ownsPending(state: CaptureState, intentId: string): boolean {
  if (state.kind === "writing" || state.kind === "unconfirmed" || state.kind === "checking") {
    return state.pending.intent.id === intentId;
  }
  if (state.kind === "retryable") return state.pending.intent.id === intentId;
  if (state.kind === "finalizing") return state.pending.intent.id === intentId;
  return false;
}

/**
 * One pure transition.
 *
 * Exhaustive over {@link CaptureEvent}: every action and every result is handled
 * by name, so a new one cannot be forgotten quietly. IO, time, identities and DOM
 * work stay outside; a payload carries each sampled value it needs.
 */
export function reduceCapture(model: CaptureModel, event: CaptureEvent): CaptureTransition {
  switch (event.kind) {
    case "ensure-draft":
      return ensureDraft(model, event);

    case "input":
      return typeInput(model, event);

    case "select-text":
      return selectText(model, event.selection);

    case "pause":
      return pause(model);

    case "painted":
      return paint(model, event.ms);

    case "new-root":
      return newRoot(model, event.contextId);

    case "retarget":
      return retarget(model, event.target, event.confirm, event.proposalId);

    case "confirm-target":
      return confirmTarget(model, event.proposalId);

    case "cancel-target":
      return model.state.kind === "target-confirmation"
        ? settle(withModel(model, { state: { kind: "draft", draft: model.state.draft } }), "best-effort")
        : settle(model);

    case "begin-revision":
      return beginRevision(model, event.snapshot, event.id);

    case "cancel-revision":
      return model.state.kind === "revision"
        ? settle(withModel(model, { state: stateOfRestorable(model.state.revision.returnTo) }), "best-effort")
        : settle(model);

    case "submit":
      return submit(model, event.id, event.published);

    case "check":
      return check(model);

    case "retry":
      return retry(model, event.id, event.published);

    case "discard":
      return discard(model);

    case "retry-local-save":
      return retryLocalSave(model);

    case "receipt-prepared":
      return receiptPrepared(model, event.intentId, event.receipt);

    case "write-refused":
      return writeRefused(model, event);

    case "write-unconfirmed":
      return writeUnconfirmed(model, event.intentId, event.message);

    case "write-confirmed":
      return confirmed(model, event.intentId, "writing");

    case "check-confirmed":
      return confirmed(model, event.intentId, "checking");

    case "check-absent":
      return checkAbsent(model, event.intentId, event.message);

    case "check-diverged":
      return stillUnconfirmed(model, event.intentId, event.message);

    case "check-failed":
      return stillUnconfirmed(model, event.intentId, event.message);

    case "completion-stored":
      return completionStored(model, event.intentId);

    case "storage-failed":
      return settle(
        withModel(model, {
          durability: "blocked",
          notice: { code: "storage-failed", message: event.message }
        })
      );

    case "acknowledged":
      return acknowledged(model, event.occurrenceId, event.generation);

    case "recovered":
      return settle(
        withModel(model, {
          state: event.state,
          durability: event.durability,
          notice: event.notice,
          acknowledgements: event.acknowledgements
        })
      );
  }
}

/** Restorable work as the state that shows it. */
function stateOfRestorable(work: RestorableWork): CaptureState {
  switch (work.kind) {
    case "empty":
      return { kind: "empty" };
    case "draft":
      return { kind: "draft", draft: workOf(work.draft) };
    case "resting":
      return { kind: "resting", saved: work.saved };
  }
}

/** Creates the draft from empty work only. */
function ensureDraft(model: CaptureModel, event: Extract<CaptureAction, { kind: "ensure-draft" }>): CaptureTransition {
  if (model.state.kind !== "empty") return settle(model);
  return settle(
    withModel(model, {
      state: {
        kind: "draft",
        draft: {
          id: event.id,
          target: event.target,
          text: "",
          selection: { from: 0, to: 0 },
          beginning: null,
          invitations: [],
          clock: idleClock()
        }
      },
      notice: null
    }),
    "best-effort"
  );
}

/** The draft work to type into: the confirmation's draft, kept on its original target. */
function draftForInput(state: CaptureState): DraftWork | null {
  if (state.kind === "draft") return state.draft;
  if (state.kind === "target-confirmation") return state.draft;
  return null;
}

/** Applies committed input, cancelling any proposal first. */
function typeInput(model: CaptureModel, event: Extract<CaptureAction, { kind: "input" }>): CaptureTransition {
  const base = draftForInput(model.state);
  if (base === null) return settle(model);

  const wasEmpty = base.text.trim() === "";
  const text = event.text;

  let beginning = base.beginning;
  let invitations = base.invitations;
  let clock = base.clock;

  if (text.trim() === "") {
    beginning = null;
    clock = idleClock();
    invitations = [];
  } else if (wasEmpty || beginning === null) {
    beginning = captureInstantAt(event.at);
    clock = resumeClock(idleClock(), event.at);
    invitations = base.target.kind === "root" ? [...(event.invitations ?? [])] : [];
  } else {
    clock = clock.resumedAt === null ? resumeClock(clock, event.at) : clock;
  }

  const draft: DraftWork = {
    ...base,
    text,
    selection: event.selection,
    beginning,
    invitations,
    clock
  };

  return settle(withModel(model, { state: { kind: "draft", draft }, notice: null }), "best-effort");
}

/** Records where the caret is without touching the clock. */
function selectText(model: CaptureModel, selection: TextSelection): CaptureTransition {
  const state = model.state;
  if (state.kind === "draft" || state.kind === "target-confirmation") {
    const draft = { ...state.draft, selection };
    return settle(
      withModel(model, {
        state: state.kind === "draft" ? { kind: "draft", draft } : { kind: "target-confirmation", draft, proposalId: state.proposalId, proposed: state.proposed }
      }),
      "best-effort"
    );
  }
  if (state.kind === "revision") {
    return settle(withModel(model, { state: { kind: "revision", revision: { ...state.revision, selection } } }), "best-effort");
  }
  return settle(model);
}

/** Pauses the draft's clock at the second it painted. */
function pause(model: CaptureModel): CaptureTransition {
  const state = model.state;
  if (state.kind !== "draft" && state.kind !== "target-confirmation") return settle(model);
  if (state.draft.clock.resumedAt === null) return settle(model);
  const draft = { ...state.draft, clock: pauseClock(state.draft.clock) };
  return settle(
    withModel(model, {
      state: state.kind === "draft" ? { kind: "draft", draft } : { kind: "target-confirmation", draft, proposalId: state.proposalId, proposed: state.proposed }
    }),
    "best-effort"
  );
}

/** Records the second a surface painted, for the value a save will write. */
function paint(model: CaptureModel, ms: number): CaptureTransition {
  const state = model.state;
  if (state.kind !== "draft" && state.kind !== "target-confirmation") return settle(model);
  const draft = { ...state.draft, clock: commitShown(state.draft.clock, ms) };
  return settle(
    withModel(model, {
      state: state.kind === "draft" ? { kind: "draft", draft } : { kind: "target-confirmation", draft, proposalId: state.proposalId, proposed: state.proposed }
    })
  );
}

/** Starts a fresh root in a chosen destination from empty or a truly empty draft. */
function newRoot(model: CaptureModel, contextId: string): CaptureTransition {
  const state = model.state;
  const busy = state.kind !== "empty" && state.kind !== "resting" && !(state.kind === "draft" && state.draft.text.trim() === "");
  if (busy) {
    return settle(
      withModel(model, {
        notice: { code: "draft-not-empty", message: "Finish or discard this draft first." }
      })
    );
  }
  return settle(
    withModel(model, {
      state: {
        kind: "draft",
        draft: {
          id: state.kind === "draft" ? state.draft.id : "",
          target: { kind: "root", contextId },
          text: "",
          selection: { from: 0, to: 0 },
          beginning: null,
          invitations: [],
          clock: idleClock()
        }
      },
      notice: null
    }),
    "best-effort"
  );
}

/** Applies a proposed move, or tags it for confirmation when the draft has words. */
function retarget(model: CaptureModel, target: DraftTarget, confirm: boolean, proposalId: number): CaptureTransition {
  const state = model.state;
  if (state.kind === "empty" || state.kind === "draft" || state.kind === "target-confirmation") {
    const work = state.kind === "empty" ? null : state.draft;
    const hasWords = work !== null && work.text.trim() !== "";
    if (hasWords && confirm) {
      const draft = work as DraftWork;
      return settle(
        withModel(model, { state: { kind: "target-confirmation", draft, proposalId, proposed: target }, notice: null }),
        "best-effort"
      );
    }
    const base: DraftWork = work ?? {
      id: "",
      target,
      text: "",
      selection: { from: 0, to: 0 },
      beginning: null,
      invitations: [],
      clock: idleClock()
    };
    const draft: DraftWork = {
      ...base,
      target,
      // A move is not a reason to claim an opening retrospectively.
      invitations: []
    };
    return settle(withModel(model, { state: { kind: "draft", draft }, notice: null }), "best-effort");
  }
  if (state.kind === "resting") {
    return settle(
      withModel(model, {
        state: {
          kind: "draft",
          draft: { id: "", target, text: "", selection: { from: 0, to: 0 }, beginning: null, invitations: [], clock: idleClock() }
        },
        notice: null
      }),
      "best-effort"
    );
  }
  return settle(model);
}

/** Applies the proposed target when its identity still matches. */
function confirmTarget(model: CaptureModel, proposalId: number): CaptureTransition {
  const state = model.state;
  if (state.kind !== "target-confirmation" || state.proposalId !== proposalId) return settle(model);
  const draft: DraftWork = { ...state.draft, target: state.proposed, invitations: [] };
  return settle(withModel(model, { state: { kind: "draft", draft }, notice: null }), "best-effort");
}

/** Borrows the composer for a correction, snapshotting the work it displaces. */
function beginRevision(model: CaptureModel, snapshot: ThoughtSnapshot, id: string): CaptureTransition {
  const state = model.state;
  if (state.kind === "revision") {
    return settle(
      withModel(model, { notice: { code: "finish-first", message: "Finish or cancel this edit first." } })
    );
  }
  const returnTo = restorableOf(state);
  if (returnTo === null) {
    return settle(
      withModel(model, { notice: { code: "finish-first", message: "Finish or cancel this edit first." } })
    );
  }
  const revision: RevisionData = {
    id,
    target: snapshot.thought,
    originalBlock: snapshot.originalBlock,
    originalText: snapshot.text,
    text: snapshot.text,
    selection: { from: snapshot.text.length, to: snapshot.text.length },
    returnTo
  };
  return settle(withModel(model, { state: { kind: "revision", revision }, notice: null }), "best-effort");
}

/** Freezes the current editable work into one write intent. */
function submit(model: CaptureModel, id: string, published: CaptureInstant): CaptureTransition {
  if (model.durability === "blocked") {
    return settle(
      withModel(model, {
        notice: { code: "store-blocked", message: "The draft cannot be stored; writing is paused until it can be." }
      })
    );
  }

  const state = model.state;

  if (state.kind === "draft") {
    if (state.draft.text.trim() === "") {
      return settle(withModel(model, { notice: { code: "empty", message: "There is nothing to save yet." } }));
    }
    const draft = draftProjection({ ...state.draft, clock: pauseClock(state.draft.clock) });
    const intent: WriteIntent = {
      kind: "capture",
      id,
      draft,
      published,
      portal: draft.invitations[0]?.portal ?? null
    };
    return settle(withModel(model, { state: { kind: "preparing", intent, retryOf: null }, notice: null }), "required", {
      kind: "write",
      intent
    });
  }

  if (state.kind === "target-confirmation") {
    return settle(withModel(model, { notice: { code: "confirm-target", message: "Confirm the destination first." } }));
  }

  if (state.kind === "revision") {
    if (state.revision.text.trim() === "") {
      return settle(
        withModel(model, {
          notice: { code: "empty-revision", message: "Use Delete to remove this thought." }
        })
      );
    }
    const intent: WriteIntent = { kind: "revision", id, revision: state.revision };
    return settle(withModel(model, { state: { kind: "preparing", intent, retryOf: null }, notice: null }), "required", {
      kind: "write",
      intent
    });
  }

  return settle(model);
}

/** Starts one background check of an uncertain write. */
function check(model: CaptureModel): CaptureTransition {
  const state = model.state;
  if (state.kind !== "unconfirmed" && state.kind !== "retryable") return settle(model);
  return settle(withModel(model, { state: { kind: "checking", pending: state.pending }, notice: null }), "none", {
    kind: "check",
    pending: state.pending
  });
}

/** Retries a write that the note proved absent, carrying the old evidence forward. */
function retry(model: CaptureModel, id: string, published: CaptureInstant): CaptureTransition {
  const state = model.state;
  if (state.kind !== "retryable") return settle(model);

  const previous = state.pending;
  let intent: WriteIntent;
  if (previous.kind === "capture") {
    intent = { ...previous.intent, id, published };
  } else {
    intent = { ...previous.intent, id };
  }
  return settle(withModel(model, { state: { kind: "preparing", intent, retryOf: previous }, notice: null }), "required", {
    kind: "write",
    intent
  });
}

/** Gives up editable work, keeping a saved root only when one still belongs to it. */
function discard(model: CaptureModel): CaptureTransition {
  const state = model.state;
  if (state.kind !== "draft" && state.kind !== "revision") return settle(model);
  const next: CaptureState =
    state.kind === "revision" ? stateOfRestorable(state.revision.returnTo) : { kind: "empty" };
  return settle(withModel(model, { state: next, notice: null }), "required");
}

/** Re-runs only the local completion handoff, never the note write. */
function retryLocalSave(model: CaptureModel): CaptureTransition {
  if (model.state.kind !== "finalizing") return settle(model);
  const { pending, next } = model.state;
  return settle(withModel(model, { durability: "ready", notice: null }), "required", {
    kind: "finalize",
    pending,
    next
  });
}

/** A receipt was prepared: the write now owns a frozen, recorded intent. */
function receiptPrepared(model: CaptureModel, intentId: string, receipt: WriteReceipt): CaptureTransition {
  const state = model.state;
  if (state.kind !== "preparing" || state.intent.id !== intentId) return settle(model);
  if (state.intent.kind !== receipt.kind) return settle(model);
  const pending = { kind: state.intent.kind, intent: state.intent, receipt } as PendingWrite;
  return settle(withModel(model, { state: { kind: "writing", pending } }), "required");
}

/** A definite refusal returned the write to editable work, or to its old evidence. */
function writeRefused(model: CaptureModel, event: Extract<CaptureResultEvent, { kind: "write-refused" }>): CaptureTransition {
  const state = model.state;
  if (state.kind === "preparing" && state.intent.id === event.intentId) {
    if (state.retryOf !== null) {
      return settle(
        withModel(model, {
          state: { kind: "retryable", pending: state.retryOf },
          notice: { code: event.reason, message: event.message }
        }),
        "required"
      );
    }
    return settle(
      withModel(model, { state: editableOf(state.intent), notice: { code: event.reason, message: event.message } }),
      "best-effort"
    );
  }
  if (state.kind === "writing" && state.pending.intent.id === event.intentId) {
    return settle(
      withModel(model, { state: editableOf(state.pending.intent), notice: { code: event.reason, message: event.message } }),
      "best-effort"
    );
  }
  return settle(model);
}

/** The outcome is unknown: keep the receipt as evidence, never claim failure. */
function writeUnconfirmed(model: CaptureModel, intentId: string, message: string): CaptureTransition {
  if (!ownsPending(model.state, intentId)) return settle(model);
  const pending = (model.state as Extract<CaptureState, { pending: PendingWrite }>).pending;
  return settle(
    withModel(model, { state: { kind: "unconfirmed", pending }, notice: { code: "unconfirmed", message } }),
    "required"
  );
}

/** Persisted bytes were confirmed: stage local completion before removing the receipt. */
function confirmed(model: CaptureModel, intentId: string, from: "writing" | "checking"): CaptureTransition {
  const state = model.state;
  if (state.kind !== from || state.pending.intent.id !== intentId) return settle(model);
  const next = restingOf(state.pending);
  return settle(withModel(model, { state: { kind: "finalizing", pending: state.pending, next } }), "required", {
    kind: "finalize",
    pending: state.pending,
    next
  });
}

/** Disk equals the pre-write bytes: nothing landed, and the note can be written again. */
function checkAbsent(model: CaptureModel, intentId: string, message: string): CaptureTransition {
  const state = model.state;
  if (state.kind !== "checking" || state.pending.intent.id !== intentId) return settle(model);
  return settle(
    withModel(model, { state: { kind: "retryable", pending: state.pending }, notice: { code: "absent", message } }),
    "required"
  );
}

/** The note holds something this write cannot explain: stay unconfirmed. */
function stillUnconfirmed(model: CaptureModel, intentId: string, message: string): CaptureTransition {
  const state = model.state;
  if (state.kind !== "checking" || state.pending.intent.id !== intentId) return settle(model);
  return settle(
    withModel(model, { state: { kind: "unconfirmed", pending: state.pending }, notice: { code: "diverged", message } }),
    "required"
  );
}

/** Local completion was stored atomically: the next work is now current. */
function completionStored(model: CaptureModel, intentId: string): CaptureTransition {
  const state = model.state;
  if (state.kind !== "finalizing" || state.pending.intent.id !== intentId) return settle(model);
  return settle(withModel(model, { state: stateOfRestorable(state.next), notice: null }), "none");
}

/** Removes one acknowledged occurrence from the queue, matched by identity and generation. */
function acknowledged(model: CaptureModel, occurrenceId: string, generation: number): CaptureTransition {
  const remaining = model.acknowledgements.filter(
    (invitation) => !(invitation.occurrenceId === occurrenceId && invitation.generation === generation)
  );
  if (remaining.length === model.acknowledgements.length) return settle(model);
  return settle(withModel(model, { acknowledgements: remaining }), "best-effort");
}

/**
 * What a capture state looks like once it is written down.
 *
 * Only the durable facts survive: a running clock serializes as its draft, the
 * in-flight family serializes as its pending receipt, and `finalizing` keeps the
 * pending receipt until completion is stored. Nothing about focus, menus, DOM or a
 * parsed index is here, because none of it belongs to the draft.
 */
export type StoredCaptureState =
  | { readonly kind: "empty" }
  | { readonly kind: "draft"; readonly draft: DraftData }
  | { readonly kind: "resting"; readonly saved: SavedThought }
  | { readonly kind: "revision"; readonly revision: RevisionData }
  | {
      readonly kind: "preparing";
      readonly intent: WriteIntent;
      readonly retryOf: PendingWrite | null;
    }
  | { readonly kind: "pending"; readonly pending: PendingWrite };

/** Projects a runtime state onto the durable shape it is stored as. */
export function storedOf(state: CaptureState): StoredCaptureState {
  switch (state.kind) {
    case "empty":
      return { kind: "empty" };
    case "draft":
      return { kind: "draft", draft: draftProjection(state.draft) };
    case "target-confirmation":
      // An unanswered proposal is not durable: the draft it protects is.
      return { kind: "draft", draft: draftProjection(state.draft) };
    case "resting":
      return { kind: "resting", saved: state.saved };
    case "revision":
      return { kind: "revision", revision: state.revision };
    case "preparing":
      return { kind: "preparing", intent: state.intent, retryOf: state.retryOf };
    case "writing":
    case "unconfirmed":
    case "checking":
    case "retryable":
      return { kind: "pending", pending: state.pending };
    case "finalizing":
      return { kind: "pending", pending: state.pending };
  }
}

/** Durable draft data as the work a surface resumes, paused at its stored time. */
function workOfStored(data: DraftData): DraftWork {
  const ms = wholeSeconds(data.durationMs);
  return {
    id: data.id,
    target: data.target,
    text: data.text,
    selection: data.selection,
    beginning: data.beginning,
    invitations: data.invitations,
    clock: { baselineMs: ms, resumedAt: null, shownMs: ms }
  };
}

/**
 * Restores the runtime state a stored one describes.
 *
 * A stored `pending` becomes `unconfirmed`, because its outcome is unknown and a
 * Check — not a guess — is what resolves it. A stored draft comes back paused: a
 * reload never resumes counting until real input arrives.
 */
export function restoredOf(stored: StoredCaptureState): CaptureState {
  switch (stored.kind) {
    case "empty":
      return { kind: "empty" };
    case "draft":
      return { kind: "draft", draft: workOfStored(stored.draft) };
    case "resting":
      return { kind: "resting", saved: stored.saved };
    case "revision":
      return { kind: "revision", revision: stored.revision };
    case "preparing":
      return { kind: "preparing", intent: stored.intent, retryOf: stored.retryOf };
    case "pending":
      return { kind: "unconfirmed", pending: stored.pending };
  }
}
