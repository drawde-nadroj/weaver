/**
 * The plans that write entry text, and the arithmetic every plan shares.
 *
 * A plan is a list of changes plus the selection to leave behind, applied in one
 * transaction so a single undo reverts all of it. `+` is never written twice,
 * `B` is the branch id (inherited on insert, repaired only when a root is
 * deleted), and `N` is only ever appended.
 */

import { formatClock } from "./clock";
import { dayKey } from "./day";
import { lineStartsOf } from "./document";
import { formatClockRow, formatDurationLine, parseClockRow, type DurationSigil } from "./duration";
import {
  childrenOf,
  endOfSubtree,
  formatMarker,
  nextBranch,
  nextSeq,
  parseEntries,
  repairBranches,
  type Entry,
  type EntryIndex
} from "./entries";
import {
  formatWhisperLine,
  WHISPER_MAX_LINES,
  type WhisperItem
} from "./whisper";

/** One replacement in the document, in absolute offsets. */
export interface TextChange {
  from: number;
  to: number;
  text: string;
}

/** Changes plus the selection to leave behind, applied in one transaction. */
export interface InsertPlan {
  changes: TextChange[];
  selection: { from: number; to: number };
}

const NEWLINE = "\n";

function lineEnd(starts: readonly number[], source: string, line: number): number {
  const nextStart = starts[line + 1];
  if (nextStart === undefined) return source.length;
  // `nextStart` sits one past the newline that terminates this line.
  return nextStart - 1;
}

/**
 * Appends `text` as the last line, separated from existing content by exactly
 * one blank line. Trailing blank lines are normalized away, so a note that ends
 * in three newlines does not collect them above the new block.
 *
 * A file that ended with a newline still ends with one: the write must not turn
 * a POSIX text file into a "no newline at end of file" diff.
 *
 * `caret` is an offset inside `text`; the plan's selection lands there.
 */
export function planAppendLine(source: string, text: string, caret: number = text.length): InsertPlan {
  if (source.trim() === "") {
    return {
      changes: [{ from: 0, to: 0, text: `${text}${NEWLINE}` }],
      selection: { from: caret, to: caret }
    };
  }

  const lines = source.split("\n");
  const starts = lineStartsOf(source);

  let lastContent = lines.length - 1;
  while (lastContent > 0 && (lines[lastContent] ?? "").trim() === "") lastContent -= 1;

  const at = lineEnd(starts, source, lastContent);
  // A note is a text file: the append leaves the document newline-terminated.
  const inserted = `${NEWLINE}${NEWLINE}${text}${NEWLINE}`;

  return {
    changes: [{ from: at, to: source.length, text: inserted }],
    selection: { from: at + NEWLINE.length * 2 + caret, to: at + NEWLINE.length * 2 + caret }
  };
}

/**
 * A new root entry at the tip of the note: `{ b.1.m }`, a blank prose line, and
 * its clock row `- 00:00:00 YYYY-MM-DD HH:MM:SS`.
 *
 * The row carries the entry's own creation day and moment, both read from the
 * one `now` the caller passed: a note may be named for another day, and the
 * entry still records when it was actually written.
 *
 * The caret lands on the blank line, which is where the writing happens.
 */
export function planStartEntry(source: string, index: EntryIndex, now: Date): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence || index.legacyFormat) return null;

  const marker = formatMarker(nextBranch(index), 1, nextSeq(index));
  const clock = formatClockRow(formatClock(now), "-", 0, dayKey(now));
  const text = `${marker}${NEWLINE}${NEWLINE}${clock}`;
  return planAppendLine(source, text, marker.length + 1);
}

/**
 * A child entry one dimension deeper, directly beneath the parent's own block,
 * above any older siblings: the newest branch is closest to what it descends
 * from.
 *
 * The child inherits its parent's written `B`, so a branch carries one branch id
 * from its root all the way down — and an insert never renumbers anything, which
 * is what makes it a single change. `N` is still `maxN + 1`, so the new child is
 * the day's newest entry even when it is shown above older siblings carrying
 * smaller numbers: `N` is identity, not display order.
 *
 * The child's clock row records the creation day and moment from the one `now`
 * it was given — its own, not the parent's — so a child written after midnight
 * under an old parent is dated the day it was written.
 */
