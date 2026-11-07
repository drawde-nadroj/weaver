/**
 * The rendered clock row.
 *
 * The row is the frame's bottom edge, and its two ends are its two labels: the
 * duration at the left corner, the moment at the right. The widget renders the
 * row the file holds — the duration from its sigil and milliseconds, then the
 * moment the parser read — and a half the row does not carry is not drawn: a
 * moment-only row has no clock at its left corner, and a duration-only row has
 * no moment at its right. Each half carries its own background, so the rail is cut
 * twice and stays visible in the gap between them.
 *
 * Each half is three white digit spans around two dimension-coloured colons — the
 * same grammar the address and the date label are drawn in, so the whole frame
 * reads as one type. The sigil is followed by a real space, exactly as the file
 * writes it. The day link does not live here: the date labels the top-right
 * corner and is drawn by the decoration.
 *
 * Three states decide what the two halves show:
 *
 * - `fixed` draws exactly what the file holds, and ticks not at all.
 * - `awaiting` is a draft that has no moment yet: the left corner still reads zero
 *   and the right corner is the wall clock, because that is the time the first
 *   input will record. Nothing is written to the note.
 * - `running` is the live session for this entry: the left corner is the shared
 *   snapshot's duration, the right corner the moment the text already recorded.
 *
 * The clock itself belongs to `EntryClock`, not this widget: the widget subscribes
 * while it is mounted and unsubscribes when it is not. Subscribing paints the last
 * snapshot without advancing it, so a redraw, a second pane, or an adopted element
 * never moves the digits and never restarts the elapsed count.
 *
 * The clock never moves the line. `eq` ignores the elapsed time, so a per
 * keystroke refresh of the decoration set finds the widget unchanged and leaves
 * the DOM, and the line's measured height, alone. When something a redraw must
 * show does change — the sigil, the mode, the colour, the moment — `updateDOM`
 * rewrites that DOM in place instead of rebuilding it, which is what used to make
 * the line hop a pixel on every keystroke.
 *
 * `n` is the entry it belongs to, so the frame layer can find the row by its
 * stamp instead of by a DOM position.
 */

import { WidgetType } from "@codemirror/view";

import { formatClock as formatTimeOfDay } from "../core/clock";
import type { DurationSigil } from "../core/duration";
import type { EntryClock } from "../entries/clock";
import { appendClockRuns } from "../ui/dcn";
import { writeClockText, writeDigits } from "./duration-ticker";

/** Whether the duration half is the file's own (fixed) or the live session's. */
export type DurationMode = "fixed" | "session";

/** Whether the moment half is absent, the file's recorded moment, or the wall clock. */
export type MomentMode = "absent" | "fixed" | "wall";

/** Everything the widget renders from; none of it changes while the clock ticks. */
export interface DurationWidgetInput {
  /** The entry this row's clocks belong to: the frame layer's row stamp. */
  n: number;
  /** The moment, `HH:MM:SS`; null when the row carries only a duration. */
  time: string | null;
  /** The duration half's sigil; null when the row carries only a moment. */
  sigil: DurationSigil | null;
  /** The duration the file holds, or the session's snapshot while running. */
  ms: number;
  /** The left corner's source: the file's duration, or the live session's second. */
  durationMode: DurationMode;
  /** The right corner's source: nothing, the recorded moment, or the wall clock. */
  momentMode: MomentMode;
  /** The note this row lives in, so identity survives a redraw. */
  path: string;
  /** The one shared clock; the widget never owns a timer of its own. */
  clock: EntryClock;
  color: string;
  /** The entry's depth, so the rendered line keeps the entry's indent. */
  d: number;
}

/**
 * The release hook of whichever widget is painting an element, so adoption can
 * hand the element over without leaving two writers on it.
 */
const owners = new WeakMap<HTMLElement, () => void>();

