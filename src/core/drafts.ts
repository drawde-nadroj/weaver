import { formatClock } from "./clock";
import { codeFenceLines, lineStartsOf, scanFrontmatter } from "./headings";
import type { InsertOptions } from "./insert";

/**
 * Draft markers are the only syntax Weaver adds to a note. Both the words and
 * the marker stay plain text, so a draft is readable, greppable and committable
 * while it is unfinished.
 *
 * ```markdown
 * ⟪draft 3.2 2026-10-26 16:37:04⟫
 * Half-formed thought
 * body of the thought
 * ⟪/draft 3.2⟫
 * ```
 */
export interface DraftBlock {
  /** `<level>.<ordinal>`, for example `3.2`. */
  id: string;
  level: number;
  ordinal: number;
  /** Zero-based line index of the open marker. */
  openLine: number;
  /** Zero-based line index of the matching close marker. */
  closeLine: number;
  /** Zero-based line index of the title line (open line + 1). */
  titleLine: number;
  /** First body line; equals `bodyTo` for a draft without a body. */
  bodyFrom: number;
  /** Line after the last body line, i.e. the close marker's line. */
  bodyTo: number;
  /** `YYYY-MM-DD HH:mm:ss`, always local and always fixed-width. */
  openedAt: string;
  title: string;
  body: string;
  /** Absolute offset of the open marker line start. */
  from: number;
  /** Absolute offset of the close marker line end, excluding its newline. */
  to: number;
  /** Absolute offset of the title line start. */
  titleFrom: number;
  /** Absolute offset of the close marker line start. */
  closeFrom: number;
}

export interface DraftOpen {
  level: number;
  ordinal: number;
  openedAt: string;
}

export interface DraftClose {
  level: number;
  ordinal: number;
}

const OPEN_MARKER = /^\s*⟪draft (\d{1,2})\.(\d{1,3}) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)⟫\s*$/;
const CLOSE_MARKER = /^\s*⟪\/draft (\d{1,2})\.(\d{1,3})⟫\s*$/;

/** A draft opened longer ago than this is reported as `stale`, not as a timer. */
export const DRAFT_STALE_SECONDS = 12 * 60 * 60;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function rightTrim(text: string): string {
  return text.replace(/\s+$/, "");
}

/** Parses an open marker line, normalising the time to `HH:mm:ss`. */
export function parseDraftOpen(line: string): DraftOpen | null {
  const match = OPEN_MARKER.exec(line);
  if (match === null) return null;

  const level = Number(match[1]);
  const ordinal = Number(match[2]);
  const date = match[3];
  const time = match[4];
  if (date === undefined || time === undefined) return null;

  return {
    level,
    ordinal,
    openedAt: `${date} ${time.length === 5 ? `${time}:00` : time}`
  };
}

/** Parses a close marker line. */
export function parseDraftClose(line: string): DraftClose | null {
  const match = CLOSE_MARKER.exec(line);
  if (match === null) return null;

  const level = Number(match[1]);
  const ordinal = Number(match[2]);
  return { level, ordinal };
}

export function draftId(level: number, ordinal: number): string {
  return `${level}.${ordinal}`;
}

/** `<level>.<ordinal>`, with the ordinal bumped until it is unused. */
export function allocateDraftId(
  level: number,
  ordinal: number,
  taken: readonly string[]
): string {
  const used = new Set(taken);
  let next = Math.max(1, Math.round(ordinal));
  while (used.has(draftId(level, next))) next += 1;
  return draftId(level, next);
}

/** The exact text of one draft block, without a trailing newline. */
export function draftBlockText(input: {
  id: string;
  openedAt: string;
  title: string;
  body: string;
}): string {
  const lines = [`⟪draft ${input.id} ${input.openedAt}⟫`, rightTrim(input.title)];
  const body = rightTrim(input.body);
  if (body !== "") lines.push(body);
  lines.push(`⟪/draft ${input.id}⟫`);
  return lines.join("\n");
}

export function draftTitleLine(draft: DraftBlock): number {
  return draft.titleLine;
}

/** True when `line` sits between the markers, both included. */
export function draftContainsLine(draft: DraftBlock, line: number): boolean {
  return line >= draft.openLine && line <= draft.closeLine;
}

