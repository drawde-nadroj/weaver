/**
 * The Loom's coordinator: one place that knows the shell, the draft and the
 * reference together, and none of their internals.
 *
 * It owns presentation and focus intent only. The draft belongs to the capture
 * owner, the reading place to the reference owner, and the note to the writer; this
 * class composes their projected models and routes commands to the owner that can
 * carry them out. A renderer draws {@link LoomState}; it cannot decide what is
 * saved, selected, dismissed or retargeted, because every one of those is a
 * command here.
 *
 * Pure of DOM: the owners, the durable UI store and the clock are injected, so a
 * test drives the whole surface with fakes.
 */

import type { CaptureAction, CaptureModel, PendingWrite } from "../core/capture-state";
import {
  initialLoomModel,
  reduceLoom,
  type FocusIntent,
  type LoomAction,
  type LoomModel,
  type TapestryActivity
} from "../core/loom";
import type { ReferenceAction, ReferenceModel } from "./reference";

/** The lower half as the Loom sees it: a model and a command port. */
export interface LoomCaptureOwner {
  readonly model: CaptureModel;
  dispatch(action: CaptureAction): void;
  subscribe(listener: (model: CaptureModel) => void): () => void;
  start(): void;
  dispose(): void;
}

/** The upper half as the Loom sees it: a model and a command port. */
export interface LoomReferenceOwner {
  readonly model: ReferenceModel;
  dispatch(action: ReferenceAction): void;
  subscribe(listener: (model: ReferenceModel) => void): () => void;
  dispose(): void;
}

/** The durable presentation record: the safe place/intent subset only. */
export interface LoomUiStore {
  load(): LoomModel | null;
  save(model: LoomModel): void;
}

/** Everything the coordinator may know about the world. */
export interface LoomPorts {
  /** The current wall-clock instant, for the MRU action time. */
  now(): number;
  /** The lower owner. */
  capture: LoomCaptureOwner;
  /** The upper owner. */
  reference: LoomReferenceOwner;
  /** The durable UI store. */
  ui: LoomUiStore;
  /** Resolves a branch parent's path to the Tapestry that owns it, when known. */
  tapestryOf?(path: string): string | null;
}

/** A command a renderer may dispatch: shell, capture or reference. */
export type LoomCommand =
  | LoomAction
  | { readonly kind: "capture"; readonly action: CaptureAction }
  | { readonly kind: "reference"; readonly action: ReferenceAction };

/** The whole surface as one projection: shell, draft and reference together. */
export interface LoomState {
  readonly loom: LoomModel;
  readonly capture: CaptureModel;
  readonly reference: ReferenceModel;
}

/** What a subscriber receives when anything the surface draws changes. */
export type LoomListener = (state: LoomState, focus: FocusIntent | null) => void;

/** Moves a Tapestry id to the front of the MRU list, recording the action instant. */
function travelMru(
  mru: readonly TapestryActivity[],
  id: string,
  at: number
): readonly TapestryActivity[] {
  return [{ id, at }, ...mru.filter((entry) => entry.id !== id)];
}

/** The one coordinator over the shell, the draft and the reference. */
export class LoomController {
  private loomValue: LoomModel;
  private readonly listeners = new Set<LoomListener>();
  private readonly unsubscribers: Array<() => void> = [];
  private focus: FocusIntent | null = null;
  private disposed = false;

  constructor(private readonly ports: LoomPorts) {
    this.loomValue = ports.ui.load() ?? initialLoomModel();
  }

  /** The three projected models a renderer draws. */
  get model(): LoomState {
    return {
      loom: this.loomValue,
      capture: this.ports.capture.model,
      reference: this.ports.reference.model
    };
  }

  /** Subscribes to any change of the shell, the draft or the reference. */
  subscribe(listener: LoomListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Starts the owners and begins forwarding their changes. */
  start(): void {
    if (this.disposed) return;
    this.ports.capture.start();
    this.unsubscribers.push(
      this.ports.capture.subscribe(() => this.notify()),
      this.ports.reference.subscribe(() => this.notify())
    );
    this.notify();
  }

  /**
   * Routes one command to the owner that carries it out.
   *
   * Shell commands are reduced here and persisted at best effort; capture and
   * reference commands are forwarded untouched, so no surface state is decided by
   * the coordinator itself.
   */
  dispatch(command: LoomCommand): void {
    if (this.disposed) return;
    if (command.kind === "capture") {
      this.ports.capture.dispatch(command.action);
      return;
    }
    if (command.kind === "reference") {
      this.ports.reference.dispatch(command.action);
      return;
    }

    const transition = reduceLoom(this.loomValue, command);
    this.loomValue = transition.model;
    if (transition.persistence === "best-effort") this.saveUi();
    this.notify();
  }

  /** Records the focus intent a renderer observed, without touching work. */
  setFocus(focus: FocusIntent | null): void {
    this.focus = focus;
    this.notify();
  }

  /**
   * Records the durable, safe part of a confirmed capture before the receipt is
   * removed: the writing Tapestry becomes selected, and the MRU moves it forward.
   */
  stageCaptureCompletion(pending: PendingWrite): void {
    if (this.disposed || pending.intent.kind !== "capture") return;
    const target = pending.intent.draft.target;
    const tapestryId =
      target.kind === "root" ? target.contextId : (this.ports.tapestryOf?.(target.parent.path) ?? null);
    if (tapestryId === null) return;

    this.loomValue = {
      ...this.loomValue,
      selectedTapestry: tapestryId,
      mru: travelMru(this.loomValue.mru, tapestryId, this.ports.now())
    };
    this.saveUi();
    this.notify();
  }

  /** Stops forwarding, disposes the owners, and releases listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.ports.capture.dispose();
    this.ports.reference.dispose();
    this.listeners.clear();
    this.focus = null;
  }

  private saveUi(): void {
    try {
      this.ports.ui.save(this.loomValue);
    } catch {
      // A presentation write that fails costs a remembered panel, never work.
    }
  }

  private notify(): void {
    if (this.disposed) return;
    const state = this.model;
    for (const listener of [...this.listeners]) listener(state, this.focus);
  }
}
