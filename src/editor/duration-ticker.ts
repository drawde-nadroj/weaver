/**
 * The digit writer shared by every drawn clock.
 *
 * A clock is three digit spans around two colons; the same spans are rewritten
 * in place for the life of the element, and no edit ever touches the document.
 * The ticking itself belongs to `EntryClock`: an element owns no timer.
 */

import { formatClock } from "../core/duration";

/** Splits an `HH:MM:SS` text into the three digit spans, in place. */
export function writeClockText(digits: readonly HTMLElement[], clock: string): void {
  clock.split(":").forEach((part, index) => {
    const span = digits[index];
    if (span !== undefined) span.textContent = part;
  });
}

/** Rewrites the three digit spans — hours, minutes, seconds — in place. */
export function writeDigits(digits: readonly HTMLElement[], ms: number): void {
  writeClockText(digits, formatClock(ms));
}
