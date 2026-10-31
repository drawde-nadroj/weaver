/**
 * The entry: the unit a day note is made of.
 *
 * An entry is a marker line `{ D.B.N }`, prose, then at most one clock row
 * `09:14:22 + 00:04:31` — the moment it was written, then how long it took. `D`
 * is the dimension, `B` the branch id (a depth-1 entry's position among depth-1
 * entries, carried unchanged by everything beneath it), `N` the day sequence
 * (assigned once, only appended). `N` is identity, `B` is address: `N` never
 * moves, and `B` changes only when a root is deleted, never on insert.
 *
 * The marker is matched as a **prefix**, so a title written on it becomes the
 * first prose line instead of breaking the entry. The clock row is the entry's
 * last line, which is what lets the moment and the duration label the frame's
 * bottom rail at its two corners. Markers inside frontmatter or a fenced code
 * block are text.
 *
 * `proseLines` is trimmed at both ends: a blank line between the prose and the
 * clock row is spacing, not content, so the caret and the "last prose line" both
 * refer to a line the writer actually typed on.
 *
 * A whisper row — `~ <text>`, or `~ learn:` / `~ next:` — is not prose. It is the
 * model's reading of the entry, written above the writer's words, and it is
 * partitioned out here so that `title`, `proseFrom` and the duration row all
 * describe what the writer wrote. A `~` line inside a fenced block is text, and
 * stays prose.
 */

import { lineStartsOf, scanFences, scanFrontmatter, type CodeFence } from "./document";
import { parseClockRow, type DurationSigil } from "./duration";
import type { TextChange } from "./insert";
import { parseWhisperLine, type WhisperItem } from "./whisper";

/** One entry: its marker, prose, clocks, and the offsets every surface reads. */
export interface Entry {
  /** Zero-based index of the marker line. */
  line: number;
  /** Absolute offset of the marker line's start. */
  from: number;
  /** Absolute offset of the marker line's end, excluding its newline. */
  to: number;
  d: number;
  b: number;
  n: number;
  /** 1-based position of the depth-1 ancestor among depth-1 entries; equals
   * `b` in a healthy note, and is what a deletion repairs. */
  branch: number;
  /** The moment, normalised `HH:MM:SS`; null when the entry has no clock row. */
  time: string | null;
  /** Absolute offset just past the marker, where a title or the day link sits. */
  markerEnd: number;
  /** `-` is a draft; `+`, `=` and an absent duration are settled. */
  state: "draft" | "settled";
  /** The clock row's duration half; null for a row without one, or no row. */
  duration: { sigil: DurationSigil; ms: number } | null;
  /** Zero-based index of the clock row, or null when the entry has none. */
  clockLine: number | null;
  clockFrom: number;
  clockTo: number;
  /** Absolute, `proseTo` exclusive. */
  proseFrom: number;
  proseTo: number;
  proseLines: number[];
  /** Zero-based indices of this entry's whisper rows, in document order. */
  whisperLines: number[];
  /** The parsed whisper, in document order; empty when there is none. */
  whisper: WhisperItem[];
  firstProseLine: number | null;
  /** First prose line, trimmed; empty when the entry has no prose yet. */
  title: string;
  /** Index into `entries`, or null for a root entry. */
  parent: number | null;
  /** Last line of the subtree. */
  blockEnd: number;
}

/** One parse of a note: its entries, maxima, and the line facts they were found in. */
export interface EntryIndex {
  entries: Entry[];
  maxD: number;
  maxN: number;
  codeFences: CodeFence[];
  unclosedFence: boolean;
  unclosedFrontmatter: boolean;
  /** True when a marker still carries its old `- HH:MM:SS` clock. */
  legacyFormat: boolean;
  frontmatterEnd: number | null;
  lines: string[];
  lineStarts: number[];
}

/** `{ 1.2.3 }`, matched as a prefix; whatever follows it is the entry's first prose. */
const MARKER = /^\{[ \t]*(\d{1,3})\.(\d{1,3})\.(\d{1,6})[ \t]*\}/d;

/**
 * The shape a marker carried before the clock row: `{ 1.2.3 } - 13:27:43`.
 *
 * It is never parsed. A note that still holds one is refused rather than read,
 * because the row would otherwise become an entry whose first prose line is its
 * own clock — a silent mistranslation, not an error.
 */
const LEGACY_MARKER =
  /^\{[ \t]*\d{1,3}\.\d{1,3}\.\d{1,6}[ \t]*\}[ \t]*-[ \t]*\d{1,2}:\d{2}(?::\d{2})?/;

/** What a marker line carries, and how much of the text it occupies. */
export interface MarkerPrefix {
  d: number;
  b: number;
  n: number;
  /** Length of the marker text, in characters. */
  length: number;
}

/**
 * Reads a marker at the start of `text`, or returns null.
 *
 * The marker is a prefix, so `{ 1.2.3 } a title` is one entry whose title is
 * `a title` — and the same is true of a hand-written line that opens with an
 * address and nothing else.
 */
