import { describe, expect, it } from "vitest";

import { applyDayStats, countDay, recountDay } from "../src/core/day-stats";
import { parseEntries } from "../src/core/entries";

const DAY = [
  "---",
  "date: 2026-10-27",
  "sparks: 3",
  "dimensions: 9",
  "sources: 2",
  "tags:",
  "  - journal",
  "---",
  "{ 1.1.1 } - 10:00:00",
  "root",
  "+ 00:01:00",
  "{ 2.1.2 } - 10:05:00",
  "child",
  "+ 00:02:30"
].join("\n");

describe("countDay", () => {
  it("counts travels, depth and the sum of every duration", () => {
    const stats = countDay(parseEntries(DAY), null);

    expect(stats.travels).toBe(2);
    expect(stats.depth).toBe(2);
    expect(stats.durationMs).toBe(210_000);
  });

  it("recounts from the note's own text", () => {
    expect(recountDay(DAY, "17:30:00").closedAt).toBe("17:30:00");
  });

  it("is zero for a note with no entries", () => {
    const stats = countDay(parseEntries("nothing here"), null);
    expect([stats.travels, stats.depth, stats.durationMs]).toEqual([0, 0, 0]);
  });
});

describe("applyDayStats", () => {
  it("writes the four fields and drops the three old counters", () => {
    const result = applyDayStats(DAY, recountDay(DAY, null), "2026-10-27");

    expect(result.changed).toBe(true);
    expect(result.source).toContain("travels: 2");
    expect(result.source).toContain("depth: 2");
    expect(result.source).toContain("duration: 00:03:30");
    expect(result.source).not.toContain("sparks");
    expect(result.source).not.toContain("dimensions");
    expect(result.source).not.toContain("sources");
    // Every other key, and every byte below the frontmatter, is untouched.
    expect(result.source).toContain("tags:\n  - journal");
    expect(result.source.endsWith(DAY.slice(DAY.indexOf("{ 1.1.1 }")))).toBe(true);
  });

  it("writes nothing on a second pass", () => {
    const once = applyDayStats(DAY, recountDay(DAY, null), "2026-10-27").source;
    const twice = applyDayStats(once, recountDay(once, null), "2026-10-27");

    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once);
  });

  it("creates the block when the note has none", () => {
    const source = "{ 1.1.1 } - 10:00:00\nprose\n+ 00:00:00";
    const result = applyDayStats(source, recountDay(source, null), "2026-10-26");

    expect(result.source.startsWith("---\ndate: 2026-10-26\ntravels: 1\ndepth: 1\n")).toBe(true);
    expect(result.source.endsWith(source)).toBe(true);
  });

  it("leaves an unclosed frontmatter alone", () => {
    const source = "---\ndate: 2026-10-27";
    expect(applyDayStats(source, recountDay(source, null), null).changed).toBe(false);
  });
});
