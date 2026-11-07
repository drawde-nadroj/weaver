/**
 * The live stopwatch: at most one entry is being written at a time.
 *
 * The baseline is what the entry's own clock row already holds, so a draft
 * resumed the next morning continues from where it stopped instead of restarting
 * at zero. Settled entries never resume: editing a typo in a `+` entry changes
 * nothing.
 *
 * Two readings of the same session, and they are not interchangeable. `elapsed`
 * is the raw sample a clock takes; `displayed` is the last whole second a surface
 * actually painted. Stopping writes `displayed`, never a fresh sample: what the
 * writer saw is what the row keeps, so a delayed timer can never make a visible
 * `00:00:07` become `00:00:09`.
 */

export interface ActiveEntry {
  path: string;
  seq: number;
  /**
   * A monotonically increasing identity, assigned on every `start`.
   *
   * Two sessions may share a path, an `N` and even a resume instant; only this id
   * distinguishes "the session that stopped" from "a replacement that happens to
   * look the same", which is what stops a late pause from clearing new work.
   */
  id: number;
  baselineMs: number;
  /** Wall-clock milliseconds when writing resumed. */
  resumedAt: number;
  /** The last painted duration, in whole seconds; authoritative when stopping. */
  shownMs: number;
}

/** Whether a native entry is running, held for a stop, or idle. */
export type NativeSessionState =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly entry: ActiveEntry }
  | { readonly kind: "held"; readonly entry: ActiveEntry };

/**
 * What stopping a native entry actually did.
 *
 * `stopped` and `failed` both name the captured owner and session id, so a caller
 * learns the truth even if the session was replaced while the write was in flight.
 * `idle` means there was nothing to stop.
 */
export type NativeStopResult =
  | { readonly kind: "idle" }
  | {
      readonly kind: "stopped" | "failed";
      readonly owner: EntrySession;
      readonly sessionId: number;
      readonly path: string;
      readonly n: number;
    };

/** Whole seconds, never negative, and never a fraction the screen cannot show. */
function wholeSeconds(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000) * 1000);
}

/** At most one live stopwatch; every field here is device-local. */
export class EntrySession {
  private current: ActiveEntry | null = null;
  /** A stop has claimed the painted second; no tick may move it. */
  private held = false;
  /** The next session identity; never reused within one plugin lifetime. */
  private nextId = 1;

  start(path: string, seq: number, baselineMs: number, now: number): void {
    const baseline = Math.max(0, baselineMs);
    this.current = {
      path,
      seq,
      id: this.nextId,
      baselineMs: baseline,
      resumedAt: now,
      shownMs: wholeSeconds(baseline)
    };
    this.nextId += 1;
    this.held = false;
  }

  active(): ActiveEntry | null {
    return this.current;
  }

  /** The current session as a tagged state, so a caller never guesses from fields. */
  state(): NativeSessionState {
    if (this.current === null) return { kind: "idle" };
    return { kind: this.held ? "held" : "running", entry: this.current };
  }

  /** True only for this exact entry: an entry elsewhere is not the session. */
  activeFor(path: string, seq: number): boolean {
    const current = this.current;
    return current !== null && current.path === path && current.seq === seq;
  }

  /**
   * The baseline plus the time since writing resumed, never negative. Raw, except
   * while a stop holds the painted second: then the held sample is the answer, so
   * a clock sample and a stop cannot disagree.
   */
  elapsed(now: number): number {
    const current = this.current;
    if (current === null) return 0;
    if (this.held) return current.shownMs;
    return Math.max(0, current.baselineMs + (now - current.resumedAt));
  }

  /** The last duration a clock painted, in whole seconds; 0 with no session. */
  displayed(): number {
    return this.current?.shownMs ?? 0;
  }

  /**
   * Records what a clock just painted. Whole seconds only, and only for the
   * current session: a late paint from an ended one must not rewrite anything.
   * A frozen session ignores it — the stop already claimed that second.
   */
  commitDisplay(ms: number): void {
    const current = this.current;
    if (current === null || this.held) return;
    current.shownMs = wholeSeconds(ms);
  }

  /**
   * Holds the painted second for a stop that is in flight.
   *
   * A stop writes what the writer saw, and the write can take a moment: without
   * this, a tick landing during the write would move the number the row shows
   * after the user already pressed stop, and a retry would write the later one.
   * Held until the session ends or a fresh start replaces it, so a failed write
   * keeps the stopped second while the entry is still open.
   */
  freezeDisplay(): void {
    if (this.current === null) return;
    this.held = true;
  }

  /** True only while the current session's painted second is held. */
  frozen(): boolean {
    return this.current !== null && this.held;
  }

  clear(): void {
    this.current = null;
    this.held = false;
  }

  /**
   * Clears only when `id` is still the current session's identity.
   *
   * A pause that finishes after the writer started a fresh session must not clear
   * the replacement, even if it shares the old one's path and `N`. Returns whether
   * it cleared.
   */
  clearIf(id: number): boolean {
    if (this.current === null || this.current.id !== id) return false;
    this.clear();
    return true;
  }
}