/** The clock row as a widget: two labels, digits that tick without a transaction. */
export class DurationWidget extends WidgetType {
  /** The element this instance built or adopted, so `destroy` can release it. */
  private root: HTMLElement | null = null;
  private clockHalf: HTMLElement | null = null;
  private momentHalf: HTMLElement | null = null;
  private digits: HTMLElement[] = [];
  private momentDigits: HTMLElement[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(readonly input: DurationWidgetInput) {
    super();
  }

  /**
   * The elapsed time is not part of this comparison on purpose: the widget is
   * the same widget while the moment, the sigil, the mode, the colour, the path
   * and the depth are, and the seconds are the clock's business, not the redraw's.
   */
  eq(other: DurationWidget): boolean {
    return (
      other.input.n === this.input.n &&
      other.input.time === this.input.time &&
      other.input.sigil === this.input.sigil &&
      other.input.durationMode === this.input.durationMode &&
      other.input.momentMode === this.input.momentMode &&
      other.input.path === this.input.path &&
      other.input.color === this.input.color &&
      other.input.d === this.input.d
    );
  }

  toDOM(): HTMLElement {
    // An instance paints one element: a fresh one, so the previous claim (if this
    // instance was rendered before) is released rather than stacked on.
    this.leave();

    const root = document.createElement("span");
    root.className = "weaver-duration";

    this.root = root;
    this.build(root);
    this.join(root);
    return root;
  }

  /** The DOM outlives this instance: rewrite it in place rather than rebuild it. */
  updateDOM(dom: HTMLElement): boolean {
    // Replacing the subscription is one step: the old one is released before the
    // new one paints, so an adopted element never carries two writers.
    this.leave();
    this.root = dom;
    this.build(dom);
    this.join(dom);
    return true;
  }

  /** Clicks reach the line, so a tap still places the caret. */
  ignoreEvent(): boolean {
    return false;
  }

  destroy(): void {
    this.leave();
    this.root = null;
    this.clockHalf = null;
    this.momentHalf = null;
    this.digits = [];
    this.momentDigits = [];
  }

  /** Brings both halves in line with the input, adding or removing one in place. */
  private build(root: HTMLElement): void {
    this.paint(root);

    // Adopt whatever this element already carries before touching it: a reused
    // element is rewritten, never rebuilt half over half with the old halves
    // left behind.
    this.clockHalf = root.querySelector<HTMLElement>(".weaver-duration-clock");
    this.momentHalf = root.querySelector<HTMLElement>(".weaver-duration-moment");
    this.digits = Array.from(
      root.querySelectorAll<HTMLElement>(".weaver-duration-clock .weaver-duration-num")
    );

    this.buildClockHalf(root);
    this.buildMomentHalf(root);

    // Before the first tick paints: the duration the row holds. For a draft that
    // has not been written into it is zero; a draft paused before its first input
    // keeps the time it had already accumulated.
    writeDigits(this.digits, this.input.ms);
  }

  private buildClockHalf(root: HTMLElement): void {
    const { sigil: sigilText } = this.input;
    if (sigilText === null) {
      this.clockHalf?.remove();
      this.clockHalf = null;
      this.digits = [];
      return;
    }

    let half = this.clockHalf;
    if (half === null) {
      half = document.createElement("span");
      half.className = "weaver-duration-clock weaver-frame-label";

      const sigil = document.createElement("span");
      sigil.className = "weaver-duration-sigil";
      half.appendChild(sigil);
      half.appendChild(document.createTextNode(" "));
      this.digits = appendClockRuns(half, "00:00:00");

      // The duration always leads the moment, however the halves were adopted.
      root.insertBefore(half, root.firstChild);
      this.clockHalf = half;
    }

    const sigil = half.querySelector<HTMLElement>(".weaver-duration-sigil");
    if (sigil !== null) sigil.textContent = sigilText;
  }

  private buildMomentHalf(root: HTMLElement): void {
    // The half always exists, even when the row carries no moment: its background
    // is what cuts the rail's right end, so removing it would move the frame.
    let half = this.momentHalf;
    if (half === null) {
      half = document.createElement("span");
      half.className = "weaver-duration-moment weaver-frame-label";
      root.appendChild(half);
      this.momentHalf = half;
    }

    // A moment is either the text the file recorded, or — for a draft with none
    // yet — the wall clock the first input will write. Repainted whole, because
    // switching between the two changes which characters exist, not just values.
    half.textContent = "";
    this.momentDigits = [];
    if (this.input.momentMode === "wall") {
      this.momentDigits = appendClockRuns(
        half,
        formatTimeOfDay(new Date(this.input.clock.snapshot().now))
      );
    } else if (this.input.momentMode === "fixed" && this.input.time !== null) {
      appendClockRuns(half, this.input.time);
    }
  }

  /** Paints the last snapshot now; the clock calls this once a second after. */
  private join(root: HTMLElement): void {
    // Adoption hands this element to a new instance: whoever held it before stops
    // painting before the new subscription starts, so one element has one writer.
    // Released even for a fixed row, which leaves nothing painting at all.
    owners.get(root)?.();
    owners.delete(root);

    const durationLive = this.input.durationMode === "session";
    const momentLive = this.input.momentMode === "wall";
    if (!durationLive && !momentLive) return;

    const unsubscribe = this.input.clock.subscribe((now, durationMs) => {
      if (momentLive) writeClockText(this.momentDigits, formatTimeOfDay(new Date(now)));
      if (durationLive) writeDigits(this.digits, durationMs);
    });

    this.unsubscribe = unsubscribe;
    owners.set(root, unsubscribe);
  }

  private leave(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    if (unsubscribe === null) return;

    unsubscribe();
    // Only the owner that is still current may clear the element's claim: an
    // instance superseded by an adopting one must not orphan the new writer.
    if (this.root !== null && owners.get(this.root) === unsubscribe) owners.delete(this.root);
  }

  /** The sigil, the row stamp and the two custom properties, which live outside
   * the digits. Everything else the widget shows is fixed by `eq`. */
  private paint(root: HTMLElement): void {
    root.setAttribute(
      "style",
      `--weaver-dcolor:${this.input.color};--weaver-d:${this.input.d}`
    );
    // The frame layer finds this row by its stamp, not by a DOM position: the
    // widget is not always a line of its own.
    root.setAttribute("data-weaver-n", String(this.input.n));
  }
}
