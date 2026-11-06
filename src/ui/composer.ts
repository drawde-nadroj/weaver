/**
 * The one bottom surface: a thought being written, and the opening it may count
 * for.
 *
 * It is deliberately not a modal, not a leaf and not a widget inside a note. It
 * floats above the workspace, keeps its draft when the writer travels, and never
 * moves the note it is writing into. The surface speaks the note's own visual
 * language on purpose — the same dimension colour, the same rounded frame, the
 * same rails, the same digit grammar — because a thought written here lands in
 * that note, and a surface that looked like a different product would make the
 * writer guess what they were about to produce.
 *
 * Everything it knows arrives from `CaptureController` (the draft, its timing, its
 * one submission) and from its host (Realms, saved Threads, workspace travel,
 * openings). It writes nothing itself: no note byte changes until the controller
 * settles, and the only thing this file does to the vault is ask.
 *
 * Five details are load-bearing:
 *
 *  - **One surface.** The opening's status is a strip inside this card, not a
 *    second floating card, and the hidden draft is a strip at the same edge.
 *    There is never a moment where two Weaver surfaces compete for the bottom.
 *  - **Nothing reflows a note.** The surface is positioned from its own measured
 *    box, never from padding inserted into a note, so an entry's duration row
 *    cannot move because a composer appeared.
 *  - **Focus is never stolen back.** A late save, a re-render or a layout change
 *    may redraw the surface; only an explicit gesture focuses its input, and Hide
 *    returns focus to where it came from.
 *  - **The input is text, all the way down.** Inside it, letters and arrows are
 *    prose and caret movement. Structural motions belong to the selected saved
 *    thought, which is its own focusable target.
 *  - **Committing is one act.** An IME's preedit is never a beginning, a
 *    composition-confirming Enter is never a save, and a repeated key is never a
 *    second save.
 */

import { Component, MarkdownView, type App } from "obsidian";

import {
  moveThreadSelection,
  type ThreadMove,
  type ThreadView,
  type ThoughtRef
} from "../core/capture";
import { dimensionColorVars } from "../core/color";
import { formatClock as formatDuration } from "../core/duration";
import { formatMarker } from "../core/entries";
import type { WeavingContext } from "../core/contexts";
import {
  composerHeightShare,
  floatingComposerBox,
  type ComposerBox
} from "../core/frame";
import { isPlainObject } from "../core/value";
import type { EntryClock } from "../entries/clock";
import { CaptureController } from "../entries/capture";
import { appendDigitRuns } from "./dcn";
import { InvitationDock } from "./portal";
import { isPhone } from "./platform";

/** The air kept between the surface and the edges it floats above. */
const INSET = 12;

/** The height the surface asks for before any clamping. */
const WANTED_HEIGHT = 420;

/** What the composer needs from the plugin. */
export interface ComposerHost {
  app: App;
  controller: CaptureController;
  clock: EntryClock;
  /** Every Realm, `main` first. */
  contexts(): readonly WeavingContext[];
  /** The saved Thread a reference belongs to, read from its note. */
  loadThread(target: ThoughtRef): Promise<ThreadView | null>;
  /** Deliberate travel: snapshot here, restore there. */
  travel(contextId: string): Promise<boolean>;
  /** The Realm the workspace is showing, or the empty string when unknown. */
  viewing(): string;
  /**
   * Renders saved prose, so a link in a thought is still a link.
   *
   * The component is the surface's own: unloading it on the next paint is what
   * releases whatever the renderer subscribed to.
   */
  renderMarkdown(
    element: HTMLElement,
    markdown: string,
    sourcePath: string,
    component: Component
  ): void;
  /** Opens the navigator on its Realms tab, without travelling. */
  openRealms(): void;
  /** The opening this surface should speak about, if any. */
  portalStrip(): PortalStripView | null;
  /** Writes into an opening's Realm: the same composer, opened there. */
  weaveOpening(occurrenceId: string): void;
  /** Puts one opening away for this occurrence only. */
  dismissOpening(occurrenceId: string): void;
  /** Opens the navigator on its Portals tab. */
  openPortals(): void;
}

/** One opening, as the strip says it. */
export interface PortalStripView {
  /** The whole opportunity set the writer may act on. */
  occurrenceId: string;
  /** The Realm it invites writing into. */
  contextName: string;
  /** Its own local hour and minute, `04:33`. */
  opening: string;
  phase: "approaching" | "available" | "closed";
  /** Whole milliseconds until it opens, or until it closes. */
  remainingMs: number;
  /** How many more opportunities exist beyond this one. */
  others: number;
  /** True when an empty composer is open, so "closed" may say writing still works. */
  writingNormally: boolean;
  /** False when the gesture is only shown closed (a draft already exists). */
  actionable: boolean;
}

/** The document a composer is currently mounted in. */
interface Mounted {
  document: Document;
  window: Window;
  release(): void;
}

/**
 * The one composer.
 *
 * A single instance serves the app: opening it again is not a second surface but
 * a second gesture on the same draft, and moving it to another window adopts it
 * rather than building a twin.
 */
export class Composer {
  readonly root: HTMLElement;

  private readonly card: HTMLElement;
  private readonly railTop: HTMLElement;
  private readonly railBottom: HTMLElement;
  private readonly durationLabel: HTMLElement;
  private readonly momentLabel: HTMLElement;
  private readonly realmButton: HTMLButtonElement;
  private readonly viewingNote: HTMLElement;
  private readonly parentStrip: HTMLElement;
  private readonly outline: HTMLElement;
  private readonly selectionEl: HTMLElement;
  private readonly input: HTMLTextAreaElement;

  private readonly statusRow: HTMLElement;
  private readonly status: HTMLElement;
  private readonly through: HTMLElement;
  private readonly portalSlot: HTMLElement;
  private readonly actions: HTMLElement;