/** `YYYY-MM-DD HH:mm:ss` in local time. */
export function formatDraftOpened(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

function openedDate(openedAt: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(openedAt);
  if (match === null) return null;

  const [, year, month, day, hours, minutes, seconds] = match;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hours === undefined ||
    minutes === undefined
  ) {
    return null;
  }

  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    seconds === undefined ? 0 : Number(seconds)
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * How long ago the draft was opened: `+mm:ss`, widening to `+h:mm:ss` past an
 * hour. A negative or very old difference reports `stale` rather than a
 * misleading timer.
 */
export function draftElapsed(draft: { openedAt: string }, now: Date): string {
  const opened = openedDate(draft.openedAt);
  if (opened === null) return "stale";

  const total = Math.floor((now.getTime() - opened.getTime()) / 1000);
  if (total < 0 || total > DRAFT_STALE_SECONDS) return "stale";

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `+${hours}:${pad2(minutes)}:${pad2(seconds)}` : `+${pad2(minutes)}:${pad2(seconds)}`;
}

/** The finished heading a draft becomes when it is woven. */
export function weaveDraftText(draft: DraftBlock, options: InsertOptions, now: Date): string {
  const title = draft.title.trim();
  const body = rightTrim(draft.body);
  const head =
    `${"#".repeat(draft.level)} ${formatClock(now, options.format)}` +
    (title.length > 0 ? options.separator + title : " ");
  return body.length > 0 ? `${head}\n${body}` : head;
}

function findCloseLine(
  lines: readonly string[],
  fenced: ReadonlySet<number>,
  from: number,
  id: string
): number | null {
  for (let line = from; line < lines.length; line += 1) {
    if (fenced.has(line)) continue;
    const close = parseDraftClose(lines[line] ?? "");
    if (close === null) continue;
    if (draftId(close.level, close.ordinal) === id) return line;
  }
  return null;
}

/**
 * Every closed draft block in `source`, in document order.
 *
 * A marker inside frontmatter or a fenced code block is never a draft, a marker
 * without a matching close line stays plain text, and an open marker inside an
 * open block is body text because drafts never nest.
 */
export function parseDrafts(source: string, maxDepth: number): DraftBlock[] {
  const lines = source.split("\n");
  const starts = lineStartsOf(source);
  const frontmatter = scanFrontmatter(lines);
  if (frontmatter.kind === "unclosed") return [];

  const fenced = codeFenceLines(lines);
  const first = frontmatter.kind === "closed" ? frontmatter.end + 1 : 0;
  const drafts: DraftBlock[] = [];

  for (let openLine = first; openLine < lines.length; openLine += 1) {
    if (fenced.has(openLine) || openLine <= frontmatter.end) continue;

    const open = parseDraftOpen(lines[openLine] ?? "");
    if (open === null) continue;
    if (open.level < 1 || open.level > maxDepth) continue;

    const id = draftId(open.level, open.ordinal);
    const closeLine = findCloseLine(lines, fenced, openLine + 1, id);
    if (closeLine === null) continue;

    const titleLine = Math.min(openLine + 1, closeLine);
    const hasTitleLine = titleLine < closeLine;
    const title = hasTitleLine ? rightTrim(lines[titleLine] ?? "") : "";
    const bodyFrom = hasTitleLine ? titleLine + 1 : closeLine;
    const body = bodyFrom < closeLine ? rightTrim(lines.slice(bodyFrom, closeLine).join("\n")) : "";
    const from = starts[openLine] ?? 0;
    const closeFrom = starts[closeLine] ?? from;

    drafts.push({
      id,
      level: open.level,
      ordinal: open.ordinal,
      openLine,
      closeLine,
      titleLine,
      bodyFrom,
      bodyTo: closeLine,
      openedAt: open.openedAt,
      title,
      body,
      from,
      to: closeFrom + (lines[closeLine] ?? "").length,
      titleFrom: starts[titleLine] ?? from,
      closeFrom
    });

    // Drafts never nest: everything up to the close marker was body text.
    openLine = closeLine;
  }

  return drafts;
}
