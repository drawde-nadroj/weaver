/**
 * The plans that write entry text, and the arithmetic every plan shares.
 *
 * A plan is a list of changes plus the selection to leave behind, applied in one
 * transaction so a single undo reverts all of it. `+` is never written twice,
 * `B` is the branch id (inherited on insert, repaired only when a root is
 * deleted), and `N` is only ever appended.
 */

import {
  detachAlignments,
  formatLocalTimestamp,
  mergeAlignment,
  readAlignments,
  type AlignmentRecord
} from "./alignments";
import { formatClock, pad2 } from "./clock";
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
import type { PortalInstant } from "./portals";
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
 * its clock row `- 00:00:00`.
 *
 * The row carries only a duration: the entry is a draft that has no moment yet,
 * because a moment is the time the first text was actually typed, not the time
 * the blank block was made. `planEntryBeginning` stamps the day and moment from
 * the one input timestamp, preserving these duration bytes.
 *
 * The caret lands on the blank line, which is where the writing happens.
 */
export function planStartEntry(source: string, index: EntryIndex): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence || index.legacyFormat) return null;

  const marker = formatMarker(nextBranch(index), 1, nextSeq(index));
  const clock = formatClockRow(null, "-", 0, null);
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
 * The child's clock row is duration-only, like a new root's: `- 00:00:00`. It
 * gains its own creation day and moment when the first text is typed, from that
 * input's timestamp, so a child written after midnight under an old parent is
 * dated the day it was actually written.
 */
export function planChildEntry(
  _source: string,
  index: EntryIndex,
  parent: Entry
): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence || index.legacyFormat) return null;

  const marker = formatMarker(parent.b, parent.d + 1, nextSeq(index));
  const clock = formatClockRow(null, "-", 0, null);

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

/** Whether two parses describe the same block at the same offsets. */
function sameBlock(left: Entry, right: Entry): boolean {
  return (
    left.from === right.from &&
    left.to === right.to &&
    left.markerEnd === right.markerEnd &&
    left.b === right.b &&
    left.d === right.d &&
    left.n === right.n &&
    left.clockLine === right.clockLine &&
    left.clockFrom === right.clockFrom &&
    left.clockTo === right.clockTo &&
    left.proseFrom === right.proseFrom &&
    left.proseTo === right.proseTo
  );
}

/**
 * Stamps a draft's beginning — the day and the moment — into the clock row that
 * already carries its duration.
 *
 * A new root or child is written as `- 00:00:00`: a real record with a duration
 * and no moment, which is exactly what "the writer has not started" means. This
 * plan turns that row into `- 00:00:00 YYYY-MM-DD HH:MM:SS` on the first text,
 * so both halves describe one input timestamp. The duration half is copied byte
 * for byte, which preserves a paused `= 00:00:05` as well as an empty `-`.
 *
 * Nothing else is ever rewritten: an entry that already carries a moment keeps
 * it, including a historical moment with no day, because a moment is a fact and
 * not a default. Settled (`+`) entries and entries with no duration are final.
 * A note this cannot read whole — unclosed frontmatter, an unclosed fence, the
 * old marker — returns null, as does an `entry` that no longer describes the
 * current parse. The selection sits in the prose, so a caller can keep the
 * caret where the text was typed.
 */
export function planEntryBeginning(
  _source: string,
  index: EntryIndex,
  entry: Entry,
  beganAt: Date
): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence || index.legacyFormat) return null;

  // The caller may hold an entry from an older parse; the facts below must
  // describe the same block in the source this plan will be applied to.
  const current = index.entries.find((candidate) => candidate.line === entry.line);
  if (current === undefined || !sameBlock(current, entry)) return null;

  if (current.state !== "draft") return null;
  if (current.clockLine === null || current.duration === null) return null;
  if (current.time !== null || current.day !== null) return null;

  const line = index.lines[current.clockLine] ?? "";
  const row = parseClockRow(line);
  if (row === null || row.durationSpan === null) return null;
  if (row.time !== null || row.day !== null) return null;

  const duration = line.slice(0, row.durationSpan.to);
  const text = `${duration} ${dayKey(beganAt)} ${formatClock(beganAt)}`;

  return {
    changes: [{ from: current.clockFrom, to: current.clockTo, text }],
    selection: { from: current.proseFrom, to: current.proseFrom }
  };
}

/**
 * The opening as the portal announced it: its own frozen local date, hour,
 * minute and offset.
 *
 * `portal.opensAt` is an epoch instant, so the machine's *current* timezone can
 * render it as another local time entirely — travel between the announcement and
 * the input would then rewrite which echoes the opening is measured against. The
 * frozen facts are the opening's, and they are what the record keeps.
 */
