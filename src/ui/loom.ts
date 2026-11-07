/**
 * The Loom: the one compact surface a thought is written in, from anywhere.
 *
 * It is a single non-modal dialog with a small header, a dominant prose area, and
 * one footer for timing and Save. The destination control opens a chooser that
 * temporarily replaces the content area, so the writer never scrolls past
 * destination machinery to reach the words. Reference context is optional and
 * starts collapsed; the saved thought replaces the editor and offers Branch, New
 * Thread and a quiet close.
 *
 * The renderer owns only presentation and ephemeral interaction: mounted DOM, the
 * composing flag, measurements and a hint overlay. Every semantic action is a
 * command on the controller or the reference owner, so the note is never written
 * by opening, browsing, hiding or resizing this surface.
 */

import { Component, type App } from "obsidian";

import { formatClock as formatTimeOfDay } from "../core/clock";
import { dimensionColor, dimensionColorVars } from "../core/color";
import { formatClock as formatDuration } from "../core/duration";
import { formatAddress } from "../core/entries";
import { loomWidth } from "../core/frame";
import type { ThreadView, ThoughtRef } from "../core/capture";
import type { WeavingContext } from "../core/contexts";
import type { CaptureView } from "../entries/capture-model-controller";
import type { EntryClock } from "../entries/clock";
import type { ReferenceController, ReferenceModel } from "../entries/reference";
import { isMobile, isPhone } from "./platform";

/** The lower surface the Loom reads and commands; either controller satisfies it. */
export interface CaptureSurface {
  readonly state: CaptureView;
  elapsed(): number;
  setText(text: string, selection?: { from: number; to: number }): void;
  setSelection(selection: { from: number; to: number }): void;
  commitDuration(ms: number): void;
  pause(): void;
  settle(): Promise<void>;
  checkSave(): Promise<void>;
  collapse(): void;
  expand(): void;
  dismiss(): void;
  discardDraft(): void;
  newThread(): Promise<boolean>;
  confirmTarget(): void;
  cancelTarget(): void;
  selectThought(target: ThoughtRef): Promise<boolean>;
  editInNote(target: ThoughtRef): Promise<boolean>;
  branch(parent: ThoughtRef): Promise<boolean>;
}

/** What the Loom needs from the plugin. */
export interface LoomHost {
  app: App;
  controller: CaptureSurface;
  /** The upper reading owner, when the reference is available. */
  reference?: ReferenceController;
  /** Writes the open draft into a Tapestry. */
  writeHere?(contextId: string): void;
  /** Every outstanding invitation. */
  invitations?(): readonly { id: string; name: string; opening: string; phase: string }[];
  /** Opens an invitation's draft. */
  takeInvitation?(occurrenceId: string): void;
  /** Dismisses one invitation. */
  dismissInvitation?(occurrenceId: string): void;
  clock: EntryClock;
  /** Every Realm, `main` first. */
  contexts(): readonly WeavingContext[];
  /** The saved Thread a reference belongs to, read from its note. */
  loadThread(target: ThoughtRef): Promise<ThreadView | null>;
  /** Deliberate travel: snapshot here, restore there. */
  travel(contextId: string): Promise<boolean>;
  /** The Realm the workspace is showing, or the empty string when unknown. */
  viewing(): string;
  /** Renders saved prose, so a link in a thought is still a link. */
  renderMarkdown(
    element: HTMLElement,
    markdown: string,
    sourcePath: string,
    component: Component
  ): void;
  /** Opens the Tapestries panel, without travelling. */
  openRealms(): void;
  /** The opening this surface should speak about, if any. */
  portalStrip(): PortalStripView | null;
  /** Writes into an opening's Realm: the same Loom, opened there. */
  weaveOpening(occurrenceId: string): void;
  /** Puts one opening away for this occurrence only. */
  dismissOpening(occurrenceId: string): void;
  /** Opens the invitations panel. */
  openPortals(): void;
}

/** One opening, as the compact strip says it. */
export interface PortalStripView {
  occurrenceId: string;
  contextName: string;
  opening: string;
  phase: "approaching" | "available" | "closed";
  remainingMs: number;
  others: number;
  writingNormally: boolean;
  actionable: boolean;
}

/** A contextual panel that temporarily replaces the content area. */
type View = "write" | "chooser" | "invitations";

/** The document a Loom is currently mounted in. */
interface Mounted {
  document: Document;
  window: Window;
  release(): void;
}

/** True when the event target is a text field. */
function isField(target: unknown): boolean {
  if (typeof target !== "object" || target === null || !("tagName" in target)) return false;
  const tag = String(target.tagName).toLowerCase();
  return tag === "input" || tag === "textarea";
}

/**
 * True when the target owns its own keys: a field, a button, a link, a select.
 * The Loom's reading keys must never fire over one of these — `Enter` on a
 * focused button is that button's activation, not a jump into a note.
 */
function isControl(target: unknown): boolean {
  if (typeof target !== "object" || target === null || !("tagName" in target)) return false;
  const tag = String(target.tagName).toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "button" || tag === "select" || tag === "a";
}

/**
 * What an opening is doing, in the strip's own words: the countdown before it,
 * the remainder while it is open, and the ordinary day once it has closed.
 */
function stripPhase(strip: PortalStripView): string {
  return strip.phase === "available"
    ? `open · ${countdown(strip.remainingMs)} left`
    : strip.phase === "approaching"
      ? `opens in ${countdown(strip.remainingMs)}`
      : "closed · writing normally";
}

/** One opening said once: its Realm, its own local `HH:MM`, and what it is doing. */
function stripLabel(strip: PortalStripView): string {
  return `${strip.contextName} · ${strip.opening} · ${stripPhase(strip)}`;
}

/** The first words of prose, for a resume strip. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/**
 * How much of the layout viewport the visual viewport misses at the bottom — the
 * keyboard, floored at zero. A page panned up (`offsetTop` > 0) can hide part of
 * that gap, which is why the offset is subtracted.
 */
export function keyboardInset(
  layoutHeight: number,
  visual: { height?: number; offsetTop?: number } | null
): number {
  if (visual === null) return 0;
  const rawHeight = visual.height;
  const rawOffset = visual.offsetTop;
  const height = typeof rawHeight === "number" && Number.isFinite(rawHeight) ? rawHeight : layoutHeight;
  const offset = typeof rawOffset === "number" && Number.isFinite(rawOffset) ? rawOffset : 0;
  return Math.max(0, layoutHeight - height - offset);
}