export function planChildEntry(
  _source: string,
  index: EntryIndex,
  parent: Entry,
  now: Date
): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence || index.legacyFormat) return null;

  const marker = formatMarker(parent.b, parent.d + 1, nextSeq(index));
  const clock = formatClockRow(formatClock(now), "-", 0, dayKey(now));

  // The parent's own block ends at its last non-blank line, before its first
  // child. Inserting there puts the newest branch directly under the parent and
  // above older siblings, and leaves the parent's subtree contiguous.
  const firstChild = childrenOf(index, parent)[0];
  let anchor = firstChild === undefined ? endOfSubtree(index, parent) : firstChild.line - 1;
  while (anchor > parent.line && (index.lines[anchor] ?? "").trim() === "") anchor -= 1;

  const at = (index.lineStarts[anchor] ?? 0) + (index.lines[anchor] ?? "").length;
  const text = `${NEWLINE}${NEWLINE}${marker}${NEWLINE}${NEWLINE}${clock}`;

  const caret = at + NEWLINE.length * 2 + marker.length + 1;
  return { changes: [{ from: at, to: at, text }], selection: { from: caret, to: caret } };
}

/**
 * Removes an entry and everything under it: the exact inverse of the block
 * `planChildEntry` writes.
 *
 * The block runs from the marker to the end of its subtree, the blank separator
 * lines below it go with it, and every surviving branch whose branch id shifted
 * is rewritten in the same plan, so one undo restores the whole subtree and the
 * addressing. The caret lands where the block was.
 */
export function planDeleteEntry(
  source: string,
  index: EntryIndex,
  entry: Entry
): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence || index.legacyFormat) return null;

  const first = entry.line;
  let last = endOfSubtree(index, entry);

  // The blank separator lines below the block are spacing the block owned.
  while (last + 1 < index.lines.length && (index.lines[last + 1] ?? "").trim() === "") last += 1;

  let from = index.lineStarts[first] ?? 0;
  const to = Math.min(source.length, from + index.lines.slice(first, last + 1).join(NEWLINE).length + 1);

  // A block that ran to the end of the file also takes the blank line above it,
  // so the file keeps exactly one trailing newline and no dangling blank line.
  if (to === source.length && first >= 2 && (index.lines[first - 1] ?? "").trim() === "") {
    from = index.lineStarts[first - 1] ?? from;
  }

  const changes: TextChange[] = [{ from, to, text: "" }];
  // The survivors' branch ids are computed on the deleted text — where every
  // marker below the block sits — and shifted back into the document as it is.
  const shift = to - from;
  const remaining = parseEntries(source.slice(0, from) + source.slice(to));
  for (const change of repairBranches(remaining)) {
    changes.push({ from: change.from + shift, to: change.to + shift, text: change.text });
  }

  const caret = Math.min(from, source.length - (to - from));
  return { changes, selection: { from: caret, to: caret } };
}

/**
 * Writes the duration half of the clock row in place.
 *
 * A settled entry — a `+` half, or a row that carries no duration at all — is
 * final: nothing is planned for it, whatever the sigil. An open entry is
 * rewritten whenever the bytes would change, which the identical-text guard
 * decides, so a pause that reaches the same second plans nothing. Only the
 * duration half is rewritten: the moment keeps its own characters, so the row
 * cannot move, and neither can the day written beside it: everything outside
 * `durationSpan` is copied byte for byte. The selection is reported at the
 * prose, because the caller keeps the live selection: rewriting a duration must
 * not move the caret. A note that
 * still carries the old marker is refused whole — its old duration line parses
 * as a clock row, so a field-level rewrite would be the one write that slipped
 * through the migration.
 */
export function planDuration(
  _source: string,
  index: EntryIndex,
  entry: Entry,
  sigil: DurationSigil,
  ms: number
): InsertPlan | null {
  if (entry.clockLine === null || entry.state === "settled") return null;
  // A note written before the clock row is refused whole, not field by field:
  // its old duration line still parses as a clock row, so a plan here would
  // rewrite one half of a note the migration has not touched.
  if (index.legacyFormat) return null;

  const line = index.lines[entry.clockLine] ?? "";
  const row = parseClockRow(line);
  if (row === null || row.durationSpan === null) return null;

  const target =
    line.slice(0, row.durationSpan.from) +
    formatDurationLine(sigil, ms) +
    line.slice(row.durationSpan.to);
  if (line === target) return null;

  return {
    changes: [{ from: entry.clockFrom, to: entry.clockTo, text: target }],
    selection: { from: entry.proseFrom, to: entry.proseFrom }
  };
}

