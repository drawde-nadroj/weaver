/**
 * The clock row of an entry, and the clocks it is written with.
 *
 * The row is the entry's last line and carries its two clocks: how long it took,
 * then the moment it was written, with the day it was written on between them
 * (`+ 00:04:12 2026-11-05 09:14:22`) so an entry keeps its own creation date
 * even in a note named for another one. One format for both clocks, `HH:MM:SS`, so
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
/** A day after the duration: canonical dashed `YYYY-MM-DD`, then air or the end. */
const DAY = /^(\d{4}-\d{2}-\d{2})(?=[ \t]|$)/;
/** A moment after the duration: `HH:MM` or `HH:MM:SS`, then air or the end. */
const MOMENT = /^(\d{1,2}:\d{2}(?::\d{2})?)(?=[ \t]|$)/;

/**
 * The parts of a clock row: the duration, the day it was written, then the
 * moment beside it.
 */
export interface ClockRow {
  /** Normalised `HH:MM:SS`; null when the row carries only a duration. */
  time: string | null;
  /**
   * The entry's own day, canonical `YYYY-MM-DD`, as written between the
   * duration and the moment; null when the row predates a written day.
   */
  day: string | null;
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
 * A clock row: a duration, a day and a moment, and nothing else.
 *
 * Either clock may be absent — a draft has no settled duration, a hand-written
 * entry may carry only a moment — so `null` back means the row is prose, not
 * that a part of it was wrong. A day is only readable beside a moment: a date
 * on its own would let a surface infer a wall-clock moment the row never
 * carried, so `+ 00:04:12 2026-11-05` is prose. The duration half's span is
 * reported so a rewrite of it can leave every other character of the row alone.
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
  let day: string | null = null;
  if (cursor < row.length) {
    const written = DAY.exec(row.slice(cursor));
    if (written !== null) {
      day = written[1] ?? null;
      cursor += written[0].length;
      while (cursor < row.length && (row[cursor] === " " || row[cursor] === "\t")) cursor += 1;
      // A day without a moment is not a clock row: nothing writes one.
      if (cursor >= row.length) return null;
    }

    const moment = MOMENT.exec(row.slice(cursor));
    if (moment === null) return null;
    if (row.slice(cursor + moment[0].length).trim() !== "") return null;
    time = normalizeClock(moment[1] ?? "");
  }

  if (time === null && parsedDuration === null) return null;
  return { time, day, duration: parsedDuration, durationSpan };
}

/**
 * The whole clock row, e.g. `+ 00:04:12 2026-11-05 09:14:22`, or a part alone.
 *
 * `day` is the entry's own creation day, `YYYY-MM-DD`; a row with no moment
 * carries no day either, because a date is read only beside a moment.
 */
export function formatClockRow(
  time: string | null,
  sigil: DurationSigil,
  ms: number,
  day: string | null
): string {
  const clock = formatDurationLine(sigil, ms);
  if (time === null) return clock;
  return day === null ? `${clock} ${time}` : `${clock} ${day} ${time}`;
}

