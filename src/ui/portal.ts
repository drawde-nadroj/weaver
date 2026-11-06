/**
 * The opening, drawn small: one strip, in the same surface as the draft.
 *
 * A portal is a scheduled opening, not an input and not a second card. This strip
 * names the opening once — its Realm, its own hour and minute, and what it is
 * doing — and offers only the gestures that exist: write into it, put it away, or
 * look at the whole list. It can never accept text, which is the structural reason
 * a clock cannot be started from it by accident.
 *
 * It lives inside the composer's own host, so the writer never has two Weaver
 * surfaces competing for the bottom edge: closed, the strip *is* the surface;
 * open, it is one line of the draft card's status row. A hidden draft owns the
 * bottom instead, because resuming it is the more important action.
 *
 * The rainbow accent belongs to an opening that is live. A minute that has closed
 * loses it at once and says so neutrally, so colour never claims an opening the
 * writer can no longer use.
 */

import { pad2 } from "../core/clock";
import type { PortalStripView } from "./composer";

/** What the strip's owner supplies. */
export interface InvitationDockOptions {
  /** Writes into that opening's Realm. */
  weave(occurrenceId: string): void;
  /** Puts this opening away, for this occurrence only. */
  dismiss(occurrenceId: string): void;
  /** Opens the navigator's Portals list. */
  showAll(): void;
}

/** The whole seconds a countdown shows, floored so it never reads one too high. */
function countdown(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
}

/**
 * The strip: one opening, its state, and its gestures.
 *
 * `render` is idempotent and cheap, so a surface may call it on every tick: it
 * rewrites only the text that changed and keeps focus where it was.
 */
export class InvitationDock {
  readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly opening: HTMLElement;
  private readonly state: HTMLElement;
  private readonly weaveButton: HTMLButtonElement;
  private readonly dismissButton: HTMLButtonElement;
  private readonly allButton: HTMLButtonElement;
  private shown: string | null = null;
  private destroyed = false;
  private current: PortalStripView | null = null;

  constructor(private readonly options: InvitationDockOptions) {
    const doc = document;
    this.root = doc.createElement("div");
    this.root.className = "weaver-portal-strip";
    this.root.setAttribute("data-weaver-portal", "");
    this.root.setAttribute("role", "group");
    this.root.setAttribute("hidden", "");

    this.label = doc.createElement("span");
    this.label.className = "weaver-portal-realm";

    this.opening = doc.createElement("span");
    this.opening.className = "weaver-portal-opening";

    this.state = doc.createElement("span");
    this.state.className = "weaver-portal-state";
    this.state.setAttribute("aria-live", "polite");

    this.weaveButton = doc.createElement("button") as HTMLButtonElement;
    this.weaveButton.className = "weaver-portal-weave";
    this.weaveButton.setAttribute("type", "button");
    this.weaveButton.textContent = "Weave";
    this.weaveButton.setAttribute("title", "Write a Thread through this opening");

    this.dismissButton = doc.createElement("button") as HTMLButtonElement;
    this.dismissButton.className = "weaver-portal-dismiss";
    this.dismissButton.setAttribute("type", "button");
    this.dismissButton.textContent = "Hide";
    this.dismissButton.setAttribute("title", "Hide this opening; the next one still comes");

    this.allButton = doc.createElement("button") as HTMLButtonElement;
    this.allButton.className = "weaver-portal-all";
    this.allButton.setAttribute("type", "button");
    this.allButton.setAttribute("hidden", "");

    this.root.appendChild(this.label);
    this.root.appendChild(this.opening);
    this.root.appendChild(this.state);
    this.root.appendChild(this.weaveButton);
    this.root.appendChild(this.dismissButton);
    this.root.appendChild(this.allButton);

    this.weaveButton.addEventListener("click", () => {
      const current = this.current;
      if (current !== null) this.options.weave(current.occurrenceId);
    });
    this.dismissButton.addEventListener("click", () => {
      const current = this.current;
      if (current !== null) this.options.dismiss(current.occurrenceId);
    });
    this.allButton.addEventListener("click", () => this.options.showAll());
  }

  /** Draws the strip, or hides it when there is nothing to say. */
  render(view: PortalStripView | null): void {
    if (this.destroyed) return;
    this.current = view;

    if (view === null) {
      this.root.setAttribute("hidden", "");
      this.shown = null;
      return;
    }

    this.root.removeAttribute("hidden");
    this.root.setAttribute("data-phase", view.phase);

    this.label.textContent = view.contextName;
    this.opening.textContent = view.opening;

    const text = this.stateText(view);
    if (this.shown !== text) {
      this.state.textContent = text;
      this.state.setAttribute("aria-label", `${view.contextName} at ${view.opening} ${text}`);
      this.shown = text;
    }

    // An opening is only offered as a gesture when it can still be used: a closed
    // minute keeps saying what happened, but cannot be entered by clicking it.
    const action = view.actionable && view.phase !== "closed";
    this.weaveButton.removeAttribute("hidden");
    this.weaveButton.disabled = !action;
    this.weaveButton.setAttribute(
      "aria-label",
      `Weave a Thread into ${view.contextName} through the ${view.opening} opening`
    );
    this.dismissButton.disabled = view.phase === "closed";
    this.dismissButton.setAttribute(
      "aria-label",
      `Hide the ${view.opening} opening in ${view.contextName}; the next one still comes`
    );

    // The control exists only when there is more than one opportunity: an empty
    // button is a bug, not a menu.
    if (view.others > 0) {
      this.allButton.removeAttribute("hidden");
      this.allButton.textContent = `Portals (${view.others + 1})`;
      this.allButton.setAttribute(
        "aria-label",
        `Portals (${view.others + 1}). Show every opening`
      );
    } else {
      this.allButton.setAttribute("hidden", "");
    }
  }

  /** What the opening is doing, in the words a writer reads. */
  private stateText(view: PortalStripView): string {
    if (view.phase === "approaching") return `opens in ${countdown(view.remainingMs)}`;
    if (view.phase === "available") return `open · ${countdown(view.remainingMs)} left`;
    // A minute that closed while the composer was open says writing still works,
    // because the alternative is a writer believing they have been locked out.
    return view.writingNormally ? "closed · writing normally" : "closed";
  }

  /** Takes the strip away. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.root.remove();
  }
}