  private readonly saveButton: HTMLButtonElement;
  private readonly hideButton: HTMLButtonElement;
  private readonly branchButton: HTMLButtonElement;
  private readonly newThreadButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly checkButton: HTMLButtonElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly moreButton: HTMLButtonElement;

  private readonly morePanel: HTMLElement;
  private readonly editButton: HTMLButtonElement;
  private readonly discardButton: HTMLButtonElement;
  private readonly discardConfirm: HTMLElement;
  private readonly keepButton: HTMLButtonElement;

  private readonly resume: HTMLElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly stripSlot: HTMLElement;
  private readonly portal: InvitationDock;

  /** The lifecycle owner of whatever the last render of saved prose created. */
  private rendered = new Component();

  private mountedIn: Mounted | null = null;
  private unsubscribeClock: (() => void) | null = null;
  private composing = false;
  private afterComposition = false;
  private measuredHeight = 0;
  private moreOpen = false;
  private discardArmed = false;
  private threadView: ThreadView | null = null;
  private threadKey = "";
  private threadGeneration = 0;
  private destroyed = false;
  /** Where focus came from, so Hide can put it back. */
  private returnFocus: HTMLElement | null = null;
  private layoutFrame: number | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => this.handleKey(event, "root");
  private readonly onInputKeyDown = (event: KeyboardEvent): void =>
    this.handleKey(event, "input");
  private readonly onOutside = (event: MouseEvent): void => {
    if (!this.moreOpen) return;
    const target = event.target;
    if (target instanceof Node && this.morePanel.contains(target)) return;
    if (target instanceof Node && this.moreButton.contains(target)) return;
    this.moreOpen = false;
    this.render();
  };

  constructor(private readonly host: ComposerHost) {
    const doc = document;

    this.root = doc.createElement("div");
    this.root.className = "weaver-composer";
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "Thread");
    this.root.setAttribute("hidden", "");

    this.card = doc.createElement("div");
    this.card.className = "weaver-composer-card";

    this.railTop = doc.createElement("div");
    this.railTop.className = "weaver-composer-rail weaver-composer-rail-top weaver-frame-label";
    this.railBottom = doc.createElement("div");
    this.railBottom.className = "weaver-composer-rail weaver-composer-rail-bottom";

    this.durationLabel = doc.createElement("span");
    this.durationLabel.className = "weaver-composer-duration weaver-frame-label";
    this.momentLabel = doc.createElement("span");
    this.momentLabel.className = "weaver-composer-moment weaver-frame-label";
    this.railBottom.appendChild(this.durationLabel);
    this.railBottom.appendChild(this.momentLabel);

    this.realmButton = this.button("weaver-composer-realm", "Realm", () => this.host.openRealms());
    this.viewingNote = doc.createElement("p");
    this.viewingNote.className = "weaver-composer-viewing-note";

    this.parentStrip = doc.createElement("div");
    this.parentStrip.className = "weaver-composer-parent";
    this.parentStrip.setAttribute("role", "group");
    this.parentStrip.setAttribute("aria-label", "Branching from");

    this.outline = doc.createElement("div");
    this.outline.className = "weaver-composer-outline";
    this.outline.setAttribute("role", "list");

    this.selectionEl = doc.createElement("div");
    this.selectionEl.className = "weaver-composer-selected";
    this.selectionEl.setAttribute("tabindex", "0");
    this.selectionEl.setAttribute("role", "group");

    this.input = doc.createElement("textarea") as HTMLTextAreaElement;
    this.input.className = "weaver-composer-input";
    this.input.setAttribute("rows", "3");
    this.input.setAttribute("aria-label", "Write a thread");
    this.input.setAttribute("spellcheck", "true");

    this.statusRow = doc.createElement("div");
    this.statusRow.className = "weaver-composer-status-row";
    this.status = doc.createElement("span");
    this.status.className = "weaver-composer-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.through = doc.createElement("span");
    this.through.className = "weaver-composer-through";
    this.portalSlot = doc.createElement("span");
    this.portalSlot.className = "weaver-composer-portal-slot";
    this.statusRow.appendChild(this.status);
    this.statusRow.appendChild(this.through);
    this.statusRow.appendChild(this.portalSlot);

    this.actions = doc.createElement("div");
    this.actions.className = "weaver-composer-actions";

    this.saveButton = this.button("weaver-composer-save", "Save ↵", () => void this.settle());
    this.hideButton = this.button("weaver-composer-hide", "Hide · Esc", () => this.hideDraft());
    this.branchButton = this.button("weaver-composer-branch", "Branch · N", () => void this.branch());
    this.newThreadButton = this.button("weaver-composer-new", "New Thread · T", () => void this.newThread());
    this.closeButton = this.button("weaver-composer-close", "Close · Enter", () =>
      this.host.controller.dismiss()
    );
    this.checkButton = this.button("weaver-composer-check", "Check save", () =>
      void this.host.controller.checkSave()
    );
    this.confirmButton = this.button("weaver-composer-confirm", "Use this parent ↵", () =>
      void this.confirmTarget()
    );
    this.cancelButton = this.button("weaver-composer-cancel", "Keep original · Esc", () =>
      this.cancelTarget()
    );
    this.moreButton = this.button("weaver-composer-more", "More", () => {
      this.moreOpen = !this.moreOpen;
      this.render();
    });
    this.moreButton.setAttribute("aria-expanded", "false");
    this.moreButton.setAttribute("aria-haspopup", "true");

    this.morePanel = doc.createElement("div");
    this.morePanel.className = "weaver-composer-more-panel";
    this.morePanel.setAttribute("role", "menu");
    this.morePanel.setAttribute("hidden", "");
    this.newThreadButton.setAttribute("title", "Start a new Thread in this Realm");