function formatPortalOpening(portal: PortalInstant): string {
  const offset = portal.offsetMinutes;
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  const clock = `${pad2(portal.hour)}:${pad2(portal.minute)}:00`;
  return `${portal.day}T${clock}${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

/**
 * A portal's first text: one root entry carrying the typed prose, the full clock
 * row of the moment it was actually typed, and the day's alignment history.
 *
 * Home is a root at the tip of the note, exactly where an ordinary entry would
 * be: `{ b.1.N }`, a blank line, the prose, then the clock row. The row is full
 * from the first byte — duration, day and moment — because this entry *was*
 * begun at a known instant; there is no awaiting phase to stamp later.
 *
 * The history record joins the same plan, so the note either gains the entry and
 * the record or changes in no way at all: one dispatch, one undo. `readAlignments`
 * runs before anything is planned, so unreadable history refuses the capture
 * instead of being replaced by a record written on top of it. The merge is
 * folded back into original-source offsets, so the body append and the
 * frontmatter edit cannot compose against mixed coordinates.
 *
 * An empty or whitespace-only first input is not a capture: a portal is entered
 * by deliberate text. Multi-line text is prose, exactly as typed — including a
 * balanced code fence, which the parser reads as text. Text that changes what
 * the block *is* — an unclosed fence, a line that reads as another marker or as
 * a clock row — is refused: the record is only merged once the written note
 * parses back as the entry this plan allocated, so a capture cannot consume a
 * portal for an entry that never began.
 */
export function planPortalEntry(
  source: string,
  index: EntryIndex,
  portal: PortalInstant,
  beganAt: Date,
  text: string
): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence || index.legacyFormat) return null;
  if (text.trim() === "") return null;
  if (!readAlignments(source).ok) return null;

  const n = nextSeq(index);
  const branch = nextBranch(index);
  const marker = formatMarker(branch, 1, n);
  const day = dayKey(beganAt);
  const time = formatClock(beganAt);
  const clock = formatClockRow(time, "-", 0, day);
  const block = `${marker}${NEWLINE}${NEWLINE}${text}${NEWLINE}${clock}`;

  // The caret sits just past the text that was typed, on the prose it belongs to.
  const caret = marker.length + NEWLINE.length * 2 + text.length;
  const body = planAppendLine(source, block, caret);

  // Until a parser reads the result, the block is only text plus arithmetic, and
  // the typed text is the variable: a paste can leave a fence open, or end the
  // prose with a line that reads as a marker or as a clock row. Any of those
  // makes the record describe an entry that is not the one planned here. So the
  // written note is parsed back before a record is merged, and the allocated
  // entry must be the planned block itself: the marker's own address, the draft
  // duration-only row at the line the block put it on, the captured day and
  // moment, and the typed bytes intact between the marker and that row.
  const written = applyPlanToSource(source, body).source;
  const validated = parseEntries(written);
  if (validated.unclosedFrontmatter || validated.unclosedFence || validated.legacyFormat) {
    return null;
  }

  const blockFrom = body.selection.from - caret;
  const entry = validated.entries.find((candidate) => candidate.from === blockFrom);
  if (entry === undefined || entry.d !== 1 || entry.b !== branch || entry.n !== n) return null;
  if (entry.state !== "draft") return null;

  const duration = entry.duration;
  if (duration === null || duration.sigil !== "-" || duration.ms !== 0) return null;
  if (entry.day !== day || entry.time !== time) return null;

  const clockLine = entry.clockLine;
  if (clockLine === null) return null;
  if (clockLine !== entry.line + 2 + text.split(NEWLINE).length) return null;
  if ((validated.lines[clockLine] ?? "") !== clock) return null;
  if (written.slice(entry.to, entry.clockFrom) !== `${NEWLINE}${NEWLINE}${text}${NEWLINE}`) {
    return null;
  }

  const record: AlignmentRecord = {
    portal: portal.id,
    opened: formatPortalOpening(portal),
    began: formatLocalTimestamp(beganAt),
    entry: n
  };

  // The body lands first, then the record merges into the frontmatter of that
  // very text. The result is folded back to one plan over the original source.
  const merged = mergeAlignment(written, record);
  if (!merged.ok) return null;

  return foldPlans(source, body, merged.source);
}

/**
 * Removes an entry and everything under it: the exact inverse of the block
 * `planChildEntry` writes.
 *
 * The block runs from the marker to the end of its subtree, the blank separator
 * lines below it go with it, and every surviving branch whose branch id shifted
 * is rewritten in the same plan, so one undo restores the whole subtree and the
 * addressing. The caret lands where the block was.
 *
 * The deleted subtree's numbers go with it: every alignment record that pointed
 * at one of them keeps its event — the portal, its opening and the instant the
 * text began — and loses only the association. `N` is reused after a delete, so
 * a record left pointing at a number would otherwise describe an unrelated entry
 * that inherited it. All of it is one plan, so one undo restores the block, the
 * addressing and the associations together.
 */
export function planDeleteEntry(
  source: string,
  index: EntryIndex,
  entry: Entry
): InsertPlan | null {
  if (index.unclosedFrontmatter || index.unclosedFence || index.legacyFormat) return null;

  const first = entry.line;
  const subtreeEnd = endOfSubtree(index, entry);
  let last = subtreeEnd;

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
  const plan: InsertPlan = { changes, selection: { from: caret, to: caret } };

  const deleted = new Set<number>();
  for (const candidate of index.entries) {
    if (candidate.line >= first && candidate.line <= subtreeEnd) deleted.add(candidate.n);
  }

  const planned = applyPlanToSource(source, plan).source;
  const detached = detachAlignments(planned, deleted);
  if (!detached.ok) return null;

  return foldPlans(source, plan, detached.source);
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

/** The smallest single replacement that turns `left` into `right`. */
function minimalChange(left: string, right: string): TextChange {
  let from = 0;
  const shared = Math.min(left.length, right.length);
  while (from < shared && left[from] === right[from]) from += 1;

  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > from && rightEnd > from && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }

  return { from, to: leftEnd, text: right.slice(from, rightEnd) };
}

/**
 * Folds a later rewrite of a plan's result back into one plan over the original
 * source.
 *
 * A body append and a frontmatter merge are two edits to the same note, and the
 * first one moves every offset below it. Dispatching the second as a separate
 * pass would either be a second undo or — worse — be applied at offsets the
 * first pass has already shifted. So the rewrite is reduced to its smallest
 * change in the planned document's coordinates and mapped back to the original:
 * a frontmatter edit sits above the body, where the offsets are still the
 * original ones, and the two changes go out together.
 *
 * When the regions cannot be kept apart — an edit that straddles an inserted
 * block, as in a note that is nothing but a fresh portal entry — the whole span
 * is emitted as one replacement built from the final text, which is still one
 * transaction and still the exact note.
 */
function foldPlans(source: string, plan: InsertPlan, rewritten: string): InsertPlan {
  const planned = applyPlanToSource(source, plan).source;
  if (rewritten === planned) return plan;

  const extra = minimalChange(planned, rewritten);
  const delta = rewritten.length - planned.length;

  let selection = plan.selection;
  if (selection.from > extra.from && selection.from < extra.to) {
    selection = { from: extra.from, to: extra.from };
  } else if (selection.from >= extra.to) {
    selection = { from: selection.from + delta, to: selection.to + delta };
  }

  // The plan's changes in the planned document's coordinates, in order.
  let shift = 0;
  const spans = [...plan.changes]
    .sort((left, right) => left.from - right.from)
    .map((change) => {
      const from = change.from + shift;
      const to = from + change.text.length;
      shift += change.text.length - (change.to - change.from);
      return {
        from,
        to,
        original: change.from,
        size: change.text.length - (change.to - change.from)
      };
    });

  // A point inside text the plan inserted has no original pre-image, so a change
  // that reaches into it cannot be renamed as two changes.
  const mapBack = (point: number): number => {
    let moved = 0;
    for (const span of spans) {
      if (point <= span.from) return point - moved;
      if (point < span.to) return span.original;
      moved += span.size;
    }
    return point - moved;
  };

  const from = mapBack(extra.from);
  const to = mapBack(extra.to);
  const apart = !spans.some((span) => {
    const insideInserted = extra.from < span.to && extra.to > span.from;
    // Two insertions at one point would race for which goes first: fold them.
    const samePoint = extra.from === extra.to && extra.from === span.from;
    return insideInserted || samePoint;
  });

  if (!apart) {
    const start = Math.min(from, ...plan.changes.map((change) => change.from));
    const end = Math.max(to, ...plan.changes.map((change) => change.to));
    const suffix = rewritten.length - (source.length - end);
    return {
      changes: [{ from: start, to: end, text: rewritten.slice(start, suffix) }],
      selection
    };
  }

  const changes = [...plan.changes, { from, to, text: extra.text }];
  changes.sort((left, right) => left.from - right.from);
  return { changes, selection };
}
