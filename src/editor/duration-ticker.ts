/**
 * The one writer of a ticking clock.
 *
 * A ticker belongs to the element it writes into, not to whoever asked for it:
 * CodeMirror may hand a new widget the element an old one built, and the frame
 * layer may hand the same element a different entry. Keying the interval by the
 * DOM means one writer per element, whichever caller started it.
 *
 * A second is the smallest unit a clock shows, so the tick is a second.
 */

import { formatClock } from "../core/duration";

export const TICK_MS = 1000;

export interface Ticker {
  timer: number;
  shown: number;
  digits: HTMLElement[];
}

const tickers = new WeakMap<HTMLElement, Ticker>();

/** Rewrites the three digit spans — hours, minutes, seconds — in place. */
export function writeDigits(digits: readonly HTMLElement[], ms: number): void {
  formatClock(ms)
    .split(":")
    .forEach((part, index) => {
      const span = digits[index];
      if (span !== undefined) span.textContent = part;
    });
}

export function stopTicking(dom: HTMLElement | null): void {
  if (dom === null) return;
  const ticker = tickers.get(dom);
  if (ticker !== undefined) window.clearInterval(ticker.timer);
  tickers.delete(dom);
}

export function startTicking(dom: HTMLElement, digits: HTMLElement[], ms: number): void {
  stopTicking(dom);

  const ticker: Ticker = { timer: 0, shown: ms, digits };
  ticker.timer = window.setInterval(() => {
    ticker.shown += TICK_MS;
    writeDigits(ticker.digits, ticker.shown);
  }, TICK_MS);
  tickers.set(dom, ticker);
}
