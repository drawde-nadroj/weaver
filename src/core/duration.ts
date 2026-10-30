/**
 * The duration line of an entry, and the clock it is written with.
 *
 * One format for both directions: `HH:MM:SS`. An entry's duration reads against
 * the marker's own clock, so a duration and a time of day are the same shape at
 * the same width. The algebra behind it — and the inverse, reading a clock
 * string back — lives in `duration.bend`, where `LAWS.bend` pins it and
 * `bend PROOF.bend` proves it; `bend/duration.mjs` is that module compiled, and
 * this file is its typed facade.
 *
 * The generated module sits in its own directory on purpose: a `duration.mjs`
 * beside this file would win the extensionless `./duration` import, and Vite
 * tries `.mjs` before `.ts`.
 *
 * What stays here is what Bend cannot see: milliseconds, which are rounded into
 * the seconds the algebra counts in, and the sigil, which is text.
 */

import duration from "./bend/duration.mjs";

/** The three sigils: `-` open and being written, `=` open and paused, `+` settled. */
export type DurationSigil = "+" | "-" | "=";

/** Milliseconds as `HH:MM:SS`; hours are unbounded. */
export function formatClock(ms: number): string {
  return duration.clock(Math.max(0, Math.round(ms / 1000)));
}

/** The whole line, e.g. `+ 00:04:12`. */
export function formatDurationLine(sigil: DurationSigil, ms: number): string {
  return `${sigil} ${formatClock(ms)}`;
}

const SIGILS = "=+-";

/**
 * A duration line: sigil, one space, then `HH:MM:SS`.
 *
 * Minutes and seconds are 0–59, so `formatClock`'s own output always reads back.
 * The separator is required, so a prose line that starts with a plus is prose.
 */
export function parseDurationLine(line: string): { sigil: DurationSigil; ms: number } | null {
  const sigil = line[0];
  if (sigil === undefined || !SIGILS.includes(sigil)) return null;
  if (line[1] !== " " && line[1] !== "\t") return null;

  // The algebra answers `seconds + 1`, so 0 is its "not a duration line".
  const secs = duration.parseClock(line.slice(1).trim());
  if (!Number.isFinite(secs) || secs <= 0) return null;

  return { sigil: sigil as DurationSigil, ms: (secs - 1) * 1000 };
}
