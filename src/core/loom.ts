/**
 * The Loom's own state: whether it is showing, what its upper half holds, which
 * layer is in front, where focus is meant to go, and the reading/Review choices
 * worth keeping between sessions.
 *
 * This is deliberately *not* the draft, the reference or the note: those belong
 * to `CaptureController`, `ReferenceController` and the writer. The Loom owns only
 * presentation and intent — a hidden shell, a collapsed upper half, an armed menu
 * or a suspended Review form — so that "what is on screen" can never disagree
 * with "what is being written". A renderer draws this model; it does not decide it.
 *
 * Pure: no DOM, no `obsidian`, no timers, no storage. The coordinator activates
 * it and persists the safe subset; a test drives it with plain values.
 */

import type { ThoughtRef } from "./capture";

/**
 * One content area the upper half can show.
 *
 * `reference` is the reading surface; the others replace it in the same area. A
 * search or a Review form is a *mode* of an area, not a separate panel here.
 */
export type UpperPanel =
  | "reference"
  | "tapestries"
  | "reviews"
  | "review-form"
  | "ancestry"
  | "invitations";

/**
 * The one thing in front of the surface, which Escape closes before anything
 * behind it. Only one layer exists at a time, so two confirmations can never be
 * armed together.
 */
export type FrontLayer =
  | { readonly kind: "none" }
  | { readonly kind: "menu"; readonly invokerId: string }
  | { readonly kind: "discard-confirmation"; readonly draftId: string }
  | {
      readonly kind: "delete-confirmation";
      readonly target: ThoughtRef;
      readonly subtree: string;
      readonly count: number;
    }
  | {
      readonly kind: "review-delete-confirmation";
      readonly reviewId: string;
      readonly name: string;
    };

/**
 * The expanded shell's content: which half is active and what the upper half is
 * showing. When the upper half is `collapsed`, it cannot own focus — there is no
 * `"upper"` active area in that variant, so the illegal pairing is unrepresentable.
 */
export type ExpandedContent =
  | { readonly upper: { readonly kind: "collapsed"; readonly retainedPanel: UpperPanel }; readonly activeArea: "lower" }
  | {
      readonly upper: { readonly kind: "shown"; readonly panel: UpperPanel };
      readonly activeArea: "lower" | "upper";
    };

/**
 * Whether the Loom is visible, and how.
 *
 * `hidden` and `reduced` both carry the expanded content to resume, so hiding is
 * never a discard: the collapsed panel, the active area and the reading place all
 * come back. `expanded` adds the front layer, which is the only state a menu or a
 * confirmation can occupy.
 */
export type LoomSurface =
  | { readonly kind: "hidden"; readonly resume: ExpandedContent }
  | { readonly kind: "reduced"; readonly resume: ExpandedContent }
  | ({ readonly kind: "expanded"; readonly front: FrontLayer } & ExpandedContent);

/** Where focus is meant to go, and the interaction that asked for it. */
export interface FocusIntent {
  readonly interactionEpoch: number;
  readonly mountGeneration: number;
  readonly from: "outside" | "lower" | "upper" | "front";
  readonly to: "lower" | "reference" | "panel" | "invoker";
}

/** One Tapestry and the last instant a Loom thread was woven into it. */
export interface TapestryActivity {
  readonly id: string;
  readonly at: number;
}

/**
 * A Review being set up in the upper half, kept while it is unfinished.
 *
 * `preparing` carries the operation that is saving it; a late save completion for
 * a superseded setup must not clear a newer one, so the identity travels with it.
 */
export interface ReviewSetup {
  readonly id: string;
  readonly revision: number;
  readonly target: { readonly kind: "new" } | { readonly kind: "existing"; readonly id: string };
  readonly values: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly returnPanel: UpperPanel;
  readonly phaseTop: "editing" | "preparing";
  readonly saveOperationId: string | null;
  readonly submittedRevision: number | null;
}

/** The Loom's durable model: what a surface draws and what survives a reload. */
export interface LoomModel {
  readonly surface: LoomSurface;
  /** The Tapestry scoping the reference, or null for none chosen yet. */
  readonly selectedTapestry: string | null;
  /** Most-recently-written Tapestries, front first. */
  readonly mru: readonly TapestryActivity[];
  /** One suspended Review setup, or null. */
  readonly reviewSetup: ReviewSetup | null;
}

/** What a reduction changed about durability: only safe place/intent is stored. */
export interface LoomTransition {
  readonly model: LoomModel;
  readonly persistence: "none" | "best-effort";
}

/**
 * A command a surface may dispatch.
 *
 * Actions that change notes, the workspace, the draft or the reference are named
 * here so the coordinator has one vocabulary, but the ones marked as forwards are
 * *not* reduced by this module: they belong to the controller that owns their
 * effects, and the coordinator routes them. This reducer owns only surface,
 * layers, panels, focus intent and the suspended Review setup.
 */