    this.editButton = this.button("weaver-composer-edit", "Edit in note", () => void this.edit());
    this.discardButton = this.button("weaver-composer-discard", "Discard draft", () => {
      this.discardArmed = true;
      this.render();
    });
    this.morePanel.appendChild(this.editButton);
    this.morePanel.appendChild(this.discardButton);

    this.discardConfirm = doc.createElement("div");
    this.discardConfirm.className = "weaver-composer-confirm-discard";
    this.discardConfirm.setAttribute("role", "group");
    this.discardConfirm.setAttribute("aria-label", "Discard this draft");
    const discardText = doc.createElement("span");
    discardText.className = "weaver-composer-confirm-text";
    discardText.textContent = "Discard this draft?";
    const discardGo = this.button("weaver-composer-discard-go", "Discard draft", () => {
      this.discardArmed = false;
      this.host.controller.discardDraft();
      this.render();
    });
    this.keepButton = this.button("weaver-composer-discard-keep", "Keep writing", () => {
      this.discardArmed = false;
      this.render();
    });
    this.discardConfirm.appendChild(discardText);
    this.discardConfirm.appendChild(discardGo);
    this.discardConfirm.appendChild(this.keepButton);

    this.actions.appendChild(this.saveButton);
    this.actions.appendChild(this.hideButton);
    this.actions.appendChild(this.branchButton);
    this.actions.appendChild(this.newThreadButton);
    this.actions.appendChild(this.closeButton);
    this.actions.appendChild(this.checkButton);
    this.actions.appendChild(this.confirmButton);
    this.actions.appendChild(this.cancelButton);
    this.actions.appendChild(this.moreButton);
    this.actions.appendChild(this.morePanel);
    this.actions.appendChild(this.discardConfirm);

    this.card.appendChild(this.railTop);
    this.card.appendChild(this.realmButton);
    this.card.appendChild(this.viewingNote);
    this.card.appendChild(this.parentStrip);
    this.card.appendChild(this.outline);
    this.card.appendChild(this.selectionEl);
    this.card.appendChild(this.input);
    this.card.appendChild(this.statusRow);
    this.card.appendChild(this.actions);
    this.card.appendChild(this.railBottom);

    this.resume = doc.createElement("div");
    this.resume.className = "weaver-composer-resume";
    this.resumeButton = doc.createElement("button") as HTMLButtonElement;
    this.resumeButton.className = "weaver-composer-resume-button";
    this.resumeButton.setAttribute("type", "button");
    this.resumeButton.addEventListener("click", () => this.resumeDraft());
    this.resume.appendChild(this.resumeButton);

    this.stripSlot = doc.createElement("div");
    this.stripSlot.className = "weaver-composer-strip";

    this.root.appendChild(this.card);
    this.root.appendChild(this.resume);
    this.root.appendChild(this.stripSlot);

    this.portal = new InvitationDock({
      weave: (occurrenceId) => this.host.weaveOpening(occurrenceId),
      dismiss: (occurrenceId) => this.host.dismissOpening(occurrenceId),
      showAll: () => this.host.openPortals()
    });
    this.stripSlot.appendChild(this.portal.root);

