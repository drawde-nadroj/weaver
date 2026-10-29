/**
 * The day's own numbers, and the frontmatter that carries them.
 *
 * They are derived from the note, never incremented blind, so a count cannot
 * disagree with the text above it. They are written only when a value changes,
 * which is what keeps a `modify` listener from writing on its own write.
 */

import { scanFrontmatter } from "./document";
import { formatClock } from "./duration";
import { parseEntries, type EntryIndex } from "./entries";

export interface DayStats {
  travels: number;
  depth: number;
  durationMs: number;
  closedAt: string | null;
}

/** Every entry is a travel; depth is the deepest dimension; durations add up. */
export function countDay(index: EntryIndex, closedAt: string | null): DayStats {
  let durationMs = 0;
  for (const entry of index.entries) durationMs += entry.durationMs;

  return { travels: index.entries.length, depth: index.maxD, durationMs, closedAt };
}

/** Keys earlier builds wrote, and nothing else writes now. */
const REMOVED: Record<string, true> = { sparks: true, dimensions: true, sources: true };

/**
 * Merges the stats into the frontmatter block, creating the block when the note
 * has none. Every other key and every byte outside the frontmatter is preserved.
 */
export function applyDayStats(
  source: string,
  stats: DayStats,
  day: string | null
): { source: string; changed: boolean } {
  const lines = source.split("\n");
  const frontmatter = scanFrontmatter(lines);
  if (frontmatter.kind === "unclosed") return { source, changed: false };

  const desired: Array<[string, string]> = [];
  if (day !== null) desired.push(["date", day]);
  desired.push(
    ["travels", String(stats.travels)],
    ["depth", String(stats.depth)],
    ["duration", formatClock(stats.durationMs)]
  );

  if (frontmatter.kind === "none") {
    const block = ["---", ...desired.map(([key, value]) => `${key}: ${value}`), "---", ""];
    const next = `${block.join("\n")}${source}`;
    return { source: next, changed: next !== source };
  }

  const wanted = new Map(desired);
  const seen = new Set<string>();
  const out: string[] = [];

  for (let line = 0; line <= frontmatter.end; line += 1) {
    const raw = lines[line] ?? "";
    const key = /^([A-Za-z0-9_-]+)\s*:/.exec(raw)?.[1];

    if (key !== undefined && REMOVED[key] === true) continue;
    if (key !== undefined && wanted.has(key)) {
      seen.add(key);
      out.push(`${key}: ${wanted.get(key) ?? ""}`);
      continue;
    }
    out.push(raw);
  }

  const closing = out.pop();
  for (const [key, value] of desired) {
    if (!seen.has(key)) out.push(`${key}: ${value}`);
  }
  if (closing !== undefined) out.push(closing);

  const next = [...out, ...lines.slice(frontmatter.end + 1)].join("\n");
  return { source: next, changed: next !== source };
}

/** Recomputes a day note's stats from its own text. */
export function recountDay(source: string, closedAt: string | null): DayStats {
  return countDay(parseEntries(source), closedAt);
}
