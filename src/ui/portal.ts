/**
 * The pending portal, drawn once for every surface that can show one.
 *
 * A portal is not an entry: it has no marker, no `n`, and no bytes in the note
 * until its first text is accepted. Its frame therefore carries its own small
 * vocabulary — a rail label, a countdown, the wall clock, and one control — and
 * this module is the only place that vocabulary is built. Live Preview mounts a
 * surface with a writing receptacle; Reading mounts the same surface without
 * one, because Reading must never write. Everything a surface knows arrives
 * from its owner: it owns no timer, reads no file, and never dispatches.
 *
 * The writing receptacle is a deliberate, temporary input position, not a second
 * editor. It exists for exactly one insertion: the first nonempty text at or
 * after the opening. Until the opening it accepts nothing and buffers nothing —
 * a blocked attempt says why once, quietly, instead of announcing every key. A
 * held key repeating across the boundary stays blocked until its key is released
 * and pressed again, so leaning on a key cannot spend an opening. Once the text
 * is handed over, the owner writes it into the real entry and focus moves to the
 * real caret; this element never echoes what it did not accept.
 *
 * A refused handoff is the one case where text stays here. The surface keeps the
 * recovered text in place and says that the entry could not be started, so the
 * writer can try again without retyping. It shows no celebration and starts
 * nothing.
 *
 * The wall clock is painted into the same digit runs as every other clock row,
 * one second at a time, from the instant the owner samples. No tick is a
 * transaction, and no tick moves the frame.
 */

import type { PortalInstant } from "../core/portals";
import { formatClock as formatTimeOfDay, pad2 } from "../core/clock";
import { writeClockText } from "../editor/duration-ticker";
import { appendClockRuns } from "./dcn";

/** The phase a face shows; `held` is a prepared opening past its own minute. */
export type PortalDisplayPhase = "approaching" | "open" | "held" | "expired";

/** Writing mounts the receptacle; Reading only offers the deliberate switch. */
export type PortalSurfaceMode = "write" | "reading";

/** What the owner supplies: the facts, the gestures, and nothing else. */
export interface PortalSurfaceOptions {
  /** The opening this frame stands for. */
  portal: PortalInstant;
  /** `write` adds the first-input receptacle; `reading` never can write. */
  mode: PortalSurfaceMode;
  /** A deliberate Prepare/Enter; called only from the control itself. */
  prepare(): void;
  /** Escape, or an explicit release; the owner restores focus. */
  release(): void;
  /**
   * Write mode only: the first committed nonempty text, synchronously.
   * `false` means the portal was refused; the surface keeps the text.
   */
  capture?(text: string, at: number): boolean;
  /** The instant a capture should be stamped with. */
  now(): number;
  /** False suppresses rail motion while keeping the frame readable. */
  effectful?: boolean;
  /** The reason a refused capture gives, if the owner knows one. */
  failure?(text: string, at: number): string | undefined;
  /** The receptacle itself took focus, so the owner can remember where to return. */
  focused?(): void;
}

/** A refusal with no more specific cause. */
export const PORTAL_REFUSAL = "Could not start this entry";

/** Whole seconds left, rounded up so a countdown never reads zero before opening. */
function remainingSeconds(portal: PortalInstant, now: number): number {
  return Math.max(0, Math.ceil((portal.opensAt - now) / 1000));
}