    // The root hears the surface's keys; the input hears its own, because a key
    // pressed while typing must be read where it was typed and must not be read
    // twice when the event bubbles.
    this.root.addEventListener("keydown", this.onKeyDown);
    this.input.addEventListener("keydown", this.onInputKeyDown);
    this.input.addEventListener("input", () => this.commitInput());
    this.input.addEventListener("beforeinput", (event: Event) => this.beforeInput(event));
    this.input.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.input.addEventListener("compositionend", () => {
      // The composed value arrives once, here: committing it now is what makes a
      // Chinese or Japanese word one beginning rather than several. The flag is
      // raised *after* that commit, so it suppresses only the duplicate `input`
      // event the browser sends next.
      this.composing = false;
      this.commitInput();
      this.afterComposition = true;
    });
    this.input.addEventListener("select", () => this.recordSelection());
    this.input.addEventListener("blur", () => this.host.controller.pause());
    document.addEventListener("mousedown", this.onOutside);
  }

  /** True while the surface is on screen. */
  get isOpen(): boolean {
    return !this.destroyed && this.mountedIn !== null && !this.root.hasAttribute("hidden");
  }

  /**
   * Shows the composer in `owner`'s document, adopting the same element.
   *
   * One composer per app: moving to another window re-parents this surface and
   * rebinds the listeners that belong to a document, keeping the draft and the
   * caret exactly where they were. A closed popout comes home hidden.
   */
  mount(owner: Document = document): void {
    if (this.destroyed) return;
    const view = owner.defaultView ?? window;
    if (this.mountedIn !== null && this.mountedIn.document === owner) {
      this.watchClock();
      this.render();
      return;
    }

    this.mountedIn?.release();
    const container = owner.body ?? owner.documentElement;
    container.appendChild(this.root);
    this.mountedIn = {
      document: owner,
      window: view,
      release: this.bindWindow(view)
    };
    this.watchClock();
    this.render();
  }

  /**
   * Binds the geometry listeners for one window.
   *
   * A composer that moved to another window must let go of the first one's
   * resize and scroll events: two subscriptions would schedule two layouts for one
   * change, and the abandoned one would measure a window nobody is looking at.
   */
  private bindWindow(view: Window): () => void {
    const relayout = (): void => this.layout();
    view.addEventListener("resize", relayout);
    view.visualViewport?.addEventListener("resize", relayout);
    view.visualViewport?.addEventListener("scroll", relayout);

    const measures = (): void => this.measure();
    let observer: ResizeObserver | null = null;
    const Source = (view as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (typeof Source === "function") {
      observer = new Source(measures);
      observer.observe(this.card);
    }

    return () => {
      view.removeEventListener("resize", relayout);
      view.visualViewport?.removeEventListener("resize", relayout);
      view.visualViewport?.removeEventListener("scroll", relayout);
      observer?.disconnect();
    };
  }

  /**
   * Subscribes to the one shared clock.
   *
   * Mounting twice must not stack two subscriptions, and a surface that was hidden
   * (which lets the clock go) has to take it back — otherwise the second draft's
   * duration would never paint.
   */
  private watchClock(): void {
    if (this.unsubscribeClock !== null) return;
    this.unsubscribeClock = this.host.clock.subscribe(() => {
      // The shared clock is the beat; the draft's own elapsed time is the fact.
      // Committing the painted second is what makes a settle write what is on
      // screen rather than a sample taken while the write is in flight.
      this.host.controller.commitDuration(this.host.controller.elapsed());
      this.paintClock();
    });
  }

  /** Remembers where focus came from, before an explicit gesture takes it. */
  rememberFocus(): void {
    const active = this.mountedIn?.document.activeElement;
    this.returnFocus = active instanceof HTMLElement && active !== this.input ? active : null;
  }

  /** Focuses the input: the one gesture that may raise a keyboard. */
  focusInput(): void {
    this.mount();
    this.input.focus();
  }

  /** Puts the caret back where the draft left it, after the surface returns. */
  restoreSelection(): void {
    const state = this.host.controller.state;
    this.input.value = state.text;
    this.input.selectionStart = state.selection.from;
    this.input.selectionEnd = state.selection.to;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeClock?.();
    this.unsubscribeClock = null;
    this.mountedIn?.release();
    this.mountedIn = null;
    document.removeEventListener("mousedown", this.onOutside);
    this.rendered.unload();
    this.portal.destroy();
    this.root.remove();
  }

  /**
   * Draws the current state.
   *
   * Idempotent: a tick, a settings change and a submission all end here, and the
   * surface only rewrites what changed. Focus is never taken — only an explicit
   * `focusInput` does that.
   */
  render(): void {
    if (this.destroyed || this.mountedIn === null) return;

    const state = this.host.controller.state;
    const strip = state.phase === "closed" ? this.host.portalStrip() : null;

    // One strip, two homes: the whole surface when nothing is being written, and
    // one line of the status row when something is. It is moved rather than
    // duplicated, so the writer never sees the same opening twice.
    const home = state.phase === "closed" ? this.stripSlot : this.portalSlot;
    if (this.portal.root.parentNode !== home) home.appendChild(this.portal.root);

    if (state.phase === "closed" && strip === null) {
      this.hideElement();
      return;
    }

    this.root.removeAttribute("hidden");
    this.root.setAttribute("data-phase", state.phase);
    this.root.setAttribute("data-collapsed", String(state.collapsed));

    if (state.phase === "closed") {
      this.card.setAttribute("hidden", "");
      this.resume.setAttribute("hidden", "");
      this.stripSlot.removeAttribute("hidden");
      this.portal.render(strip);
      this.layout();
      return;
    }

    this.stripSlot.setAttribute("hidden", "");
    this.card.removeAttribute("hidden");

    const hidden = state.collapsed;
    // `hidden` is a boolean attribute: only its presence matters, so a visible
    // element is shown by *removing* it, never by writing `hidden="false"`.
    this.setVisible(this.card, !hidden);
    this.setVisible(this.resume, hidden);
    if (hidden) this.renderResume(state.phase, state.error);

    this.renderHeader(state.contextId);
    this.renderRails(state.phase, state.parent, state.selected);
    this.renderParentStrip(state.parent, state.pendingTarget);
    this.paintSelection(state.phase, state.selected);
    this.paintClock();
    this.renderStatus(state.phase, state.error, state.text);
    this.renderControls(state.phase, state.pendingTarget !== null, state.text);
    this.paintThrough(state.invitations);

    // The opening's own status lives in this row, once, and only while no
    // beginning has qualified: after that the `Through` label is the same fact.
    const offered = state.invitations.length === 0 ? this.host.portalStrip() : null;
    this.portal.render(hidden ? null : offered);
    this.setVisible(this.portalSlot, !hidden && offered !== null);

    // The input belongs to writing. Once the thought is a record, the surface
    // draws the saved prose and the textarea leaves the focus order entirely —
    // a visible editable copy of a saved entry would invite a second one.
    const writing = state.phase === "editing" || state.phase === "submitting" || state.phase === "uncertain";
    this.setVisible(this.input, writing);
    if (this.input.value !== state.text && this.mountedIn.document.activeElement !== this.input) {
      this.input.value = state.text;
    }
    this.input.readOnly =
      state.phase === "submitting" || state.phase === "uncertain" || state.pendingTarget !== null;

    this.renderThread(state.selected);
    this.layout();
  }

  /**
   * Places the surface: measured column, clamped viewport, one animation frame.
   *
   * The measurement runs per frame, never per countdown tick, so a repainted
   * second costs nothing. A missing markdown column is normal — an empty
   * workspace, Reading view — and centres the surface instead of guessing at a
   * column.
   */
  private layout(): void {
    const mounted = this.mountedIn;
    if (mounted === null) return;
    if (this.layoutFrame !== null) return;

    const run = (): void => {
      this.layoutFrame = null;
      if (this.destroyed || this.mountedIn === null) return;
      const box = this.boxFor(mounted.window);
      this.root.setAttribute("style", styleOf(box));
    };

    if (typeof mounted.window.requestAnimationFrame === "function") {
      this.layoutFrame = mounted.window.requestAnimationFrame(run);
    } else {
      run();
    }
  }

  /** Records the height the card actually took, then re-anchors. */
  private measure(): void {
    if (this.destroyed) return;
    const height = this.card.getBoundingClientRect().height;
    const next = Math.round(height);
    if (next === this.measuredHeight) return;
    this.measuredHeight = next;
    this.layout();
  }

  /** The box the surface occupies right now. */
  private boxFor(view: Window): ComposerBox {
    const phone = isPhone();
    const visual = view.visualViewport;
    const width = view.innerWidth ?? 1024;
    const height = view.innerHeight ?? 768;

    const viewport = {
      left: 0,
      right: width,
      top: visual?.offsetTop ?? 0,
      bottom: (visual?.offsetTop ?? 0) + (visual?.height ?? height)
    };

    const container = this.host.app.workspace.containerEl as HTMLElement | undefined;
    const rect = container?.getBoundingClientRect?.();
    const pane =
      rect === undefined || rect.width === 0
        ? { left: 0, right: width, top: 0, bottom: height }
        : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };

    return floatingComposerBox({
      viewport,
      pane,
      content: measureColumn(this.host.app),
      inset: INSET,
      wantedHeight: WANTED_HEIGHT,
      renderedHeight: this.measuredHeight,
      phone,
      bottomReserve: phone ? bottomReserve(view) : 0
    });
  }

  /** The header: one Realm control, and one quiet line when viewing differs. */
  private renderHeader(contextId: string): void {
    const contexts = this.host.contexts();
    const writing = contexts.find((context) => context.id === contextId);
    const writingName = writing?.name ?? contextId;
    const viewingId = this.host.viewing();
    const viewingName = contexts.find((context) => context.id === viewingId)?.name ?? null;

    this.realmButton.textContent = `Realm: ${writingName}`;
    this.realmButton.setAttribute("aria-label", `Realm: ${writingName}. Choose where to write`);
    this.realmButton.setAttribute(
      "title",
      `Writing to ${writingName}. Choose a Realm to write into`
    );

    const differs = viewingName !== null && viewingId !== contextId;
    this.setVisible(this.viewingNote, differs);
    this.viewingNote.textContent = differs
      ? `Writing to ${writingName} · viewing ${viewingName}`
      : "";
  }

  /**
   * The two rails: what the draft is, and what it has taken.
   *
   * The top rail names the thing — `Thread`, `Branch`, or the saved marker — and
   * never a fabricated address. The bottom rail carries the duration at one corner
   * and the moment at the other, exactly as an entry's own clock row does.
   */
  private renderRails(phase: string, parent: ThoughtRef | null, selected: ThoughtRef | null): void {
    this.railTop.textContent = "";
    const depth = parent === null ? 1 : parent.d + 1;

    if (phase === "resting" && selected !== null) {
      // The colour lives on the card: the root's own style is the measured box,
      // and layout writes it every frame.
      this.card.setAttribute("style", dimensionColorVars(selected.d));
      appendDigitRuns(this.railTop, formatMarker(selected.b, selected.d, selected.n));
      this.railTop.setAttribute("aria-label", `Saved thought ${selected.b}.${selected.d}.${selected.n}`);
    } else {
      this.card.setAttribute("style", dimensionColorVars(depth));
      this.railTop.textContent = parent === null ? "Thread" : "Branch";
      this.railTop.setAttribute("aria-label", parent === null ? "New thread" : "New branch");
    }

    this.momentLabel.textContent = "";
    if (phase === "resting" && selected !== null) {
      this.momentLabel.textContent = selected.time ?? "";
    }
  }

  /**
   * The parent a branch descends from, or the move being proposed.
   *
   * While a proposal is on screen this strip replaces itself rather than adding a
   * card: the old parent and the proposed one are the same question, asked in the
   * same place, with the draft still visible underneath.
   */
  private renderParentStrip(parent: ThoughtRef | null, pending: { kind: string; parent?: ThoughtRef } | null): void {
    this.parentStrip.textContent = "";
    const proposed = pending !== null && pending.kind === "branch" ? pending.parent ?? null : null;

    if (proposed !== null) {
      this.setVisible(this.parentStrip, true);
      this.parentStrip.appendChild(this.parentRow("Current parent", parent));
      this.parentStrip.appendChild(this.parentRow("Proposed parent", proposed));
      return;
    }

    if (parent === null) {
      this.setVisible(this.parentStrip, false);
      return;
    }

    this.setVisible(this.parentStrip, true);
    this.parentStrip.appendChild(this.parentRow("Branching from", parent));
  }

  /** One named parent row, with the address in the digit grammar. */
  private parentRow(label: string, parent: ThoughtRef | null): HTMLElement {
    const row = document.createElement("div");
    row.className = "weaver-composer-parent-row";

    const name = document.createElement("span");
    name.className = "weaver-composer-parent-label";
    name.textContent = label;
    row.appendChild(name);

    if (parent === null) {
      const none = document.createElement("span");
      none.className = "weaver-composer-parent-excerpt";
      none.textContent = "a new Thread in this Realm";
      row.appendChild(none);
      return row;
    }

    const address = document.createElement("span");
    address.className = "weaver-composer-parent-address";
    appendDigitRuns(address, formatMarker(parent.b, parent.d, parent.n));
    row.appendChild(address);

    const excerpt = document.createElement("span");
    excerpt.className = "weaver-composer-parent-excerpt";
    excerpt.textContent = firstLine(parent.prose);
    row.appendChild(excerpt);
    return row;
  }

  /** The saved prose, or the draft's own words, in their dimension colour. */
  private paintSelection(phase: string, selected: ThoughtRef | null): void {
    this.selectionEl.textContent = "";
    const view = this.threadView;

    if (phase === "resting" && selected !== null) {
      this.setVisible(this.selectionEl, true);
      this.selectionEl.setAttribute(
        "aria-label",
        `Selected thought ${selected.b}.${selected.d}.${selected.n}: ${firstLine(selected.prose)}`
      );
      const body = document.createElement("div");
      body.className = "weaver-composer-prose";
      this.rendered.unload();
      this.rendered = new Component();
      this.rendered.load();
      this.host.renderMarkdown(body, selected.prose, selected.path, this.rendered);
      this.selectionEl.appendChild(body);
      this.paintOutline(view, selected);
      this.paintMotionHint();
      return;
    }

    this.setVisible(this.selectionEl, false);
    this.selectionEl.removeAttribute("aria-label");
    this.paintOutline(view, selected);
  }

  /** The ancestry and the Thread's nodes, collapsed to one control by default. */
  private paintOutline(view: ThreadView | null, selected: ThoughtRef | null): void {
    this.outline.textContent = "";
    if (view === null || selected === null) {
      this.setVisible(this.outline, false);
      return;
    }

    const ancestry = view.ancestry.slice(0, -1);
    this.setVisible(this.outline, ancestry.length > 0);
    for (const ancestor of ancestry) {
      const row = document.createElement("button");
      row.className = "weaver-composer-ancestor";
      row.setAttribute("type", "button");
      appendDigitRuns(row, formatMarker(ancestor.b, ancestor.d, ancestor.n));
      row.setAttribute("aria-label", `Go to ancestor ${ancestor.b}.${ancestor.d}.${ancestor.n}`);
      row.addEventListener("click", () => void this.select(ancestor));
      this.outline.appendChild(row);
    }
  }

  /** One short line naming the motions, beside the thing they move. */
  private paintMotionHint(): void {
    const hint = document.createElement("p");
    hint.className = "weaver-composer-hint";
    hint.textContent = "j k · parents & children h l · N branch · T new";
    this.outline.appendChild(hint);
  }

  /**
   * The duration, from the draft's own clock or from the saved entry's row.
   *
   * A resting composer reads the recorded duration: the draft's clock is gone,
   * and a zero it never earned would be a different fact from the note's.
   */
  private paintClock(): void {
    const state = this.host.controller.state;
    const selected = state.selected;
    const recorded =
      this.threadView?.nodes.find((node) => node.thought.n === selected?.n)?.durationMs ?? null;
    const ms =
      state.phase === "editing"
        ? this.host.controller.elapsed()
        : (recorded ?? state.durationMs);
    this.durationLabel.textContent = formatDuration(Math.max(0, ms));
  }

  /** The row that says what the composer is doing, and why not. */
  private renderStatus(phase: string, error: string | null, text: string): void {
    if (error !== null) {
      this.status.textContent = error;
      this.status.setAttribute("data-kind", "error");
      this.setVisible(this.status, true);
      return;
    }

    this.status.setAttribute("data-kind", "info");
    if (phase === "submitting") {
      this.status.textContent = "Saving…";
      this.setVisible(this.status, true);
      return;
    }
    if (phase === "uncertain") {
      this.status.textContent = "This save is unconfirmed; check the note before writing again.";
      this.setVisible(this.status, true);
      return;
    }
    if (phase === "resting") {
      this.status.textContent = "Saved";
      this.setVisible(this.status, true);
      return;
    }

    this.status.textContent = "";
    this.setVisible(this.status, false);
    void text;
  }

  /** What the opening gave this draft, when its beginning qualified for one. */
  private paintThrough(invitations: readonly { portal: { hour: number; minute: number } }[]): void {
    const first = invitations[0];
    if (first === undefined) {
      this.setVisible(this.through, false);
      this.through.textContent = "";
      return;
    }

    const state = this.host.controller.state;
    const opening = `${pad2(first.portal.hour)}:${pad2(first.portal.minute)}`;
    const suffix = state.phase === "resting" ? "" : " · draft";
    this.through.textContent = `Through ${opening}${suffix}`;
    this.setVisible(this.through, true);
  }

  /** The controls each state shows, and the ones it must not. */
  private renderControls(phase: string, proposing: boolean, text: string): void {
    const editing = phase === "editing";
    const resting = phase === "resting";

    this.setVisible(this.saveButton, editing && !proposing && text.trim() !== "");
    this.setVisible(this.confirmButton, proposing);
    this.setVisible(this.cancelButton, proposing);
    this.setVisible(this.hideButton, !resting);
    this.setVisible(this.branchButton, resting);
    this.setVisible(this.newThreadButton, resting);
    this.setVisible(this.closeButton, resting);
    this.setVisible(this.checkButton, phase === "uncertain");
    this.setVisible(this.moreButton, editing || resting);

    this.setVisible(this.morePanel, this.moreOpen);
    this.moreButton.setAttribute("aria-expanded", String(this.moreOpen));
    // A resting Thread has somewhere to send a correction; a draft does not yet.
    this.setVisible(this.editButton, resting && this.moreOpen);
    this.setVisible(this.discardButton, editing && this.moreOpen && text.trim() !== "");
    this.setVisible(this.discardConfirm, this.discardArmed);

    if (resting) {
      const selected = this.host.controller.state.selected;
      this.branchButton.textContent = "Branch · N";
      this.branchButton.setAttribute(
        "aria-label",
        selected === null ? "Branch from the selected thought" : `Branch from ${firstLine(selected.prose)}`
      );
      this.branchButton.disabled = selected === null;
    }
  }

  /** The one bottom strip a hidden draft leaves behind. */
  private renderResume(phase: string, error: string | null): void {
    const state = this.host.controller.state;
    const contexts = this.host.contexts();
    const name = contexts.find((context) => context.id === state.contextId)?.name ?? state.contextId;
    // A saved Thread that finished while hidden reads as saved, not as a draft
    // waiting to be resumed: the words are in the note.
    const saved = phase === "resting" ? (state.selected ?? state.root) : null;
    const excerpt = saved === null ? firstLine(state.text) : firstLine(saved.prose);

    const label =
      phase === "submitting"
        ? `Saving… · ${name}`
        : phase === "uncertain"
          ? `Check save · ${name}`
          : saved === null
            ? `Resume · ${name}`
            : `Saved · ${name}`;

    this.resumeButton.textContent = excerpt === "" ? label : `${label} — ${excerpt}`;
    this.resumeButton.setAttribute(
      "aria-label",
      excerpt === "" ? `${label}. Resume writing` : `${label}. Resume writing: ${excerpt}`
    );
    this.resumeButton.setAttribute("title", state.text);
    this.resume.setAttribute("data-kind", error === null ? "info" : "error");
  }

  /** The saved Thread, drawn from the note it lives in. */
  private renderThread(selected: ThoughtRef | null): void {
    const key = selected === null ? "" : `${selected.path}:${selected.n}:${selected.rootN}`;

    if (key === this.threadKey) return;
    this.threadKey = key;
    const generation = ++this.threadGeneration;
    this.threadView = null;
    if (selected === null) return;

    void this.host.loadThread(selected).then((view) => {
      if (this.destroyed || generation !== this.threadGeneration) return;
      this.threadView = view;
      const state = this.host.controller.state;
      this.paintSelection(state.phase, state.selected);
    });
  }

  /** Records committed input, once, and never a preedit. */
  private commitInput(): void {
    if (this.composing) return;
    if (this.afterComposition) {
      // The input event the browser fires right after `compositionend` is the
      // same text this handler already committed.
      this.afterComposition = false;
      return;
    }
    this.host.controller.setText(this.input.value, {
      from: this.input.selectionStart ?? this.input.value.length,
      to: this.input.selectionEnd ?? this.input.value.length
    });
    this.render();
  }

  /** A soft keyboard's Return is a save; a composition's confirm is not. */
  private beforeInput(event: Event): void {
    const input = event as InputEvent;
    if (input.inputType !== "insertLineBreak" && input.inputType !== "insertParagraph") return;
    if (this.composing || this.host.controller.state.pendingTarget !== null) return;
    input.preventDefault?.();
    void this.settle();
  }

  /** Records the caret without touching the clock. */
  private recordSelection(): void {
    const state = this.host.controller.state;
    if (state.phase !== "editing") return;
    this.host.controller.setSelection({
      from: this.input.selectionStart ?? state.selection.from,
      to: this.input.selectionEnd ?? state.selection.to
    });
  }

  /**
   * One gesture: save, or defer a dismissal while a save is in flight.
   *
   * Whether the surface owned focus when the key was pressed is remembered first,
   * because a save that lands while the writer was here must hand the surface back
   * to them: the input is gone, and the saved thought's own target is where the
   * structural motions work. A save that lands while the writer was elsewhere
   * never summons focus.
   */
  private async settle(): Promise<void> {
    if (this.composing) return;
    const owned = this.ownsFocus();
    await this.host.controller.settle();
    this.render();
    if (owned && this.host.controller.state.phase === "resting") this.focusSelection();
  }

  /** True while focus is somewhere inside this surface. */
  private ownsFocus(): boolean {
    const active = this.mountedIn?.document.activeElement ?? null;
    if (active === null) return false;
    return active === this.root || this.root.contains(active);
  }

  /**
   * Puts focus on the saved thought: the target the structural motions move.
   *
   * Only ever called from a gesture that already had focus here — a save, a
   * selection move, a resume.
   */
  private focusSelection(): void {
    if (this.destroyed) return;
    const state = this.host.controller.state;
    if (state.phase !== "resting" || state.collapsed) return;
    this.selectionEl.focus();
  }

  /** Hide: the draft stays, the surface leaves, focus goes back. */
  private hideDraft(): void {
    this.host.controller.collapse();
    this.releaseFocus();
    this.render();
  }

  /** Resume: expand first, then put the caret back. */
  private resumeDraft(): void {
    this.host.controller.expand();
    this.render();
    this.restoreSelection();
    this.focusInput();
  }

  /** `N`: branch under the selected thought, without touching the note. */
  private async branch(): Promise<void> {
    const selected = this.host.controller.state.selected;
    if (selected === null) return;
    const applied = await this.host.controller.branch(selected);
    this.render();
    if (applied && this.host.controller.state.pendingTarget === null) this.focusInput();
  }

  /** `T`: a new Thread, or the proposal that keeps this draft's words. */
  private async newThread(): Promise<void> {
    const applied = await this.host.controller.newThread();
    this.render();
    if (applied && this.host.controller.state.pendingTarget === null) this.focusInput();
  }

  /** `Edit in note`: opens the saved thought at its own prose. */
  private async edit(): Promise<void> {
    const selected = this.host.controller.state.selected;
    if (selected === null) return;
    this.moreOpen = false;
    await this.host.controller.editInNote(selected);
    this.render();
  }

  private async confirmTarget(): Promise<void> {
    await this.host.controller.confirmTarget();
    this.render();
    this.focusInput();
  }

  private cancelTarget(): void {
    this.host.controller.cancelTarget();
    this.render();
    this.focusInput();
  }

  /** Selects a thought, then keeps focus on the thing that was clicked. */
  private async select(target: ThoughtRef): Promise<void> {
    const owned = this.ownsFocus();
    await this.host.controller.selectThought(target);
    this.render();
    if (owned) this.focusSelection();
  }

  /** Moves the selection one structural step, or leaves it where it is. */
  private async move(direction: ThreadMove): Promise<void> {
    const view = this.threadView;
    const state = this.host.controller.state;
    if (view === null || state.phase !== "resting") return;
    const next = moveThreadSelection(view, direction);
    if (next === null) return;
    await this.select(next);
  }

  /**
   * One keyboard rule for the whole surface.
   *
   * Inside the input, letters are prose and the arrows are the caret: only Enter
   * and Escape mean anything there. In the resting state the surface owns the
   * structural motions, but never where an editable control or a native button
   * has focus — a keystroke on a focused action must activate that action.
   */
  private handleKey(event: KeyboardEvent, source: "root" | "input"): void {
    if (event.isComposing || this.composing) return;
    // One key, one decision: an event already handled at the input must not be
    // handled again where it bubbles to.
    if (event.defaultPrevented === true) return;

    const state = this.host.controller.state;
    const target: unknown = event.target ?? null;
    const onButton = tagNameOf(target) === "button";
    const onInput = source === "input" || target === this.input;

    if (event.key === "Escape") {
      if (event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      // Nested layers are consumed first, so one Escape never closes two things.
      if (this.discardArmed) {
        this.discardArmed = false;
        this.render();
        return;
      }
      if (this.moreOpen) {
        this.moreOpen = false;
        this.render();
        return;
      }
      if (state.pendingTarget !== null) {
        this.cancelTarget();
        return;
      }
      if (state.phase === "resting") {
        this.host.controller.dismiss();
        this.releaseFocus();
      } else if (state.phase === "editing") {
        this.hideDraft();
      }
      this.render();
      return;
    }

    if (onInput) {
      if (event.key === "Enter" && event.shiftKey !== true) {
        if (event.repeat) return;
        if (state.pendingTarget !== null) return;
        event.preventDefault();
        void this.settle();
      }
      return;
    }

    if (onButton) return;

    if (event.key === "Enter") {
      if (event.repeat) return;
      event.preventDefault();
      if (state.pendingTarget !== null) {
        void this.confirmTarget();
        return;
      }
      if (state.phase === "resting") this.host.controller.dismiss();
      else void this.settle();
      this.render();
      return;
    }

    if (state.phase !== "resting") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const moves: Record<string, ThreadMove | undefined> = {
      j: "next",
      ArrowDown: "next",
      k: "previous",
      ArrowUp: "previous",
      h: "parent",
      ArrowLeft: "parent",
      l: "child",
      ArrowRight: "child"
    };

    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      void this.move(move);
      return;
    }

    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      void this.branch();
      return;
    }
    if (event.key === "t" || event.key === "T") {
      event.preventDefault();
      void this.newThread();
    }
  }

  /** Puts focus back where the gesture took it, or on the workspace. */
  private releaseFocus(): void {
    const previous = this.returnFocus;
    this.returnFocus = null;
    if (previous !== null && previous.isConnected) {
      previous.focus();
      return;
    }

    const container = this.host.app.workspace.containerEl as HTMLElement | undefined;
    container?.focus?.();
  }

  /** Takes the whole surface away without touching the draft. */
  private hideElement(): void {
    this.root.setAttribute("hidden", "");
    this.card.setAttribute("hidden", "");
    this.resume.setAttribute("hidden", "");
    this.stripSlot.setAttribute("hidden", "");
    this.portal.render(null);
    this.unsubscribeClock?.();
    this.unsubscribeClock = null;
  }

  private button(className: string, label: string, run: () => void): HTMLButtonElement {
    const button = document.createElement("button") as HTMLButtonElement;
    button.className = className;
    button.setAttribute("type", "button");
    button.textContent = label;
    button.addEventListener("click", run);
    return button;
  }

  private setVisible(element: HTMLElement, visible: boolean): void {
    if (visible) element.removeAttribute("hidden");
    else element.setAttribute("hidden", "");
  }
}

