import { formatClock, type TimestampFormat } from "./clock";
import {
  findCurrentHeading,
  findHeadingAtLine,
  findSectionEndLine,
  lineStartsOf,
  type Heading,
  type HeadingIndex
} from "./headings";
import { sparkLine } from "./marks";
import { newBlockId, shortLabel, trailingBlockId } from "./reference";
import { SPARK_GLYPH } from "./vocabulary";

export interface InsertOptions {
  maxDepth: number;
  separator: string;
  format: TimestampFormat;
}

export interface TextChange {
  from: number;
  to: number;
  text: string;
}

export interface InsertPlan {
  changes: TextChange[];
  selection: { from: number; to: number };
}

export interface InsertSite {
  from: number;
  to: number;
  /** Text placed before the heading, so the heading lands on its own line. */
  prefix: string;
  line: number;
}

const NEWLINE = "\n";

/**
 * Builds a heading line. An empty title keeps a single trailing space so the
 * cursor has somewhere to sit and the user can type immediately.
 */
export function formatHeading(level: number, time: string, title: string, separator: string): string {
  return `${"#".repeat(level)} ${time}${title.length > 0 ? separator + title : " "}`;
}

/** One level below the containing heading, capped at `maxDepth`. */
export function computeInsertLevel(parent: Heading | null, maxDepth: number): number {
  const level = parent === null ? 1 : parent.level + 1;
  return Math.min(Math.max(level, 1), maxDepth);
}

function lineEnd(starts: readonly number[], source: string, line: number): number {
  const nextStart = starts[line + 1];
  if (nextStart === undefined) return source.length;
  // `nextStart` sits one past the newline that terminates this line.
  return nextStart - 1;
}

function siteForLine(starts: readonly number[], source: string, line: number, prefix: string): InsertSite {
  const end = lineEnd(starts, source, line);
  // An empty prefix replaces the line itself (a blank cursor line); otherwise
  // the heading is appended after the line, keeping its content intact.
  if (prefix === "") return { from: starts[line] ?? 0, to: end, prefix, line };
  return { from: end, to: end, prefix, line };
}

/**
 * Decides where a new heading belongs for the given cursor line.
 *
 * Returns null only when the document state makes insertion unsafe: an unclosed
 * frontmatter block or an unclosed fence.
 */
export function resolveInsertSite(
  source: string,
  index: HeadingIndex,
  cursorLine: number
): InsertSite | null {
  const starts = lineStartsOf(source);
  const lines = source.split("\n");

  if (index.unclosedFrontmatter) return null;

  const frontmatterEnd = index.frontmatterEnd;
  if (frontmatterEnd !== null && cursorLine <= frontmatterEnd) {
    return siteForLine(starts, source, frontmatterEnd, NEWLINE);
  }

  for (const fence of index.codeFences) {
    if (cursorLine < fence.start || cursorLine > fence.end) continue;
    if (!fence.closed) return null;
    return siteForLine(starts, source, fence.end, NEWLINE);
  }

  if ((lines[cursorLine] ?? "").trim() === "") {
    return siteForLine(starts, source, cursorLine, "");
  }

  const heading = findHeadingAtLine(index, cursorLine);
  if (heading !== null) {
    return siteForLine(starts, source, findSectionEndLine(lines, index, heading), NEWLINE);
  }

  return siteForLine(starts, source, cursorLine, NEWLINE);
}

