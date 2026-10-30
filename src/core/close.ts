/**
 * Closing the day.
 *
 * A close is a decision recorded as one mark: `✓ <time>` on its own line, never
 * an entry. A day carries at most one, so a second close is refused rather than
 * appended — the first decision stands.
 */

import { formatClock } from "./clock";
import { scanFences, scanFrontmatter } from "./document";
import { parseEntries } from "./entries";
import { planAppendLine, type InsertPlan } from "./insert";

/** The one shape a close mark has: `✓ HH:MM:SS`, on its own line. */
export const CLOSE_MARK = /^✓\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;

/** What a note says about being closed: the last mark's clock and the line it sits on. */
export interface CloseScan {
  /** The last close mark's clock, or null when the day is open. */
  closedAt: string | null;
  /** Line index of that mark, or null. */
  line: number | null;
}

/** Every mark in a note, ignoring frontmatter and fenced code. */
export function parseClose(source: string): CloseScan {
  const lines = source.split("\n");
  const frontmatter = scanFrontmatter(lines);
  if (frontmatter.kind === "unclosed") return { closedAt: null, line: null };

  const fenced = scanFences(lines).inside;
  let closedAt: string | null = null;
  let line: number | null = null;

  for (let index = frontmatter.end + 1; index < lines.length; index += 1) {
    if (fenced.has(index)) continue;
    const match = CLOSE_MARK.exec(lines[index] ?? "");
    if (match === null) continue;
    // The last close wins: a stray earlier mark never overrides the decision.
    closedAt = match[1] ?? null;
    line = index;
  }

  return { closedAt, line };
}

/** The closing mark, on its own line. */
export function closeLine(time: string): string {
  return `✓ ${time}`;
}

/** The plan that appends the closing mark, or null when it must be refused. */
export function planCloseDay(source: string, now: Date): InsertPlan | null {
  if (parseClose(source).closedAt !== null) return null;

  const index = parseEntries(source);
  if (index.unclosedFrontmatter || index.unclosedFence) return null;

  return planAppendLine(source, closeLine(formatClock(now)));
}
