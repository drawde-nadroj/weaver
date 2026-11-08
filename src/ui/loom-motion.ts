/**
 * The Loom's one motion director: the gestures a surface change earns.
 *
 * The renderer draws final states; this module reads what changed between two
 * paints and names the gesture that belongs to the change. A gesture is one
 * token on the root (`data-motion="rise"`), drawn by one block of `styles.css`,
 * and a token is cleared as soon as its animation ends or the next render
 * begins — so two animations never run over the same element.
 *
 * Two things are deliberately outside the token vocabulary. FLIP geometry is
 * measured per paint and animated with `Element.animate`, because it inverts an
 * element's own rect rather than naming a shape in CSS. A hidden root is held
 * for the sink's duration, then hidden — the only path to `hidden` — so an
 * exit reads as a dissolve instead of a cut, and a re-open inside that window
 * cancels the timer and rises instead.
 *
 * Nothing here runs where motion is unavailable: a document without
 * `Element.animate`, or a reader who asked for reduced motion, gets the final
 * state synchronously. That is also why the test shim, which defines neither,
 * never pauses or animates.
 */

/** The visible part of the surface: a full card, or the reduced strip. */
export type MotionSurface = "card" | "strip" | "none";

/** The one front layer that can be open above the card, if any. */
export type MotionLayer = "none" | "menu" | "shortcuts" | "dest";

/** Every token the stylesheet knows, in the order the director prefers them. */
export type MotionGesture =
  | "rise"
  | "sink"
  | "seal"
  | "pop"
  | "panel-up"
  | "panel-down"
  | "walk-fwd"
  | "walk-back"
  | "row-open"
  | "nav-fade";

/** What a paint drew, as facts rather than DOM: the diff's two halves. */
export interface MotionFeatures {
  /** Which part of the surface is on screen. */
  readonly visible: MotionSurface;
  /** The controller's phase, so a save and a re-entry are visible here too. */
  readonly phase: string;
  /** True while the surface is the reduced strip because the draft is hidden. */
  readonly collapsed: boolean;
  /** True while the Loom shows the reading alone, with no draft beside it. */
  readonly browsingOnly: boolean;
  /** True while the reading panel is on screen. */
  readonly referenceExpanded: boolean;
  /** The body's arrangement: stacked beside or above, split beside. */
  readonly layout: string;
  /** True when the draft branches from a parent. */
  readonly hasParent: boolean;
  /** The dimension whose colour the surface wears. */
  readonly dimension: number;
  /** The open front layer, or `none`. */
  readonly layer: MotionLayer;
  /** The selected browse row's index, or null when nothing is selected. */
  readonly selected: number | null;
  /** True while the selected browse row carries its inline reading. */
  readonly expanded: boolean;
}

/** One painted rect, in the coordinates the animation needs. */
interface Box {
  readonly top: number;
  readonly height: number;
}

/** Everything one paint leaves behind for the next diff. */
interface Paint {
  readonly features: MotionFeatures;
  readonly surfaces: ReadonlyMap<HTMLElement, Box>;
  readonly rows: ReadonlyMap<string, Box>;
}

/** The stylesheet's own easing, read once so CSS and FLIP cannot disagree. */
const DEFAULT_EASE = "cubic-bezier(0.3, 0.7, 0, 1)";
/** The exit is decelerating twice as fast as the entry: it must not linger. */
const EXIT_DURATION = 180;
/** Longest a token may outlive its animation if `animationend` never arrives. */
const TOKEN_CEILING = 900;
/** A row's growth is measured, so its FLIP is clamped like any other geometry. */
const FLIP_FLOOR = 140;
const FLIP_CEILING = 320;

/**
 * One surface's motion: gestures, FLIP and the exit hold.
 *
 * Constructed once with the elements it may move; the renderer calls
 * `beforePaint` before it draws and `afterPaint` after, and never touches a
 * token itself.
 */
export class LoomMotion {
  private paint: Paint | null = null;
  private token: MotionGesture | null = null;
  private tokenTimer: number | null = null;
  private hideTimer: number | null = null;
  /** True while a sink is in flight, so a re-open can answer with a rise. */
  private sinking = false;
  private readonly running = new Set<Animation>();
  private disposed = false;

  /** One animation ending releases the token it belongs to. */
  private readonly onAnimationEnd = (event: Event): void => {
    const name = (event as AnimationEvent).animationName ?? "";
    const gesture = TOKEN_OF_ANIMATION[name];
    if (gesture === undefined || gesture !== this.token) return;
    this.clearToken();
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly card: HTMLElement,
    private readonly resume: HTMLElement,
    private readonly stage: HTMLElement | null,
    private readonly getWindow: () => Window
  ) {
    this.root.addEventListener("animationend", this.onAnimationEnd);
  }

