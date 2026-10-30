/**
 * The clock row of an entry, and the clocks it is written with.
 *
 * The row is the entry's last line and carries its two clocks: the moment it was
 * written, and how long it took. One format for both directions, `HH:MM:SS`, so
 * a time of day and a duration are the same shape at the same width — which is
 * what lets them sit at opposite ends of one rail. The algebra behind it — and
 * the inverse, reading a clock string back — lives in `duration.bend`, where
 * `LAWS.bend` pins it and `bend PROOF.bend` proves it; `bend/duration.mjs` is
 * that module compiled, and this file is its typed facade.
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

/** The duration half of a clock row, e.g. `+ 00:04:12`. */
export function formatDurationLine(sigil: DurationSigil, ms: number): string {
  return `${sigil} ${formatClock(ms)}`;
}

const SIGILS = "=+-";
/** A moment at the head of a row: `HH:MM` or `HH:MM:SS`, then air or the end. */
const MOMENT = /^(\d{1,2}:\d{2}(?::\d{2})?)(?=[ \t]|$)/;
/** The duration half: a sigil, one space or tab, then a clock. */
const DURATION_HALF = /^([=+-])[ \t]+(.+)$/;

/** The two halves of a clock row: the moment, then the duration beside it. */
export interface ClockRow {
  /** Normalised `HH:MM:SS`; null when the row carries only a duration. */
  time: string | null;
  /** The duration half; null when the row carries only a moment. */
  duration: { sigil: DurationSigil; ms: number } | null;
  /** The row's text through the moment and its trailing spaces, unchanged. */
  head: string;
}

/** `9:14` and `09:14:22` both read as `09:14:22`. */
function normalizeClock(time: string): string {
  const parts = time.split(":");
  return `${(parts[0] ?? "0").padStart(2, "0")}:${(parts[1] ?? "00").padStart(2, "0")}:${(
    parts[2] ?? "00"
  ).padStart(2, "0")}`;
}

/**
 * A clock row: a moment, a duration, or both, and nothing else.
 *
 * Either half may be absent — a draft has no settled duration, a hand-written
 * entry may carry only a duration — so `null` back means the row is prose, not
 * that half of it was wrong. The moment keeps its own bytes in {@link ClockRow.head}
 * so a rewrite of the duration can leave it character for character alone.
 *
 * Minutes and seconds are 0–59, so `formatClock`'s own output always reads back.
 * The duration's separator is required, so a prose line that starts with a plus
 * is prose.
 */
export function parseClockRow(text: string): ClockRow | null {
  const leading = text.length - text.trimStart().length;
  const row = text.trim();
  if (row === "") return null;

  const moment = MOMENT.exec(row);
  let rest = row;
  let head = text.slice(0, leading);
  let time: string | null = null;

  if (moment !== null) {
    time = normalizeClock(moment[1] ?? "");
    const after = row.slice(moment[0].length);
    const air = after.length - after.trimStart().length;
    head = text.slice(0, leading + moment[0].length + air);
    rest = after.trimStart();
  }

  if (rest === "") return time === null ? null : { time, duration: null, head };

  const half = DURATION_HALF.exec(rest);
  if (half === null) return null;

  const sigil = half[1] as DurationSigil;
  if (!SIGILS.includes(sigil)) return null;

  // The algebra answers `seconds + 1`, so 0 is its "not a duration".
  const secs = duration.parseClock((half[2] ?? "").trim());
  if (!Number.isFinite(secs) || secs <= 0) return null;

  return { time, duration: { sigil, ms: (secs - 1) * 1000 }, head };
}

/** The whole clock row, e.g. `09:14:22 + 00:04:12`, or the duration alone. */
export function formatClockRow(time: string | null, sigil: DurationSigil, ms: number): string {
  const clock = formatDurationLine(sigil, ms);
  return time === null ? clock : `${time} ${clock}`;
}