export type LoomAction =
  | { readonly kind: "open-writing" }
  | { readonly kind: "open-reference"; readonly panel: UpperPanel }
  | { readonly kind: "today" }
  | { readonly kind: "hide" }
  | { readonly kind: "return-to-writing" }
  | { readonly kind: "collapse-upper" }
  | { readonly kind: "select-tapestry"; readonly id: string; readonly at: number }
  | { readonly kind: "cycle-tapestry"; readonly order: readonly string[]; readonly delta: 1 | -1; readonly at: number }
  | { readonly kind: "show-panel"; readonly panel: UpperPanel }
  | { readonly kind: "back" }
  | { readonly kind: "open-menu"; readonly invokerId: string }
  | { readonly kind: "close-front" }
  | { readonly kind: "begin-review"; readonly setup: ReviewSetup }
  | { readonly kind: "edit-review"; readonly setup: ReviewSetup }
  | { readonly kind: "change-review-field"; readonly revision: number; readonly values: Readonly<Record<string, string>>; readonly errors: Readonly<Record<string, string>> }
  | { readonly kind: "save-review"; readonly revision: number; readonly operationId: string }
  | { readonly kind: "cancel-review"; readonly revision: number }
  | { readonly kind: "request-delete"; readonly target: ThoughtRef; readonly subtree: string; readonly count: number }
  | { readonly kind: "confirm-delete" }
  | { readonly kind: "request-delete-review"; readonly reviewId: string; readonly name: string }
  | { readonly kind: "confirm-delete-review" }
  | { readonly kind: "mounted"; readonly mountGeneration: number }
  | { readonly kind: "focus-changed"; readonly intent: FocusIntent }
  | { readonly kind: "visibility-changed"; readonly visible: boolean }
  | { readonly kind: "unmounted"; readonly mountGeneration: number };

/** The model a session starts with: hidden, nothing chosen, nothing suspended. */
export function initialLoomModel(): LoomModel {
  return {
    surface: { kind: "hidden", resume: { upper: { kind: "collapsed", retainedPanel: "reference" }, activeArea: "lower" } },
    selectedTapestry: null,
    mru: [],
    reviewSetup: null
  };
}

/** The expanded content a hidden or reduced surface would come back as. */
function resumeContent(surface: LoomSurface): ExpandedContent {
  if (surface.kind === "hidden" || surface.kind === "reduced") return surface.resume;
  return contentOf(surface.upper, surface.activeArea);
}

/** Builds expanded content, forcing a collapsed upper half to keep focus below. */
function contentOf(upper: ExpandedContent["upper"], activeArea: "lower" | "upper"): ExpandedContent {
  if (upper.kind === "collapsed") return { upper, activeArea: "lower" };
  return { upper, activeArea };
}

/** A model whose front layer is replaced and whose shell is expanded. */
function withFront(model: LoomModel, front: FrontLayer): LoomModel {
  const content = resumeContent(model.surface);
  return { ...model, surface: { kind: "expanded", front, ...content } };
}

/** A model showing an expanded shell over the given content, no layer in front. */
function expanded(model: LoomModel, content: ExpandedContent): LoomModel {
  return { ...model, surface: { kind: "expanded", front: { kind: "none" }, ...content } };
}

/** Moves a Tapestry id to the front of the MRU list, recording the action instant. */
function travelMru(mru: readonly TapestryActivity[], id: string, at: number): readonly TapestryActivity[] {
  return [{ id, at }, ...mru.filter((entry) => entry.id !== id)];
}

/**
 * One pure transition of the Loom's presentation.
 *
 * `persistence` says whether the safe subset (surface choice, selected Tapestry,
 * MRU, suspended setup) is worth storing; focus and layers are never persisted.
 * Actions that belong to another owner leave the model alone and are forwarded by
 * the coordinator, so this reducer cannot invent a note, travel or a write.
 */
