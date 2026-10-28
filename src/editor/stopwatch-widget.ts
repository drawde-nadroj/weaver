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
 * A ticker belongs to the element it writes into, not to the widget instance:
 * CodeMirror calls `updateDOM` on the *new* widget while the previous instance
 * may still hold an interval. Keying the interval by the DOM means one writer
 * per element, whichever instance created it.
 */

import { WidgetType } from "@codemirror/view";

import { formatClock, type DurationSigil } from "../core/duration";

export interface DurationWidgetInput {
  sigil: DurationSigil;
  ms: number;
  active: boolean;
  color: string;
  /** The entry's depth, so the rendered line keeps the entry's indent. */
  d: number;
}

/** A second is the smallest unit the line shows, so the tick is a second. */
const TICK_MS = 1000;

interface Ticker {
  timer: number;
  shown: number;
  digits: HTMLElement[];
}

const tickers = new WeakMap<HTMLElement, Ticker>();

function writeDigits(digits: readonly HTMLElement[], ms: number): void {
  formatClock(ms)
    .split(":")
    .forEach((part, index) => {
      const span = digits[index];
      if (span !== undefined) span.textContent = part;
    });
}

function stopTicking(dom: HTMLElement | null): void {
  if (dom === null) return;
  const ticker = tickers.get(dom);
  if (ticker !== undefined) window.clearInterval(ticker.timer);
  tickers.delete(dom);
}

function startTicking(dom: HTMLElement, digits: HTMLElement[], ms: number): void {
  stopTicking(dom);

  const ticker: Ticker = { timer: 0, shown: ms, digits };
  ticker.timer = window.setInterval(() => {
    ticker.shown += TICK_MS;
    writeDigits(ticker.digits, ticker.shown);
  }, TICK_MS);
  tickers.set(dom, ticker);
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

  /** The sigil and the two custom properties, which live outside the digits. */
  private paint(root: HTMLElement): void {
    root.setAttribute(
      "style",
      `--weaver-dcolor:${this.input.color};--weaver-d:${this.input.d}`
    );

    let sigil = root.querySelector<HTMLElement>(".weaver-duration-sigil");
    if (sigil === null) {
      sigil = document.createElement("span");
      sigil.className = "weaver-duration-sigil";
      root.appendChild(sigil);
    }
    sigil.textContent = this.input.sigil;
  }
}
