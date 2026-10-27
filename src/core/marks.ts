/**
 * Day marks: the glyph lines that record an event rather than a thought.
 *
 * A `✦` line records where a spark came from; a `✓` line records that a day was
 * closed. Neither is a dimension, and neither may be read out of frontmatter, a
 * fenced code block, or a draft — a draft's body belongs to the draft until it
 * is woven, so a `✦` typed inside one is not yet a record.
 *
 * This module composes `scanFrontmatter`, `codeFenceLines` and `parseDrafts`
 * exactly as `parseHeadings` does, so the two parsers cannot disagree about
 * what is code and what is text.
 */

import { parseDrafts } from "./drafts";
import { codeFenceLines, lineStartsOf, scanFrontmatter } from "./headings";
import { MAX_MAX_DEPTH } from "../settings";
import { CLOSE_GLYPH, SPARK_GLYPH } from "./vocabulary";

export interface SourceMark {
  /** Zero-based line index of the `✦` line. */
  line: number;
  /** Absolute offset of the start of the line. */
  from: number;
  /** Absolute offset of the end of the line, excluding its newline. */
  to: number;
  /** The link target, or null for a bare `✦`. */
  target: string | null;
  /** The link alias, or null when the link carries none. */
  label: string | null;
  /** Whatever follows the link, with a leading ` - ` separator removed. */
  note: string;
}

export interface DayMarks {
  sources: SourceMark[];
  /** The last close mark's clock, or null when the day is open. */
  closedAt: string | null;
}

const SOURCE_LINE = /^\s*✦\s*(?:\[\[([^\]|]+)(?:\|([^\]]+))?\]\])?\s*(.*)$/;
const CLOSE_LINE = /^\s*✓\s+(\d{2}:\d{2}(?::\d{2})?)\s*$/;

/** Parses one line as a `✦` mark, or returns null when it is not one. */
export function parseSourceLine(
  line: string
): { target: string | null; label: string | null; note: string } | null {
  const match = SOURCE_LINE.exec(line);
  if (match === null) return null;

  const remainder = (match[3] ?? "").trim();
  return {
    target: match[1] ?? null,
    label: match[2] ?? null,
    note: remainder.startsWith("- ") ? remainder.slice(2).trim() : remainder
  };
}

/** Parses one line as a `✓` close mark, returning its clock or null. */
export function parseCloseLine(line: string): string | null {
  return CLOSE_LINE.exec(line)?.[1] ?? null;
}

/** Every mark in a note, ignoring drafts, frontmatter and fenced code. */
export function parseMarks(source: string): DayMarks {
  const lines = source.split("\n");
  const starts = lineStartsOf(source);
  const frontmatter = scanFrontmatter(lines);
  if (frontmatter.kind === "unclosed") return { sources: [], closedAt: null };

  const fenced = codeFenceLines(lines);
  const drafts = parseDrafts(source, MAX_MAX_DEPTH);
  const bodyLines = new Set<number>();
  for (const draft of drafts) {
    for (let line = draft.openLine; line <= draft.closeLine; line += 1) bodyLines.add(line);
  }

  const sources: SourceMark[] = [];
  let closedAt: string | null = null;

  for (let line = frontmatter.end + 1; line < lines.length; line += 1) {
    if (fenced.has(line) || bodyLines.has(line)) continue;

    const raw = lines[line] ?? "";
    const from = starts[line] ?? 0;

    const close = parseCloseLine(raw);
    if (close !== null) {
      // The last close wins: a day is closed once, and a stray earlier mark
      // never overrides the decision that ended it.
      closedAt = close;
      continue;
    }

    const parsed = parseSourceLine(raw);
    if (parsed === null) continue;

    sources.push({ line, from, to: from + raw.length, ...parsed });
  }

  return { sources, closedAt };
}

/** The `✦` line a spark writes under its dimension. */
export function sparkLine(target: string, label: string): string {
  return `${SPARK_GLYPH} [[${target}|${label}]]`;
}

/** The closing mark, on its own line, in the note's own clock format. */
export function closeLine(time: string): string {
  return `${CLOSE_GLYPH} ${time}`;
}
