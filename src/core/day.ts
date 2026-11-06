/**
 * The day's name, and nothing else.
 *
 * `dayKey` is the frontmatter's `date`; `dayNotePath` is the file the core Daily
 * Notes plugin opens; `dayKeyFromName` is the way back from a filename, so a
 * surface can tell a past day from today's without reading the vault.
 * `entryDayLinkTarget` labels only an entry whose recorded creation day differs
 * from its day-note filename, using that filename's dotted or dashed style.
 * It takes no `Date`, so reading a note later never changes a label.
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

/** Expands `YYYY`, `MM` and `DD` and joins the result with the folder. */
export function dayNotePath(now: Date, options: DayNoteOptions): string {
  const name = options.format
    .replace(/YYYY/g, String(now.getFullYear()))
    .replace(/MM/g, pad2(now.getMonth() + 1))
    .replace(/DD/g, pad2(now.getDate()));
  const folder = options.folder.trim().replace(/^\/+|\/+$/g, "");
  return folder === "" ? `${name}.md` : `${folder}/${name}.md`;
}

const DOTTED_DAY = /^(\d{4})\.(\d{2})\.(\d{2})$/;
const DASHED_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026.10.27` or `2026-10-27` becomes `2026-10-27`; anything else is null. */
export function dayKeyFromName(basename: string): string | null {
  const dotted = DOTTED_DAY.exec(basename);
  if (dotted !== null) return `${dotted[1]}-${dotted[2]}-${dotted[3]}`;
  return DASHED_DAY.test(basename) ? basename : null;
}

/**
 * A creation-day link only when the recorded day differs from the note's day.
 *
 * Historical undated entries inherit the filename day and need no label.
 * Non-day notes provide no comparison day and carry no generated link.
 */
export function entryDayLinkTarget(day: string | null, basename: string): string | null {
  const noteDay = dayKeyFromName(basename);
  if (day === null || noteDay === null || day === noteDay) return null;
  return DOTTED_DAY.test(basename) ? day.replace(/-/g, ".") : day;
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
