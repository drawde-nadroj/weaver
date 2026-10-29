/**
 * The rendered duration line.
 *
 * While the session is live the widget ticks itself: it mutates the three digit
 * spans every second and dispatches nothing, so the document, the undo history
 * and the decoration set are all untouched by the clock. The two colons are
 * their own spans because they carry the dimension's colour while the digits
 * stay white.
 *
 * The clock never moves the line. `eq` ignores the elapsed time, so a per
 * keystroke refresh of the decoration set finds the widget unchanged and leaves
 * the DOM, and the line's measured height, alone. When something a redraw must
 * show does change — the sigil, the liveness, the colour — `updateDOM` rewrites
 * that DOM in place instead of rebuilding it, which is what used to make the
 * line hop a pixel on every keystroke.
 *
 * With frames on, this element is the box's bottom rail label: the clock's own
 * box paints over the rail behind it, and the rail runs through the middle of the
 * row. It is right-aligned like nothing else in the note, and it is the only clock
 * — the frame layer draws no text. `n` is the entry it belongs to, so the frame
 * layer can find the row by its stamp instead of by a DOM position. The ticker is
 * keyed by the element, so whichever surface owns the element owns the one
 * interval.
 */

import { WidgetType } from "@codemirror/view";

import { formatClock, type DurationSigil } from "../core/duration";
import { startTicking, stopTicking, writeDigits } from "./duration-ticker";

export interface DurationWidgetInput {
  /** The entry this row's clock belongs to: the frame layer's row stamp. */
  n: number;
  sigil: DurationSigil;
  ms: number;
  active: boolean;
  color: string;
  /** The entry's depth, so the rendered line keeps the entry's indent. */
  d: number;
}

export class DurationWidget extends WidgetType {
  /** The element this instance built or adopted, so `destroy` can stop its ticker. */
  private root: HTMLElement | null = null;
  private digits: HTMLElement[] = [];

  constructor(readonly input: DurationWidgetInput) {
    super();
  }

  /**
   * The elapsed time is not part of this comparison on purpose: the widget is
   * the same widget while the sigil, the liveness, the colour and the depth are,
   * and the seconds are the tick's business, not the redraw's.
   */
  eq(other: DurationWidget): boolean {
    return (
      other.input.n === this.input.n &&
      other.input.sigil === this.input.sigil &&
      other.input.active === this.input.active &&
      other.input.color === this.input.color &&
      other.input.d === this.input.d
    );
  }

  toDOM(): HTMLElement {
    const root = document.createElement("span");
    root.className = "weaver-duration";
    this.paint(root);

    this.digits = [];
    formatClock(this.input.ms)
      .split(":")
      .forEach((part, index) => {
        if (index > 0) {
          const colon = document.createElement("span");
          colon.className = "weaver-duration-ink";
          colon.textContent = ":";
          root.appendChild(colon);
        }

        const span = document.createElement("span");
        span.className = "weaver-duration-num";
        span.textContent = part;
        root.appendChild(span);
        this.digits.push(span);
      });

    this.root = root;
    if (this.input.active) startTicking(root, this.digits, this.input.ms);
    return root;
  }

  /** The DOM outlives this instance: repaint it rather than rebuild it. */
  updateDOM(dom: HTMLElement): boolean {
    this.root = dom;
    this.paint(dom);

    this.digits = Array.from(dom.querySelectorAll<HTMLElement>(".weaver-duration-num"));
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
   * the digits. */
  private paint(root: HTMLElement): void {
    root.setAttribute(
      "style",
      `--weaver-dcolor:${this.input.color};--weaver-d:${this.input.d}`
    );
    // The frame layer finds this row by its stamp, not by a DOM position: the
    // widget is not always a line of its own.
    root.setAttribute("data-weaver-n", String(this.input.n));

    let sigil = root.querySelector<HTMLElement>(".weaver-duration-sigil");
    if (sigil === null) {
      sigil = document.createElement("span");
      sigil.className = "weaver-duration-sigil";
      root.appendChild(sigil);
    }
    sigil.textContent = this.input.sigil;
  }
}
