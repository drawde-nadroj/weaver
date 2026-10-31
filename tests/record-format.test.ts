import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseClose } from "../src/core/close";
import { applyDayStats, recountDay } from "../src/core/day-stats";
import { parseEntries } from "../src/core/entries";

/**
 * The record format has one example, and it is this file: `SYSTEM-DESIGN.md`
 * embeds it from `tests/fixtures/day-note.md`. A documented example that is not
 * this file is a second, unverified copy of the format.
 */
const SOURCE = readFileSync(new URL("./fixtures/day-note.md", import.meta.url), "utf8");

describe("the record format, as documented", () => {
  it("reads three entries with their dimensions, branches and sequences", () => {
    const index = parseEntries(SOURCE);

    expect(index.entries.map((entry) => [entry.d, entry.b, entry.n])).toEqual([
      [1, 1, 1],
      [2, 1, 2],
      [2, 1, 3]
    ]);
    expect(index.maxD).toBe(2);
  });

  it("reads a title typed after the clock as the first prose line", () => {
    const [first] = parseEntries(SOURCE).entries;

    expect(first?.title).toBe("sparked by [[2026.10.26 - Breaking Free and Building Thoughtware]]");
    expect(first?.firstProseLine).toBe(first?.line === undefined ? null : first.line + 1);
  });

  it("reads `+` as settled and `=` as still open", () => {
    expect(parseEntries(SOURCE).entries.map((entry) => entry.state)).toEqual([
      "settled",
      "settled",
      "draft"
    ]);
  });

  it("reads the close mark, which is not an entry", () => {
    expect(parseClose(SOURCE).closedAt).toBe("17:02:00");
    expect(parseEntries(SOURCE).entries).toHaveLength(3);
  });

  it("agrees with its own frontmatter, so the example cannot contradict itself", () => {
    const stats = recountDay(SOURCE, parseClose(SOURCE).closedAt);

    expect(stats).toMatchObject({ travels: 3, depth: 2, durationMs: 545_000, closedAt: "17:02:00" });
    expect(applyDayStats(SOURCE, stats, "2026-10-29")).toEqual({ source: SOURCE, changed: false });
  });
});