export function parseMarkerPrefix(text: string): MarkerPrefix | null {
  const match = MARKER.exec(text);
  if (match === null) return null;

  return {
    d: Number.parseInt(match[1] ?? "1", 10),
    b: Number.parseInt(match[2] ?? "1", 10),
    n: Number.parseInt(match[3] ?? "1", 10),
    length: match[0].length
  };
}

/** The clock row of the entry starting at `line`, before `limit`. */
function findClockRow(
  lines: readonly string[],
  line: number,
  limit: number,
  fenced: ReadonlySet<number>
): number | null {
  for (let candidate = line + 1; candidate < limit; candidate += 1) {
    if (fenced.has(candidate)) continue;
    if (parseClockRow(lines[candidate] ?? "") !== null) return candidate;
  }
  return null;
}

interface MarkerHit {
  line: number;
  d: number;
  b: number;
  n: number;
  markerEnd: number;
  /** Where the prose starts when it is on the marker line: past the spaces. */
  proseStart: number;
  inline: boolean;
}

/** Parses a note into entries, ignoring frontmatter and fenced code. */
export function parseEntries(source: string): EntryIndex {
  const lines = source.split("\n");
  const lineStarts = lineStartsOf(source);
  const frontmatter = scanFrontmatter(lines);

  const index: EntryIndex = {
    entries: [],
    maxD: 0,
    maxN: 0,
    codeFences: [],
    unclosedFence: false,
    unclosedFrontmatter: false,
    legacyFormat: false,
    frontmatterEnd: null,
    lines,
    lineStarts
  };

  if (frontmatter.kind === "unclosed") return { ...index, unclosedFrontmatter: true };

  const fences = scanFences(lines);
  index.codeFences = fences.fences;
  index.unclosedFence = fences.unclosed;
  index.frontmatterEnd = frontmatter.kind === "closed" ? frontmatter.end : null;

  const hits: MarkerHit[] = [];
  for (let line = frontmatter.end + 1; line < lines.length; line += 1) {
    if (fences.inside.has(line)) continue;

    const raw = lines[line] ?? "";
    const prefix = parseMarkerPrefix(raw);
    if (prefix === null) continue;

    const start = lineStarts[line] ?? 0;
    const remainder = raw.slice(prefix.length);
    const inline = remainder.trim() !== "";
    if (LEGACY_MARKER.test(raw)) index.legacyFormat = true;
    hits.push({
      line,
      d: prefix.d,
      b: prefix.b,
      n: prefix.n,
      markerEnd: start + prefix.length,
      proseStart: start + prefix.length + (inline ? remainder.length - remainder.trimStart().length : 0),
      inline
    });
  }

  const stack: number[] = [];
  // Depth-1 entries seen so far: a root's branch is its own 1-based position.
  let roots = 0;

  for (let position = 0; position < hits.length; position += 1) {
    const hit = hits[position] as MarkerHit;
    const raw = lines[hit.line] ?? "";
    const start = lineStarts[hit.line] ?? 0;

    const limit = position + 1 < hits.length ? (hits[position + 1] as MarkerHit).line : lines.length;
    const clockLine = findClockRow(lines, hit.line, limit, fences.inside);

    let lo = hit.inline ? hit.line : hit.line + 1;
    let hi = (clockLine ?? limit) - 1;
    while (lo <= hi && (lines[lo] ?? "").trim() === "") lo += 1;
    while (hi >= lo && (lines[hi] ?? "").trim() === "") hi -= 1;

    const proseLines: number[] = [];
    const whisperLines: number[] = [];
    for (let line = lo; line <= hi; line += 1) {
      // A `~` inside a fenced block is code, so the fence decides first.
      if (!fences.inside.has(line) && parseWhisperLine(lines[line] ?? "") !== null) {
        whisperLines.push(line);
      } else {
        proseLines.push(line);
      }
    }

    const whisper = whisperLines
      .map((line) => parseWhisperLine(lines[line] ?? ""))
      .filter((item): item is WhisperItem => item !== null);

    const firstProseLine = proseLines[0] ?? null;
    const lastProseLine = proseLines[proseLines.length - 1] ?? null;

    const proseFrom = hit.inline
      ? hit.proseStart
      : (firstProseLine !== null
        ? (lineStarts[firstProseLine] ?? hit.markerEnd)
        : (lineStarts[Math.min(hit.line + 1, lines.length - 1)] ?? hit.markerEnd));

    const proseTo =
      lastProseLine === null
        ? proseFrom
        : (lineStarts[lastProseLine] ?? 0) + (lines[lastProseLine] ?? "").length;

    const title =
      firstProseLine === null
        ? ""
        : hit.inline && firstProseLine === hit.line
          ? raw.slice(hit.markerEnd - start).trim()
          : (lines[firstProseLine] ?? "").trim();

    const clock = clockLine === null ? null : parseClockRow(lines[clockLine] ?? "");
    const duration = clock?.duration ?? null;
    const clockFrom = clockLine === null ? 0 : (lineStarts[clockLine] ?? 0);

    while (stack.length > 0) {
      const top = index.entries[stack[stack.length - 1] as number];
      if (top === undefined || top.d < hit.d) break;
      (index.entries[stack.pop() as number] as Entry).blockEnd = hit.line - 1;
    }

    // The stack is popped before this, so its top is the nearest shallower
    // entry: every ancestor is already in `entries`, which is what makes a
    // child's branch a lookup rather than a walk.
    const parentIndex = stack.length > 0 ? (stack[stack.length - 1] as number) : null;
    const branch =
      parentIndex === null ? ++roots : (index.entries[parentIndex] as Entry).branch;

    const entry: Entry = {
      line: hit.line,
      from: start,
      to: start + raw.length,
      d: hit.d,
      b: hit.b,
      n: hit.n,
      branch,
      time: clock?.time ?? null,
      markerEnd: hit.markerEnd,
      // `+` alone is settled: `-` is being written and `=` is paused, and both
      // are still open. Every `state === "draft"` check in the tree now reads
      // as "open".
      state: duration !== null && duration.sigil !== "+" ? "draft" : "settled",
      duration,
      clockLine,
      clockFrom,
      clockTo: clockFrom + (clockLine === null ? 0 : (lines[clockLine] ?? "").length),
      proseFrom,
      proseTo,
      proseLines,
      whisperLines,
      whisper,
      firstProseLine,
      title,
      parent: parentIndex,
      blockEnd: lines.length - 1
    };

    stack.push(index.entries.length);
    index.entries.push(entry);
    if (entry.d > index.maxD) index.maxD = entry.d;
    if (entry.n > index.maxN) index.maxN = entry.n;
  }

  return index;
}

