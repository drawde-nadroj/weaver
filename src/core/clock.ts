import type { TimestampFormat } from "../settings";

export type { TimestampFormat };

/** Pads a clock component to two digits. */
export function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Formats wall-clock time using the machine's local timezone. `toLocaleTimeString`
 * is never used: it can insert non-breaking characters and follows locale rules.
 */
export function formatClock(date: Date, format: TimestampFormat): string {
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  if (format === "HH:mm") return `${hours}:${minutes}`;
  return `${hours}:${minutes}:${pad2(date.getSeconds())}`;
}

/** Formats an elapsed session as `+mm:ss`, widening to `+h:mm:ss` past an hour. */
export function formatSessionDuration(start: Date, now: Date): string {
  const total = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `+${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `+${pad2(minutes)}:${pad2(seconds)}`;
}

const CLOCK_PREFIX = /^(\d{1,2}:\d{2}(?::\d{2})?)\b/;

/**
 * Splits a heading text into its optional leading clock and the remaining title.
 * A following `" - "` separator is stripped; any other remainder is returned
 * verbatim, so a title that happens to contain a dash keeps it.
 *
 * Heading text is right-trimmed before it arrives here, so a timestamp with no
 * title yet (`# 09:12:01 - `) leaves the separator alone as `" -"`. That is an
 * empty title, not a title of `-`: an untitled dimension is legal, merely
 * unfinished.
 */
export function parseClockPrefix(text: string): { time: string | null; rest: string } {
  const match = CLOCK_PREFIX.exec(text);
  const time = match?.[1];
  if (time === undefined) return { time: null, rest: text };

  const remainder = text.slice(time.length);
  if (remainder.startsWith(" - ")) return { time, rest: remainder.slice(3) };
  if (remainder.trim() === "-") return { time, rest: "" };
  return { time, rest: remainder };
}
