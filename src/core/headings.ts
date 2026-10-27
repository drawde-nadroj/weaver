import { parseClockPrefix } from "./clock";
import { parseDrafts, type DraftBlock } from "./drafts";

export interface Heading {
  /** Zero-based line index of the heading. */
  line: number;
  level: number;
  /** Absolute offset of the start of the heading line. */
  from: number;
  /** Absolute offset of the end of the heading line, excluding its newline. */
  to: number;
  hashFrom: number;
  hashTo: number;
  /** Heading text after the hash run and one separator, right-trimmed. */
  text: string;
  time: string | null;
  title: string;
  /** Index into `HeadingIndex.headings`, or null when this is a root heading. */
  parent: number | null;
}

export interface CodeFence {
  /** Line index of the opening fence. */
  start: number;
  /** Line index of the closing fence, or the last line when unclosed. */
  end: number;
  closed: boolean;
}

export interface HeadingIndex {
  headings: Heading[];
  /** Closed draft blocks. Drafts never appear in `headings` until woven. */
  drafts: DraftBlock[];
  maxLevel: number;
  codeFences: CodeFence[];
  unclosedFence: boolean;
  unclosedFrontmatter: boolean;
  /** Line index of the closing frontmatter delimiter, or null when absent. */
  frontmatterEnd: number | null;
}

export interface ParseOptions {
  maxDepth: number;
}

export interface ParsedHeadingLine {
  level: number;
  text: string;
  hashLength: number;
  leadingSpaces: number;
}

// Hashes must be followed by whitespace or end of line; `#notaheading` is text.
const ATX_HEADING = /^( {0,3})(#{1,})(?:[ \t]+(.*))?$/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^( {0,3})(`{3,}|~{3,})[ \t]*$/;
const FRONTMATTER_DELIMITER = /^(---|\.\.\.)[ \t]*$/;

export function parseHeadingLine(line: string, maxDepth: number): ParsedHeadingLine | null {
  const match = ATX_HEADING.exec(line);
  if (match === null) return null;

  const hashRun = match[2];
  if (hashRun === undefined) return null;

  const level = hashRun.length;
  if (level > maxDepth) return null;

  return {
    level,
    text: (match[3] ?? "").replace(/\s+$/, ""),
    hashLength: level,
    leadingSpaces: match[1]?.length ?? 0
  };
}

/** Absolute start offset of every line in `source`. */
export function lineStartsOf(source: string): number[] {
  const lines = source.split("\n");
  const starts: number[] = new Array(lines.length);
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    starts[index] = offset;
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return starts;
}

export interface FrontmatterScan {
  kind: "none" | "closed" | "unclosed";
  end: number;
}

/** Locates the leading frontmatter block, if the document opens with one. */
export function scanFrontmatter(lines: readonly string[]): FrontmatterScan {
  if (lines.length === 0) return { kind: "none", end: -1 };
  const first = lines[0] ?? "";
  if (!FRONTMATTER_DELIMITER.test(first) || !first.startsWith("---")) {
    return { kind: "none", end: -1 };
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONTMATTER_DELIMITER.test(lines[index] ?? "")) return { kind: "closed", end: index };
  }
  return { kind: "unclosed", end: -1 };
}

/**
 * Line indices that sit inside a fenced code block, fence lines included.
 * Mirrors the scan `parseHeadings` performs, so both agree on what is code.
 */
export function codeFenceLines(lines: readonly string[]): Set<number> {
  const inside = new Set<number>();
  let open: { character: string; length: number; start: number } | null = null;

  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line] ?? "";

    if (open !== null) {
      inside.add(line);
      const close = FENCE_CLOSE.exec(raw);
      const run = close?.[2];
      if (run !== undefined && run[0] === open.character && run.length >= open.length) {
        open = null;
      }
      continue;
    }

    const match = FENCE_OPEN.exec(raw);
    const run = match?.[2];
    if (run === undefined) continue;

    open = { character: run[0] ?? "`", length: run.length, start: line };
    inside.add(line);
  }

  return inside;
}

/**
 * Indexes every ATX heading outside frontmatter and fenced code, together with
 * the fences it saw and the parent chain implied by the level sequence.
 */
