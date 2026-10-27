/**
 * The day's three counters, and the frontmatter that carries them.
 *
 * The counters are derived from the note, never incremented blind, so a count
 * cannot disagree with the text above it and cannot go negative. They are
 * written only when a value changes, which is what keeps a `modify` listener
 * from writing on its own write.
 */

import type { App, TFile } from "obsidian";

import { parseHeadings, scanFrontmatter, type HeadingIndex } from "./headings";
import { parseMarks, type DayMarks } from "./marks";
import { dayKeyFromName } from "./day-note";

export interface DayCounts {
  sparks: number;
  dimensions: number;
  sources: number;
  /** 1D dimensions with no title yet: legal evidence, merely unfinished. */
  untitled: number;
  /** The later of the newest 1D clock and the closing mark. */
  lastMark: string | null;
  closedAt: string | null;
}

/** Seconds since midnight; a one-digit hour sorts correctly here. */
function clockSeconds(time: string | null): number | null {
  if (time === null) return null;
  const parts = time.split(":").map((part) => Number.parseInt(part, 10));
  const [hours = 0, minutes = 0, seconds = 0] = parts;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * 1D dimensions whose title is still empty. Derived, never stored: an untitled
 * spark is legal evidence and is never repaired or deleted, only reported.
 */
export function countUntitled(index: HeadingIndex): number {
  let untitled = 0;
  for (const heading of index.headings) {
    if (heading.level === 1 && heading.title.trim() === "") untitled += 1;
  }
  return untitled;
}

/**
 * Counts a day note: sparks are its 1D dimensions, sources are link marks.
 *
 * The index and the marks are already parsed by every caller (`recountDay` does
 * it once), so the note text is not taken again here.
 */
export function countDay(index: HeadingIndex, marks: DayMarks): DayCounts {
  let sparks = 0;
  let newestSpark: string | null = null;
  let newestSparkSeconds = -1;

  for (const heading of index.headings) {
    if (heading.level !== 1) continue;
    sparks += 1;
    const seconds = clockSeconds(heading.time);
    // A hand-written `9:05` must not outrank `16:37`, so compare in seconds.
    if (seconds !== null && seconds >= newestSparkSeconds) {
      newestSparkSeconds = seconds;
      newestSpark = heading.time;
    }
  }

  const closedSeconds = clockSeconds(marks.closedAt);
  const lastMark =
    closedSeconds !== null && closedSeconds >= newestSparkSeconds ? marks.closedAt : newestSpark;

  return {
    sparks,
    dimensions: index.headings.length,
    sources: marks.sources.filter((mark) => mark.target !== null).length,
    untitled: countUntitled(index),
    lastMark,
    closedAt: marks.closedAt
  };
}

/**
 * Merges the counters into the frontmatter block, creating the block when the
 * note has none. Every other line is preserved byte for byte, and `date` is
 * only ever added — a value the writer already set is not fought over.
 */
export function applyDayCounts(
  source: string,
  counts: DayCounts,
  day: string | null
): { source: string; changed: boolean } {
  const lines = source.split("\n");
  const frontmatter = scanFrontmatter(lines);
  if (frontmatter.kind === "unclosed") return { source, changed: false };

  const desired: Array<[string, string]> = [
    ["sparks", String(counts.sparks)],
    ["dimensions", String(counts.dimensions)],
    ["sources", String(counts.sources)]
  ];
  const dateLine = day === null ? null : `date: ${day}`;

  if (frontmatter.kind === "none") {
    const block = ["---", ...(dateLine === null ? [] : [dateLine]), ...desired.map(([key, value]) => `${key}: ${value}`), "---", ""];
    const next = `${block.join("\n")}${source}`;
    return { source: next, changed: next !== source };
  }

  const end = frontmatter.end;
  const present = new Map(desired.map(([key, value]) => [key, value]));
  const seen = new Set<string>();
  const out: string[] = [];

  for (let line = 0; line <= end; line += 1) {
    const raw = lines[line] ?? "";
    const match = /^([A-Za-z0-9_-]+)\s*:/.exec(raw);
    const key = match?.[1];

    if (key !== undefined && present.has(key)) {
      seen.add(key);
      out.push(`${key}: ${present.get(key) ?? ""}`);
      continue;
    }
    if (key === "date") seen.add("date");
    out.push(raw);
  }

  const closing = out.pop();
  if (dateLine !== null && !seen.has("date")) out.push(dateLine);
  for (const [key, value] of desired) {
    if (!seen.has(key)) out.push(`${key}: ${value}`);
  }
  if (closing !== undefined) out.push(closing);

  const next = [...out, ...lines.slice(end + 1)].join("\n");
  return { source: next, changed: next !== source };
}

/**
 * Writes the counters into `file` through `Vault.process`, so a concurrent edit
 * is re-read rather than overwritten. Returns false when nothing needed writing.
 */
export async function writeDayCounts(app: App, file: TFile, counts: DayCounts): Promise<boolean> {
  let changed = false;
  await app.vault.process(file, (data) => {
    const result = applyDayCounts(data, counts, dayKeyFromName(file.basename));
    changed = result.changed;
    return result.source;
  });
  return changed;
}

/** Recomputes a day note's counters from its own text. */
export function recountDay(source: string, maxDepth: number): DayCounts {
  const index = parseHeadings(source, { maxDepth });
  return countDay(index, parseMarks(source));
}
