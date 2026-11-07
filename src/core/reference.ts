/**
 * Reading a note's thoughts: the values a reference is drawn from and walked by.
 *
 * The upper half of the Loom is one reading surface, and everything it needs to
 * decide about *where the reader is* is a value: a scope, an order, a filter, a
 * frozen sequence and the stop the reader is on. None of it writes, opens, travels
 * or creates — that is the point of keeping the reading algebra here beside the
 * entry parser it parses with, rather than inside the surface that draws it.
 *
 * Pure: no DOM, no `obsidian`, no filesystem, no timers.
 */

import type { ThoughtRef } from "./capture";
import { contextDayForPath, type WeavingContext } from "./contexts";
import { dayKeyFromName } from "./day";
import type { Entry, EntryIndex } from "./entries";
import { thoughtRefOf } from "./capture";

/**
 * Which thoughts a reference shows.
 *
 * `tapestryId` is null for **All Tapestries**. `history` is every recorded
 * thought; `today` and `range` bound the recorded *day*, inclusive, and never by
 * a file's name — a note whose filename day lies outside the range still
 * contributes its in-range recorded-day thoughts.
 */
export type ReferenceScope =
  | { readonly kind: "history"; readonly tapestryId: string | null }
  | { readonly kind: "today"; readonly tapestryId: string | null; readonly day: string }
  | {
      readonly kind: "range";
      readonly tapestryId: string | null;
      readonly from: string;
      readonly through: string;
    };

/**
 * How a sequence is ordered.
 *
 * `time` is the ordinary reading order, by recorded day and moment; `connections`
 * is the tree, roots ordered the same way and each parent before its descendants.
 */
export type ReadingOrder = "time" | "connections";

/**
 * What the reference is filtered by.
 *
 * `none` shows everything in scope; `address` is one exact `B.D.N`; `words` is
 * every whitespace-separated term occurring in authored prose. There is no
 * regex, no semantic search and no whisper text in this filter.
 */
export type SearchQuery =
  | { readonly kind: "none" }
  | { readonly kind: "address"; readonly b: number; readonly d: number; readonly n: number }
  | { readonly kind: "words"; readonly terms: readonly string[] };

/** One reading request: scope, order and filter together, as ordinary data. */
export interface ReferenceQuery {
  readonly scope: ReferenceScope;
  readonly order: ReadingOrder;
  readonly search: SearchQuery;
}

/** One placed thought: the reference, and where its prose was scrolled to. */
export interface ReferenceStop {
  readonly thought: ThoughtRef;
  readonly textOffset: number;
}

/**
 * One thought as the reference reads it, losslessly.
 *
 * `thought` is the strict reference identity; `root` and `ancestry` place it in
 * its Thread; `originalBlock` is the exact bytes a correction must still match;
 * `text` is the authored prose a correction edits, distinct from the normalised
 * `thought.prose` used for identity and search. `whispers` are the machine rows
 * shown with it, kept as their own reading rather than folded into the text.
 */
export interface ThoughtSnapshot {
  readonly thought: ThoughtRef;
  readonly root: ThoughtRef;
  readonly ancestry: readonly ThoughtRef[];
  readonly day: string | null;
  readonly time: string | null;
  readonly durationMs: number | null;
  readonly originalBlock: string;
  readonly text: string;
  readonly whispers: readonly string[];
}

/** What loading one thought produced: its lossless snapshot, or why not. */
export type ThoughtSnapshotResult =
  | { readonly kind: "ready"; readonly snapshot: ThoughtSnapshot }
  | { readonly kind: "unavailable"; readonly thought: ThoughtRef; readonly reason: string };

/** One file that could not be read while building a sequence. */
export interface ReferenceReadError {
  readonly path: string;
  readonly message: string;
}

/**
 * One thought as a reading sequence holds it: its strict reference, the
 * Tapestry and note day it came from, and the tree edge the reader walks by.
 */
