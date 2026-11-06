/**
 * The one clock a running stopwatch is read through.
 *
 * Every surface that draws a ticking clock — the entry's own row, a second pane
 * showing the same entry, the raw clock row it pauses into — reads this one
 * instance, so there is one sample per second and one snapshot to stop from. A
 * widget never owns a timer: it subscribes, paints, and unsubscribes.
 *
 * A tick samples the real time once, floors the session's elapsed milliseconds to
 * whole seconds, paints every subscriber synchronously, and only then commits that
 * painted value to the session. Committing after the paint is what makes
 * `displayed()` mean "what is on screen" rather than "what the wall clock said".
 *
 * Subscribing paints the last snapshot without advancing it: adoption, a redraw
 * or a second view must never move the digits. The timer runs while someone is
 * painting or while a session is live — an unmounted stopwatch still advances the
 * shared snapshot, so the next surface shows the right second and a stop uses it.
 *
 * The tick is scheduled for the nearest of the next wall second and the next
 * session second, from the actual time each wakeup, so a delayed callback
 * reconciles itself instead of drifting or replaying skipped seconds.
 */

import type { EntrySession } from "./session";

/** The last instant painted, and the duration that was painted with it. */
export interface ClockSnapshot {
  /** Wall-clock milliseconds of the last sample. */
  now: number;
  /** Whole seconds the session had reached at that sample. */
  durationMs: number;
}

/** Called once per tick with the sampled instant and the painted duration. */
export type ClockListener = (now: number, durationMs: number) => void;

/** One timeout handle; `window` timers are the browser's own, and vitest's fake ones. */
type TickTimer = number | undefined;

/** One sampled, synchronously painted stopwatch shared by every mounted surface. */
export class EntryClock {
  private snapshotValue: ClockSnapshot;
  private readonly listeners = new Set<ClockListener>();
  private timer: TickTimer = undefined;
  private destroyed = false;

  constructor(
    private readonly session: EntrySession,
    private readonly now: () => number
  ) {
    this.snapshotValue = { now: this.now(), durationMs: this.session.displayed() };
  }

  /** The last painted snapshot, for a view that mounts between ticks. */
  snapshot(): ClockSnapshot {
    return this.snapshotValue;
  }

  /**
   * Paints the current session's painted second at once, then joins the tick.
   * Returning nothing painted would leave a new pane blank for up to a second;
   * reading the committed second never advances it, so a redraw or a second pane
   * cannot move the digits. The remembered snapshot is not reused as-is: it may
   * belong to a session that has since ended, and a new row must not inherit it.
   */
  subscribe(listener: ClockListener): () => void {
    if (this.destroyed) return () => {};
    this.listeners.add(listener);

    const at = this.now();
    const durationMs = this.session.displayed();
    this.snapshotValue = { now: at, durationMs };
    listener(at, durationMs);

    this.schedule(at);
    return () => {
      this.listeners.delete(listener);
      this.schedule(this.now());
    };
  }

  /** Samples the real time, paints, commits, and waits for the next boundary. */
  refresh(): void {
    if (this.destroyed) return;
    const at = this.now();
    // A session that holds a stopped second samples as that second, so a tick and
    // the stop that is waiting on a write agree.
    const durationMs = Math.max(0, Math.floor(this.session.elapsed(at) / 1000) * 1000);
    this.snapshotValue = { now: at, durationMs };

    // Synchronous, and over a copy: a listener that unsubscribes or destroys
    // during its own paint must not make the remaining views miss the second.
    for (const listener of [...this.listeners]) listener(at, durationMs);

    this.session.commitDisplay(durationMs);
    this.schedule(at);
  }

  destroy(): void {
    // Widget teardown may unsubscribe after plugin unload; destruction is final.
    this.destroyed = true;
    this.cancel();
    this.listeners.clear();
  }

  /**
   * One timeout, at the first boundary that can change a digit. Wall seconds run
   * for the moment on the right; session seconds run for the duration on the
   * left; the earlier one wins. Nothing is scheduled when nothing is painting and
   * no session is live.
   */
  private schedule(at: number): void {
    this.cancel();
    if (this.destroyed || (this.listeners.size === 0 && this.session.active() === null)) return;

    const wall = 1000 - (((at % 1000) + 1000) % 1000);
    const session = 1000 - (this.session.elapsed(at) % 1000);
    const delay = Math.max(1, Math.min(wall, session));

    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, delay);
  }

  private cancel(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
