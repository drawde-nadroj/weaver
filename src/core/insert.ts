/**
 * The three plans that write entry text, and the arithmetic every plan shares.
 *
 * A plan is a list of changes plus the selection to leave behind, applied in one
 * transaction so a single undo reverts all of it. `+` is never written twice,
 * `C` is a branch's thread id (inherited on insert, repaired only when a root is
 * deleted), and `N` is only ever appended.
 */

import { formatClock } from "./clock";
import { lineStartsOf } from "./document";
import { formatDurationLine, type DurationSigil } from "./duration";
import {
  endOfSubtree,
  formatMarker,
  nextSeq,
  nextThread,
  parseEntries,
  repairThreads,
  type Entry,
  type EntryIndex
} from "./entries";

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
 * A new root entry at the tip of the note: `{ 1.k.m } - HH:MM:SS`, a blank prose
 * line, and its `- 00:00:00` duration.
 *
 * The caret lands on the blank line, which is where the writing happens.
 */
export function planStartEntry(source: string, index: EntryIndex, now: Date): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence) return null;

  const marker = formatMarker(1, nextThread(index), nextSeq(index), formatClock(now));
  const text = `${marker}${NEWLINE}${NEWLINE}${formatDurationLine("-", 0)}`;
  return planAppendLine(source, text, marker.length + 1);
}

/**
 * A child entry one dimension deeper, directly under the parent's subtree.
 *
 * The child inherits its parent's written `C`, so a branch carries one thread id
 * from its root all the way down — and an insert never renumbers anything, which
 * is what makes it a single change.
 */
export function planChildEntry(
  _source: string,
  index: EntryIndex,
  parent: Entry,
  now: Date
): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence) return null;

  const marker = formatMarker(parent.d + 1, parent.c, nextSeq(index), formatClock(now));
  const blockEnd = endOfSubtree(index, parent);

  // Blank lines at the end of the subtree are spacing; the child goes under the
  // last line the writer actually typed.
  let anchor = blockEnd;
  while (anchor > parent.line && (index.lines[anchor] ?? "").trim() === "") anchor -= 1;

  const at = (index.lineStarts[anchor] ?? 0) + (index.lines[anchor] ?? "").length;
  const text = `${NEWLINE}${NEWLINE}${marker}${NEWLINE}${NEWLINE}${formatDurationLine("-", 0)}`;

  const caret = at + NEWLINE.length * 2 + marker.length + 1;
  return { changes: [{ from: at, to: at, text }], selection: { from: caret, to: caret } };
}

/**
 * Removes an entry and everything under it: the exact inverse of the block
 * `planChildEntry` writes.
 *
 * The block runs from the marker to the end of its subtree, the blank separator
 * lines below it go with it, and every surviving branch whose thread id shifted
 * is rewritten in the same plan, so one undo restores the whole subtree and the
 * addressing. The caret lands where the block was.
 */
export function planDeleteEntry(
  source: string,
  index: EntryIndex,
  entry: Entry
): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence) return null;

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
  // The survivors' threads are computed on the deleted text — where every marker
  // below the block sits — and shifted back into the document as it is.
  const shift = to - from;
  const remaining = parseEntries(source.slice(0, from) + source.slice(to));
  for (const change of repairThreads(remaining)) {
    changes.push({ from: change.from + shift, to: change.to + shift, text: change.text });
  }

  const caret = Math.min(from, source.length - (to - from));
  return { changes, selection: { from: caret, to: caret } };
}

/**
 * Writes the duration line in place.
 *
 * A settled entry — a `+` line, or a line that carries no duration at all — is
 * final: nothing is planned for it, whatever the sigil. An open entry is
 * rewritten whenever the bytes would change, which the identical-text guard
 * decides, so a pause that reaches the same second plans nothing. The selection
 * is reported at the prose, because the caller keeps the live selection:
 * rewriting a duration must not move the caret.
 */
export function planDuration(
  _source: string,
  index: EntryIndex,
  entry: Entry,
  sigil: DurationSigil,
  ms: number
): InsertPlan | null {
  if (entry.durationLine === null || entry.state === "settled") return null;

  const target = formatDurationLine(sigil, ms);
  if ((index.lines[entry.durationLine] ?? "") === target) return null;

  return {
    changes: [{ from: entry.durationFrom, to: entry.durationTo, text: target }],
    selection: { from: entry.proseFrom, to: entry.proseFrom }
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