export interface ThoughtRecord {
  readonly thought: ThoughtRef;
  /** The Tapestry the note belongs to, or null for an unassigned historical note. */
  readonly tapestryId: string | null;
  /** The day the note's own filename names, which stands in for an undated entry. */
  readonly noteDay: string;
  /** The parent entry's `N` within the same note, or null for a root. */
  readonly parentN: number | null;
  /** The duration the entry's clock row records, or null when it has none. */
  readonly durationMs: number | null;
  /** The model's name for the thought, when a whisper gave it one. */
  readonly whisper: string | null;
}

/**
 * A frozen query result: the thoughts it matched, in reading order, and any files
 * that failed.
 *
 * A sequence is immutable once published, so a query that finishes late can be
 * compared against the generation that asked for it rather than overwriting a
 * newer one. A non-empty `errors` list means the count is partial, never an
 * exact whole-scope answer.
 */
export interface ReferenceSequence {
  readonly members: readonly ThoughtRecord[];
  readonly errors: readonly ReferenceReadError[];
}

/** The direction a reading move travels. */
export type ReferenceMove = "previous" | "next" | "parent" | "child" | "first" | "last";

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

/** One entry as a reading record, with its Tapestry, note day and tree edge. */
export function thoughtRecordOf(
  index: EntryIndex,
  entry: Entry,
  path: string,
  tapestryId: string | null,
  noteDay: string
): ThoughtRecord {
  const parent = entry.parent === null ? null : index.entries[entry.parent];
  return {
    thought: thoughtRefOf(index, entry, path),
    tapestryId,
    noteDay,
    parentN: parent?.n ?? null,
    durationMs: entry.duration?.ms ?? null,
    whisper: entry.whisper[0]?.text ?? null
  };
}

/** The day a record is selected by: its own recorded day, else its note's day. */
function effectiveDay(record: ThoughtRecord): string {
  return record.thought.day ?? record.noteDay;
}

/** True when a record belongs to the query's Tapestry and day range. */
export function recordInScope(record: ThoughtRecord, scope: ReferenceScope): boolean {
  if (scope.tapestryId !== null && record.tapestryId !== scope.tapestryId) return false;
  const day = effectiveDay(record);
  switch (scope.kind) {
    case "history":
      return true;
    case "today":
      return day === scope.day;
    case "range":
      return day >= scope.from && day <= scope.through;
  }
}

/** Parses a typed query into an address query or a words query, never both. */
export function searchQueryOf(text: string): SearchQuery {
  const trimmed = text.trim();
  const address = /^\{?\s*(\d{1,3})\.(\d{1,3})\.(\d{1,6})\s*\}?$/.exec(trimmed);
  if (address !== null) {
    return {
      kind: "address",
      b: Number.parseInt(address[1] ?? "0", 10),
      d: Number.parseInt(address[2] ?? "0", 10),
      n: Number.parseInt(address[3] ?? "0", 10)
    };
  }
  const terms = trimmed
    .split(/\s+/)
    .filter((term) => term !== "")
    .map((term) => term.toLowerCase());
  return terms.length === 0 ? { kind: "none" } : { kind: "words", terms };
}

/**
 * True when a record matches a search filter.
 *
 * An address matches the record's own `B.D.N`. Words match only the authored
 * prose — never a whisper — as case-insensitive substrings, and every term must
 * occur. There is no regex, no widening and no fuzzy match.
 */
export function recordMatches(record: ThoughtRecord, search: SearchQuery): boolean {
  switch (search.kind) {
    case "none":
      return true;
    case "address": {
      const thought = record.thought;
      return thought.b === search.b && thought.d === search.d && thought.n === search.n;
    }
    case "words": {
      const prose = record.thought.prose.toLowerCase();
      return search.terms.every((term) => prose.includes(term));
    }
  }
}

/**
 * The reading order's chronological comparison: recorded day, then moment, then
 * path and `N` as deterministic ties.
 *
 * An untimed thought follows timed thoughts *within its own day*; it is never
 * invented as midnight. Across days, the day still comes first.
 */
