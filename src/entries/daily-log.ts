/**
 * The day across every destination: one chronology, read and never written.
 *
 * A day is no longer one note. A thought begun before midnight can land in
 * yesterday's file while a branch of it is written this morning, and a
 * destination keeps its own folder entirely. So the day's list is derived from
 * every *recognised* day note — one whose path a configured destination's
 * template reads back, or an older dotted or dashed note that predates
 * destinations — and includes the entries those notes record as created on the
 * selected day, whatever file they sit in.
 *
 * The rules that keep the list honest:
 *
 *  - **Live text first.** An open editor holds the truth about a note it has
 *    unsaved changes for, so a registered editor's own document is read before
 *    the file on disk. A list that disagrees with the screen above it is worse
 *    than a slow one.
 *  - **No fabricated midnight.** An entry whose clock row carries no moment is
 *    grouped separately, not placed at `00:00:00`. A missing fact is missing.
 *  - **Nothing invented, nothing created.** Browsing reads; it never creates a
 *    note, and an unreadable file is reported with its path instead of quietly
 *    shortening the list.
 *  - **Bounded work.** Reads run a few at a time and a newer request cancels the
 *    generation of an older one, so changing the day twice cannot interleave two
 *    answers.
 *
 * Pure of every Obsidian API: paths in, rows out, with the reading injected.
 */

import {
  contextDayForPath,
  parseDayTemplate,
  templateNamesADay,
  type WeavingContext
} from "../core/contexts";
import { dayKeyFromName } from "../core/day";
import { parseEntries } from "../core/entries";

/** How many notes are read at once. */
const READ_CONCURRENCY = 4;

/** One entry as the day's list shows it. */
export interface DailyRow {
  path: string;
  /** The destination the note belongs to, or null for a historical note. */
  contextId: string | null;
  n: number;
  b: number;
  d: number;
  /** The day the entry records, or null when the note's own day stands in. */
  recordedDay: string | null;
  /** The day this row was selected by: the recorded one, else the note's. */
  day: string;
  /** The recorded moment, or null when the row carries none. */
  time: string | null;
  /** The model's name for the thought, when it has one. */
  whisper: string | null;
  excerpt: string;
}

/** A note the list could not read, named so the gap is visible. */
export interface DailyLogError {
  path: string;
  message: string;
}

/** The day's rows, in chronological order, and every gap in the list. */
export interface DailyLog {
  /** Timed rows, ascending by recorded moment, then path, then `N`. */
  rows: DailyRow[];
  /** Rows with no recorded moment: a list of their own, never a midnight. */
  untimed: DailyRow[];
  errors: DailyLogError[];
  /** Destinations whose own note could not be read back into a day. */
  unsupported: string[];
}

/** How the list reads the vault. */
export interface DailyLogPorts {
  /** Every markdown path, in any order. */
  paths(): readonly string[];
  /** One note's text, preferring a live editor's own document. */
  read(path: string): Promise<string | null>;
  /** A generation number: a smaller one is stale and must not be answered. */
  generation(): number;
}

/** An empty history is a history; an unreadable one is not. */
function emptyLog(unsupported: string[] = []): DailyLog {
  return { rows: [], untimed: [], errors: [], unsupported };
}

/** The destination and day a path names, whichever way this vault recognises it. */
export function recognisePath(
  path: string,
  contexts: readonly WeavingContext[]
): { contextId: string | null; day: string } | null {
  const contained = contextDayForPath(path, contexts);
  if (contained !== null) return { contextId: contained.contextId, day: contained.day };

  const basename = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  const day = dayKeyFromName(basename);
  return day === null ? null : { contextId: null, day };
}

/**
 * Reads one day across every recognised destination.
 *
 * `day` is the selected creation day, canonical `YYYY-MM-DD`. A row joins the
 * list when its own recorded day — or, for an undated historical entry, its
 * note's day — is that day.
 */
export async function readDailyLog(
  ports: DailyLogPorts,
  contexts: readonly WeavingContext[],
  day: string
): Promise<DailyLog> {
  const generation = ports.generation();
  // A destination whose own format cannot be read back names no day, so no path
  // can be attributed to it; saying so is better than quietly omitting its notes.
  const unsupported = contexts
    .filter((context) => {
      const template = parseDayTemplate(context.folder, context.format);
      return !template.ok || !templateNamesADay(template.template);
    })
    .map((context) => context.name);

  const candidates: { path: string; contextId: string | null; noteDay: string }[] = [];
  for (const path of ports.paths()) {
    const recognised = recognisePath(path, contexts);
    if (recognised === null) continue;
    // A note dated after the day being listed cannot hold a thought created on
    // it, so only that much is read.
    if (recognised.day > day) continue;
    candidates.push({ path, contextId: recognised.contextId, noteDay: recognised.day });
  }

  candidates.sort((left, right) => (left.noteDay < right.noteDay ? 1 : -1));

  const rows: DailyRow[] = [];
  const untimed: DailyRow[] = [];
  const errors: DailyLogError[] = [];

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = cursor;
      cursor += 1;
      const candidate = candidates[at];
      if (candidate === undefined) return;

      const source = await ports.read(candidate.path);
      if (ports.generation() !== generation) return;
      if (source === null) {
        errors.push({ path: candidate.path, message: "this note could not be read" });
        continue;
      }

      const index = parseEntries(source);
      if (index.legacyFormat) {
        errors.push({
          path: candidate.path,
          message: "this note still uses the old entry format; its entries are not listed"
        });
        continue;
      }
      if (index.unclosedFrontmatter || index.unclosedFence) {
        errors.push({
          path: candidate.path,
          message: index.unclosedFrontmatter
            ? "this note's frontmatter is never closed"
            : "this note has an unclosed code block"
        });
        continue;
      }

      for (const entry of index.entries) {
        const recorded = entry.day;
        const effective = recorded ?? candidate.noteDay;
        if (effective !== day) continue;

        const row: DailyRow = {
          path: candidate.path,
          contextId: candidate.contextId,
          n: entry.n,
          b: entry.b,
          d: entry.d,
          recordedDay: recorded,
          day: effective,
          time: entry.time,
          whisper: entry.whisper[0]?.text ?? null,
          excerpt: entry.title
        };
        if (entry.time === null) untimed.push(row);
        else rows.push(row);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, Math.max(1, candidates.length)) }, () => worker())
  );

  if (ports.generation() !== generation) return emptyLog(unsupported);

  rows.sort(
    (left, right) =>
      (left.time ?? "").localeCompare(right.time ?? "") ||
      left.path.localeCompare(right.path) ||
      left.n - right.n
  );
  untimed.sort((left, right) => left.path.localeCompare(right.path) || left.n - right.n);

  return { rows, untimed, errors, unsupported };
}