/** The line holding `offset`; the last line for an offset past the end. */
function lineOfOffset(index: EntryIndex, offset: number): number {
  const starts = index.lineStarts;
  let low = 0;
  let high = starts.length - 1;
  let found = 0;

  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((starts[middle] ?? 0) <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found;
}

/** The entry whose block contains this zero-based line, or null. */
export function findEntryAtLine(index: EntryIndex, line: number): Entry | null {
  for (const entry of index.entries) {
    if (entry.line === line) return entry;
    if (entry.line > line) break;
  }
  return null;
}

/** The entry whose subtree holds `offset`, or null when it is outside every one. */
export function findEntryAtOffset(index: EntryIndex, offset: number): Entry | null {
  const line = lineOfOffset(index, offset);
  const entry = findCurrentEntry(index, line);
  if (entry === null) return null;
  return line <= entry.blockEnd ? entry : null;
}

/** The entry on `line`, else the nearest one above it, else null. */
export function findCurrentEntry(index: EntryIndex, line: number): Entry | null {
  let best: Entry | null = null;
  for (const entry of index.entries) {
    if (entry.line > line) break;
    best = entry;
  }
  return best;
}

/** The entry carrying this `N`, or null when a write removed it. */
export function entryBySeq(index: EntryIndex, n: number): Entry | null {
  for (const entry of index.entries) {
    if (entry.n === n) return entry;
  }
  return null;
}

/** Direct children of `entry`, in document order; roots when it is null. */
export function childrenOf(index: EntryIndex, entry: Entry | null): Entry[] {
  const parent = entry === null ? null : index.entries.indexOf(entry);
  return index.entries.filter((candidate) => candidate.parent === parent);
}

/** The last line of `entry`'s subtree. */
export function endOfSubtree(index: EntryIndex, entry: Entry): number {
  return Math.min(entry.blockEnd, Math.max(0, index.lines.length - 1));
}

/** The next day sequence: one past the largest, starting at 1. */
export function nextSeq(index: EntryIndex): number {
  return index.maxN + 1;
}

/** The next branch id: one past the depth-1 entries. */
export function nextBranch(index: EntryIndex): number {
  return childrenOf(index, null).length + 1;
}

/** `{ 1.2.3 }`; one space inside each brace, and nothing after it. */
export function formatMarker(d: number, b: number, n: number): string {
  return `{ ${d}.${b}.${n} }`;
}

/**
 * Changes that put every `B` back onto its branch's id.
 *
 * A root's `B` is its 1-based position among roots, and a deeper entry's `B` is
 * its root's — so deleting a root is the only thing that can unsettle a branch,
 * and one pass over the note rewrites exactly the markers that drifted.
 */
export function repairBranches(index: EntryIndex): TextChange[] {
  const changes: TextChange[] = [];

  for (const entry of index.entries) {
    if (entry.b === entry.branch) continue;

    const span = MARKER.exec(index.lines[entry.line] ?? "")?.indices?.[2];
    if (span === undefined) continue;

    const start = index.lineStarts[entry.line] ?? 0;
    changes.push({ from: start + span[0], to: start + span[1], text: String(entry.branch) });
  }

  return changes;
}