export function reduceLoom(model: LoomModel, action: LoomAction): LoomTransition {
  switch (action.kind) {
    case "open-writing": {
      if (model.surface.kind === "expanded") {
        return { model: expanded(model, contentOf(model.surface.upper, "lower")), persistence: "none" };
      }
      return {
        model: expanded(model, { upper: { kind: "collapsed", retainedPanel: "reference" }, activeArea: "lower" }),
        persistence: "best-effort"
      };
    }

    case "open-reference":
    case "today":
    case "show-panel": {
      const panel = action.kind === "today" ? "reference" : action.panel;
      return {
        model: expanded(model, { upper: { kind: "shown", panel }, activeArea: "upper" }),
        persistence: "best-effort"
      };
    }

    case "hide": {
      // Hiding clears the front layer but never the resume content: the draft,
      // the reading place and a suspended Review form all come back.
      return { model: { ...model, surface: { kind: "hidden", resume: resumeContent(model.surface) } }, persistence: "best-effort" };
    }

    case "return-to-writing": {
      const content = resumeContent(model.surface);
      return {
        model: expanded(model, contentOf(content.upper, "lower")),
        persistence: "best-effort"
      };
    }

    case "collapse-upper": {
      const content = resumeContent(model.surface);
      const retained = content.upper.kind === "collapsed" ? content.upper.retainedPanel : content.upper.panel;
      return {
        model: expanded(model, contentOf({ kind: "collapsed", retainedPanel: retained }, "lower")),
        persistence: "best-effort"
      };
    }

    case "select-tapestry":
      return {
        model: { ...model, selectedTapestry: action.id, mru: travelMru(model.mru, action.id, action.at) },
        persistence: "best-effort"
      };

    case "cycle-tapestry": {
      if (action.order.length === 0) return { model, persistence: "none" };
      const current = model.selectedTapestry ?? action.order[0] ?? "";
      const index = Math.max(0, action.order.indexOf(current));
      const next = action.order[(index + action.delta + action.order.length) % action.order.length] ?? current;
      return {
        model: { ...model, selectedTapestry: next, mru: travelMru(model.mru, next, action.at) },
        persistence: "best-effort"
      };
    }

    case "back": {
      const content = resumeContent(model.surface);
      if (content.upper.kind === "shown") {
        return {
          model: expanded(model, contentOf({ kind: "collapsed", retainedPanel: content.upper.panel }, "lower")),
          persistence: "best-effort"
        };
      }
      return { model: { ...model, surface: { kind: "hidden", resume: content } }, persistence: "best-effort" };
    }

    case "open-menu":
      // A menu can only be in front of an expanded shell; from hidden it is refused.
      return model.surface.kind === "expanded"
        ? { model: withFront(model, { kind: "menu", invokerId: action.invokerId }), persistence: "none" }
        : { model, persistence: "none" };

    case "close-front":
      return model.surface.kind === "expanded" && model.surface.front.kind !== "none"
        ? { model: withFront(model, { kind: "none" }), persistence: "none" }
        : { model, persistence: "none" };

    case "begin-review":
    case "edit-review":
      return {
        model: {
          ...expanded(model, { upper: { kind: "shown", panel: "review-form" }, activeArea: "upper" }),
          reviewSetup: action.setup
        },
        persistence: "best-effort"
      };

    case "change-review-field": {
      const setup = model.reviewSetup;
      if (setup === null || setup.revision !== action.revision) return { model, persistence: "none" };
      return {
        model: { ...model, reviewSetup: { ...setup, values: action.values, errors: action.errors } },
        persistence: "best-effort"
      };
    }

    case "save-review": {
      const setup = model.reviewSetup;
      if (setup === null || setup.revision !== action.revision || setup.phaseTop !== "editing") {
        return { model, persistence: "none" };
      }
      return {
        model: {
          ...model,
          reviewSetup: {
            ...setup,
            phaseTop: "preparing",
            saveOperationId: action.operationId,
            submittedRevision: setup.revision
          }
        },
        persistence: "best-effort"
      };
    }

    case "cancel-review": {
      const setup = model.reviewSetup;
      if (setup === null || setup.revision !== action.revision) return { model, persistence: "none" };
      return {
        model: {
          ...expanded(model, contentOf({ kind: "shown", panel: setup.returnPanel }, "upper")),
          reviewSetup: null
        },
        persistence: "best-effort"
      };
    }

    case "request-delete":
      return {
        model: withFront(model, {
          kind: "delete-confirmation",
          target: action.target,
          subtree: action.subtree,
          count: action.count
        }),
        persistence: "none"
      };

    case "confirm-delete":
    case "confirm-delete-review":
      // The coordinator performs the deletion through its guarded writer; the
      // reducer only closes the layer it was asked under.
      return { model: withFront(model, { kind: "none" }), persistence: "none" };

    case "request-delete-review":
      return {
        model: withFront(model, { kind: "review-delete-confirmation", reviewId: action.reviewId, name: action.name }),
        persistence: "none"
      };

    case "mounted":
    case "focus-changed":
      // Mount generations and focus intent are ephemeral; nothing is stored.
      return { model, persistence: "none" };

    case "visibility-changed":
      if (action.visible) return { model, persistence: "none" };
      return { model: { ...model, surface: { kind: "hidden", resume: resumeContent(model.surface) } }, persistence: "none" };

    case "unmounted":
      return { model, persistence: "none" };
  }
}