  /** Records the state a render is about to replace, and cancels stale motion. */
  beforePaint(): void {
    if (this.disposed) return;
    this.cancelHide();
    this.clearToken();
    this.stop();
    this.paint = this.measure();
  }

  /**
   * Draws the gesture this paint earned, then the geometry that changed.
   *
   * The new state is read from the surface itself, not passed in: the renderer
   * publishes what it drew as attributes, so there is exactly one reader of
   * those facts and the two halves of the diff cannot disagree.
   */
  afterPaint(walk: "fwd" | "back" | null): void {
    const before = this.paint;
    this.paint = null;
    if (this.disposed || before === null || !this.enabled()) {
      this.sinking = false;
      return;
    }
    const now = this.features();
    const gesture = this.gestureFor(before.features, now, walk);
    if (gesture !== null) this.setToken(gesture);
    this.sinking = false;
    this.flip(before, now);
  }

  /**
   * Hides the root after the sink, or at once when motion is unavailable.
   *
   * The caller supplies the real hiding, so this module never writes the
   * attribute that `render` reads: it only decides *when*.
   */
  holdThenHide(hideNow: () => void): void {
    this.cancelHide();
    if (this.disposed || !this.enabled()) {
      hideNow();
      return;
    }
    this.sinking = true;
    this.setToken("sink");
    this.hideTimer = this.getWindow().setTimeout(() => {
      this.hideTimer = null;
      this.sinking = false;
      this.clearToken();
      hideNow();
    }, EXIT_DURATION);
  }