export function compareThoughtTime(left: ThoughtRecord, right: ThoughtRecord): number {
  const leftDay = effectiveDay(left);
  const rightDay = effectiveDay(right);
  if (leftDay !== rightDay) return leftDay < rightDay ? -1 : 1;

  const leftTime = left.thought.time;
  const rightTime = right.thought.time;
  if (leftTime !== rightTime) {
    if (leftTime === null) return 1;
    if (rightTime === null) return -1;
    return leftTime < rightTime ? -1 : 1;
  }

  if (left.thought.path !== right.thought.path) return left.thought.path < right.thought.path ? -1 : 1;
  return left.thought.n - right.thought.n;
}

/**
 * Orders records by Time or Connections.
 *
 * Connections visits each Thread's root before its descendants and a parent
 * before its children, with siblings in the same chronological key. The walk is
 * iterative, so a deep branch does not depend on the call stack.
 */
export function orderRecords(
  records: readonly ThoughtRecord[],
  order: ReadingOrder
): ThoughtRecord[] {
  if (order === "time") return [...records].sort(compareThoughtTime);
  return orderByConnections(records);
}

/** Parent-before-descendants tree order, roots and siblings by the Time key. */
function orderByConnections(records: readonly ThoughtRecord[]): ThoughtRecord[] {
  const children = new Map<string, ThoughtRecord[]>();
  const key = (record: ThoughtRecord): string => `${record.thought.path}#${record.thought.n}`;

  for (const record of records) {
    if (record.parentN === null) continue;
    const parentKey = `${record.thought.path}#${record.parentN}`;
    const siblings = children.get(parentKey);
    if (siblings === undefined) children.set(parentKey, [record]);
    else siblings.push(record);
  }
  for (const siblings of children.values()) siblings.sort(compareThoughtTime);

  // A record whose parent is outside this set is a root here, so a filtered
  // branch is not silently dropped from the sequence.
  const present = new Set(records.map(key));
  const roots = records
    .filter((record) => record.parentN === null || !present.has(`${record.thought.path}#${record.parentN}`))
    .sort(compareThoughtTime);
  const ordered: ThoughtRecord[] = [];
  const stack: ThoughtRecord[] = [...roots].reverse();

  while (stack.length > 0) {
    const record = stack.pop();
    if (record === undefined) continue;
    ordered.push(record);
    const kids = children.get(key(record)) ?? [];
    for (let at = kids.length - 1; at >= 0; at -= 1) {
      const kid = kids[at];
      if (kid !== undefined) stack.push(kid);
    }
  }

  return ordered;
}

/** The first record in a sequence, or null when it is empty. */
export function firstRecord(records: readonly ThoughtRecord[]): ThoughtRecord | null {
  return records[0] ?? null;
}

/** The last record in a sequence, or null when it is empty. */
export function lastRecord(records: readonly ThoughtRecord[]): ThoughtRecord | null {
  return records[records.length - 1] ?? null;
}

/**
 * The record a reading move selects, or null when it cannot move.
 *
 * Previous and next are neighbours in the frozen sequence; parent and child are
 * the tree's own edges within one note. Nothing wraps: a move past an end keeps
 * the reader where it is, because a jump from the last thought to the first is
 * not what walking meant.
 */
export function moveRecord(
  records: readonly ThoughtRecord[],
  current: ThoughtRef | null,
  move: ReferenceMove
): ThoughtRecord | null {
  if (records.length === 0) return null;
  if (move === "first") return firstRecord(records);
  if (move === "last") return lastRecord(records);

  const at = current === null ? -1 : records.findIndex((record) => record.thought.n === current.n && record.thought.path === current.path);
  if (at < 0) return records[0] ?? null;

  switch (move) {
    case "previous":
      return records[at - 1] ?? null;
    case "next":
      return records[at + 1] ?? null;
    case "parent": {
      const parentN = records[at]?.parentN ?? null;
      if (parentN === null) return null;
      const path = records[at]?.thought.path;
      return records.find((record) => record.thought.path === path && record.thought.n === parentN) ?? null;
    }
    case "child": {
      const parentN = records[at]?.thought.n;
      const path = records[at]?.thought.path;
      return records.find((record) => record.thought.path === path && record.parentN === parentN) ?? null;
    }
  }
}
