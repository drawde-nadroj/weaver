/**
 * The Loom: the one compact surface a thought is written in, from anywhere.
 *
 * It is a single non-modal dialog with a small header, one identity line, a
 * persistent rich-Markdown writing pane, and one footer rail that always holds
 * the same two things: what the surface is saying on the left, and the actions
 * it is offering on the right. The destination control opens a chooser in place
 * of the prose, so the writer never scrolls past destination machinery to reach
 * the words. Reference context is optional and starts collapsed; it is a second
 * persistent pane, read-only, with its own navigation. A saved thought keeps the
 * same editor node, its history and its scroll, and turns read-only instead of
 * being replaced by rendered HTML.
 *
 * The renderer owns only presentation and ephemeral interaction: mounted DOM,
 * the composing flag, measurements and a hint overlay. Every semantic action is
 * a command on the controller or the reference owner, so the note is never
 * written by opening, browsing, hiding or resizing this surface.
 */

import { type App } from "obsidian";

import type { CaptureInstant, ThoughtRef } from "../core/capture";
import { dimensionColor, dimensionColorVars } from "../core/color";
import { contextDayPath, type WeavingContext } from "../core/contexts";
import { dayKey } from "../core/day";
import { formatClock as formatElapsed } from "../core/duration";
import { formatAddress } from "../core/entries";
import { loomAnchor, revealScrollDelta, type LoomAnchor, type LoomViewport } from "../core/frame";
import type { ThoughtSnapshotResult } from "../core/reference";
import type { CaptureView } from "../entries/capture-model-controller";
import type { EntryClock } from "../entries/clock";
import type { ReferenceController, ReferenceModel } from "../entries/reference";
import { appendDigitRuns } from "./dcn";
import { MarkdownPane, type PaneSelection } from "./markdown-pane";
import { isMobile } from "./platform";

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
  invitations?(): readonly LoomInvitation[];
  /** Opens an invitation's draft. */
  takeInvitation?(occurrenceId: string): void;
  /** Dismisses one invitation. */
  dismissInvitation?(occurrenceId: string): void;
  clock: EntryClock;
  /** Every Realm, `main` first. */
  contexts(): readonly WeavingContext[];
  /** Reads the saved entry's own clock row, never a discarded draft's duration. */
  loadThought(target: ThoughtRef): Promise<ThoughtSnapshotResult>;
  /** Deliberate travel: snapshot here, restore there. */
  travel(contextId: string): Promise<boolean>;
  /** The Realm the workspace is showing, or the empty string when unknown. */
  viewing(): string;
}

/** An opening offered by the scheduler: upcoming, or in its available minute. */
export interface LoomInvitation {
  id: string;
  name: string;
  opening: string;
  phase: "approaching" | "available";
}

/** A contextual panel that temporarily replaces the composition area. */
type View = "write" | "chooser" | "invitations";

/** One transient message, shown in the rail until it is replaced or expires. */
interface Feedback {
  text: string;
  kind: "ok" | "error";
}

/** The document a Loom is currently mounted in. */
interface Mounted {
  document: Document;
  window: Window;
  release(): void;
}

/** True when the value behaves like a DOM node, across window boundaries. */
function isNode(target: unknown): target is Node {
  return typeof target === "object" && target !== null && "nodeType" in target;
}

/** The element a target belongs to, when it is one. */
function elementOf(target: unknown): HTMLElement | null {
  if (typeof target !== "object" || target === null) return null;
  const element = target as HTMLElement;
  return typeof element.closest === "function" ? element : null;
}

/**
 * True when the event target edits text: a field, or a contenteditable pane.
 * Both the prose and the reading are editors, so neither one may be treated as
 * an inert background when keys arrive.
 */
function isField(target: unknown): boolean {
  const element = elementOf(target);
  return element !== null && element.closest("input, textarea, [contenteditable='true']") !== null;
}

/**
 * True when the target lives inside a MarkdownPane surface. The read-only half
 * is a native rendered body rather than a contenteditable, so arrows and text
 * selection there must stay the reader's, not the toolbar's.
 */
function isEditorSurface(target: unknown): boolean {
  const element = elementOf(target);
  return (
    element !== null &&
    element.closest(
      "input, textarea, [contenteditable='true'], .weaver-markdown-content, .weaver-markdown-reading"
    ) !== null
  );
}

/**
 * True when the target owns its own keys: a field, a button, a link, a select,
 * or an editor pane. The Loom's global reading keys must never fire over one of
 * these — `Enter` on a focused button is that button's activation, and an arrow
 * key in an editor belongs to the editor.
 */
function isControl(target: unknown): boolean {
  const element = elementOf(target);
  return (
    element !== null &&
    element.closest("input, textarea, button, select, a, summary, [contenteditable='true']") !== null
  );
}

/** True when `target` sits inside `element`. */
function within(element: HTMLElement, target: unknown): boolean {
  return isNode(target) && element.contains(target);
}