/** The first non-empty line of some prose, flattened for a one-line label. */
function firstLine(prose: string): string {
  const line = prose.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.trim();
}

/** Two digits, for a clock half. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The writing column of the active pane, in viewport coordinates.
 *
 * Reading view and Live Preview put their text in different elements, so both are
 * looked for; nothing else is guessed at, and a pane with neither has no column.
 */
function measureColumn(app: App): { left: number; right: number } | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const container = view?.containerEl as HTMLElement | undefined;
  if (container === undefined) return null;

  const element =
    (container.querySelector?.(".cm-content") as HTMLElement | null) ??
    (container.querySelector?.(".markdown-preview-sizer") as HTMLElement | null);
  const rect = element?.getBoundingClientRect?.();
  if (rect === undefined || rect.width === 0) return null;
  return { left: rect.left, right: rect.left + rect.width };
}

/**
 * The bottom strip a phone reserves for itself: its own toolbar, and the safe
 * area under it. The surface must sit above both, or its actions are unreachable.
 */
function bottomReserve(view: Window): number {
  const doc = view.document;
  const toolbar = doc.querySelector?.(".mobile-navbar") as HTMLElement | null;
  const toolbarHeight = toolbar?.getBoundingClientRect?.().height ?? 0;
  const styles = view.getComputedStyle(doc.documentElement);
  const safe = Number.parseFloat(styles.getPropertyValue("--safe-area-inset-bottom") || "0");
  return Math.max(0, toolbarHeight) + (Number.isFinite(safe) ? safe : 0);
}

/**
 * The lower-cased tag name of an event target, or the empty string.
 *
 * An event's target is `unknown` in practice — a text node, an element, or
 * nothing at all in a synthetic event — so the name is checked rather than
 * assumed, and a keystroke on a focused action is recognised without a cast.
 */
function tagNameOf(target: unknown): string {
  if (!isPlainObject(target) || !("tagName" in target)) return "";
  const tag = target["tagName"];
  return typeof tag === "string" ? tag.toLowerCase() : "";
}

/** The composer's box as inline style: position, width, height cap. */
export function styleOf(box: ComposerBox): string {
  return [
    "position: fixed",
    `left: ${box.left}px`,
    `top: ${box.top}px`,
    `width: ${box.width}px`,
    `max-height: ${box.maxHeight}px`,
    `--weaver-composer-max-height: ${box.maxHeight}px`
  ].join("; ");
}

/** How much of the viewport the surface may take, re-exported for a stylesheet. */
export const COMPOSER_HEIGHT_SHARE = composerHeightShare(false);
