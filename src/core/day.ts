/**
 * The day's name, and nothing else.
 *
 * `dayKey` is the frontmatter's `date`; `dayNotePath` is the file the core Daily
 * Notes plugin opens for a `Date`, and `dayNotePathFor` the same expansion for a
 * day the caller already holds; `dayKeyFromName` is the way back from a
 * filename, so a surface can tell a past day from today's without reading the
 * vault. It takes no `Date`, so reading a note later never changes a label.
 *
 * This is the pure half of the day plane. Resolving a path to a `TFile`, and
 * creating the note, touches Obsidian and lives in `entries/day-note.ts` — the
 * split is what keeps `core` free of an `obsidian` import.
 */

import { pad2 } from "./clock";

/** The folder and the filename format a day-note path is expanded from. */
export interface DayNoteOptions {
  folder: string;
  format: string;
}

/** `YYYY-MM-DD`, the day key the frontmatter and the calendar use. */
export function dayKey(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * Expands `YYYY`, `MM` and `DD` for a canonical `YYYY-MM-DD` day and joins the
 * result with the folder.
 *
 * A destination is resolved from an explicit day, never from a fresh reading of
 * the clock: the note a thought is filed in is the day the thought began, which
 * is a fact the caller already holds even when the save happens after midnight.
 */
export function dayNotePathFor(day: string, options: DayNoteOptions): string {
  const name = options.format
    .replace(/YYYY/g, day.slice(0, 4))
    .replace(/MM/g, day.slice(5, 7))
    .replace(/DD/g, day.slice(8, 10));
  const folder = options.folder.trim().replace(/^\/+|\/+$/g, "");
  return folder === "" ? `${name}.md` : `${folder}/${name}.md`;
}

/** The same expansion for a `Date`: the day key, then {@link dayNotePathFor}. */
export function dayNotePath(now: Date, options: DayNoteOptions): string {
  return dayNotePathFor(dayKey(now), options);
}

const DOTTED_DAY = /^(\d{4})\.(\d{2})\.(\d{2})$/;
const DASHED_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026.10.27` or `2026-10-27` becomes `2026-10-27`; anything else is null. */
export function dayKeyFromName(basename: string): string | null {
  const dotted = DOTTED_DAY.exec(basename);
  if (dotted !== null) return `${dotted[1]}-${dotted[2]}-${dotted[3]}`;
  return DASHED_DAY.test(basename) ? basename : null;
}

/** The frontmatter a brand-new day note carries, and nothing else. */
export function dayFrontmatter(day: string): string {
  return [
    "---",
    `date: ${day}`,
    "travels: 0",
    "depth: 0",
    "duration: 00:00:00",
    "---",
    ""
  ].join("\n");
}