  /** Clears timers, listeners and animations; the Loom is going away. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelHide();
    this.clearToken();
    this.stop();
    this.root.removeEventListener("animationend", this.onAnimationEnd);
    this.paint = null;
  }

  /** True when this document can animate at all, for a reader who allows it. */
  private enabled(): boolean {
    if (typeof this.root.animate !== "function") return false;
    const view = this.getWindow();
    if (typeof view.matchMedia !== "function") return true;
    return !view.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /**
   * The single gesture this diff earns, strongest first.
   *
   * Exactly one token per paint: a front layer opening is the newest thing on
   * screen, a sealed save is the completion the writer is waiting for, and a
   * walking row moves on its own. Colour changes need no gesture at all.
   */
  private gestureFor(
    before: MotionFeatures,
    now: MotionFeatures,
    walk: "fwd" | "back" | null
  ): MotionGesture | null {
    if (now.visible === "none") return null;
    if (before.visible === "none" || this.sinking) return "rise";
    if (before.layer === "none" && now.layer !== "none") return "pop";
    if (before.phase === "submitting" && now.phase === "resting") return "seal";
    if (!before.referenceExpanded && now.referenceExpanded) return "panel-up";
    if (before.referenceExpanded && !now.referenceExpanded) return "panel-down";
    if (before.phase === "resting" && now.phase === "editing") return "panel-up";
    if (walk !== null) return walk === "fwd" ? "walk-fwd" : "walk-back";
    if (before.expanded !== now.expanded && now.expanded) return "row-open";
    if (before.selected !== now.selected && now.expanded) return "nav-fade";
    return null;
  }

  /**
   * Measures what the FLIP needs, and no more.
   *
   * One box for the surface, because a flip only ever translates the element
   * that arrives from where the previous one was. Rows are measured only while
   * the browser is on screen: there is nothing to move when it is not, and a
   * render on every keystroke must not measure a list that does not exist.
   */
  private measure(): Paint {
    const features = this.features();
    const surfaces = new Map<HTMLElement, Box>();
    const current = features.visible === "strip" ? this.resume : features.visible === "card" ? this.card : null;
    if (current !== null) surfaces.set(current, boxOf(current));
    const rows = new Map<string, Box>();
    if (features.referenceExpanded) {
      for (const row of this.rows()) {
        rows.set(addressOf(row), boxOf(row));
      }
    }
    return { features, surfaces, rows };
  }

  /** The browse rows, in list order, when the browser is on screen. */
  private rows(): readonly HTMLElement[] {
    if (this.stage === null) return [];
    const list = this.stage.querySelector(".weaver-composer-browse-list");
    if (list === null) return [];
    return Array.from(list.querySelectorAll<HTMLElement>(".weaver-composer-browse-row"));
  }

  /**
   * The features a paint just drew, read from the DOM it wrote.
   *
   * The renderer sets these attributes itself, so this module never guesses at
   * controller state: it diffs the surface's own published facts.
   */
  private features(): MotionFeatures {
    const selected = this.rows().findIndex((row) => row.hasAttribute("data-selected"));
    const expanded = this.rows().some((row) => row.hasAttribute("data-expanded"));
    const layer: MotionLayer = this.root.querySelector(".weaver-composer-menu:not([hidden])") !== null
      ? "menu"
      : this.root.querySelector(".weaver-composer-shortcuts:not([hidden])") !== null
        ? "shortcuts"
        : this.root.querySelector(".weaver-composer-dest-popover:not([hidden])") !== null
          ? "dest"
          : "none";
    const visible: MotionSurface = this.root.hasAttribute("hidden")
      ? "none"
      : this.resume.hasAttribute("hidden") ? "card" : "strip";
    return {
      visible,
      phase: this.root.getAttribute("data-phase") ?? "",
      collapsed: this.root.getAttribute("data-collapsed") === "true",
      browsingOnly: this.root.getAttribute("data-browsing") === "true",
      referenceExpanded: this.root.getAttribute("data-reference") === "expanded",
      layout: this.root.querySelector(".weaver-composer-body")?.getAttribute("data-layout") ?? "stacked",
      hasParent: this.root.querySelector(".weaver-composer-context:not([hidden])") !== null,
      dimension: Number(this.root.getAttribute("data-d") ?? "1"),
      layer,
      selected: selected < 0 ? null : selected,
      expanded
    };
  }

  /**
   * Moves what the paint moved, from where it was.
   *
   * A different surface reads as the old one giving way: the new one starts at
   * the old rect and settles. Browse rows animate when the list survives (a
   * walk or an expansion); a filtered list is a new list and does not.
   */
  private flip(before: Paint, now: MotionFeatures): void {
    const visible = now.visible === "strip" ? this.resume : now.visible === "card" ? this.card : null;
    if (visible !== null) {
      const previous = before.surfaces.get(this.card) ?? before.surfaces.get(this.resume);
      if (previous !== undefined && before.surfaces.has(visible) === false) {
        const duration = Number.parseFloat(this.motionValue("--loom-duration", "220"));
        this.slide(visible, previous.top - boxOf(visible).top, Number.isFinite(duration) ? duration : 220);
      }
    }

    for (const row of this.rows()) {
      const previous = before.rows.get(addressOf(row));
      if (previous === undefined) continue;
      const delta = previous.top - boxOf(row).top;
      if (Math.abs(delta) < 1) continue;
      const duration = Math.min(FLIP_CEILING, Math.max(FLIP_FLOOR, 120 + Math.abs(delta) * 0.6));
      this.slide(row, delta, duration);
    }
  }

  /** One FLIP: invert the delta, then let it settle to nothing. */
  private slide(element: HTMLElement, delta: number, duration: number): void {
    if (Math.abs(delta) < 1) return;
    const animation = element.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0px)" }],
      { duration, easing: this.motionValue("--loom-ease", DEFAULT_EASE) }
    );
    this.running.add(animation);
    if (typeof animation.addEventListener === "function") {
      animation.addEventListener("finish", () => this.running.delete(animation));
    }
  }

  /** One motion property as the stylesheet computed it, so FLIP agrees with it. */
  private motionValue(property: string, fallback: string): string {
    const view = this.getWindow();
    if (typeof view.getComputedStyle !== "function") return fallback;
    const text = view.getComputedStyle(this.root).getPropertyValue(property).trim();
    return text === "" ? fallback : text;
  }

  /** Publishes one gesture, and schedules its release. */
  private setToken(gesture: MotionGesture): void {
    this.clearToken();
    this.token = gesture;
    this.root.setAttribute("data-motion", gesture);
    this.tokenTimer = this.getWindow().setTimeout(() => {
      this.tokenTimer = null;
      this.clearToken();
    }, TOKEN_CEILING);
  }

  private clearToken(): void {
    if (this.tokenTimer !== null) {
      this.getWindow().clearTimeout(this.tokenTimer);
      this.tokenTimer = null;
    }
    if (this.token === null) return;
    this.token = null;
    this.root.removeAttribute("data-motion");
  }

  private cancelHide(): void {
    if (this.hideTimer === null) return;
    this.getWindow().clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  /** Cancels every FLIP still in flight, so a new gesture starts clean. */
  private stop(): void {
    for (const animation of this.running) {
      animation.cancel();
    }
    this.running.clear();
  }
}

/** The animation names the stylesheet publishes, mapped back to their token. */
const TOKEN_OF_ANIMATION: Readonly<Record<string, MotionGesture | undefined>> = {
  "loom-rise": "rise",
  "loom-sink": "sink",
  "loom-thread-draw": "seal",
  "loom-pop": "pop",
  "loom-panel-up": "panel-up",
  "loom-panel-down": "panel-down",
  "loom-walk-fwd": "walk-fwd",
  "loom-walk-back": "walk-back",
  "loom-row-open": "row-open",
  "loom-nav-fade": "nav-fade"
};

/** One element's rect, read defensively: a shim may report nothing at all. */
function boxOf(element: HTMLElement): Box {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, height: rect.height };
}

/** A browse row's identity across paints: the address it shows, not its index. */
function addressOf(row: HTMLElement): string {
  return row.querySelector(".weaver-composer-browse-address")?.textContent ?? "";
}
