/**
 * Closing the day.
 *
 * A close is a decision recorded as one mark: `✓ <time>` on its own line, in the
 * note's own clock format, never a heading. A day carries at most one, so a
 * second close is refused rather than appended — the first decision stands.
 */

import { MAX_MAX_DEPTH } from "../settings";
import { formatClock } from "./clock";
import { parseHeadings } from "./headings";
import { planAppendLine, type InsertOptions, type InsertPlan } from "./insert";
import { closeLine, parseMarks } from "./marks";

/** The plan that appends the closing mark, or null when it must be refused. */
export function planCloseDay(source: string, now: Date, options: InsertOptions): InsertPlan | null {
  if (parseMarks(source).closedAt !== null) return null;

  const index = parseHeadings(source, { maxDepth: MAX_MAX_DEPTH });
  if (index.unclosedFrontmatter || index.unclosedFence) return null;

  return planAppendLine(source, closeLine(formatClock(now, options.format)));
}