/**
 * Writes a whisper above an entry's first prose line. One insertion, so one
 * undo.
 *
 * A whisper is the model's reading of a settled thought, so this plan refuses
 * every case where it would be a guess: a note it cannot read whole, an answer
 * with no rows or more than three, an entry that already has one — written once,
 * never rewritten — an entry with nothing to read, an entry with no clock row to
 * sit above, and an entry the writer named on the marker row himself. It does
 * not look at `entry.state`: settle runs while the entry is still `draft`, so
 * the callers decide who may be whispered.
 *
 * The inserted text is newline-terminated and the selection lands past it, so
 * the plan is valid against the text it produces. No caller uses that selection
 * to move a caret: the writer is somewhere else, by construction.
 */
export function planWhisper(
  _source: string,
  index: EntryIndex,
  entry: Entry,
  whisper: readonly WhisperItem[]
): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence || index.legacyFormat) return null;
  if (whisper.length === 0 || whisper.length > WHISPER_MAX_LINES) return null;
  if (entry.whisperLines.length > 0) return null;
  if (entry.firstProseLine === null || entry.clockLine === null) return null;
  if ((index.lines[entry.line] ?? "").slice(entry.markerEnd - entry.from).trim() !== "") return null;

  const at = index.lineStarts[entry.firstProseLine] ?? 0;
  const text = `${whisper.map(formatWhisperLine).join(NEWLINE)}${NEWLINE}`;

  return {
    changes: [{ from: at, to: at, text }],
    selection: { from: at + text.length, to: at + text.length }
  };
}

/**
 * Appends one row to an entry that already carries a whisper.
 *
 * The day pass may add a `thread:` row to a reading written earlier — the day it
 * refers to did not exist when the reading was written. Nothing is rewritten: the
 * row goes directly below the last whisper row, so the reading above it is the same
 * bytes it was.
 */
export function planThread(
  source: string,
  index: EntryIndex,
  entry: Entry,
  item: WhisperItem
): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence || index.legacyFormat) return null;
  if (entry.whisperLines.length === 0) return null;
  if (entry.whisper.some((row) => row.type === "thread")) return null;

  const last = entry.whisperLines[entry.whisperLines.length - 1] as number;
  const text = formatWhisperLine(item);
  const at = index.lineStarts[last + 1];
  const inserted = at === undefined ? `${NEWLINE}${text}` : `${text}${NEWLINE}`;
  const from = at === undefined ? source.length : at;

  return {
    changes: [{ from, to: from, text: inserted }],
    selection: { from: from + inserted.length, to: from + inserted.length }
  };
}

/** Converts an absolute offset into a zero-based line/ch position. */
export function offsetToLineCh(source: string, offset: number): { line: number; ch: number } {
  const before = source.slice(0, Math.min(Math.max(0, offset), source.length));
  const line = before.split("\n").length - 1;
  return { line, ch: before.length - (before.lastIndexOf("\n") + 1) };
}

/**
 * A plan's changes in CodeMirror's own shape.
 *
 * CodeMirror reads `insert`, not `text`: a `TextChange` handed to a view as-is
 * is a change with no text, so nothing is written and nothing throws. Every
 * dispatch of a plan goes through here.
 */
export function cmChanges(
  changes: readonly TextChange[]
): { from: number; to: number; insert: string }[] {
  return changes.map((change) => ({ from: change.from, to: change.to, insert: change.text }));
}

/** Applies a plan's changes to a source string; used by tests and previews. */
export function applyPlanToSource(source: string, plan: InsertPlan): {
  source: string;
  selection: { from: number; to: number };
} {
  let result = source;
  for (const change of [...plan.changes].sort((left, right) => right.from - left.from)) {
    result = result.slice(0, change.from) + change.text + result.slice(change.to);
  }
  return { source: result, selection: plan.selection };
}