/** The first words of prose, for a resume strip. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
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
  private readonly shortcuts: HTMLElement;
  private readonly shortcutsClose: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly contextEl: HTMLElement;
  private readonly referenceEl: HTMLElement;
  private readonly referenceTabs: HTMLElement;
  private readonly referenceReadTab: HTMLButtonElement;
  private readonly referenceInviteTab: HTMLButtonElement;
  private readonly referenceTools: HTMLElement;
  private readonly refPrev: HTMLButtonElement;
  private readonly refNext: HTMLButtonElement;
  private readonly refPosition: HTMLElement;
  private readonly refOpen: HTMLButtonElement;
  private readonly refSearchButton: HTMLButtonElement;
  private readonly referenceSearchField: HTMLInputElement;
  private readonly referenceAddress: HTMLElement;
  private readonly referenceNotice: HTMLElement;
  private readonly referenceProse: HTMLElement;
  private readonly referenceHint: HTMLElement;
  private readonly chooserEl: HTMLElement;
  private readonly writingEl: HTMLElement;
  private readonly identityEl: HTMLElement;
  private readonly proseEl: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly stateEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly elapsedEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly newlineButton: HTMLButtonElement;
  private readonly useButton: HTMLButtonElement;
  private readonly keepTargetButton: HTMLButtonElement;
  private readonly discardButton: HTMLButtonElement;
  private readonly keepDraftButton: HTMLButtonElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly checkButton: HTMLButtonElement;
  private readonly branchButton: HTMLButtonElement;
  private readonly freshButton: HTMLButtonElement;
  private readonly resume: HTMLElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly resumeDismiss: HTMLButtonElement;

  private pane: MarkdownPane | null = null;
  private refPane: MarkdownPane | null = null;
  private panesDoc: Document | null = null;

  private mountedIn: Mounted | null = null;
  private unsubscribeClock: (() => void) | null = null;
  private composing = false;
  private measuredHeight = 0;
  private view: View = "write";
  private referenceExpanded = false;
  private menuOpen = false;
  private shortcutsOpen = false;
  private discardArmed = false;
  private destroyed = false;
  private returnFocus: HTMLElement | null = null;
  private layoutFrame: number | null = null;
  private bodyScroll = 0;
  /** The one search field, kept across renders so typing is never interrupted. */
  private searching = false;
  /** What the resume strip's main button will do, captured by its last render. */
  private resumeAction: (() => void) | null = null;
  /** What the resume strip's quiet button will do, when it is shown. */
  private resumeDismissAction: (() => void) | null = null;

  /** The document state currently installed in the writing pane. */
  private composerPath = "";
  private composerReadOnly = false;
  /** The reading document currently installed in the reference pane. */
  private referenceKey = "";
  /** The parent excerpt stays open while this same reading remains current. */
  private contextParent: ThoughtRef | null = null;
  /** Lookup identity also guards against late reads after another draft or save. */
  private savedTiming: { thought: ThoughtRef; result: ThoughtSnapshotResult | null } | null = null;
  /** Existing drafts advance only on shared-clock ticks, never incidental renders. */
  private timedBeginning: CaptureInstant | null = null;

  private feedback: Feedback | null = null;
  private feedbackTimer: number | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => this.handleKey(event);
  /**
   * The save chord, taken in the window's capture phase while focus is inside
   * the Loom.
   *
   * Obsidian's own key scope runs in the document's capture phase and claims
   * `Mod-Enter` for "Open link under cursor in new tab", so a listener on the
   * editor never sees the chord — and while the composer has focus that
   * Obsidian command cannot mean anything. Claiming it one phase earlier, only
   * for events whose target is inside the surface, makes `⌘↵` do what its
   * footer says without touching the chord anywhere else in the app.
   */
  private readonly onCaptureKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || event.altKey) return;
    if (!event.metaKey && !event.ctrlKey) return;
    if (event.isComposing || this.composing) return;
    if (this.view !== "write" || this.mountedIn === null) return;
    if (this.menuOpen || this.shortcutsOpen) return;
    const node = event.target;
    if (!isNode(node) || !this.root.contains(node)) return;
    event.preventDefault();
    event.stopPropagation();
    void this.save();
  };
  private readonly onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (this.menuOpen && !this.menu.contains(target as Node) && !this.moreButton.contains(target as Node)) {
      this.menuOpen = false;
      this.render();
    }
    if (
      this.shortcutsOpen &&
      !this.shortcuts.contains(target as Node) &&
      !this.moreButton.contains(target as Node)
    ) {
      this.shortcutsOpen = false;
      this.render();
    }
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

    this.hideButton = doc.createElement("button");
    this.hideButton.type = "button";
    this.hideButton.className = "weaver-composer-hide";
    this.hideButton.textContent = "Hide";

    this.moreButton = doc.createElement("button");
    this.moreButton.type = "button";
    this.moreButton.className = "weaver-composer-more";
    this.moreButton.textContent = "⋯";
    this.moreButton.setAttribute("aria-label", "More");
    this.moreButton.setAttribute("aria-haspopup", "menu");
    this.moreButton.setAttribute("aria-expanded", "false");

    this.menu = doc.createElement("div");
    this.menu.className = "weaver-composer-menu";
    this.menu.setAttribute("role", "menu");
    this.menu.setAttribute("aria-label", "More actions");
    this.menu.setAttribute("hidden", "");

    this.shortcuts = doc.createElement("div");
    this.shortcuts.className = "weaver-composer-shortcuts";
    this.shortcuts.setAttribute("role", "dialog");
    this.shortcuts.setAttribute("aria-label", "Keyboard shortcuts");
    this.shortcuts.setAttribute("hidden", "");
    this.buildShortcuts(doc);

    // `buildShortcuts` appends the close button this field points at.
    this.shortcutsClose = this.shortcuts.querySelector<HTMLButtonElement>(".weaver-composer-shortcuts-close")!;

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
    this.referenceEl.tabIndex = -1;

    this.referenceTabs = doc.createElement("div");
    this.referenceTabs.className = "weaver-composer-reference-tabs";
    this.referenceTabs.setAttribute("role", "tablist");
    this.referenceTabs.setAttribute("aria-label", "Reading");

    this.referenceReadTab = doc.createElement("button");
    this.referenceReadTab.type = "button";
    this.referenceReadTab.className = "weaver-composer-reference-tab";
    this.referenceReadTab.textContent = "Thought";
    this.referenceReadTab.setAttribute("role", "tab");
    this.referenceReadTab.setAttribute("aria-selected", "true");

    this.referenceInviteTab = doc.createElement("button");
    this.referenceInviteTab.type = "button";
    this.referenceInviteTab.className = "weaver-composer-reference-tab weaver-composer-reference-invitations";
    this.referenceInviteTab.textContent = "Invitations";
    this.referenceInviteTab.setAttribute("role", "tab");
    this.referenceInviteTab.setAttribute("aria-selected", "false");

    this.referenceTabs.appendChild(this.referenceReadTab);
    this.referenceTabs.appendChild(this.referenceInviteTab);

    this.referenceTools = doc.createElement("div");
    this.referenceTools.className = "weaver-composer-reference-tools";
    this.referenceTools.setAttribute("role", "toolbar");
    this.referenceTools.setAttribute("aria-label", "Thought navigation");
    this.referenceTools.tabIndex = 0;

    const referenceNav = doc.createElement("div");
    referenceNav.className = "weaver-composer-reference-nav";

    this.refPrev = doc.createElement("button");
    this.refPrev.type = "button";
    this.refPrev.className = "weaver-composer-reference-prev";
    this.refPrev.textContent = "Previous";
    this.refPrev.setAttribute("aria-label", "Previous thought");
    this.refPrev.title = "Previous thought (↑)";

    this.refNext = doc.createElement("button");
    this.refNext.type = "button";
    this.refNext.className = "weaver-composer-reference-next";
    this.refNext.textContent = "Next";
    this.refNext.setAttribute("aria-label", "Next thought");
    this.refNext.title = "Next thought (↓)";

    this.refPosition = doc.createElement("span");
    this.refPosition.className = "weaver-composer-reference-position";
    this.refPosition.setAttribute("aria-live", "polite");

    this.refOpen = doc.createElement("button");
    this.refOpen.type = "button";
    this.refOpen.className = "weaver-composer-reference-open";
    this.refOpen.textContent = "Open";
    this.refOpen.setAttribute("aria-label", "Open the selected thought in its note");
    this.refOpen.title = "Open in its note (⏎)";

    this.refSearchButton = doc.createElement("button");
    this.refSearchButton.type = "button";
    this.refSearchButton.className = "weaver-composer-reference-search-toggle";
    this.refSearchButton.textContent = "Search";
    this.refSearchButton.setAttribute("aria-label", "Search thoughts");
    this.refSearchButton.title = "Search (/)";

    this.referenceSearchField = doc.createElement("input");
    this.referenceSearchField.type = "search";
    this.referenceSearchField.className = "weaver-composer-reference-search";
    this.referenceSearchField.setAttribute("aria-label", "Search thoughts");
    this.referenceSearchField.setAttribute("hidden", "");

    referenceNav.appendChild(this.refPrev);
    referenceNav.appendChild(this.refNext);
    referenceNav.appendChild(this.refPosition);
    this.referenceTools.appendChild(referenceNav);
    this.referenceTools.appendChild(this.refOpen);
    this.referenceTools.appendChild(this.refSearchButton);
    this.referenceTools.appendChild(this.referenceSearchField);

    this.referenceAddress = doc.createElement("div");
    this.referenceAddress.className = "weaver-composer-reference-address";
    this.referenceAddress.setAttribute("hidden", "");

    this.referenceNotice = doc.createElement("div");
    this.referenceNotice.className = "weaver-composer-reference-notice";
    this.referenceNotice.setAttribute("role", "status");
    this.referenceNotice.setAttribute("hidden", "");

    this.referenceProse = doc.createElement("div");
    this.referenceProse.className = "weaver-composer-reference-prose";
    this.referenceProse.setAttribute("hidden", "");

    this.referenceHint = doc.createElement("div");
    this.referenceHint.className = "weaver-composer-keyhint";
    this.referenceHint.textContent = "With navigation focused: ↑↓ browse · / search · ⏎ open";

    this.referenceEl.appendChild(this.referenceTabs);
    this.referenceEl.appendChild(this.referenceTools);
    this.referenceEl.appendChild(this.referenceAddress);
    this.referenceEl.appendChild(this.referenceNotice);
    this.referenceEl.appendChild(this.referenceProse);
    this.referenceEl.appendChild(this.referenceHint);

    this.chooserEl = doc.createElement("div");
    this.chooserEl.className = "weaver-composer-chooser";
    this.chooserEl.setAttribute("hidden", "");
    this.chooserEl.tabIndex = -1;

    this.writingEl = doc.createElement("div");
    this.writingEl.className = "weaver-composer-writing";
    this.writingEl.tabIndex = -1;

    this.identityEl = doc.createElement("div");
    this.identityEl.className = "weaver-composer-identity";

    this.proseEl = doc.createElement("div");
    this.proseEl.className = "weaver-composer-prose";

    this.writingEl.appendChild(this.identityEl);
    this.writingEl.appendChild(this.proseEl);

    this.body.appendChild(this.contextEl);
    this.body.appendChild(this.referenceEl);
    this.body.appendChild(this.writingEl);
    this.body.appendChild(this.chooserEl);
    this.body.addEventListener("scroll", () => {
      this.bodyScroll = this.body.scrollTop;
    });

    this.footer = doc.createElement("div");
    this.footer.className = "weaver-composer-footer";

    this.stateEl = doc.createElement("div");
    this.stateEl.className = "weaver-composer-state";

    this.statusEl = doc.createElement("div");
    this.statusEl.className = "weaver-composer-status";
    this.statusEl.setAttribute("role", "status");

    this.elapsedEl = doc.createElement("span");
    this.elapsedEl.className = "weaver-composer-elapsed";
    this.elapsedEl.setAttribute("role", "timer");
    this.elapsedEl.setAttribute("aria-live", "off");

    this.stateEl.appendChild(this.statusEl);
    this.stateEl.appendChild(this.elapsedEl);

    this.actionsEl = doc.createElement("div");
    this.actionsEl.className = "weaver-composer-actions";

    this.saveButton = doc.createElement("button");
    this.saveButton.type = "button";
    this.saveButton.className = "weaver-composer-save";

    this.newlineButton = this.button(doc, "New line", "weaver-composer-newline");
    this.newlineButton.setAttribute("aria-label", "Start a new line");

    this.useButton = this.button(doc, "Use", "weaver-composer-save weaver-composer-use");
    this.keepTargetButton = this.button(doc, "Keep original", "weaver-composer-quiet-close");
    this.discardButton = this.button(doc, "Discard", "weaver-composer-save weaver-composer-save-alt");
    this.keepDraftButton = this.button(doc, "Keep writing", "weaver-composer-quiet-close");
    this.retryButton = this.button(doc, "Retry save", "weaver-composer-save weaver-composer-retry");
    this.checkButton = this.button(doc, "Check save", "weaver-composer-save weaver-composer-check");
    this.branchButton = this.button(doc, "Branch", "weaver-composer-branch");
    this.freshButton = this.button(doc, "New Thread", "weaver-composer-new");

    // The primary Save stays first in the rail so a generic `.weaver-composer-save`
    // selector always means Save; each conditional decision has its own class,
    // and "keep writing" precedes its alternative so the quiet slot is stable.
    this.actionsEl.appendChild(this.saveButton);
    this.actionsEl.appendChild(this.newlineButton);
    this.actionsEl.appendChild(this.discardButton);
    this.actionsEl.appendChild(this.keepDraftButton);
    this.actionsEl.appendChild(this.useButton);
    this.actionsEl.appendChild(this.keepTargetButton);
    this.actionsEl.appendChild(this.retryButton);
    this.actionsEl.appendChild(this.checkButton);
    this.actionsEl.appendChild(this.branchButton);
    this.actionsEl.appendChild(this.freshButton);

    this.footer.appendChild(this.stateEl);
    this.footer.appendChild(this.actionsEl);

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
    // would be cut off on a short draft. The root lays these over the card.
    this.root.appendChild(this.menu);
    this.root.appendChild(this.shortcuts);

    this.wirePanes();
    this.wireActions();
    this.wireReference();
    this.wireHeader();

    // The resume strip's two buttons act on whatever it is showing right now, so
    // they are bound once, here, and read `renderResume`'s recorded intent.
    this.resumeButton.addEventListener("click", () => this.activateResume());
    this.resumeDismiss.addEventListener("click", () => this.dismissResume());
  }

  /** A footer action button, hidden until a render offers it. */
  private button(doc: Document, label: string, className: string): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.setAttribute("hidden", "");
    return button;
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
    const onCapture = (event: KeyboardEvent): void => this.onCaptureKey(event);
    // The soft keyboard shrinks/offsets the visual viewport without resizing the
    // window; re-anchor whenever either viewport moves.
    const onViewport = (): void => {
      this.measure();
      this.layout();
    };
    owner.addEventListener("pointerdown", onPointer);
    this.root.addEventListener("keydown", onKey);
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

    this.unsubscribeClock = this.host.clock.subscribe(() => this.paintElapsed(true));
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
    const state = this.host.controller.state;
    if (state.phase === "closed") return;
    this.ensurePanes();
    if (state.phase === "resting") {
      this.pane?.focus();
      return;
    }
    this.pane?.focus(state.selection);
  }

  /** Restores the recorded caret into the writing pane, without focusing it. */
  restoreSelection(): void {
    const state = this.host.controller.state;
    if (state.phase !== "editing" || this.pane === null || this.composing) return;
    if (this.pane.text !== state.text) return;
    this.pane.update(state.text, this.draftPath(state), false, state.selection);
  }

  /** Opens a contextual panel, preserving the draft's scroll position. */
  private beginPanel(view: View): void {
    if (this.view === "write") this.bodyScroll = this.body.scrollTop;
    this.view = view;
    this.menuOpen = false;
    this.shortcutsOpen = false;
    this.render();
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
      this.render();
      this.body.scrollTop = this.bodyScroll;
      this.focusReferenceTools();
      return;
    }
    if (panel === "tapestries") {
      this.beginPanel("chooser");
      return;
    }
    this.beginPanel("invitations");
  }

  /**
   * One control for the reference, from the header and the reading alike.
   *
   * Both routes mean the same thing: show the reading above the prose, or put
   * it away. Collapsing never touches the draft's text, timing or scroll.
   */
  private toggleReference(): void {
    if (this.referenceExpanded) {
      this.collapseReference();
      return;
    }
    if (this.view !== "write") {
      this.view = "write";
      this.body.scrollTop = this.bodyScroll;
    }
    this.referenceExpanded = true;
    if (this.host.reference !== undefined) void this.host.reference.refresh();
    this.render();
    // Opening the reading hands it the keys; the draft keeps its text and clock,
    // and clicking back into the prose takes them back.
    if (this.host.reference !== undefined && this.host.reference.model.search.kind !== "editing") {
      this.focusReferenceTools();
    }
  }

  /** Puts the reading away and returns focus to where the writer was. */
  private collapseReference(): void {
    if (!this.referenceExpanded) return;
    this.referenceExpanded = false;
    const phase = this.host.controller.state.phase;
    this.render();
    if (phase === "editing" || phase === "resting") {
      this.focusInput();
      return;
    }
    if (phase === "closed") {
      // The reading-only surface hid itself; focus returns to wherever the
      // reader came from rather than to a control that is no longer on screen.
      const focus = this.returnFocus;
      if (focus !== null && focus.isConnected && !this.root.contains(focus)) focus.focus();
      return;
    }
    this.refButton.focus();
  }

  /** Takes the surface out of the document. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const activeWindow = this.mountedIn?.window ?? window;
    if (this.feedbackTimer !== null) {
      activeWindow.clearTimeout(this.feedbackTimer);
      this.feedbackTimer = null;
    }
    if (this.layoutFrame !== null) {
      activeWindow.cancelAnimationFrame?.(this.layoutFrame);
      this.layoutFrame = null;
    }
    this.mountedIn?.release();
    this.mountedIn = null;
    this.destroyPanes();
  }

  /** Draws the surface from the controller and reference projections. */
  render(): void {
    if (this.destroyed || this.mountedIn === null) return;
    const state = this.host.controller.state;
    // Invitations can offer a beginning, never interrupt an existing draft.
    const invitation = state.phase === "closed" ? this.host.invitations?.()[0] ?? null : null;
    // A reference loaded without a draft is shown only because a caller asked
    // for it explicitly (showPanel); a loaded reference alone never opens here.
    const referenceOnly = state.phase === "closed" && this.referenceExpanded;

    if (state.phase === "closed" && !referenceOnly && invitation === null) {
      this.hideElement();
      return;
    }

    this.root.removeAttribute("hidden");
    this.root.setAttribute("data-phase", state.phase);
    this.root.setAttribute("data-collapsed", String(state.collapsed));
    this.root.setAttribute("data-view", this.view);
    this.root.setAttribute("data-reference", this.referenceExpanded ? "expanded" : "collapsed");

    if (referenceOnly) {
      this.renderReferenceOnly(state);
      this.layout();
      return;
    }

    if (state.phase === "closed") {
      this.renderResume(invitation);
      this.layout();
      return;
    }

    if (state.collapsed) {
      this.renderResume(null, state);
      this.layout();
      return;
    }

    this.renderCard(state);
    this.layout();
  }

  /**
   * The compact reading-only surface: header, reference navigation and an
   * explicit way to begin writing. No draft exists, so no identity, editor or
   * destination is implied — only an offer.
   */
  private renderReferenceOnly(state: CaptureView): void {
    this.card.removeAttribute("hidden");
    this.resume.setAttribute("hidden", "");
    this.paintDimension(state);
    this.setVisible(this.destButton, false);
    this.setVisible(this.refButton, false);
    this.viewingEl.textContent = "Reference";
    this.setVisible(this.viewingEl, true);
    this.refButton.setAttribute("aria-expanded", String(this.referenceExpanded));
    this.setVisible(this.menu, this.menuOpen);
    this.setVisible(this.shortcuts, this.shortcutsOpen);
    this.moreButton.setAttribute("aria-expanded", String(this.menuOpen));
    this.setVisible(this.contextEl, false);
    this.setVisible(this.writingEl, false);
    this.ensurePanes();
    this.setVisible(this.footer, true);
    this.statusEl.textContent = "";
    this.setVisible(this.statusEl, false);
    this.elapsedEl.textContent = "";
    this.setVisible(this.elapsedEl, false);
    this.renderActions(state);

    if (this.view !== "write") {
      // Auxiliary panels return to the same reading, with the same New Thread offer.
      this.setVisible(this.referenceEl, false);
      this.setVisible(this.chooserEl, true);
      this.searching = false;
      if (this.view === "chooser") this.renderChooser();
      else this.renderInvitations();
      return;
    }
    this.setVisible(this.chooserEl, false);
    this.renderReference();
  }

  private renderCard(state: CaptureView): void {
    this.card.removeAttribute("hidden");
    this.resume.setAttribute("hidden", "");
    this.setVisible(this.destButton, true);
    this.setVisible(this.refButton, true);
    this.setVisible(this.writingEl, true);
    // Paint the dimension before the first frame of content: the box, the prose
    // and the actions all read these two properties.
    this.paintDimension(state);
    const destination = this.destinationLabel(state);
    this.destButton.textContent = `${destination} ▾`;
    this.destButton.setAttribute("aria-label", `Writing destination: ${destination}`);

    const viewing = this.host.contexts().find((context) => context.id === this.host.viewing())?.name ?? null;
    const differs = viewing !== null && this.host.viewing() !== "" && this.host.viewing() !== state.contextId;
    if (differs) {
      this.viewingEl.textContent = `viewing ${viewing}`;
      this.viewingEl.removeAttribute("hidden");
    } else {
      this.viewingEl.setAttribute("hidden", "");
    }

    this.refButton.setAttribute("aria-expanded", String(this.referenceExpanded));
    this.setVisible(this.menu, this.menuOpen);
    this.setVisible(this.shortcuts, this.shortcutsOpen);
    this.moreButton.setAttribute("aria-expanded", String(this.menuOpen));

    if (this.discardArmed && state.phase !== "editing") this.discardArmed = false;

    this.ensurePanes();
    this.renderContext(state);
    this.renderIdentity(state);
    this.syncComposerPane(state);
    this.renderStatus(state);
    this.renderActions(state);
    this.paintElapsed();
    this.setVisible(this.footer, true);

    if (this.view !== "write") {
      this.setVisible(this.chooserEl, true);
      this.setVisible(this.proseEl, false);
      this.setVisible(this.referenceEl, false);
      this.searching = false;
      if (this.view === "chooser") this.renderChooser();
      else this.renderInvitations();
      return;
    }

    this.setVisible(this.chooserEl, false);
    this.setVisible(this.proseEl, true);
    this.renderReference();
  }

  private destinationLabel(state: CaptureView): string {
    const name = this.host.contexts().find((context) => context.id === state.contextId)?.name ?? state.contextId;
    return state.parent === null ? name : `Branch · ${name}`;
  }

  private renderContext(state: CaptureView): void {
    const parent = state.parent;
    if (parent === null) {
      this.contextParent = null;
      this.contextEl.setAttribute("hidden", "");
      this.contextEl.textContent = "";
      return;
    }
    this.contextEl.removeAttribute("hidden");
    const previous = this.contextParent;
    if (
      previous !== null &&
      previous.path === parent.path &&
      previous.b === parent.b &&
      previous.d === parent.d &&
      previous.n === parent.n &&
      previous.prose === parent.prose
    ) return;
    this.contextParent = parent;
    this.contextEl.textContent = "";
    const label = this.doc().createElement("span");
    label.className = "weaver-composer-context-label";
    label.setAttribute("style", dimensionColorVars(parent.d));
    label.textContent = "Branching from ";
    appendDigitRuns(label, formatAddress(parent.b, parent.d, parent.n));
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

  /** The fixed identity slot: what this draft will be, or the address it became. */
  private renderIdentity(state: CaptureView): void {
    const dimension = this.dimensionOf(state);
    this.identityEl.setAttribute("style", dimensionColorVars(dimension));
    this.identityEl.textContent = "";
    const label = this.doc().createElement("span");
    label.className = "weaver-composer-identity-label";
    const address = this.doc().createElement("span");
    address.className = "weaver-composer-identity-address";
    if (state.phase === "resting") {
      const saved = state.selected ?? state.root;
      label.textContent = "Saved";
      if (saved === null) address.textContent = "unwritten";
      else appendDigitRuns(address, formatAddress(saved.b, saved.d, saved.n));
    } else {
      label.textContent = "Draft";
      appendDigitRuns(address, `${state.parent === null ? "Thread" : "Branch"} · ${dimension}D`);
    }
    this.identityEl.appendChild(label);
    this.identityEl.appendChild(address);
  }

  /** The note a draft will be written into, for resolving relative links. */
  private draftPath(state: CaptureView): string {
    if (state.parent !== null) return state.parent.path;
    const context = this.host.contexts().find((candidate) => candidate.id === state.contextId);
    if (context === undefined) return "";
    const day = state.beginning?.day ?? dayKey(new Date());
    return contextDayPath(context, day);
  }

  /** The text and mode the writing pane should hold right now. */
  private composerContent(state: CaptureView): { text: string; path: string; readOnly: boolean } {
    if (state.phase === "resting") {
      const saved = state.selected ?? state.root;
      return { text: saved?.prose ?? "", path: saved?.path ?? "", readOnly: true };
    }
    return { text: state.text, path: this.draftPath(state), readOnly: state.phase !== "editing" };
  }

  private ensurePanes(): void {
    const doc = this.doc();
    if (this.panesDoc === doc && this.pane !== null && this.refPane !== null) return;
    this.destroyPanes();

    this.pane = new MarkdownPane({
      parent: this.proseEl,
      app: this.host.app,
      label: "Write a thought",
      onChange: (text, selection) => this.onPaneChange(text, selection),
      onKey: (event) => this.onPaneKey(event),
      onComposition: (active) => this.onPaneComposition(active),
      onMeasure: () => this.measure()
    });
    this.pane.dom.classList.add("weaver-composer-editor");

    this.refPane = new MarkdownPane({
      parent: this.referenceProse,
      app: this.host.app,
      label: "Read a thought",
      onKey: (event) => this.onReferencePaneKey(event),
      onMeasure: () => this.measure()
    });
    this.refPane.dom.classList.add("weaver-composer-editor");
    this.refPane.dom.setAttribute("data-readonly", "true");

    this.panesDoc = doc;
    this.composerPath = "";
    this.composerReadOnly = false;
    this.referenceKey = "";
  }

  private destroyPanes(): void {
    this.pane?.destroy();
    this.pane = null;
    this.refPane?.destroy();
    this.refPane = null;
    this.panesDoc = null;
    this.proseEl.textContent = "";
    this.referenceProse.textContent = "";
    this.composerPath = "";
    this.composerReadOnly = false;
    this.referenceKey = "";
  }

  /**
   * Keeps the one writing pane on the document the controller is holding.
   *
   * A save is the same document switching to read-only, so history and scroll
   * survive it; only a genuinely new draft or branch resets history.
   */
  private syncComposerPane(state: CaptureView): void {
    const pane = this.pane;
    // An IME owns the editor's text until it commits; writing the controller's
    // older text into the pane here would tear the composition apart.
    if (pane === null || this.composing) return;
    const content = this.composerContent(state);
    // Only a genuinely new empty draft resets history. A path change or the
    // user's own deletion/undo must never replace its existing editor state.
    const textChanged = pane.text !== content.text;
    const reset = !content.readOnly && content.text === "" && textChanged;
    const needsDocument =
      textChanged ||
      this.composerPath !== content.path ||
      this.composerReadOnly !== content.readOnly;
    if (needsDocument) {
      const selection: PaneSelection | undefined = content.readOnly ? undefined : state.selection;
      pane.update(content.text, content.path, content.readOnly, selection, reset);
      this.composerPath = content.path;
      this.composerReadOnly = content.readOnly;
    }
  }

  private onPaneChange(text: string, selection: PaneSelection): void {
    if (this.destroyed || this.composing) return;
    const state = this.host.controller.state;
    if (state.phase !== "editing") return;
    if (this.discardArmed) this.discardArmed = false;
    if (text !== state.text) this.host.controller.setText(text, selection);
    else if (selection.from !== state.selection.from || selection.to !== state.selection.to) {
      this.host.controller.setSelection(selection);
    }
  }

  private onPaneComposition(active: boolean): void {
    this.composing = active;
    if (!active) this.syncFromPane();
  }

  /** Reads the writing pane back after an IME session commits. */
  private syncFromPane(): void {
    const pane = this.pane;
    if (pane === null || this.destroyed || this.composing) return;
    const state = this.host.controller.state;
    if (state.phase !== "editing") return;
    const text = pane.text;
    const selection = pane.selection;
    if (text !== state.text) this.host.controller.setText(text, selection);
    else this.host.controller.setSelection(selection);
  }

  /** The writing pane's own keys: Enter finishes, Escape puts the surface away. */
  private onPaneKey(event: KeyboardEvent): boolean {
    if (event.isComposing || this.composing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      this.handleEscape();
      return true;
    }
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return false;
    event.preventDefault();
    if (this.host.controller.state.phase === "resting") this.hide();
    else void this.save();
    return true;
  }

  /** The reading pane owns its text; Escape only puts the reading away. */
  private onReferencePaneKey(event: KeyboardEvent): boolean {
    if (event.key !== "Escape" || event.isComposing) return false;
    event.preventDefault();
    this.collapseReference();
    return true;
  }

  private renderStatus(state: CaptureView): void {
    let message: string | null = null;
    let error = false;
    if (state.error !== null) {
      message = state.error;
      error = true;
    } else if (state.pendingTarget !== null) {
      message = "Use this destination?";
    } else if (this.discardArmed && state.phase === "editing") {
      message = "Discard this draft?";
    } else if (this.feedback !== null) {
      message = this.feedback.text;
      error = this.feedback.kind === "error";
    } else if (state.phase === "submitting") {
      message = "Saving…";
    }

    this.statusEl.textContent = message ?? "";
    if (error) this.statusEl.setAttribute("data-kind", "error");
    else this.statusEl.removeAttribute("data-kind");
    this.setVisible(this.statusEl, message !== null);
  }

  private renderActions(state: CaptureView): void {
    if (state.phase === "closed") {
      // Reading without a draft offers exactly one beginning.
      for (const button of [
        this.useButton,
        this.keepTargetButton,
        this.discardButton,
        this.keepDraftButton,
        this.retryButton,
        this.checkButton,
        this.saveButton,
        this.newlineButton,
        this.branchButton
      ]) {
        this.setVisible(button, false);
      }
      this.setVisible(this.freshButton, true);
      return;
    }

    const pending = state.pendingTarget !== null;
    const discard = this.discardArmed && state.phase === "editing";
    const blocked = pending || discard || state.phase === "retryable" || state.phase === "uncertain";
    const resting = state.phase === "resting";
    const saved = state.selected ?? state.root;

    this.setVisible(this.useButton, pending);
    this.setVisible(this.keepTargetButton, pending);
    this.setVisible(this.discardButton, discard);
    this.setVisible(this.keepDraftButton, discard);
    this.setVisible(this.retryButton, !pending && !discard && state.phase === "retryable");
    this.setVisible(this.checkButton, !pending && !discard && state.phase === "uncertain");
    this.setVisible(this.saveButton, !blocked && !resting);
    // Soft Return is Save on mobile, so the rail carries the newline gesture the
    // hardware keyboard keeps on Shift+Return.
    this.setVisible(this.newlineButton, state.phase === "editing" && !blocked && isMobile());
    this.newlineButton.disabled = this.composing;
    this.setVisible(this.branchButton, resting);
    this.setVisible(this.freshButton, resting);

    this.saveButton.textContent = isMobile() ? "Save" : "Save ↵";
    this.saveButton.disabled =
      state.phase !== "editing" || pending || this.composing || state.text.trim() === "";
    this.branchButton.disabled = saved === null;
  }

  /** One stable timing slot: the draft's clock, then the saved note's recorded clock. */
  private paintElapsed(tick = false): void {
    if (this.destroyed) return;
    const state = this.host.controller.state;
    const beginning = state.phase === "editing" ? state.beginning : null;
    if (!tick && beginning !== null && this.timedBeginning === beginning) return;
    this.timedBeginning = beginning;
    const saved = state.phase === "resting" ? state.selected ?? state.root : null;
    let duration: number | null = state.durationMs;
    let time = state.beginning?.time ?? null;
    let title = "Writing duration · start time";
    if (saved !== null) {
      if (this.savedTiming?.thought !== saved) {
        const lookup: { thought: ThoughtRef; result: ThoughtSnapshotResult | null } = { thought: saved, result: null };
        this.savedTiming = lookup;
        void this.host.loadThought(saved).then(
          (result) => {
            if (this.destroyed || this.savedTiming !== lookup) return;
            lookup.result = result;
            this.paintElapsed();
          },
          (error: unknown) => {
            if (this.destroyed || this.savedTiming !== lookup) return;
            lookup.result = {
              kind: "unavailable",
              thought: saved,
              reason: error instanceof Error ? error.message : String(error)
            };
            this.paintElapsed();
          }
        );
      }
      const result = this.savedTiming.result;
      duration = result?.kind === "ready" ? result.snapshot.durationMs : null;
      time = result?.kind === "ready" ? result.snapshot.time : saved.time;
      title = result === null ? "Reading recorded duration…"
        : result.kind === "unavailable" ? result.reason
        : "Recorded duration · creation time";
    } else {
      this.savedTiming = null;
    }
    const show = saved !== null || time !== null;
    const text = show ? `${duration === null ? "—" : formatElapsed(duration)} · ${time?.slice(0, 5) ?? "—"}` : "";
    const changed = this.elapsedEl.textContent !== text;
    if (changed) this.elapsedEl.textContent = text;
    this.elapsedEl.setAttribute("title", title);
    this.elapsedEl.setAttribute("aria-label", title);
    this.setVisible(this.elapsedEl, show);
    // Commit changed clock ticks after painting. Incidental renders must not
    // overwrite a second already committed by a clock or a pending stop.
    if (tick && changed && show && state.phase === "editing") this.host.controller.commitDuration(state.durationMs);
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
      empty.className = "weaver-composer-chooser-row weaver-composer-chooser-empty";
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
    const active = this.referenceExpanded;
    this.setVisible(this.referenceEl, active);
    if (!active) {
      this.searching = false;
      return;
    }

    const model = controller?.model ?? null;
    const ready = model !== null && model.readiness.kind === "ready";
    const selection = model?.selection ?? null;
    const search = model?.search ?? null;
    const editing = search !== null && search.kind === "editing";

    this.setVisible(this.referenceSearchField, editing);
    if (search !== null && search.kind === "editing") {
      if (this.referenceSearchField.value !== search.text) this.referenceSearchField.value = search.text;
      // Focus once, on the way in. Focusing on every render would pull the caret
      // to the end of the query after every keystroke.
      if (!this.searching) {
        this.searching = true;
        this.referenceSearchField.focus();
      }
    } else {
      this.searching = false;
    }
    this.refSearchButton.setAttribute("aria-expanded", String(editing));

    const empty = model !== null && model.readiness.kind === "ready" && model.readiness.sequence.members.length === 0;
    this.refPrev.disabled = controller === undefined || !ready || empty;
    this.refNext.disabled = controller === undefined || !ready || empty;
    this.refOpen.disabled = controller === undefined || selection === null;
    this.refSearchButton.disabled = controller === undefined || !ready;

    this.refPosition.textContent = this.positionOf(model);

    this.setVisible(this.referenceAddress, selection !== null);
    if (selection !== null) {
      this.referenceEl.style.setProperty("--weaver-dcolor", dimensionColor(selection.d));
      this.referenceEl.style.setProperty("--weaver-d", String(Math.max(1, selection.d)));
      this.referenceAddress.setAttribute("style", dimensionColorVars(selection.d));
      this.referenceAddress.textContent = "";
      appendDigitRuns(this.referenceAddress, formatAddress(selection.b, selection.d, selection.n));
    } else {
      this.referenceEl.style.setProperty("--weaver-dcolor", dimensionColor(1));
      this.referenceEl.style.setProperty("--weaver-d", "1");
    }

    let notice: string | null = null;
    let error = false;
    if (controller === undefined) {
      notice = "Reading is unavailable here.";
    } else if (model === null) {
      notice = "Reading…";
    } else if (model.readiness.kind === "loading" || model.readiness.kind === "idle") {
      notice = "Reading…";
    } else if (model.readiness.kind === "failed") {
      notice = model.readiness.message;
      error = true;
    } else if (model.readiness.sequence.members.length === 0) {
      notice = "Nothing in this reading yet.";
    } else if (model.body.kind === "loading") {
      notice = "Reading…";
    } else if (model.body.kind === "failed") {
      notice = model.body.message;
      error = true;
    } else if (model.body.kind === "none") {
      notice = model.selection === null ? "Choose a thought to read." : "Reading…";
    }
    this.referenceNotice.textContent = notice ?? "";
    if (error) this.referenceNotice.setAttribute("data-kind", "error");
    else this.referenceNotice.removeAttribute("data-kind");
    this.setVisible(this.referenceNotice, notice !== null);

    const body = model?.body ?? null;
    if (body !== null && body.kind === "ready") {
      this.setVisible(this.referenceProse, true);
      this.syncReferencePane(body.snapshot.text, body.snapshot.thought.path);
    } else {
      this.setVisible(this.referenceProse, false);
      this.referenceKey = "";
    }

    this.setVisible(this.referenceHint, controller !== undefined && selection !== null);
  }

  private syncReferencePane(text: string, path: string): void {
    const pane = this.refPane;
    if (pane === null) return;
    const key = `${path}\u0000${text}`;
    if (this.referenceKey === key && pane.text === text) return;
    this.referenceKey = key;
    pane.update(text, path, true);
  }

  /** Where the selected thought sits in the reading, in compact digits. */
  private positionOf(model: ReferenceModel | null): string {
    if (model === null) return "";
    if (model.readiness.kind === "loading") return "Reading…";
    if (model.readiness.kind !== "ready") return "";
    const total = model.readiness.sequence.members.length;
    if (total === 0) return "No thoughts";
    const at =
      model.selection === null
        ? 0
        : model.readiness.sequence.members.findIndex(
            (record) => record.thought.n === model.selection?.n && record.thought.path === model.selection?.path
          ) + 1;
    if (at > 0) return `${at} / ${total}`;
    return `${total} thoughts`;
  }

  private renderResume(invitation: LoomInvitation | null, state?: CaptureView): void {
    this.setVisible(this.card, false);
    this.setVisible(this.resume, true);

    if (invitation !== null) {
      this.resume.setAttribute("data-invitation", invitation.phase);
      const phase = invitation.phase === "available" ? "Available" : "Upcoming";
      this.resumeButton.textContent = `${invitation.name} · ${invitation.opening} · ${phase}`;
      this.resumeButton.setAttribute("aria-label", `Open invitation: ${invitation.name} at ${invitation.opening}`);
      this.setVisible(this.resumeDismiss, true);
      this.resumeDismiss.setAttribute("aria-label", "Dismiss this invitation");
      this.resumeAction = () => this.host.takeInvitation?.(invitation.id);
      this.resumeDismissAction = () => {
        this.host.dismissInvitation?.(invitation.id);
        this.render();
      };
      return;
    }
    this.resume.removeAttribute("data-invitation");

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

  /** Copy always names the visible draft, saved prose, or reference-only reading. */
  private copyableProse(): string {
    const state = this.host.controller.state;
    if (state.phase === "closed") {
      const body = this.referenceExpanded && this.view === "write" ? this.host.reference?.model.body : null;
      return body?.kind === "ready" ? body.snapshot.text : "";
    }
    return state.phase === "resting" ? (state.selected ?? state.root)?.prose ?? "" : state.text;
  }

  private buildMenu(): void {
    this.menu.textContent = "";
    const state = this.host.controller.state;
    const item = (label: string, action: () => void, disabled = false): void => {
      const button = this.doc().createElement("button");
      button.type = "button";
      button.className = "weaver-composer-menu-item";
      button.textContent = label;
      button.setAttribute("role", "menuitem");
      button.disabled = disabled;
      button.addEventListener("click", () => {
        this.menuOpen = false;
        action();
        this.render();
      });
      this.menu.appendChild(button);
    };
    item(
      "Copy text",
      () => {
        this.moreButton.focus();
        void this.copyText();
      },
      this.copyableProse().trim() === ""
    );
    if (state.phase === "editing") {
      item("Discard draft…", () => {
        this.armDiscard();
      });
    }
    item("Keyboard shortcuts", () => {
      this.shortcutsOpen = true;
      this.render();
      this.shortcutsClose.focus();
    });
  }

  private menuItems(): HTMLButtonElement[] {
    return Array.from(this.menu.querySelectorAll<HTMLButtonElement>("button.weaver-composer-menu-item")).filter(
      (item) => !item.disabled
    );
  }

  private openMenu(): void {
    this.buildMenu();
    this.menuOpen = true;
    this.shortcutsOpen = false;
    this.render();
    this.menuItems()[0]?.focus();
  }

  private closeMenu(restoreFocus: boolean): void {
    this.menuOpen = false;
    this.render();
    if (restoreFocus) this.moreButton.focus();
  }

  private closeShortcuts(restoreFocus: boolean): void {
    this.shortcutsOpen = false;
    this.render();
    if (restoreFocus) this.moreButton.focus();
  }

  private armDiscard(): void {
    const state = this.host.controller.state;
    if (state.phase !== "editing") return;
    if (state.text.trim() === "") {
      this.discardDraft();
      return;
    }
    // The rail draws the confirmation, so it stays visible for as long as the
    // decision is open — including after the menu has closed.
    this.discardArmed = true;
    this.render();
    this.keepDraftButton.focus();
  }

  /** Discard ends only the draft; focus returns to the surviving reading or note. */
  private discardDraft(): void {
    this.discardArmed = false;
    this.host.controller.discardDraft();
    this.view = "write";
    this.render();
    if (this.host.controller.state.phase !== "closed") this.focusInput();
    else if (this.referenceExpanded) this.focusReferenceTools();
    else {
      const focus = this.returnFocus;
      if (focus !== null && focus.isConnected && !this.root.contains(focus)) focus.focus();
    }
  }

  private async copyText(): Promise<void> {
    const prose = this.copyableProse();
    if (prose.trim() === "") {
      this.flash("Nothing to copy.", "error");
      return;
    }
    try {
      const clipboard = this.mountedIn?.window.navigator.clipboard;
      if (clipboard === undefined) throw new Error("clipboard unavailable");
      await clipboard.writeText(prose);
      this.flash("Copied.", "ok");
    } catch {
      this.flash("The text could not be copied; select it and copy.", "error");
    }
  }

  private flash(text: string, kind: Feedback["kind"]): void {
    this.feedback = { text, kind };
    if (this.feedbackTimer !== null) {
      (this.mountedIn?.window ?? window).clearTimeout(this.feedbackTimer);
      this.feedbackTimer = null;
    }
    this.feedbackTimer =
      this.mountedIn?.window.setTimeout(() => {
        this.feedback = null;
        this.feedbackTimer = null;
        if (!this.destroyed) this.renderStatus(this.host.controller.state);
      }, 4000) ?? null;
    this.renderStatus(this.host.controller.state);
  }

  private buildShortcuts(doc: Document): void {
    const title = doc.createElement("div");
    title.className = "weaver-composer-shortcuts-title";
    title.textContent = "Keyboard";
    this.shortcuts.appendChild(title);

    const rows: [string, string][] = [
      ["↵", "Save the thought"],
      ["⇧↵", "Start a new line"],
      ["⌘↵", "Save the thought"],
      ["↑ ↓", "Previous or next thought (reading toolbar)"],
      ["/", "Search the reading"],
      ["↵", "Open the selected thought (reading toolbar)"],
      ["Esc", "Close the menu, panel or surface"]
    ];
    const list = doc.createElement("div");
    list.className = "weaver-composer-shortcuts-list";
    for (const [keys, label] of rows) {
      const row = doc.createElement("div");
      row.className = "weaver-composer-shortcut";
      const key = doc.createElement("kbd");
      key.textContent = keys;
      const text = doc.createElement("span");
      text.textContent = label;
      row.appendChild(key);
      row.appendChild(text);
      list.appendChild(row);
    }
    this.shortcuts.appendChild(list);

    const close = doc.createElement("button");
    close.type = "button";
    close.className = "weaver-composer-shortcuts-close weaver-composer-quiet-close";
    close.textContent = "Close";
    close.addEventListener("click", () => this.closeShortcuts(true));
    this.shortcuts.appendChild(close);
  }

  private wirePanes(): void {
    this.referenceSearchField.addEventListener("input", () => {
      const controller = this.host.reference;
      if (controller === undefined) return;
      void controller.setSearchText(this.referenceSearchField.value);
    });
    this.referenceSearchField.addEventListener("keydown", (event) => {
      const controller = this.host.reference;
      if (controller === undefined) return;
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (!controller.acceptSearch()) return;
        this.searching = false;
        this.render();
        this.focusReferenceTools();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void controller.cancelSearch().then(() => {
          this.searching = false;
          this.render();
          this.focusReferenceTools();
        });
      }
    });
  }

  private wireActions(): void {
    this.useButton.addEventListener("click", () => {
      this.host.controller.confirmTarget();
      this.render();
      this.focusInput();
    });
    this.keepTargetButton.addEventListener("click", () => {
      this.host.controller.cancelTarget();
      this.render();
      this.focusInput();
    });
    this.discardButton.addEventListener("click", () => this.discardDraft());
    this.keepDraftButton.addEventListener("click", () => {
      this.discardArmed = false;
      this.render();
      this.focusInput();
    });
    this.retryButton.addEventListener("click", () => void this.save());
    this.checkButton.addEventListener("click", () => {
      void this.host.controller.checkSave().then(() => this.render());
    });
    this.saveButton.addEventListener("click", () => void this.save());
    this.newlineButton.addEventListener("click", () => {
      if (this.composing) return;
      this.pane?.insertText("\n");
      this.pane?.focus();
    });
    this.branchButton.addEventListener("click", () => {
      const state = this.host.controller.state;
      const saved = state.selected ?? state.root;
      if (saved === null) return;
      this.view = "write";
      void this.host.controller.branch(saved);
    });
    this.freshButton.addEventListener("click", () => {
      this.view = "write";
      void this.host.controller.newThread().then(() => {
        this.render();
        this.focusInput();
      });
    });
  }

  private wireReference(): void {
    this.refPrev.addEventListener("click", () => {
      void this.host.reference?.move("previous");
    });
    this.refNext.addEventListener("click", () => {
      void this.host.reference?.move("next");
    });
    this.refOpen.addEventListener("click", () => {
      const selected = this.host.reference?.model.selection ?? null;
      if (selected !== null) void this.host.controller.editInNote(selected);
    });
    this.refSearchButton.addEventListener("click", () => {
      const controller = this.host.reference;
      if (controller === undefined) return;
      if (controller.model.search.kind === "editing") {
        void controller.cancelSearch().then(() => {
          this.searching = false;
          this.render();
          this.focusReferenceTools();
        });
        return;
      }
      controller.beginSearch();
      this.searching = false;
      this.render();
    });
    this.referenceReadTab.addEventListener("click", () => this.focusReferenceTools());
    this.referenceInviteTab.addEventListener("click", () => this.beginPanel("invitations"));
  }

  private wireHeader(): void {
    this.destButton.addEventListener("click", () => {
      if (this.view === "chooser") this.returnToWrite();
      else this.beginPanel("chooser");
    });
    this.refButton.addEventListener("click", () => this.toggleReference());
    this.hideButton.addEventListener("click", () => this.hide());
    this.moreButton.addEventListener("click", () => {
      if (this.menuOpen) this.closeMenu(true);
      else if (this.shortcutsOpen) this.closeShortcuts(true);
      else this.openMenu();
    });
  }

  private async save(): Promise<void> {
    const state = this.host.controller.state;
    if (state.phase === "resting" || state.phase === "closed") return;
    if (state.phase === "submitting" || state.phase === "uncertain") return;
    // An open target or discard confirmation has to be answered first; saving
    // through it would decide for the writer.
    if (state.pendingTarget !== null || this.discardArmed) return;
    if (this.composing) return;
    // An empty draft is refused by the controller with a notice, so the chord
    // still answers instead of doing nothing.
    await this.host.controller.settle();
    this.pane?.blur();
    this.view = "write";
    this.render();
    // Nobody else owns the keys now: hand them to the reading so Escape can
    // always close the Loom after a thought has been entered.
    if (this.host.controller.state.phase === "resting") {
      if (this.pane !== null) this.pane.focus();
      else this.writingEl.focus();
    }
  }

  private hide(): void {
    this.menuOpen = false;
    this.shortcutsOpen = false;
    this.discardArmed = false;
    this.view = "write";
    const state = this.host.controller.state;
    if (state.phase === "closed") {
      // Reading-only has no draft to dismiss: putting the reading away is the
      // whole of hiding, and the next render must not bring it back.
      this.referenceExpanded = false;
      this.pane?.blur();
      this.render();
    } else {
      this.pane?.blur();
      this.host.controller.dismiss();
      this.render();
    }
    const focus = this.returnFocus;
    if (focus !== null && focus.isConnected && !this.root.contains(focus)) focus.focus();
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.isComposing || this.composing) return;
    if (event.defaultPrevented) return;

    if (this.shortcutsOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeShortcuts(true);
      }
      return;
    }

    if (this.menuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeMenu(true);
        return;
      }
      const items = this.menuItems();
      if (items.length > 0) {
        const active = this.mountedIn?.document.activeElement ?? null;
        const at = items.findIndex((item) => item === active);
        const focus = (index: number): void => {
          const target = items[((index % items.length) + items.length) % items.length];
          target?.focus();
        };
        if (event.key === "ArrowDown") {
          event.preventDefault();
          focus(at + 1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          focus(at < 0 ? -1 : at - 1);
        } else if (event.key === "Home") {
          event.preventDefault();
          focus(0);
        } else if (event.key === "End") {
          event.preventDefault();
          focus(items.length - 1);
        }
      }
      // Tab is deliberately not trapped; it leaves the menu like any other.
      return;
    }

    if (event.key === "Escape") {
      if (this.host.reference?.model.search.kind === "editing") {
        event.preventDefault();
        void this.host.reference.cancelSearch().then(() => {
          this.searching = false;
          this.render();
          this.focusReferenceTools();
        });
        return;
      }
      if (this.view !== "write") {
        event.preventDefault();
        this.returnToWrite();
        return;
      }
      if (this.referenceExpanded) {
        event.preventDefault();
        this.collapseReference();
        return;
      }
      if (!isField(event.target)) {
        event.preventDefault();
        this.handleEscape();
      }
      return;
    }

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isField(event.target)) {
      event.preventDefault();
      void this.save();
      return;
    }

    if (this.referenceExpanded && this.view === "write") {
      const controller = this.host.reference;
      const target = event.target;
      const inPane =
        (this.pane !== null && within(this.pane.dom, target)) ||
        (this.refPane !== null && within(this.refPane.dom, target));
      const inTools = target === this.referenceEl || within(this.referenceTools, target);
      // Arrows belong to whichever editor has focus; only the navigation toolbar
      // turns them into reading moves.
      if (controller !== undefined && inTools && !inPane && !isEditorSurface(target)) {
        if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          controller.beginSearch();
          this.searching = false;
          this.render();
          return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          void controller.move(event.key === "ArrowUp" ? "previous" : "next");
          return;
        }
        if (event.key === "Enter" && !isControl(target)) {
          const selected = controller.model.selection;
          if (selected !== null) {
            event.preventDefault();
            void this.host.controller.editInNote(selected);
          }
          return;
        }
      }
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
    }
  }

  private handleEscape(): void {
    if (this.discardArmed) {
      this.discardArmed = false;
      this.render();
      this.focusInput();
      return;
    }
    this.hide();
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
   * saved thought or reference-only reading uses its own recorded dimension.
   * Colour is a function of this number alone, so the card, prose and actions
   * wear the colour the entry has in the note.
   */
  private dimensionOf(state: CaptureView): number {
    if (state.phase === "closed" && this.referenceExpanded) {
      return this.host.reference?.model.selection?.d ?? 1;
    }
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
    const box = this.viewportBox();
    const dimension = this.dimensionOf(this.host.controller.state);
    // Viewport changes choose the arrangement too; waiting for another edit
    // would leave a phone stack on a wide screen (or two cramped columns).
    const split = this.referenceExpanded &&
      this.host.reference !== undefined &&
      this.host.controller.state.phase !== "closed" &&
      this.view === "write" &&
      box.width >= 720;
    const layout = split ? "split" : "stacked";
    if (this.body.getAttribute("data-layout") !== layout) this.body.setAttribute("data-layout", layout);
    // Fixed `bottom` and innerHeight need not share a coordinate system in a
    // mobile webview. Anchor to the visual edge itself, then grow upward.
    this.root.setAttribute(
      "style",
      [
        "position: fixed",
        `left: ${box.left}px`,
        `top: ${box.bottom}px`,
        "transform: translateY(-100%)",
        `width: ${box.width}px`,
        `max-height: ${box.maxHeight}px`,
        `--weaver-composer-max-height: ${box.maxHeight}px`,
        dimensionColorVars(dimension)
      ].join("; ")
    );
    this.root.setAttribute("data-d", String(dimension));
    // Keep the focused editor or panel reachable; the action rail lives outside
    // this body and needs no scrolling of its own. Scroll only this body: native
    // scrollIntoView could pan the whole webview.
    const target =
      this.pane !== null && this.pane.hasFocus ? this.proseEl
        : this.view !== "write" ? this.chooserEl : null;
    if (target !== null) {
      const body = this.body.getBoundingClientRect();
      const content = target.getBoundingClientRect();
      this.body.scrollTop += revealScrollDelta(body.top, body.bottom, content.top, content.bottom);
      this.bodyScroll = this.body.scrollTop;
    }
    if (this.pane !== null && this.pane.hasFocus) {
      const caret = this.pane.caretBounds;
      if (caret !== null) {
        const prose = this.proseEl.getBoundingClientRect();
        this.proseEl.scrollTop += revealScrollDelta(prose.top, prose.bottom, caret.top, caret.bottom);
      }
    }
  }

  private viewportBox(): LoomAnchor {
    const view = this.mountedIn?.window ?? window;
    const visual = view.visualViewport;
    const left = visual?.offsetLeft ?? 0;
    const top = visual?.offsetTop ?? 0;
    const viewport: LoomViewport = {
      left,
      right: left + (visual?.width ?? view.innerWidth),
      top,
      bottom: top + (visual?.height ?? view.innerHeight)
    };
    const toolbar = this.mountedIn?.document.querySelector(".mobile-toolbar");
    const rect = toolbar?.getBoundingClientRect();
    const visible = toolbar !== null && toolbar !== undefined &&
      view.getComputedStyle(toolbar).visibility !== "hidden";
    return loomAnchor(viewport, visible && rect !== undefined ? rect : null);
  }

  /** The document the surface is mounted in, or the ambient one before mount. */
  private doc(): Document {
    return this.mountedIn?.document ?? document;
  }

  private focusReferenceTools(): void {
    this.referenceTools.focus();
  }

  private setVisible(element: HTMLElement, visible: boolean): void {
    if (visible) element.removeAttribute("hidden");
    else element.setAttribute("hidden", "");
  }

  private hideElement(): void {
    this.root.setAttribute("hidden", "");
    this.menuOpen = false;
    this.shortcutsOpen = false;
    this.searching = false;
  }
}
