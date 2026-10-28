import { describe, expect, it } from "vitest";

import {
  childrenOf,
  entryBySeq,
  findCurrentEntry,
  findEntryAtLine,
  findEntryAtOffset,
  formatMarker,
  nextChild,
  nextSeq,
  parseEntries,
  renumberMarkers
} from "../src/core/entries";

const SINGLE = ["{ 1.2.3 } - 13:27:43", "the title line", "+ 00:04:12"].join("\n");

describe("parseEntries", () => {
  it("reads the marker's three numbers and its clock", () => {
    const index = parseEntries(SINGLE);
    const entry = index.entries[0];

    expect(entry?.d).toBe(1);
    expect(entry?.c).toBe(2);
    expect(entry?.n).toBe(3);
    expect(entry?.time).toBe("13:27:43");
    expect(entry?.state).toBe("settled");
    expect(entry?.durationMs).toBe(252_000);
  });

  it("accepts a bare marker and a two-field clock", () => {
    const entry = parseEntries("{1.2.3}-13:27").entries[0];

    expect(entry?.time).toBe("13:27:00");
    expect(entry?.markerEnd).toBe("{1.2.3}-13:27".length);
  });

  it("turns a title written after the clock into the first prose line", () => {
    const source = "{ 2.1.4 } - 09:05 spoke about the breath\nand then more";
    const entry = parseEntries(source).entries[0];

    expect(entry?.title).toBe("spoke about the breath");
    expect(source.slice(entry?.proseFrom)).toBe("spoke about the breath\nand then more");
    expect(entry?.firstProseLine).toBe(0);
  });

  it("ignores a marker inside frontmatter or a fenced code block", () => {
    const source = [
      "---",
      "{ 9.9.9 } - 10:00:00",
      "---",
      "```",
      "{ 8.8.8 } - 11:00:00",
      "```",
      "{ 1.1.1 } - 12:00:00"
    ].join("\n");

    const index = parseEntries(source);
    expect(index.entries.length).toBe(1);
    expect(index.entries[0]?.n).toBe(1);
  });

  it("reads the sigil as the entry's state", () => {
    const states = ["- 00:00:10", "+ 00:00:10", "= 00:00:10", null].map((duration) => {
      const lines = ["{ 1.1.1 } - 10:00:00", "prose"];
      if (duration !== null) lines.push(duration);
      return parseEntries(lines.join("\n")).entries[0];
    });

    // `+` alone is settled: `-` is being written and `=` is paused, and both are
    // open. An entry with no duration line has no clock to settle, so it is
    // settled too.
    expect(states[0]?.state).toBe("draft");
    expect(states[1]?.state).toBe("settled");
    expect(states[2]?.state).toBe("draft");
    expect(states[3]?.state).toBe("settled");
    expect(states[2]?.durationMs).toBe(10_000);
    expect(states[3]?.durationMs).toBe(0);
    expect(states[3]?.durationLine).toBeNull();
  });

  it("gives a parent the whole subtree as its block", () => {
    const source = [
      "{ 1.1.1 } - 10:00:00",
      "root",
      "+ 00:00:00",
      "{ 2.1.2 } - 10:01:00",
      "child",
      "+ 00:00:00",
      "{ 3.1.3 } - 10:02:00",
      "grandchild",
      "+ 00:00:00",
      "{ 2.2.4 } - 10:03:00",
      "sibling",
      "+ 00:00:00",
      "{ 1.2.5 } - 10:04:00"
    ].join("\n");

    const index = parseEntries(source);
    expect(index.entries.map((entry) => entry.parent)).toEqual([null, 0, 1, 0, null]);
    // A block ends on the line before the next entry that is not deeper.
    expect(index.entries[0]?.blockEnd).toBe(11);
    expect(index.entries[1]?.blockEnd).toBe(8);
    expect(index.maxD).toBe(3);
    expect(index.maxN).toBe(5);
  });

  it("addresses entries by line, offset and sequence", () => {
    const source = ["{ 1.1.1 } - 10:00:00", "first", "", "{ 1.2.2 } - 10:01:00", "second"].join("\n");
    const index = parseEntries(source);

    expect(findEntryAtLine(index, 0)?.n).toBe(1);
    expect(findEntryAtLine(index, 1)).toBeNull();
    expect(findCurrentEntry(index, 2)?.n).toBe(1);
    expect(findEntryAtOffset(index, 0)?.n).toBe(1);
    expect(findEntryAtOffset(index, source.indexOf("second"))?.n).toBe(2);
    expect(entryBySeq(index, 2)?.title).toBe("second");
  });

  it("counts children and the next sequence", () => {
    const source = ["{ 1.1.1 } - 10:00:00", "{ 2.1.2 } - 10:01:00", "{ 2.2.3 } - 10:02:00"].join("\n");
    const index = parseEntries(source);
    const root = index.entries[0] ?? null;

    expect(childrenOf(index, root).length).toBe(2);
    expect(nextChild(index, root)).toBe(3);
    expect(nextChild(index, null)).toBe(2);
    expect(nextSeq(index)).toBe(4);
  });

  it("formats a marker with one space inside each brace", () => {
    expect(formatMarker(1, 2, 3, "13:27:43")).toBe("{ 1.2.3 } - 13:27:43");
  });

  it("renumbers only the addresses that are out of order", () => {
    const source = [
      "{ 2.5.1 } - 10:00:00",
      "first",
      "+ 00:00:00",
      "{ 2.7.2 } - 10:01:00",
      "second",
      "+ 00:00:00"
    ].join("\n");

    const index = parseEntries(source);
    const changes = renumberMarkers(index);
    expect(changes.map((change) => change.text)).toEqual(["1", "2"]);

    const next = changes.reduce(
      (text, change) => text.slice(0, change.from) + change.text + text.slice(change.to),
      source
    );
    expect(next.split("\n")[0]).toBe("{ 2.1.1 } - 10:00:00");
    expect(next.split("\n")[3]).toBe("{ 2.2.2 } - 10:01:00");
  });

  it("reports an unclosed frontmatter instead of guessing", () => {
    const index = parseEntries("---\ndate: 2026-10-26\n{ 1.1.1 } - 10:00:00");
    expect(index.unclosedFrontmatter).toBe(true);
    expect(index.entries.length).toBe(0);
  });
});
