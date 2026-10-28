/**
 * The live stopwatch: at most one entry is being written at a time.
 *
 * The baseline is what the entry's own duration line already holds, so a draft
 * resumed the next morning continues from where it stopped instead of restarting
 * at zero. Settled entries never resume: editing a typo in a `+` entry changes
 * nothing.
 */

export interface ActiveEntry {
  path: string;
  seq: number;
  baselineMs: number;
  /** Wall-clock milliseconds when writing resumed. */
  resumedAt: number;
}

export class EntrySession {
  private current: ActiveEntry | null = null;

  start(path: string, seq: number, baselineMs: number, now: number): void {
    this.current = { path, seq, baselineMs: Math.max(0, baselineMs), resumedAt: now };
  }

  active(): ActiveEntry | null {
    return this.current;
  }

  /** True only for this exact entry: an entry elsewhere is not the session. */
  activeFor(path: string, seq: number): boolean {
    const current = this.current;
    return current !== null && current.path === path && current.seq === seq;
  }

  /** The baseline plus the time since writing resumed, never negative. */
  elapsed(now: number): number {
    const current = this.current;
    if (current === null) return 0;
    return Math.max(0, current.baselineMs + (now - current.resumedAt));
  }

  clear(): void {
    this.current = null;
  }
}
