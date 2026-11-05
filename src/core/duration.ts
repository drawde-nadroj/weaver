/**
 * The clock row of an entry, and the clocks it is written with.
 *
 * The row is the entry's last line and carries its two clocks: how long it took,
 * then the moment it was written. One format for both directions, `HH:MM:SS`, so
 * a time of day and a duration are the same shape at the same width — which is
 * what lets them sit at opposite ends of one rail. The algebra behind it — and
 * the inverse, reading a clock string back — lives in `duration.bend`, where
 * `LAWS.bend` pins it and `bend PROOF.bend` proves it; `bend/duration.mjs` is
 * that module compiled, and this file is its typed facade.
 *
 * The duration comes first because it is the half that moves: settling rewrites
 * the head of the row and leaves the moment's own characters untouched. On the
 * frame the duration labels the left corner and the moment the right.
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

/** The duration half's sigil, then air, then its clock, at the start of a row. */
const DURATION_HALF = /^([=+-])[ \t]+([^ \t]+)(?=[ \t]|$)/;
/** A moment after the duration: `HH:MM` or `HH:MM:SS`, then air or the end. */
const MOMENT = /^(\d{1,2}:\d{2}(?::\d{2})?)(?=[ \t]|$)/;

/** The two halves of a clock row: the duration, then the moment beside it. */
export interface ClockRow {
  /** Normalised `HH:MM:SS`; null when the row carries only a duration. */
  time: string | null;
  /** The duration half; null when the row carries only a moment. */
  duration: { sigil: DurationSigil; ms: number } | null;
  /**
   * The duration half's span in the row's own text, or null when it has none.
   * The span covers the sigil through its clock, not the moment or the air
   * between them, so a rewrite can replace exactly the mutable half.
   */
  durationSpan: { from: number; to: number } | null;
}

/** `9:14` and `09:14:22` both read as `09:14:22`. */
function normalizeClock(time: string): string {
  const parts = time.split(":");
  return `${(parts[0] ?? "0").padStart(2, "0")}:${(parts[1] ?? "00").padStart(2, "0")}:${(
    parts[2] ?? "00"
  ).padStart(2, "0")}`;
}

/**
 * A clock row: a duration, a moment, or both, and nothing else.
 *
 * Either half may be absent — a draft has no settled duration, a hand-written
 * entry may carry only a moment — so `null` back means the row is prose, not
 * that half of it was wrong. The duration half's span is reported so a rewrite
 * of it can leave every other character of the row alone.
 *
 * Minutes and seconds are 0–59, so `formatClock`'s own output always reads back.
 * The duration's separator is required, so a prose line that starts with a plus
 * is prose. The moment follows the duration; the old moment-first row is not a
 * clock row, which is what makes an unmigrated note fail visibly rather than be
 * read with its clock as prose.
 */
export function parseClockRow(text: string): ClockRow | null {
  const leading = text.length - text.trimStart().length;
  const row = text.trim();
  if (row === "") return null;

  let cursor = 0;
  let parsedDuration: ClockRow["duration"] = null;
  let durationSpan: ClockRow["durationSpan"] = null;

  const half = DURATION_HALF.exec(row);
  if (half !== null) {
    const secs = duration.parseClock(half[2] ?? "");
    if (!Number.isFinite(secs) || secs <= 0) return null;

    parsedDuration = { sigil: half[1] as DurationSigil, ms: (secs - 1) * 1000 };
    durationSpan = { from: leading, to: leading + half[0].length };
    cursor = half[0].length;
    while (cursor < row.length && (row[cursor] === " " || row[cursor] === "\t")) cursor += 1;
  }

  let time: string | null = null;
  if (cursor < row.length) {
    const moment = MOMENT.exec(row.slice(cursor));
    if (moment === null) return null;
    if (row.slice(cursor + moment[0].length).trim() !== "") return null;
    time = normalizeClock(moment[1] ?? "");
  }

  if (time === null && parsedDuration === null) return null;
  return { time, duration: parsedDuration, durationSpan };
}

/** The whole clock row, e.g. `+ 00:04:12 09:14:22`, or a half alone. */
export function formatClockRow(time: string | null, sigil: DurationSigil, ms: number): string {
  const clock = formatDurationLine(sigil, ms);
  return time === null ? clock : `${clock} ${time}`;
}

