/**
 * The rendered clock row.
 *
 * The row is the frame's bottom edge, and its two ends are its two labels: the
 * moment at the left corner, the duration at the right. The widget renders the
 * row the file holds — the moment the parser read, the duration from its sigil
 * and milliseconds — and a half the row does not carry is not drawn: a
 * moment-only row has no clock at its right corner, and a duration-only row has
 * no moment at its left. Each half carries its own background, so the rail is cut
 * twice and stays visible in the gap between them.
 *
 * Each half is three white digit spans around two dimension-coloured colons — the
 * same grammar the marker and the date label are drawn in, so the whole frame
 * reads as one type. The day link no longer lives here: the date labels the top
 * right corner and is drawn by the decoration.
 *
 * While the session is live the widget ticks itself: it mutates the duration
 * half's three digit spans every second and dispatches nothing, so the document,
 * the undo history and the decoration set are all untouched by the clock, and the
 * moment's digits — which never change — are never written to.
 *
 * The clock never moves the line. `eq` ignores the elapsed time, so a per
 * keystroke refresh of the decoration set finds the widget unchanged and leaves
 * the DOM, and the line's measured height, alone. When something a redraw must
 * show does change — the sigil, the liveness, the colour, the moment — `updateDOM`
 * rewrites that DOM in place instead of rebuilding it, which is what used to make
 * the line hop a pixel on every keystroke.
 *
 * `n` is the entry it belongs to, so the frame layer can find the row by its
 * stamp instead of by a DOM position. The ticker is keyed by the element, so
 * whichever surface owns the element owns the one interval.
 */

import { WidgetType } from "@codemirror/view";

import { formatClock, type DurationSigil } from "../core/duration";
import { appendClockRuns } from "../ui/dcn";
import { startTicking, stopTicking, writeDigits } from "./duration-ticker";

/** Everything the widget renders from; none of it changes while the clock ticks. */
export interface DurationWidgetInput {
  /** The entry this row's clocks belong to: the frame layer's row stamp. */
  n: number;
  /** The moment, `HH:MM:SS`; null when the row carries only a duration. */
  time: string | null;
  /** The duration half's sigil; null when the row carries only a moment. */
  sigil: DurationSigil | null;
  ms: number;
  active: boolean;
  color: string;
  /** The entry's depth, so the rendered line keeps the entry's indent. */
  d: number;
}

/** The clock row as a widget: two labels, digits that tick without a transaction. */
export class DurationWidget extends WidgetType {
  /** The element this instance built or adopted, so `destroy` can stop its ticker. */
  private root: HTMLElement | null = null;
  private digits: HTMLElement[] = [];

  constructor(readonly input: DurationWidgetInput) {
    super();
  }

  /**
   * The elapsed time is not part of this comparison on purpose: the widget is
   * the same widget while the moment, the sigil, the liveness, the colour and the
   * depth are, and the seconds are the tick's business, not the redraw's.
   */
  eq(other: DurationWidget): boolean {
    return (
      other.input.n === this.input.n &&
      other.input.time === this.input.time &&
      other.input.sigil === this.input.sigil &&
      other.input.active === this.input.active &&
      other.input.color === this.input.color &&
      other.input.d === this.input.d
    );
  }

  toDOM(): HTMLElement {
    const root = document.createElement("span");
    root.className = "weaver-duration";

    // The bottom-left label: the moment, in white digits and the dimension's
    // colons — the same grammar as the stopwatch beside it.
    const moment = document.createElement("span");
    moment.className = "weaver-duration-moment weaver-frame-label";
    if (this.input.time !== null) appendClockRuns(moment, this.input.time);
    root.appendChild(moment);

    // The bottom-right label: the sigil, then the clock. A row that carries only
    // a moment has no duration half, so the widget draws none: the frame must not
    // label a corner with a value the file does not hold.
    if (this.input.sigil !== null) {
      const clock = document.createElement("span");
      clock.className = "weaver-duration-clock weaver-frame-label";

      const sigil = document.createElement("span");
      sigil.className = "weaver-duration-sigil";
      clock.appendChild(sigil);

      this.digits = appendClockRuns(clock, formatClock(this.input.ms));

      root.appendChild(clock);
    } else {
      this.digits = [];
    }

    this.root = root;
    this.paint(root);
    if (this.input.active) startTicking(root, this.digits, this.input.ms);
    return root;
  }

  /** The DOM outlives this instance: repaint it rather than rebuild it. */
  updateDOM(dom: HTMLElement): boolean {
    this.root = dom;
    this.paint(dom);

    // Scoped to the clock half: the moment carries `.weaver-duration-num` spans
    // too, and the ticker must write only into the duration.
    this.digits = Array.from(
      dom.querySelectorAll<HTMLElement>(".weaver-duration-clock .weaver-duration-num")
    );
    writeDigits(this.digits, this.input.ms);

    if (this.input.active) startTicking(dom, this.digits, this.input.ms);
    else stopTicking(dom);
    return true;
  }

  /** Clicks reach the line, so a tap still places the caret. */
  ignoreEvent(): boolean {
    return false;
  }

  destroy(dom?: HTMLElement): void {
    stopTicking(dom ?? this.root);
    this.root = null;
    this.digits = [];
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

    const sigil = root.querySelector<HTMLElement>(".weaver-duration-sigil");
    if (sigil !== null) sigil.textContent = this.input.sigil;
  }
}