export function parseHeadings(source: string, options: ParseOptions): HeadingIndex {
  const maxDepth = options.maxDepth;
  const lines = source.split("\n");
  const lineStarts = lineStartsOf(source);

  const frontmatter = scanFrontmatter(lines);
  if (frontmatter.kind === "unclosed") {
    return {
      headings: [],
      drafts: [],
      maxLevel: 0,
      codeFences: [],
      unclosedFence: false,
      unclosedFrontmatter: true,
      frontmatterEnd: null
    };
  }

  const headings: Heading[] = [];
  const codeFences: CodeFence[] = [];
  const parents: number[] = [];
  let openFence: { character: string; length: number; start: number } | null = null;
  let maxLevel = 0;

  for (let line = frontmatter.end + 1; line < lines.length; line += 1) {
    const raw = lines[line] ?? "";
    const lineStart = lineStarts[line] ?? 0;

    if (openFence !== null) {
      const close = FENCE_CLOSE.exec(raw);
      const run = close?.[2];
      if (
        run !== undefined &&
        run[0] === openFence.character &&
        run.length >= openFence.length
      ) {
        codeFences.push({ start: openFence.start, end: line, closed: true });
        openFence = null;
      }
      continue;
    }

    const open = FENCE_OPEN.exec(raw);
    const openRun = open?.[2];
    if (openRun !== undefined) {
      openFence = { character: openRun[0] ?? "`", length: openRun.length, start: line };
      continue;
    }

    const parsed = parseHeadingLine(raw, maxDepth);
    if (parsed === null) continue;

    const clock = parseClockPrefix(parsed.text);

    while (parents.length > 0) {
      const top = headings[parents[parents.length - 1] ?? 0];
      if (top === undefined || top.level < parsed.level) break;
      parents.pop();
    }

    const index = headings.length;
    headings.push({
      line,
      level: parsed.level,
      from: lineStart,
      to: lineStart + raw.length,
      hashFrom: lineStart + parsed.leadingSpaces,
      hashTo: lineStart + parsed.leadingSpaces + parsed.hashLength,
      text: parsed.text,
      time: clock.time,
      title: clock.rest,
      parent: parents.length > 0 ? (parents[parents.length - 1] ?? null) : null
    });

    parents.push(index);
    if (parsed.level > maxLevel) maxLevel = parsed.level;
  }

  if (openFence !== null) {
    codeFences.push({ start: openFence.start, end: Math.max(openFence.start, lines.length - 1), closed: false });
  }

  return {
    headings,
    drafts: parseDrafts(source, maxDepth),
    maxLevel,
    codeFences,
    unclosedFence: openFence !== null,
    unclosedFrontmatter: false,
    frontmatterEnd: frontmatter.kind === "closed" ? frontmatter.end : null
  };
}

export function findHeadingAtLine(index: HeadingIndex, line: number): Heading | null {
  for (const heading of index.headings) {
    if (heading.line === line) return heading;
    if (heading.line > line) break;
  }
  return null;
}

/** The heading on `line`, else the nearest one above it, else null. */
export function findCurrentHeading(index: HeadingIndex, line: number): Heading | null {
  let best: Heading | null = null;
  for (const heading of index.headings) {
    if (heading.line > line) break;
    best = heading;
  }
  return best;
}

/**
 * The last non-empty line of a heading's section, or the heading line itself
 * when the section has no content.
 */
export function findSectionEndLine(
  lines: readonly string[],
  index: HeadingIndex,
  heading: Heading
): number {
  let limit = lines.length;
  for (const candidate of index.headings) {
    if (candidate.line <= heading.line) continue;
    if (candidate.level <= heading.level) {
      limit = candidate.line;
      break;
    }
  }

  for (let line = limit - 1; line > heading.line; line -= 1) {
    if ((lines[line] ?? "").trim() !== "") return line;
  }
  return heading.line;
}

/** Ancestors of `heading`, root-first, excluding the heading itself. */
export function buildAncestors(index: HeadingIndex, heading: Heading | null): Heading[] {
  const chain: Heading[] = [];
  let current = heading;
  const guard = new Set<number>();

  while (current !== null && current.parent !== null) {
    if (guard.has(current.parent)) break;
    guard.add(current.parent);
    const parent = index.headings[current.parent];
    if (parent === undefined) break;
    chain.unshift(parent);
    current = parent;
  }

  return chain;
}

/** Highest heading level across sources, or 0 when none contain headings. */
export function maxHeadingLevel(sources: readonly string[], maxDepth: number): number {
  let maximum = 0;
  for (const source of sources) {
    const parsed = parseHeadings(source, { maxDepth }).maxLevel;
    if (parsed > maximum) maximum = parsed;
  }
  return maximum;
}