export function planInsertHeading(
  source: string,
  index: HeadingIndex,
  cursorLine: number,
  now: Date,
  options: InsertOptions,
  title: string,
  levelOverride?: number
): InsertPlan | null {
  const site = resolveInsertSite(source, index, cursorLine);
  if (site === null) return null;

  const computedLevel = computeInsertLevel(findCurrentHeading(index, cursorLine), options.maxDepth);
  const level = Math.min(
    Math.max(levelOverride ?? computedLevel, computedLevel),
    options.maxDepth
  );

  const heading = formatHeading(
    level,
    formatClock(now, options.format),
    title.trim(),
    options.separator
  );
  const inserted = site.prefix + heading;

  return {
    changes: [{ from: site.from, to: site.to, text: inserted }],
    selection: { from: site.from + inserted.length, to: site.from + inserted.length }
  };
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

/** A source named by a caller that already knows its link target. */
export interface SourceRef {
  /** What the `✦` line links to, e.g. `Note#^abc123` or `Note#09:12 - first`. */
  target: string;
  label: string;
}

export interface SparkInput {
  source: string;
  index: HeadingIndex;
  now: Date;
  options: InsertOptions;
  /** The selected passage, in absolute offsets, when the spark came from one. */
  selection: { from: number; to: number; text: string } | null;
  /** Basename of the note the spark came from, for the `✦` link target. */
  noteBasename: string;
  /** Block ids already used in the note the id will be written into. */
  existingIds: ReadonlySet<string>;
  /**
   * An id another writer already put on the source line, used when the
   * selection lives in a different file from the spark.
   */
  selectionId?: string;
  /** A source the caller already resolved, used by the shuttle. */
  sourceRef?: SourceRef;
}

export interface SourceIdPlan {
  id: string;
  /** The change that appends ` ^id`, or null when the line already carries one. */
  change: TextChange | null;
}

const SPARK_TITLE_MAX = 120;

/**
 * The block id a selection needs: the one already ending its last line, else a
 * fresh id plus the change that appends it there. Both planners share this, so
 * they cannot disagree about where an id goes.
 */
export function planSourceId(
  source: string,
  selection: { from: number; to: number; text: string },
  existingIds: ReadonlySet<string>
): SourceIdPlan {
  const lines = source.split("\n");
  const starts = lineStartsOf(source);
  // A selection that ends on a newline belongs to the line above it, and an
  // offset past the end of the document (a stale cursor) still resolves to a
  // real line rather than to nothing.
  const ending =
    selection.to > selection.from && source[selection.to - 1] === "\n"
      ? selection.to - 1
      : selection.to;
  const lastOffset = Math.max(0, Math.min(source.length - 1, ending));
  const line = offsetToLineCh(source, lastOffset).line;
  const lineText = lines[line] ?? "";

  const trailing = trailingBlockId(lineText);
  if (trailing !== null) return { id: trailing, change: null };

  const id = newBlockId(existingIds);
  const end = (starts[line] ?? 0) + lineText.length;
  return { id, change: { from: end, to: end, text: ` ^${id}` } };
}

/**
 * Appends a spark — a 1D dimension plus its `✦` source line — to the target
 * note. A selection carries its own block id, appended to the end of its last
 * line inside the same plan, so one undo removes both halves.
 *
 * Returns null only when the document is unsafe to write: unclosed frontmatter
 * or an unclosed fence.
 */
export function planSpark(input: SparkInput): InsertPlan | null {
  const { source, index, now, options, selection, noteBasename, existingIds, selectionId } = input;
  const { sourceRef } = input;
  if (index.unclosedFrontmatter || index.unclosedFence) return null;

  const title =
    selection === null
      ? ""
      : selection.text.replace(/\s+/g, " ").trim().slice(0, SPARK_TITLE_MAX);

  const clock = formatClock(now, options.format);
  // An empty title keeps the note's separator, so the title typed at the caret
  // produces the same `time - title` line as every other dimension here.
  const heading =
    title === ""
      ? // An empty separator would glue the title to the clock as soon as the
        // writer starts typing, so the space stands in for it.
        `# ${clock}${options.separator || " "}`
      : formatHeading(1, clock, title, options.separator);

  let mark = SPARK_GLYPH;
  const changes: TextChange[] = [];

  if (sourceRef !== undefined) {
    mark = sparkLine(sourceRef.target, sourceRef.label);
  } else if (selection !== null && noteBasename !== "") {
    const idPlan =
      selectionId !== undefined
        ? { id: selectionId, change: null }
        : planSourceId(source, selection, existingIds);
    if (idPlan.change !== null) changes.push(idPlan.change);

    mark = sparkLine(`${noteBasename}#^${idPlan.id}`, shortLabel(selection.text));
  }

  const plan = planAppendLine(source, `${heading}${NEWLINE}${mark}`, heading.length);
  return { changes: [...plan.changes, ...changes], selection: plan.selection };
}

/** Converts an absolute offset into a zero-based line/ch position. */
export function offsetToLineCh(source: string, offset: number): { line: number; ch: number } {
  const before = source.slice(0, Math.min(Math.max(0, offset), source.length));
  const line = before.split("\n").length - 1;
  return { line, ch: before.length - (before.lastIndexOf("\n") + 1) };
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