/** `MM:SS` for a countdown; minutes are padded because the lead is under an hour. */
function countdownClock(seconds: number): string {
  return `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
}

/** The rail label: the opening's frozen local hour and minute, never a target. */
export function portalTimeLabel(portal: PortalInstant): string {
  return `Portal · ${pad2(portal.hour)}:${pad2(portal.minute)}`;
}

/**
 * The bottom-left label: a countdown, then the state once the minute starts.
 *
 * `prepared` is what distinguishes a held opening from one that has passed;
 * without it the label never claims a hold the surface does not have.
 */
export function portalCountdownLabel(portal: PortalInstant, now: number, prepared = false): string {
  if (now < portal.opensAt) return `Opens in ${countdownClock(remainingSeconds(portal, now))}`;
  if (now < portal.opensAt + 60_000) return "Open";
  return prepared ? "Held" : "Passed";
}

/** Newlines are not prose in an entry; a paste of many lines becomes one line. */
function normalizeInput(text: string): string {
  return text.replace(/\r\n?|\n/g, " ").trim();
}

/** The one portal frame: labels, one control, an optional receptacle. */
export class PortalSurface {
  /** The element the owner inserts into a tray. */
  readonly root: HTMLElement;
  /** The opening this surface stands for. */
  readonly portal: PortalInstant;

  private readonly countdownEl: HTMLElement;
  private readonly clockDigits: HTMLElement[];
  private readonly button: HTMLButtonElement;
  private readonly input: HTMLElement | null;
  private readonly refusalEl: HTMLElement;
  private readonly lockEl: HTMLElement;

  /** Prepared through a deliberate gesture; the receptacle exists only then. */
  private prepared = false;
  /** Text a refused handoff kept, so a retry carries it rather than losing it. */
  private pending = "";
  /** Guards the synchronous handoff against a reentrant input event. */
  private capturing = false;
  /** Once a handoff is accepted the receptacle is done; late events are ignored. */
  private accepted = false;
  /** IME composition is native preedit until it commits. */
  private composing = false;
  /** The wall clock last painted, so a repaint never rewrites the same digits. */
  private shownClock = "";
  /** A blocked attempt has already spoken for this locked window. */
  private lockSpoken = false;
  /** A refused handoff is showing; the control offers an explicit retry. */
  private refused = false;
  /** The key currently auto-repeating; its input is ignored until released. */
  private repeatingKey: string | null = null;
  private destroyed = false;

  constructor(private readonly options: PortalSurfaceOptions) {
    const doc = document;
    const portal = options.portal;
    this.portal = portal;

    this.root = doc.createElement("div");
    this.root.className = "weaver-portal";
    this.root.setAttribute("data-weaver-portal", portal.id);
    this.root.setAttribute("data-mode", options.mode);
    this.root.setAttribute("data-phase", "approaching");
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", portalTimeLabel(portal));
    if (options.effectful === false) this.root.setAttribute("data-effects", "off");

    const label = doc.createElement("span");
    label.className = "weaver-portal-label";
    label.textContent = portalTimeLabel(portal);
    this.root.appendChild(label);

    this.button = doc.createElement("button");
    this.button.className = "weaver-portal-prepare";
    this.button.setAttribute("type", "button");
    this.root.appendChild(this.button);

    if (options.mode === "write") {
      const input = doc.createElement("div");
      input.className = "weaver-portal-input";
      input.setAttribute("role", "textbox");
      input.setAttribute("aria-multiline", "false");
      input.setAttribute("aria-label", `Portal ${pad2(portal.hour)}:${pad2(portal.minute)} input`);
      input.setAttribute("contenteditable", "false");
      input.setAttribute("tabindex", "-1");
      input.setAttribute("spellcheck", "false");
      input.setAttribute("autocapitalize", "off");
      input.setAttribute("hidden", "");
      this.input = input;
      this.root.appendChild(input);
      this.bindInput(input);
    } else {
      this.input = null;
    }

    // One row on the frame's bottom rail, exactly like an entry's clock row:
    // the countdown at the left corner and the wall clock at the right, each
    // with the halo that cuts the rail it names. The interior controls sit
    // between the two labels, never inside this row, so a bigger touch target
    // cannot push the clock off its rail.
    const footer = doc.createElement("div");
    footer.className = "weaver-portal-footer";

    this.countdownEl = doc.createElement("span");
    this.countdownEl.className = "weaver-portal-countdown weaver-frame-label";
    footer.appendChild(this.countdownEl);

    const clock = doc.createElement("span");
    clock.className = "weaver-portal-clock weaver-frame-label";
    this.clockDigits = appendClockRuns(clock, "00:00:00");
    footer.appendChild(clock);

    this.root.appendChild(footer);

    this.refusalEl = doc.createElement("span");
    this.refusalEl.className = "weaver-portal-refusal";
    this.refusalEl.setAttribute("role", "status");
    this.refusalEl.setAttribute("hidden", "");
    this.root.appendChild(this.refusalEl);

    this.lockEl = doc.createElement("span");
    this.lockEl.className = "weaver-portal-lock";
    this.lockEl.setAttribute("role", "status");
    this.lockEl.setAttribute("aria-live", "polite");
    this.lockEl.setAttribute("hidden", "");
    this.root.appendChild(this.lockEl);

    this.button.addEventListener("click", () => {
      if (this.refused && this.pending !== "") {
        this.retry();
        return;
      }
      // The same control that prepared the opening is the way out of it, so a
      // touch keyboard without Escape still has a deliberate release.
      if (this.prepared) {
        this.options.release();
        return;
      }
      this.requestPrepare();
    });
    this.refresh(options.now());
  }

  /** Whether this face is the prepared input position; the owner syncs it. */
  get isPrepared(): boolean {
    return this.prepared;
  }

  /** Paints the state a sample implies; the owner calls this once per second. */
  refresh(now: number, prepared = this.prepared): void {
    if (this.destroyed) return;
    this.prepared = prepared;

    const phase = this.phaseAt(now);
    this.root.setAttribute("data-phase", phase);
    if (prepared) this.root.classList.add("is-prepared");
    else this.root.classList.remove("is-prepared");

    const countdown = portalCountdownLabel(this.portal, now, this.prepared);
    if (this.countdownEl.textContent !== countdown) this.countdownEl.textContent = countdown;

    const clock = formatTimeOfDay(new Date(now));
    if (clock !== this.shownClock) {
      this.shownClock = clock;
      writeClockText(this.clockDigits, clock);
    }

    if (phase !== "approaching") this.clearLock();
    this.refreshControl(phase);
    this.refreshInput(phase);
  }

  /**
   * Turns the surface into the waiting input position and takes focus.
   *
   * Only a deliberate gesture reaches this: the owner prepares the portal and
   * then asks for focus, so an announcement or a rollover never moves the caret.
   */
  setPrepared(prepared: boolean, focus = false): void {
    if (this.destroyed) return;
    this.prepared = prepared;

    if (this.input !== null) {
      if (prepared) {
        this.input.removeAttribute("hidden");
        this.input.setAttribute("contenteditable", "true");
        this.input.setAttribute("tabindex", "0");
        if (focus) this.focusInput();
      } else {
        this.input.setAttribute("hidden", "");
        this.input.setAttribute("contenteditable", "false");
        this.input.setAttribute("tabindex", "-1");
        this.root.classList.remove("is-locked");
      }
    }

    if (!prepared) this.clearLock();
    this.refresh(this.options.now(), prepared);
  }

  /** Focuses the prepared receptacle, if this surface is allowed to have one. */
  focusInput(): boolean {
    if (this.destroyed || this.options.mode !== "write" || this.input === null) return false;
    if (!this.prepared) return false;
    // Selecting contents on a touch keyboard can scroll the page for no reason;
    // an empty receptacle already places its caret when it takes focus.
    if (this.pending !== "") this.placeCaretAtEnd();
    this.input.focus();
    return true;
  }

  /** Shows why the handoff failed; the recovered text stays in the receptacle. */
  showRefusal(message: string): void {
    if (this.destroyed) return;
    this.refused = true;
    this.root.classList.add("is-refused");
    this.refusalEl.textContent = message;
    this.refusalEl.removeAttribute("hidden");
  }

  /**
   * Restores text a refused handoff kept, so replacing this element does not
   * lose the writer's first words. The explicit retry offers them again.
   */
  recover(text: string, message: string = PORTAL_REFUSAL): void {
    if (this.destroyed || this.accepted) return;
    this.pending = text;
    this.setText(text);
    this.showRefusal(message);
    this.refreshControl(this.phaseAt(this.options.now()));
  }

  /** Forgets any recovered text after the owner accepted it. */
  clearInput(): void {
    this.pending = "";
    this.refused = false;
    this.root.classList.remove("is-refused", "is-captured");
    this.refusalEl.setAttribute("hidden", "");
    if (this.input !== null) this.setText("");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.repeatingKey = null;
    this.root.remove();
  }

  /** A prepared opening outlives its minute as `held`; nothing else does. */
  private phaseAt(now: number): PortalDisplayPhase {
    if (now < this.portal.opensAt) return "approaching";
    if (now < this.portal.opensAt + 60_000) return "open";
    return this.prepared ? "held" : "expired";
  }

  /** Prepare while locked, Enter once open, and Release while prepared. */
  private refreshControl(phase: PortalDisplayPhase): void {
    if (this.refused && this.pending !== "") {
      this.button.removeAttribute("hidden");
      this.button.disabled = false;
      if (this.button.textContent !== "Retry") this.button.textContent = "Retry";
      this.button.setAttribute("aria-label", "Retry starting this entry");
      return;
    }

    if (phase === "expired") {
      this.button.setAttribute("hidden", "");
      this.button.disabled = true;
      return;
    }

    const time = `${pad2(this.portal.hour)}:${pad2(this.portal.minute)}`;

    if (this.prepared) {
      // Prepared: the existing control stays usable as the deliberate release,
      // which is the only way out on a touch keyboard that has no Escape.
      this.button.removeAttribute("hidden");
      this.button.disabled = false;
      if (this.button.textContent !== "Release") this.button.textContent = "Release";
      this.button.setAttribute("aria-label", `Release portal ${time}`);
      return;
    }

    this.button.removeAttribute("hidden");
    this.button.disabled = false;
    const label = phase === "approaching" ? "Prepare" : "Enter";
    if (this.button.textContent !== label) this.button.textContent = label;
    this.button.setAttribute("aria-label", `${label} portal ${time}`);
  }

  /** The receptacle is a textbox only after preparation, and only when write mode. */
  private refreshInput(phase: PortalDisplayPhase): void {
    if (this.input === null) return;
    const time = `${pad2(this.portal.hour)}:${pad2(this.portal.minute)}`;
    const state = phase === "approaching"
      ? `locked until ${time}`
      : phase === "held" ? "held" : phase === "expired" ? "passed" : "open";
    this.input.setAttribute("aria-label", `Portal ${time} input, ${state}`);
    if (phase === "expired" && this.input.getAttribute("contenteditable") === "true") {
      this.input.setAttribute("contenteditable", "false");
      this.input.setAttribute("tabindex", "-1");
    }
  }

  /** A control gesture: prepare the owner's hold, then become the input. */
  private requestPrepare(): void {
    if (this.destroyed || this.prepared) return;
    this.options.prepare();
  }

  /** True when text at `at` may be handed over right now. */
  private accepts(at: number): boolean {
    if (this.destroyed || this.options.mode !== "write" || !this.prepared || this.capturing) {
      return false;
    }
    const phase = this.phaseAt(at);
    return phase === "open" || phase === "held";
  }

  /** One insertion attempt, from any committed input path. */
  private submit(text: string, at: number): boolean {
    if (this.destroyed) return false;
    // A reentrant insertion while the handoff is in flight is ignored, not refused.
    if (this.capturing) return false;
    if (!this.accepts(at)) {
      this.showLock();
      return false;
    }

    const capture = this.options.capture;
    if (capture === undefined) return false;

    const body = normalizeInput(text);
    if (body === "") return false;

    this.capturing = true;
    let accepted = false;
    try {
      accepted = capture(body, at);
    } catch {
      accepted = false;
    } finally {
      this.capturing = false;
    }

    if (accepted) {
      this.accepted = true;
      this.refused = false;
      this.pending = "";
      this.setText("");
      this.root.classList.remove("is-refused");
      this.refusalEl.setAttribute("hidden", "");
      this.root.classList.add("is-captured");
      return true;
    }

    this.pending = body;
    this.setText(body);
    const reason = this.options.failure?.(body, at) ?? PORTAL_REFUSAL;
    this.showRefusal(reason);
    this.refreshControl(this.phaseAt(at));
    return false;
  }

  /**
   * Deliberate retry after a repair: the whole recovered text is offered again,
   * never just the next character typed into the receptacle.
   */
  private retry(): void {
    if (this.destroyed || this.accepted || this.pending === "") return;
    this.submit(this.pending, this.options.now());
  }

  /** Says why the opening is not taking text, at most once per lock window. */
  private showLock(): void {
    if (this.lockSpoken) return;
    this.lockSpoken = true;
    this.root.classList.add("is-locked");
    const expired = this.phaseAt(this.options.now()) === "expired";
    this.lockEl.textContent = expired
      ? "This opening has passed"
      : `Locked until ${pad2(this.portal.hour)}:${pad2(this.portal.minute)}`;
    this.lockEl.removeAttribute("hidden");
  }

  private clearLock(): void {
    if (!this.lockSpoken) return;
    this.lockSpoken = false;
    this.root.classList.remove("is-locked");
    this.lockEl.textContent = "";
    this.lockEl.setAttribute("hidden", "");
  }

  /** The receptacle holds recovered text only; it is never a live editor mirror. */
  private setText(value: string): void {
    if (this.input === null) return;
    this.input.textContent = value;
    if (value !== "") this.placeCaretAtEnd();
  }

  private placeCaretAtEnd(): void {
    if (this.input === null) return;
    if (typeof getSelection !== "function") return;
    const selection = getSelection();
    if (selection === null) return;
    const doc = this.input.ownerDocument;
    if (!doc || typeof doc.createRange !== "function") return;
    try {
      const range = doc.createRange();
      range.selectNodeContents(this.input);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // A selection API is optional in a headless harness; typing still works.
    }
  }

  /** Every committed insertion path funnels here; nothing is buffered early. */
  private bindInput(input: HTMLElement): void {
    input.addEventListener("keydown", (event: Event) => this.onKeydown(event as KeyboardEvent));
    input.addEventListener("keyup", (event: Event) => this.onKeyup(event as KeyboardEvent));
    input.addEventListener("beforeinput", (event: Event) => this.onBeforeInput(event as InputEvent));
    input.addEventListener("input", (event: Event) => this.onInput(event as InputEvent));
    input.addEventListener("paste", (event: Event) => this.onPaste(event as ClipboardEvent));
    input.addEventListener("drop", (event: Event) => this.onDrop(event as DragEvent));
    input.addEventListener("focus", () => this.options.focused?.());
    input.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    input.addEventListener("compositionend", () => {
      this.composing = false;
      this.onCompositionEnd();
    });
  }

  /** Escape and Enter belong to the surface; a held key never crosses a boundary. */
  private onKeydown(event: KeyboardEvent): void {
    if (this.destroyed || this.accepted || event.isComposing === true) return;

    if (event.key === "Escape") {
      this.consume(event);
      this.options.release();
      return;
    }

    if (event.key === "Enter") {
      // One entry is one line: Enter is never the first text and never splits it.
      this.consume(event);
      if (this.refused && this.pending !== "") this.retry();
      return;
    }

    if (event.key === "Tab") return;

    if (event.repeat === true) {
      // Only a held key that can write text can spend an opening.
      if (event.key.length === 1) this.repeatingKey = event.key;
      return;
    }

    // A fresh press is the release the boundary was waiting for.
    this.repeatingKey = null;
  }

  private onKeyup(event: KeyboardEvent): void {
    if (this.repeatingKey === event.key) this.repeatingKey = null;
  }

  /**
   * One committed insertion attempt.
   *
   * While the portal is locked every insert is refused and the reason is said
   * once. While it is open the browser's own insertion is replaced by the
   * synchronous handoff, so the text exists in exactly one place: the entry.
   */
  private onBeforeInput(event: InputEvent): void {
    if (this.destroyed) return;
    if (this.accepted || this.capturing) {
      this.consume(event);
      return;
    }

    const now = this.options.now();
    const type = event.inputType ?? "";

    if (type === "insertFromComposition") return;

    if (this.composing || event.isComposing === true) {
      if (!this.accepts(now)) {
        this.consume(event);
        this.showLock();
      }
      return;
    }

    if (type === "insertLineBreak" || type === "insertParagraph") {
      this.consume(event);
      return;
    }

    if (type === "insertFromPaste" || type === "insertFromDrop") {
      // The paste/drop handlers own these paths; stop the default second copy.
      this.consume(event);
      return;
    }

    if (!type.startsWith("insert") && !type.startsWith("format")) return;

    if (this.repeatingKey !== null) {
      // A key held across the boundary spends nothing until it is released.
      this.consume(event);
      return;
    }

    const data = event.data ?? "";
    if (data === "") {
      if (!this.accepts(now)) {
        this.consume(event);
        this.showLock();
      }
      return;
    }

    this.consume(event);
    this.submit(this.pending + data, now);
  }

  /**
   * The last-resort path for a browser that inserts without `beforeinput`.
   *
   * Anything already committed is either handed over or put back; composition
   * is left to `compositionend`, and an accepted handoff clears the receptacle
   * instead of echoing a second copy.
   */
  private onInput(event: InputEvent): void {
    if (this.destroyed || this.composing || event.isComposing === true) return;
    if (this.input === null) return;

    if (this.accepted || this.capturing) {
      this.setText("");
      return;
    }

    const text = this.input.textContent ?? "";
    if (text === "") return;

    if (!this.accepts(this.options.now())) {
      this.setText(this.pending);
      this.showLock();
      return;
    }

    this.submit(text, this.options.now());
  }

  /** The paste event runs before `beforeinput`; one path, one capture. */
  private onPaste(event: ClipboardEvent): void {
    if (this.destroyed) return;
    if (this.accepted || this.capturing) {
      this.consume(event);
      return;
    }
    this.consume(event);

    const now = this.options.now();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text === "") {
      if (!this.accepts(now)) this.showLock();
      return;
    }
    this.submit(this.pending + text, now);
  }

  private onDrop(event: DragEvent): void {
    if (this.destroyed) return;
    if (this.accepted || this.capturing) {
      this.consume(event);
      return;
    }
    this.consume(event);

    const now = this.options.now();
    const text = event.dataTransfer?.getData("text/plain") ?? "";
    if (text === "") {
      if (!this.accepts(now)) this.showLock();
      return;
    }
    this.submit(this.pending + text, now);
  }

  /**
   * Composition commits once, as the whole text the receptacle now holds.
   *
   * Native preedit is allowed while the opening accepts text; a commit before
   * the opening clears the receptacle instead of buffering it.
   */
  private onCompositionEnd(): void {
    if (this.destroyed || this.accepted || this.capturing || this.input === null) return;

    const now = this.options.now();
    if (!this.accepts(now)) {
      this.setText("");
      this.showLock();
      return;
    }

    const text = this.input.textContent ?? "";
    if (text === "") return;
    this.submit(text, now);
  }

  /** Prevents the browser's own insertion and keeps the event from the editor. */
  private consume(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
  }
}

/** The empty tray element every view mounts its pending portals into. */
export function portalTrayElement(): HTMLElement {
  const tray = document.createElement("div");
  tray.className = "weaver-portal-tray";
  tray.setAttribute("data-weaver-portal-tray", "");
  return tray;
}

/** Creates and appends the tray a view renders its pending portals in. */
export function mountPortalTray(container: HTMLElement): HTMLElement {
  const tray = portalTrayElement();
  container.appendChild(tray);
  return tray;
}

/** Mounts one pending portal into a tray, in the tray's own order. */
export function mountPortalSurface(container: HTMLElement, options: PortalSurfaceOptions): PortalSurface {
  const surface = new PortalSurface(options);
  container.appendChild(surface.root);
  return surface;
}