/** Whole seconds as `MM:SS`, floored so a countdown never reads one too high. */
function countdown(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The one compact Loom surface. */
export class Loom {
  readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly header: HTMLElement;
  private readonly destButton: HTMLButtonElement;
  private readonly viewingEl: HTMLElement;
  private readonly refButton: HTMLButtonElement;
  private readonly hideButton: HTMLButtonElement;
  private readonly moreButton: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private readonly body: HTMLElement;
  private readonly contextEl: HTMLElement;
  private readonly referenceEl: HTMLElement;
  private readonly chooserEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly savedEl: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly durationEl: HTMLElement;
  private readonly momentEl: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly resume: HTMLElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly resumeDismiss: HTMLButtonElement;
  /**
   * The opening's one line in the status row, while a draft is open. It is the
   * same strip that fills the whole surface when nothing is being written, moved
   * between the two homes rather than duplicated.
   */
  private readonly portalLine: HTMLElement;
  private readonly portalRealm: HTMLElement;
  private readonly portalWhen: HTMLElement;
  private readonly portalState: HTMLElement;
  private readonly portalOpen: HTMLButtonElement;
  private portalAction: (() => void) | null = null;

  private readonly rendered = new Component();
  private mountedIn: Mounted | null = null;
  private unsubscribeClock: (() => void) | null = null;
  private composing = false;
  private measuredHeight = 0;
  private view: View = "write";
  private referenceExpanded = false;
  private menuOpen = false;
  private discardArmed = false;
  private destroyed = false;
  private returnFocus: HTMLElement | null = null;
  private layoutFrame: number | null = null;
  private hintEl: HTMLElement | null = null;
  private hintTimer: number | null = null;
  private lastSavedKey = "";
  private bodyScroll = 0;
  /** The one search field, kept across renders so typing is never interrupted. */
  private searchField: HTMLInputElement | null = null;
  /** The head/body nodes of the reference, rebuilt when the reading changes. */
  private referenceNodes: HTMLElement[] = [];
  /** Whether the reference is in search mode, to focus the field only once. */
  private searching = false;
  /** What the resume strip's main button will do, captured by its last render. */
  private resumeAction: (() => void) | null = null;
  /** What the resume strip's quiet button will do, when it is shown. */
  private resumeDismissAction: (() => void) | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => this.handleKey(event);
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (!event.metaKey || !event.altKey) this.clearHints();
  };
  /**
   * The save chord, taken in the window's capture phase while focus is inside
   * the Loom.
   *
   * Obsidian's own key scope runs in the document's capture phase and claims
   * `Mod-Enter` for "Open link under cursor in new tab", so a listener on the
   * textarea never sees the chord — and while the composer has focus that
   * Obsidian command cannot mean anything. Claiming it one phase earlier, only
   * for events whose target is inside the surface, makes `⌘↵` do what its
   * footer says without touching the chord anywhere else in the app.
   */
  private readonly onCaptureKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || event.altKey) return;
    if (!event.metaKey && !event.ctrlKey) return;
    if (event.isComposing || this.composing) return;
    if (this.view !== "write" || this.mountedIn === null) return;
    const target = event.target;
    const node = target instanceof Node || target instanceof HTMLElement ? target : null;
    if (node === null || !this.root.contains(node)) return;
    event.preventDefault();
    event.stopPropagation();
    void this.save();
  };
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.menuOpen) return;
    const target = event.target;
    if (target instanceof Node && (this.menu.contains(target) || this.moreButton.contains(target))) return;
    this.menuOpen = false;
    this.render();
  };

  constructor(private readonly host: LoomHost) {
    const doc = document;
    this.root = doc.createElement("div");
    this.root.className = "weaver-composer";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Loom");
    this.root.setAttribute("aria-modal", "false");
    this.root.setAttribute("hidden", "");

    this.card = doc.createElement("div");
    this.card.className = "weaver-composer-card";
    this.card.setAttribute("hidden", "");

    this.header = doc.createElement("div");
    this.header.className = "weaver-composer-header";

    this.destButton = doc.createElement("button");
    this.destButton.type = "button";
    this.destButton.className = "weaver-composer-dest";

    this.viewingEl = doc.createElement("span");
    this.viewingEl.className = "weaver-composer-viewing";
    this.viewingEl.setAttribute("hidden", "");

    this.refButton = doc.createElement("button");
    this.refButton.type = "button";
    this.refButton.className = "weaver-composer-ref-toggle";
    this.refButton.textContent = "Reference";
    this.refButton.setAttribute("aria-expanded", "false");
    this.refButton.setAttribute("hidden", "");

    this.hideButton = doc.createElement("button");
    this.hideButton.type = "button";
    this.hideButton.className = "weaver-composer-hide";
    this.hideButton.textContent = "Hide";

    this.moreButton = doc.createElement("button");
    this.moreButton.type = "button";
    this.moreButton.className = "weaver-composer-more";
    this.moreButton.textContent = "⋯";
    this.moreButton.setAttribute("aria-label", "More");

    this.menu = doc.createElement("div");
    this.menu.className = "weaver-composer-menu";
    this.menu.setAttribute("role", "menu");
    this.menu.setAttribute("hidden", "");
    this.buildMenu(doc);

    this.header.appendChild(this.destButton);
    this.header.appendChild(this.viewingEl);
    this.header.appendChild(this.refButton);
    this.header.appendChild(this.hideButton);
    this.header.appendChild(this.moreButton);

    this.body = doc.createElement("div");
    this.body.className = "weaver-composer-body";

    this.contextEl = doc.createElement("div");
    this.contextEl.className = "weaver-composer-context";
    this.contextEl.setAttribute("hidden", "");

    this.referenceEl = doc.createElement("div");
    this.referenceEl.className = "weaver-composer-reference";
    this.referenceEl.setAttribute("hidden", "");
    // The panel takes focus when a search ends, so `↑`/`↓`/`/`/`Enter` keep
    // reaching the Loom even though no field is focused.
    this.referenceEl.tabIndex = -1;

    this.chooserEl = doc.createElement("div");
    this.chooserEl.className = "weaver-composer-chooser";
    this.chooserEl.setAttribute("hidden", "");
    // A panel must be able to hold focus: the field it replaces is hidden, and a
    // focus that falls to the body would stop Escape reaching the Loom.
    this.chooserEl.tabIndex = -1;

    this.statusEl = doc.createElement("div");
    this.statusEl.className = "weaver-composer-status";
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("hidden", "");

    // The strip's three facts and its one action. The line is built once and
    // re-used, so a ticking countdown only changes text, never the row it lives
    // in.
    this.portalLine = doc.createElement("div");
    this.portalLine.className = "weaver-composer-portal";
    this.portalLine.setAttribute("hidden", "");
    this.portalRealm = doc.createElement("span");
    this.portalRealm.className = "weaver-composer-portal-realm";
    this.portalWhen = doc.createElement("span");
    this.portalWhen.className = "weaver-composer-portal-opening";
    this.portalState = doc.createElement("span");
    this.portalState.className = "weaver-composer-portal-state";
    this.portalOpen = doc.createElement("button");
    this.portalOpen.type = "button";
    this.portalOpen.className = "weaver-composer-portal-open";
    this.portalOpen.textContent = "Weave";
    this.portalLine.appendChild(this.portalRealm);
    this.portalLine.appendChild(this.portalWhen);
    this.portalLine.appendChild(this.portalState);
    this.portalLine.appendChild(this.portalOpen);

    this.input = doc.createElement("textarea");
    this.input.className = "weaver-composer-input";
    this.input.setAttribute("aria-label", "Write a thought");
    this.input.spellcheck = false;
    this.input.rows = 1;

    this.savedEl = doc.createElement("div");
    this.savedEl.className = "weaver-composer-saved";
    this.savedEl.setAttribute("hidden", "");
    // After a save the textarea is hidden and focus would otherwise fall to the
    // body, where the Loom's own Escape handler can never hear it. The reading
    // takes focus instead, so one Escape always puts the surface away.
    this.savedEl.tabIndex = -1;

    this.body.appendChild(this.contextEl);
    this.body.appendChild(this.referenceEl);
    this.body.appendChild(this.chooserEl);
    this.body.appendChild(this.savedEl);
    this.body.appendChild(this.input);
    this.body.appendChild(this.statusEl);
    this.body.addEventListener("scroll", () => {
      this.bodyScroll = this.body.scrollTop;
    });

    this.footer = doc.createElement("div");
    this.footer.className = "weaver-composer-footer";

    this.durationEl = doc.createElement("span");
    this.durationEl.className = "weaver-composer-duration";
    this.durationEl.setAttribute("aria-hidden", "true");

    this.momentEl = doc.createElement("span");
    this.momentEl.className = "weaver-composer-moment";
    this.momentEl.setAttribute("aria-hidden", "true");

    this.saveButton = doc.createElement("button");
    this.saveButton.type = "button";
    this.saveButton.className = "weaver-composer-save";

    this.footer.appendChild(this.durationEl);
    this.footer.appendChild(this.momentEl);
    this.footer.appendChild(this.saveButton);

    this.card.appendChild(this.header);
    this.card.appendChild(this.body);
    this.card.appendChild(this.footer);

    this.resume = doc.createElement("div");
    this.resume.className = "weaver-composer-resume";
    this.resume.setAttribute("hidden", "");

    this.resumeButton = doc.createElement("button");
    this.resumeButton.type = "button";
    this.resumeButton.className = "weaver-composer-resume-open";
    this.resumeDismiss = doc.createElement("button");
    this.resumeDismiss.type = "button";
    this.resumeDismiss.className = "weaver-composer-resume-dismiss";
    this.resumeDismiss.textContent = "Hide";
    this.resumeDismiss.setAttribute("hidden", "");
    this.resume.appendChild(this.resumeButton);
    this.resume.appendChild(this.resumeDismiss);

    this.root.appendChild(this.card);
    this.root.appendChild(this.resume);
    // Outside the card: the card clips its own content, so a menu inside it
    // would be cut off on a short draft. The fix is that the root lays the menu
    // over the card rather than the card containing it.
    this.root.appendChild(this.menu);

    this.wireInput();
    this.destButton.addEventListener("click", () => {
      if (this.view === "chooser") this.returnToWrite();
      else this.beginPanel("chooser");
    });
    this.refButton.addEventListener("click", () => this.toggleReference());
    this.hideButton.addEventListener("click", () => this.hide());
    this.moreButton.addEventListener("click", () => {
      this.menuOpen = !this.menuOpen;
      this.render();
      // Opening hands the keys to the menu; closing puts them back on its
      // invoker, so Escape always has somewhere to land.
      if (this.menuOpen) this.menu.querySelector("button")?.focus();
      else this.moreButton.focus();
    });
    // The resume strip's two buttons act on whatever it is showing right now, so
    // they are bound once, here, and read `renderResume`'s recorded intent. A
    // per-render `onclick` would stack on top of a permanent listener and fire
    // both actions.
    this.resumeButton.addEventListener("click", () => this.activateResume());
    this.resumeDismiss.addEventListener("click", () => this.dismissResume());
    this.portalOpen.addEventListener("click", () => this.portalAction?.());
    this.saveButton.addEventListener("click", () => void this.save());
  }

  private activateResume(): void {
    this.resumeAction?.();
  }

  private dismissResume(): void {
    this.resumeDismissAction?.();
  }

  /** True while the surface is on screen. */
  get isOpen(): boolean {
    return !this.destroyed && this.mountedIn !== null && !this.root.hasAttribute("hidden");
  }

  /** Mounts the Loom in `owner`, adopting the same element. */
  mount(owner: Document = document): void {
    if (this.destroyed) return;
    if (this.mountedIn !== null && this.mountedIn.document === owner) {
      this.render();
      return;
    }
    this.mountedIn?.release();
    owner.body.appendChild(this.root);

    const window = owner.defaultView ?? globalThis.window;
    const onPointer = (event: PointerEvent): void => this.onPointerDown(event);
    const onKey = (event: KeyboardEvent): void => this.onKeyDown(event);
    const onKeyUp = (event: KeyboardEvent): void => this.onKeyUp(event);
    const onCapture = (event: KeyboardEvent): void => this.onCaptureKey(event);
    // The soft keyboard shrinks/offsets the visual viewport without resizing the
    // window; re-anchor whenever either viewport moves.
    const onViewport = (): void => {
      this.growInput();
      this.layout();
    };
    owner.addEventListener("pointerdown", onPointer);
    this.root.addEventListener("keydown", onKey);
    this.root.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("resize", onViewport);
    window.visualViewport?.addEventListener("resize", onViewport);
    window.visualViewport?.addEventListener("scroll", onViewport);

    this.mountedIn = {
      document: owner,
      window,
      release: () => {
        owner.removeEventListener("pointerdown", onPointer);
        this.root.removeEventListener("keydown", onKey);
        this.root.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("keydown", onCapture, true);
        window.removeEventListener("resize", onViewport);
        window.visualViewport?.removeEventListener("resize", onViewport);
        window.visualViewport?.removeEventListener("scroll", onViewport);
        if (this.unsubscribeClock !== null) {
          this.unsubscribeClock();
          this.unsubscribeClock = null;
        }
        this.root.remove();
      }
    };

    this.unsubscribeClock = this.host.clock.subscribe(() => this.paintClock());
    this.render();
    if (this.measuredHeight === 0) this.measure();
  }

  /** Remembers what had focus, so Hide can put it back. */
  rememberFocus(): void {
    const active = this.mountedIn?.document.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;
  }

  /** Focuses the prose, after making the surface visible. */
  focusInput(): void {
    this.restoreSelection();
    this.input.focus();
  }

  /** Restores the recorded caret into the textarea. */
  restoreSelection(): void {
    const selection = this.host.controller.state.selection;
    if (this.input.value === this.host.controller.state.text) {
      this.input.setSelectionRange(selection.from, selection.to);
    }
  }

  /** Opens a contextual panel, preserving the draft's scroll position. */
  private beginPanel(view: View): void {
    if (this.view === "write") this.bodyScroll = this.body.scrollTop;
    this.view = view;
    this.render();
    // The panel replaces the field, so it takes the keys from it.
    this.chooserEl.focus();
  }

  /** Returns to the draft, restoring the scroll position it had before. */
  private returnToWrite(focus = true): void {
    this.view = "write";
    this.render();
    this.body.scrollTop = this.bodyScroll;
    if (focus) this.focusInput();
  }

  /** Opens a contextual panel in place of the content area. */
  showPanel(panel: "reference" | "tapestries" | "invitations"): void {
    if (panel === "reference") {
      this.referenceExpanded = true;
      this.view = "write";
    } else if (panel === "tapestries") {
      this.view = "chooser";
    } else {
      this.view = "invitations";
    }
    this.render();
    if (this.view === "write") this.referenceEl.focus();
    else this.chooserEl.focus();
  }

  /**
   * One control for the reference, from the header and the menu alike.
   *
   * Both routes mean the same thing: show the reading above the prose, or put
   * it away. Collapsing never touches the draft's text, timing or scroll.
   */
  private toggleReference(): void {
    this.referenceExpanded = !this.referenceExpanded;
    if (this.view !== "write") {
      this.view = "write";
      this.body.scrollTop = this.bodyScroll;
    }
    if (this.referenceExpanded) void this.host.reference?.refresh();
    this.render();
    // Opening the reading hands it the keys; the draft keeps its text and clock,
    // and clicking back into the prose takes them back.
    if (
      this.referenceExpanded &&
      this.host.reference !== undefined &&
      this.host.reference.model.search.kind !== "editing"
    ) {
      this.referenceEl.focus();
    }
  }

  /** Takes the surface out of the document. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mountedIn?.release();
    this.mountedIn = null;
    this.rendered.unload();
    this.clearHints();
    if (this.layoutFrame !== null) {
      window.cancelAnimationFrame?.(this.layoutFrame);
      this.layoutFrame = null;
    }
  }

  /** Draws the surface from the controller and reference projections. */
  render(): void {
    if (this.destroyed || this.mountedIn === null) return;
    const state = this.host.controller.state;
    // The strip has two homes: the whole surface when nothing is being written,
    // and one line of the draft's status row while it is. Fetch it for every
    // phase and let the phase decide which home draws it.
    const strip = this.host.portalStrip();

    if (state.phase === "closed" && strip === null) {
      this.hideElement();
      return;
    }

    this.root.removeAttribute("hidden");
    this.root.setAttribute("data-phase", state.phase);
    this.root.setAttribute("data-collapsed", String(state.collapsed));
    this.root.setAttribute("data-view", this.view);

    if (state.phase === "closed") {
      this.renderResume(strip);
      this.layout();
      return;
    }

    if (state.collapsed) {
      this.renderResume(null, state);
      this.layout();
      return;
    }

    this.renderCard(state, strip);
    this.layout();
  }

  private renderCard(state: CaptureView, strip: PortalStripView | null): void {
    this.card.removeAttribute("hidden");
    this.resume.setAttribute("hidden", "");
    // Paint the dimension before the first frame of content: the box, the prose
    // and the Save action all read these two properties.
    this.paintDimension(state);
    this.destButton.textContent = this.destinationLabel(state);
    this.destButton.setAttribute("aria-label", `Destination: ${this.destinationLabel(state)}`);

    const viewing = this.host.contexts().find((context) => context.id === this.host.viewing())?.name ?? null;
    const differs = viewing !== null && this.host.viewing() !== "" && this.host.viewing() !== state.contextId;
    if (differs) {
      this.viewingEl.textContent = `viewing ${viewing}`;
      this.viewingEl.removeAttribute("hidden");
    } else {
      this.viewingEl.setAttribute("hidden", "");
    }

    this.setVisible(this.refButton, this.host.reference !== undefined && !isPhone());
    this.refButton.setAttribute("aria-expanded", String(this.referenceExpanded));
    this.setVisible(this.menu, this.menuOpen);

    this.renderContext(state);
    this.renderStatus(state, strip);

    if (this.view === "chooser") {
      this.setVisible(this.chooserEl, true);
      this.setVisible(this.input, false);
      this.setVisible(this.savedEl, false);
      this.setVisible(this.referenceEl, false);
      this.setVisible(this.footer, false);
      this.renderChooser();
      return;
    }
    if (this.view === "invitations") {
      this.setVisible(this.chooserEl, true);
      this.setVisible(this.input, false);
      this.setVisible(this.savedEl, false);
      this.setVisible(this.referenceEl, false);
      this.setVisible(this.footer, false);
      this.renderInvitations();
      return;
    }

    this.setVisible(this.chooserEl, false);
    this.setVisible(this.footer, true);

    if (state.phase === "resting") {
      this.setVisible(this.input, false);
      this.setVisible(this.savedEl, true);
      this.renderSaved(state);
    } else {
      this.setVisible(this.savedEl, false);
      this.setVisible(this.input, true);
      if (this.input.value !== state.text && this.mountedIn?.document.activeElement !== this.input) {
        this.input.value = state.text;
      }
      this.input.readOnly = state.phase === "submitting" || state.phase === "uncertain";
      this.growInput();
    }

    this.renderReference();
    const split =
      this.referenceExpanded &&
      this.host.reference !== undefined &&
      (this.mountedIn?.window.innerWidth ?? 1024) >= 720;
    this.body.setAttribute("data-layout", split ? "split" : "stacked");
    this.body.scrollTop = this.bodyScroll;
    this.saveButton.textContent = isMobile() ? "Save" : "Save ↵";
    this.saveButton.disabled =
      state.phase === "submitting" || state.phase === "uncertain" || state.pendingTarget !== null || state.text.trim() === "";
    this.paintClock();
  }

  private destinationLabel(state: CaptureView): string {
    const name = this.host.contexts().find((context) => context.id === state.contextId)?.name ?? state.contextId;
    return state.parent === null ? `Writing to ${name}` : `Branching · ${name}`;
  }

  private renderContext(state: CaptureView): void {
    const parent = state.parent;
    if (parent === null) {
      this.contextEl.setAttribute("hidden", "");
      this.contextEl.textContent = "";
      return;
    }
    this.contextEl.removeAttribute("hidden");
    this.contextEl.textContent = "";
    const label = this.doc().createElement("span");
    label.textContent = `Branching from ${formatAddress(parent.b, parent.d, parent.n)}`;
    const details = this.doc().createElement("details");
    const summary = this.doc().createElement("summary");
    summary.textContent = excerpt(parent.prose) || "parent";
    const prose = this.doc().createElement("p");
    prose.textContent = parent.prose;
    details.appendChild(summary);
    details.appendChild(prose);
    this.contextEl.appendChild(label);
    this.contextEl.appendChild(details);
  }

  private renderStatus(state: CaptureView, strip: PortalStripView | null): void {
    const doc = this.doc();
    this.statusEl.textContent = "";
    const actions: HTMLElement[] = [];
    // An opening says one line here while a draft is open; the surface is not
    // split into two cards for it.
    const portal = state.phase === "editing" ? strip : null;
    let message = state.error ?? (state.phase === "submitting" ? "Saving…" : null);
    // An error is the one message that must be able to shout.
    if (state.error !== null) this.statusEl.setAttribute("data-kind", "error");
    else this.statusEl.removeAttribute("data-kind");

    if (state.pendingTarget !== null) {
      message = "Use this destination?";
      const use = doc.createElement("button");
      use.type = "button";
      use.className = "weaver-composer-save";
      use.textContent = "Use";
      use.addEventListener("click", () => {
        this.host.controller.confirmTarget();
        this.render();
      });
      const keep = doc.createElement("button");
      keep.type = "button";
      keep.className = "weaver-composer-quiet-close";
      keep.textContent = "Keep original";
      keep.addEventListener("click", () => {
        this.host.controller.cancelTarget();
        this.render();
      });
      actions.push(use, keep);
    } else if (this.discardArmed && state.phase === "editing") {
      // The confirmation is part of the status row, not a message that the next
      // render erases: arming twice is the same one decision, and it survives
      // until it is answered, cancelled or the draft changes.
      message = "Discard this draft?";
      const discard = doc.createElement("button");
      discard.type = "button";
      discard.className = "weaver-composer-save";
      discard.textContent = "Discard";
      discard.addEventListener("click", () => {
        this.discardArmed = false;
        this.host.controller.discardDraft();
        this.view = "write";
        this.render();
      });
      const keep = doc.createElement("button");
      keep.type = "button";
      keep.className = "weaver-composer-quiet-close";
      keep.textContent = "Keep writing";
      keep.addEventListener("click", () => {
        this.discardArmed = false;
        this.render();
      });
      actions.push(discard, keep);
    } else if (state.phase === "uncertain") {
      const check = doc.createElement("button");
      check.type = "button";
      check.className = "weaver-composer-save";
      check.textContent = "Check save";
      check.addEventListener("click", () => {
        void this.host.controller.checkSave().then(() => this.render());
      });
      actions.push(check);
    }

    if (message === null && actions.length === 0 && portal === null) {
      this.statusEl.setAttribute("hidden", "");
      return;
    }
    this.statusEl.removeAttribute("hidden");
    if (message !== null) {
      const span = doc.createElement("span");
      span.textContent = message;
      this.statusEl.appendChild(span);
    }
    for (const action of actions) this.statusEl.appendChild(action);
    if (portal !== null) {
      this.paintPortal(portal);
      this.statusEl.appendChild(this.portalLine);
    }
  }

  private renderChooser(): void {
    const doc = this.doc();
    this.chooserEl.textContent = "";
    const title = doc.createElement("div");
    title.className = "weaver-composer-chooser-title";
    title.textContent = "Write into";
    const back = doc.createElement("button");
    back.type = "button";
    back.className = "weaver-composer-quiet-close";
    back.textContent = "Back";
    back.addEventListener("click", () => this.returnToWrite());
    title.appendChild(back);
    this.chooserEl.appendChild(title);

    const current = this.host.controller.state.contextId;
    for (const context of this.host.contexts()) {
      const row = doc.createElement("div");
      row.className = "weaver-composer-chooser-row";
      const name = doc.createElement("span");
      name.textContent = context.name;
      row.appendChild(name);
      if (context.id === current) {
        // The draft is already here; a button that re-proposes the same
        // destination would only ask a question with one answer.
        const here = doc.createElement("span");
        here.className = "weaver-composer-chooser-here";
        here.textContent = "Writing here";
        row.appendChild(here);
      } else {
        const write = doc.createElement("button");
        write.type = "button";
        write.className = "weaver-composer-chooser-write";
        write.textContent = "Write here";
        write.addEventListener("click", () => {
          this.host.writeHere?.(context.id);
          this.returnToWrite();
        });
        row.appendChild(write);
      }
      const travel = doc.createElement("button");
      travel.type = "button";
      travel.className = "weaver-composer-chooser-travel";
      travel.textContent = "Open workspace";
      travel.addEventListener("click", () => {
        void this.host.travel(context.id).then((travelled) => {
          // A completed visit leaves the chooser behind: it was a map, and the
          // writer is now somewhere on it.
          if (travelled) this.returnToWrite(false);
        });
      });
      row.appendChild(travel);
      this.chooserEl.appendChild(row);
    }
  }

  private renderInvitations(): void {
    const doc = this.doc();
    this.chooserEl.textContent = "";
    const title = doc.createElement("div");
    title.className = "weaver-composer-chooser-title";
    title.textContent = "Invitations";
    const back = doc.createElement("button");
    back.type = "button";
    back.className = "weaver-composer-quiet-close";
    back.textContent = "Back";
    back.addEventListener("click", () => this.returnToWrite());
    title.appendChild(back);
    this.chooserEl.appendChild(title);

    const offers = this.host.invitations?.() ?? [];
    if (offers.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "weaver-composer-chooser-row";
      empty.textContent = "No invitations right now.";
      this.chooserEl.appendChild(empty);
      return;
    }
    for (const offer of offers) {
      const row = doc.createElement("div");
      row.className = "weaver-composer-chooser-row";
      const name = doc.createElement("span");
      name.textContent = `${offer.name} · ${offer.opening}`;
      row.appendChild(name);
      const open = doc.createElement("button");
      open.type = "button";
      open.className = "weaver-composer-chooser-write";
      open.textContent = "Open";
      open.addEventListener("click", () => {
        this.host.takeInvitation?.(offer.id);
        this.returnToWrite(false);
      });
      row.appendChild(open);
      const hide = doc.createElement("button");
      hide.type = "button";
      hide.className = "weaver-composer-chooser-travel";
      hide.textContent = "Hide";
      hide.addEventListener("click", () => {
        this.host.dismissInvitation?.(offer.id);
        this.render();
      });
      row.appendChild(hide);
      this.chooserEl.appendChild(row);
    }
  }

  private renderReference(): void {
    const controller = this.host.reference;
    const active = this.referenceExpanded && controller !== undefined;
    this.setVisible(this.referenceEl, active);
    if (!active || controller === undefined) {
      this.dropReferenceNodes();
      this.searching = false;
      return;
    }
    const model = controller.model;
    const doc = this.doc();

    if (model.search.kind === "editing") {
      const field = this.searchField ?? this.createSearchField(controller);
      if (field.value !== model.search.text) field.value = model.search.text;
      field.removeAttribute("hidden");
      // Focus once, on the way in. Focusing on every render would pull the caret
      // to the end of the query after every keystroke.
      if (!this.searching) {
        this.searching = true;
        field.focus();
      }
    } else {
      this.searching = false;
      this.searchField?.setAttribute("hidden", "");
    }

    this.dropReferenceNodes();
    const head = doc.createElement("div");
    head.className = "weaver-composer-reference-head";
    if (model.readiness.kind === "loading") head.textContent = "Reading…";
    else if (model.readiness.kind === "failed") head.textContent = model.readiness.message;
    else head.textContent = this.positionOf(model);
    this.referenceEl.appendChild(head);
    this.referenceNodes.push(head);

    if (model.body.kind === "ready") {
      const body = doc.createElement("div");
      body.className = "weaver-composer-reference-body";
      body.textContent = model.body.snapshot.text;
      this.referenceEl.appendChild(body);
      this.referenceNodes.push(body);
    }
  }

  /** The one search field: created once, then only shown, hidden and synced. */
  private createSearchField(controller: ReferenceController): HTMLInputElement {
    const search = this.doc().createElement("input");
    search.type = "search";
    search.className = "weaver-composer-reference-search";
    search.setAttribute("aria-label", "Search thoughts");
    search.addEventListener("input", () => void controller.setSearchText(search.value));
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (!controller.acceptSearch()) return;
      // The field disappears on acceptance; the panel takes the keys back so
      // `↑`/`↓`/`/`/`Enter` still reach the Loom.
      this.referenceEl.focus();
      this.render();
    });
    this.referenceEl.appendChild(search);
    this.searchField = search;
    return search;
  }

  /** Removes the head and body of the reading, keeping the search field. */
  private dropReferenceNodes(): void {
    for (const node of this.referenceNodes) node.remove();
    this.referenceNodes = [];
  }

  private positionOf(model: ReferenceModel): string {
    if (model.readiness.kind !== "ready") return "";
    const total = model.readiness.sequence.members.length;
    const at =
      model.selection === null
        ? 0
        : model.readiness.sequence.members.findIndex(
            (record) => record.thought.n === model.selection?.n && record.thought.path === model.selection?.path
          ) + 1;
    const address = model.selection !== null ? formatAddress(model.selection.b, model.selection.d, model.selection.n) : "";
    return at > 0 ? `${at} of ${total}${address ? ` · ${address}` : ""}` : `${total} thoughts`;
  }

  private renderSaved(state: CaptureView): void {
    const saved = state.selected ?? state.root;
    const doc = this.doc();
    const key = saved === null ? "" : `${saved.path}#${saved.n}:${saved.prose}`;
    if (key === this.lastSavedKey && this.savedEl.textContent !== "") {
      this.renderSavedActions(saved);
      return;
    }
    this.lastSavedKey = key;
    this.savedEl.textContent = "";

    if (saved !== null) {
      const address = doc.createElement("div");
      address.className = "weaver-composer-saved-address";
      address.textContent = formatAddress(saved.b, saved.d, saved.n);
      const prose = doc.createElement("div");
      prose.className = "weaver-composer-saved-prose";
      this.rendered.unload();
      this.host.renderMarkdown(prose, saved.prose, saved.path, this.rendered);
      this.savedEl.appendChild(address);
      this.savedEl.appendChild(prose);
    }
    this.renderSavedActions(saved);
  }

  private renderSavedActions(saved: ThoughtRef | null): void {
    const doc = this.doc();
    const existing = this.savedEl.querySelector(".weaver-composer-saved-actions");
    existing?.remove();
    const actions = doc.createElement("div");
    actions.className = "weaver-composer-saved-actions";

    const branch = doc.createElement("button");
    branch.type = "button";
    branch.className = "weaver-composer-branch";
    branch.textContent = "Branch";
    branch.disabled = saved === null;
    branch.addEventListener("click", () => {
      if (saved !== null) void this.host.controller.branch(saved);
    });
    actions.appendChild(branch);

    const fresh = doc.createElement("button");
    fresh.type = "button";
    fresh.className = "weaver-composer-new";
    fresh.textContent = "New Thread";
    fresh.addEventListener("click", () => void this.host.controller.newThread());
    actions.appendChild(fresh);

    const close = doc.createElement("button");
    close.type = "button";
    close.className = "weaver-composer-quiet-close";
    close.textContent = "Close";
    close.addEventListener("click", () => this.hide());
    actions.appendChild(close);

    this.savedEl.appendChild(actions);
  }

  private renderResume(strip: PortalStripView | null, state?: CaptureView): void {
    this.setVisible(this.card, false);
    this.setVisible(this.resume, true);

    if (strip !== null) {
      this.resumeButton.textContent = stripLabel(strip);
      this.resumeButton.setAttribute("aria-label", `Open the ${strip.opening} invitation in ${strip.contextName}`);
      // Only an opening that is still enterable can be put away.
      this.setVisible(this.resumeDismiss, strip.phase !== "closed");
      this.resumeDismiss.setAttribute("aria-label", "Hide this invitation");
      this.resumeAction = () => this.host.weaveOpening(strip.occurrenceId);
      this.resumeDismissAction = () => {
        this.host.dismissOpening(strip.occurrenceId);
        this.render();
      };
      return;
    }

    this.setVisible(this.resumeDismiss, false);
    if (state === undefined) {
      this.resumeAction = null;
      this.resumeDismissAction = null;
      return;
    }
    const name = this.host.contexts().find((context) => context.id === state.contextId)?.name ?? state.contextId;
    const text = excerpt(state.text) || "Untitled draft";
    this.resumeButton.textContent = `${name} · ${text}`;
    this.resumeButton.setAttribute("aria-label", `Resume the draft in ${name}`);
    this.resumeAction = () => {
      this.host.controller.expand();
      this.render();
      this.focusInput();
    };
    this.resumeDismissAction = null;
  }

  /**
   * Paints the opening's one line, or hides it. Called both by a full render and
   * by the clock's tick: the countdown is the only thing that changes between
   * them, so the row itself is never rebuilt while it ticks.
   */
  private paintPortal(strip: PortalStripView | null): void {
    if (strip === null) {
      this.portalLine.setAttribute("hidden", "");
      this.portalAction = null;
      return;
    }
    this.portalLine.removeAttribute("hidden");
    this.portalLine.setAttribute("data-phase", strip.phase);
    this.portalRealm.textContent = strip.contextName;
    this.portalWhen.textContent = strip.opening;
    this.portalState.textContent = stripPhase(strip);
    // A closed minute is a fact, not a control: there is nothing left to enter.
    const enterable = strip.phase !== "closed";
    this.setVisible(this.portalOpen, enterable);
    this.portalOpen.setAttribute(
      "aria-label",
      `Open the ${strip.opening} invitation in ${strip.contextName}`
    );
    this.portalAction = enterable ? () => this.host.weaveOpening(strip.occurrenceId) : null;
  }

  private paintClock(): void {
    const state = this.host.controller.state;
    // The clock is the only thing that moves an opening's countdown, so the line
    // is repainted here rather than by a second timer or a whole render.
    this.paintPortal(state.phase === "editing" ? this.host.portalStrip() : null);
    if (state.phase === "resting") {
      this.durationEl.textContent = "";
      this.momentEl.textContent = state.selected?.time ?? "";
      return;
    }
    if (state.phase === "closed") {
      this.durationEl.textContent = "";
      this.momentEl.textContent = "";
      return;
    }
    this.durationEl.textContent = formatDuration(state.durationMs);
    const now = this.host.clock.snapshot().now;
    this.momentEl.textContent = formatTimeOfDay(new Date(now));
  }

  private buildMenu(doc: Document): void {
    const item = (label: string, action: () => void): void => {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "weaver-composer-menu-item";
      button.textContent = label;
      button.addEventListener("click", () => {
        this.menuOpen = false;
        // The prose is the surface's home: an action that wants another target
        // moves focus there itself. Without this, the hidden menu item would
        // drop focus to the body and Escape would stop reaching the Loom.
        this.focusInput();
        action();
        this.render();
      });
      this.menu.appendChild(button);
    };
    item("Reference", () => this.toggleReference());
    item("Tapestries", () => this.beginPanel("chooser"));
    item("Invitations", () => this.beginPanel("invitations"));
    item("Copy", () => {
      void this.copyDraft();
    });
    item("Discard", () => this.armDiscard());
  }

  private armDiscard(): void {
    const text = this.host.controller.state.text;
    if (text.trim() === "") {
      this.discardArmed = false;
      this.host.controller.discardDraft();
      this.view = "write";
      return;
    }
    // The status row draws the confirmation, so it is visible as long as the
    // decision is open — including after the menu has closed.
    this.discardArmed = true;
  }

  private async copyDraft(): Promise<void> {
    const text = this.host.controller.state.text;
    try {
      const clipboard = this.mountedIn?.window.navigator.clipboard;
      await clipboard?.writeText(text);
      this.statusEl.removeAttribute("data-kind");
      this.statusEl.removeAttribute("hidden");
      this.statusEl.textContent = "Draft copied.";
    } catch {
      this.statusEl.setAttribute("data-kind", "error");
      this.statusEl.removeAttribute("hidden");
      this.statusEl.textContent = "The draft could not be copied; select it and copy.";
    }
  }

  private wireInput(): void {
    this.input.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.input.addEventListener("compositionend", () => {
      this.composing = false;
      this.syncText();
    });
    this.input.addEventListener("input", () => this.syncText());
    this.input.addEventListener("keydown", (event) => {
      if (event.isComposing || this.composing) return;
      // Return commits; Shift+Return is the newline. The composer is a capture
      // surface, not a prose editor: the common gesture must be the one that
      // finishes the thought, and the textarea keeps the rare one behind Shift.
      if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        void this.save();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.save();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.handleEscape();
      }
    });
  }

  private syncText(): void {
    if (this.composing) return;
    const from = this.input.selectionStart;
    const to = this.input.selectionEnd;
    this.host.controller.setText(this.input.value, { from, to });
    this.growInput();
  }

  private growInput(): void {
    this.input.style.height = "auto";
    const max = this.usableHeight();
    const next = Math.min(this.input.scrollHeight, Math.max(48, max));
    this.input.style.height = `${next}px`;
    this.measure();
  }

  private async save(): Promise<void> {
    const state = this.host.controller.state;
    if (state.phase === "resting" || state.phase === "closed") return;
    if (state.phase === "submitting" || state.phase === "uncertain") return;
    // An empty draft is refused by the controller with a notice, so the chord
    // still answers instead of doing nothing.
    await this.host.controller.settle();
    this.input.blur();
    this.view = "write";
    this.render();
    // Nobody else owns the keys now: hand them to the reading so Escape can
    // always close the Loom after a thought has been entered.
    if (this.host.controller.state.phase === "resting") this.savedEl.focus();
  }

  private hide(): void {
    this.menuOpen = false;
    this.view = "write";
    this.host.controller.dismiss();
    this.render();
    const focus = this.returnFocus;
    if (focus !== null && focus.isConnected) focus.focus();
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.isComposing || this.composing) return;
    if (event.defaultPrevented) return;
    if (event.metaKey && event.altKey) this.scheduleHints();

    if (event.key === "Escape") {
      if (this.menuOpen) {
        event.preventDefault();
        this.menuOpen = false;
        this.render();
        this.moreButton.focus();
        return;
      }
      if (this.host.reference?.model.search.kind === "editing") {
        event.preventDefault();
        void this.host.reference.cancelSearch().then(() => this.referenceEl.focus());
        return;
      }
      if (this.view !== "write") {
        event.preventDefault();
        this.view = "write";
        this.render();
        return;
      }
      if (this.referenceExpanded) {
        event.preventDefault();
        this.referenceExpanded = false;
        this.render();
        return;
      }
      if (!isField(event.target)) this.handleEscape();
      return;
    }

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isField(event.target)) {
      event.preventDefault();
      void this.save();
      return;
    }

    // After a save, one more Return closes the reading — the same gesture that
    // finished the thought finishes the visit.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      this.host.controller.state.phase === "resting" &&
      !this.referenceExpanded &&
      !isControl(event.target)
    ) {
      event.preventDefault();
      this.hide();
      return;
    }

    if (this.referenceExpanded && !isControl(event.target)) {
      const reference = this.host.reference;
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && reference !== undefined) {
        event.preventDefault();
        reference.beginSearch();
        this.render();
        return;
      }
      if ((event.key === "ArrowUp" || event.key === "ArrowDown") && reference !== undefined) {
        event.preventDefault();
        void reference.move(event.key === "ArrowUp" ? "previous" : "next");
        return;
      }
      if (event.key === "Enter" && reference !== undefined) {
        // Enter accepts the match it is reading; once accepted, it opens the
        // selected original in its own note. Reading itself never travels.
        if (reference.model.search.kind === "editing") {
          event.preventDefault();
          if (reference.acceptSearch()) {
            this.referenceEl.focus();
            this.render();
          }
          return;
        }
        const selected = reference.model.selection;
        if (selected !== null) {
          event.preventDefault();
          void this.host.controller.editInNote(selected);
        }
        return;
      }
    }
  }

  private handleEscape(): void {
    if (this.discardArmed) {
      this.discardArmed = false;
      this.render();
      return;
    }
    this.hide();
  }

  private scheduleHints(): void {
    if (this.hintTimer !== null || this.hintEl !== null) return;
    this.hintTimer = this.mountedIn?.window.setTimeout(() => {
      this.hintTimer = null;
      if (this.hintEl === null) {
        const doc = this.mountedIn?.document;
        if (doc === undefined) return;
        const el = doc.createElement("div");
        el.className = "weaver-hint-layer";
        el.textContent = `↵ save · ⇧↵ newline · / search · Esc hide`;
        this.root.appendChild(el);
        this.hintEl = el;
      }
    }, 250) ?? null;
  }

  private clearHints(): void {
    if (this.hintTimer !== null) {
      this.mountedIn?.window.clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    this.hintEl?.remove();
    this.hintEl = null;
  }

  private measure(): void {
    if (this.destroyed) return;
    const visible = this.resume.hasAttribute("hidden") ? this.card : this.resume;
    const height = Math.round(visible.getBoundingClientRect().height);
    if (height === this.measuredHeight) return;
    this.measuredHeight = height;
    this.layout();
  }

  private layout(): void {
    if (this.mountedIn === null) return;
    if (this.layoutFrame !== null) return;
    const run = (): void => {
      this.layoutFrame = null;
      if (this.destroyed || this.mountedIn === null) return;
      this.applyBox();
    };
    const raf = this.mountedIn.window.requestAnimationFrame;
    if (typeof raf === "function") this.layoutFrame = raf(run);
    else run();
  }

  /**
   * The dimension the surface is speaking for.
   *
   * A root is written at depth 1; a branch one dimension below its parent. The
   * saved thought is shown in its own recorded dimension. Colour is a function of
   * this number alone, so the card, the prose and the Save action wear exactly
   * the colour the entry will have in the note.
   */
  private dimensionOf(state: CaptureView): number {
    if (state.parent !== null) return Math.max(1, state.parent.d + 1);
    const saved = state.selected ?? state.root;
    return saved === null ? 1 : saved.d;
  }

  /** Writes the dimension's colour onto the root before the first paint. */
  private paintDimension(state: CaptureView): void {
    const dimension = this.dimensionOf(state);
    this.root.setAttribute("data-d", String(dimension));
    this.root.style.setProperty("--weaver-dcolor", dimensionColor(dimension));
    this.root.style.setProperty("--weaver-d", String(dimension));
  }

  private applyBox(): void {
    if (this.mountedIn === null) return;
    const view = this.mountedIn.window;
    const layoutWidth = view.innerWidth ?? 1024;
    const layoutHeight = view.innerHeight ?? 768;
    const visual = view.visualViewport ?? null;
    const visualWidth = visual?.width ?? layoutWidth;
    const visualLeft = visual?.offsetLeft ?? 0;
    const keyboard = keyboardInset(layoutHeight, visual);
    const { width: loomW, inset } = loomWidth(Math.min(visualWidth, layoutWidth));
    const reserve = this.bottomReserve();
    const usable = this.usableHeight();
    const state = this.host.controller.state;
    const dimension = this.dimensionOf(state);

    // The surface hangs from the bottom of the *visible* area, so the keyboard
    // cannot cover it and its own height never moves that edge.
    const left = Math.round(visualLeft + Math.max(inset, (visualWidth - loomW) / 2));
    const bottom = Math.round(keyboard + inset + reserve);
    this.root.setAttribute(
      "style",
      [
        "position: fixed",
        `left: ${left}px`,
        `bottom: ${bottom}px`,
        `width: ${loomW}px`,
        `max-height: ${usable}px`,
        `--weaver-composer-max-height: ${usable}px`,
        dimensionColorVars(dimension)
      ].join("; ")
    );
    this.root.setAttribute("data-d", String(dimension));
  }

  private usableHeight(): number {
    const view = this.mountedIn?.window;
    if (view === undefined) return 480;
    const visual = view.visualViewport ?? null;
    const height = visual?.height ?? view.innerHeight ?? 768;
    const width = visual?.width ?? view.innerWidth ?? 1024;
    const reserve = this.bottomReserve();
    return Math.max(160, height - 2 * loomWidth(width).inset - reserve);
  }

  /** The host's mobile toolbar height, when it is on screen. */
  private bottomReserve(): number {
    const doc = this.mountedIn?.document;
    if (doc === undefined) return 0;
    const toolbar = doc.querySelector(".mobile-toolbar") as Element | null;
    if (toolbar === null) return 0;
    const height = toolbar.getBoundingClientRect().height;
    return height > 0 ? height : 0;
  }

  /** The document the surface is mounted in, or the ambient one before mount. */
  private doc(): Document {
    return this.mountedIn?.document ?? document;
  }

  private setVisible(element: HTMLElement, visible: boolean): void {
    if (visible) element.removeAttribute("hidden");
    else element.setAttribute("hidden", "");
  }

  private hideElement(): void {
    this.root.setAttribute("hidden", "");
    this.menuOpen = false;
    this.clearHints();
  }
}
